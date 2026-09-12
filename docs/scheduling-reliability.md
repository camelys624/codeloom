# 领取、lease 与可靠性

- 状态：Accepted（阶段 1 基线）
- 版本：0.6
- 日期：2026-09-06

## 1. 目标

在以下情况下不重复执行、不丢任务、不静默丢失用户的工作：

- Runner 离线、断网、进程重启；
- 服务端重启；
- Agent 进程崩溃或长时间无输出；
- 用户重复点击、取消与完成竞态；
- 同一 Runner 上多个 Attempt 并发。

阶段 1 不存在独立的调度器组件。"调度"就是 Run 创建时把 Attempt 写成 `queued` 并绑定用户选定的 Runner，加上 Runner 领取时的一条 SQL。

## 2. 事实与提示

PostgreSQL 中的以下内容是事实：Attempt 状态、`leaseExpiresAt`、`lastClientSeq`、`lastChunkSeq`、当前 Attempt 指针、审批决定。

`LISTEN/NOTIFY` 的唤醒和 WebSocket 推送只是提示。Runner 每 30 秒兜底调用一次领取接口，浏览器重连后按游标补拉。丢失任何提示都不会丢任务。

## 3. 领取

```sql
-- 同一 Runner 的领取串行化，避免并发领取绕过 profile 限制
SELECT pg_advisory_xact_lock(hashtext($runner_id));

WITH cap AS (
  SELECT CASE WHEN r.status = 'online'
              THEN r.max_concurrency
                   - count(a.id) FILTER (WHERE a.status IN ('claimed','preparing','running','idle','waiting_approval'))
              ELSE 0                      -- draining / offline / revoked 不再领取
         END AS free
  FROM runners r
  LEFT JOIN attempts a ON a.runner_id = r.id
  WHERE r.id = $runner_id
  GROUP BY r.id, r.status, r.max_concurrency
),
picked AS (
  SELECT a.id
  FROM attempts a
  WHERE a.runner_id = $runner_id
    AND a.status = 'queued'
    AND (a.not_before IS NULL OR a.not_before <= now())
    AND NOT EXISTS (
      SELECT 1 FROM attempts b
      WHERE b.runner_id = a.runner_id
        AND b.agent_profile_id = a.agent_profile_id
        AND b.status IN ('claimed','preparing','running','idle','waiting_approval')
    )
    -- NOT EXISTS 只看到 UPDATE 之前的活跃行；同批次仍须每个 profile 只选一个。
    AND a.id = (
      SELECT c.id
      FROM attempts c
      WHERE c.runner_id = a.runner_id
        AND c.agent_profile_id = a.agent_profile_id
        AND c.status = 'queued'
        AND (c.not_before IS NULL OR c.not_before <= now())
      ORDER BY c.created_at, c.id
      LIMIT 1
    )
  ORDER BY a.created_at, a.id
  LIMIT LEAST(GREATEST((SELECT free FROM cap), 0), $requested_capacity)
  FOR UPDATE OF a SKIP LOCKED
)
UPDATE attempts a
SET status = 'claimed',
    claimed_at = now(),
    last_heartbeat_at = now(),
    lease_expires_at = now() + interval '45 seconds'
FROM picked
WHERE a.id = picked.id
RETURNING a.*;
```

领取后在同一事务写 `attempt.claimed` 事件并更新 Run 投影。`draining` 的 Runner `free` 为 0。

并发限制只有两层：

- 每个 Runner 最多 `maxConcurrency` 个活跃 Attempt（默认 2）；
- 每个 AgentProfile 最多 1 个活跃 Attempt（ADR-007）。

不同 Attempt 有各自的 worktree 和分支，同一仓库可以并发。

## 4. 唤醒

Attempt 进入 `queued` 的事务中执行：

```sql
SELECT pg_notify('aw_wake', json_build_object('kind','work','runnerId',$runner_id)::text);
```

服务进程启动时 `LISTEN aw_wake`。收到后若持有该 Runner 的 WebSocket，发 `work.available`。多实例时每个实例都会收到通知，只有持有连接的那个会转发。

## 5. lease 与 reaper

- Runner 每 15 秒发 `attempt.heartbeat`，服务端设 `leaseExpiresAt = now() + 45s`。
- reaper 每 15 秒执行：

```sql
UPDATE attempts
SET status = 'lost', finished_at = now(),
    error = jsonb_build_object('code','lost','message','heartbeat timeout','retryable', status IN ('claimed','preparing'))
WHERE status IN ('claimed','preparing','running','idle','waiting_approval')
  AND lease_expires_at < now()
RETURNING *;
```

- 每条结果写 `attempt.lost` 事件、更新 Run 投影、把 pending 审批置为 `expired`、通知浏览器。
- 心跳在 `waiting_approval` 期间照常进行，审批等多久都不影响 lease。
- 心跳不落事件表。

## 6. 重试

### 6.1 Agent 启动前：自动重试

Attempt 在 `queued`、`claimed`、`preparing` 阶段 `failed` 或 `lost`，且 `error.retryable = true`，服务端自动创建下一个 Attempt：

- `number + 1`，`resumeFrom: { kind: 'base' }`，状态 `queued`；
- `notBefore = now() + 5s × 2^(n-1)`，上限 60 秒，n 为本 Run 自动重试次数；
- 每个 Run 最多自动重试 3 次，之后 Run `failed`，错误保留最后一次。

可自动重试的错误码：`runner_offline`、`worktree_failed`、`agent_start_failed`、`lost`（仅启动前）。不可自动重试：`repository_not_registered`、`invalid_config`、`provider_auth`。

### 6.2 Agent 启动后：只由用户重试

Attempt 在 `running`、`idle`、`waiting_approval` 阶段 `failed`、`lost` 或 `canceled`，服务端只更新状态并通知。用户在 Run 页面点重试：

```http
POST /api/v1/runs/{runId}/retry
{ "resumeFrom": "last_commit" | "base" }
```

- `last_commit`（默认，前一个 Attempt 有 `headCommitSha` 时）：新 Attempt 的 `baseCommitSha` 为该 sha，新分支 `aw/<runShortId>/a<number>` 从该 sha 开始，Agent 收到的第一个 prompt 是用户此刻输入的（默认填入"继续上次的工作"）；
- `base`：从 `frozenSpec.baseCommitSha` 重来。

旧 Attempt 的分支和 worktree 保留，直到用户清理。

### 6.3 Turn 级失败

Turn 内出现 `provider_rate_limit` 时 adapter 自行按 provider 的 retry-after 等待，不上升到 Attempt。Turn 达到 `maxTurnMinutes` 时 Runner 调用 `cancelTurn`，记 `turn.canceled`，Attempt 回到 `idle`，用户决定下一步。

## 7. 取消

```text
用户点"停止这一轮"或"取消 Run"
  ↓ 服务端写 cancelRequestedAt + attempt.cancel_requested 事件（幂等）
  ↓ 发 turn.cancel 或 attempt.cancel
Runner: adapter.cancelTurn()；10 秒内未停则 SIGTERM 进程树，再 10 秒 SIGKILL
  ↓ 提交 worktree 现有改动
  ↓ 发 turn.canceled（回到 idle）或 attempt.canceled（终态）
```

服务端不把"已发送取消"当成"已取消"。Runner 离线时取消请求保留，Runner 重连后在 hello 对账中收到；若 45 秒内没有心跳则由 reaper 标为 `lost`。取消 `queued` 的 Attempt 由服务端直接完成。

## 8. 完成与空闲超时

- 用户点"完成"：服务端发 `attempt.close`，Runner 关闭 session、最后提交一次、上传最终 patch、发 `attempt.completed { reason: 'user' }`。
- 空闲超时：Runner 记录 Turn 结束时间，超过 `idleTimeoutMinutes` 时自行关闭并发 `attempt.completed { reason: 'idle_timeout' }`。
- 完成后 Run `completed`，Task `needs_review`。worktree 保留供用户查看，默认 14 天后由 Runner 清理（见 data-and-events.md §8）。

## 9. 事件顺序与幂等

- 一个 Runner 只有一条 WebSocket，Attempt 内的 `clientSeq` 和 `chunkSeq` 严格递增。
- 服务端校验 `clientSeq == lastClientSeq + 1`，否则 nack 并告知期望值；重复序号幂等 ack。`chunkSeq` 同理。
- 服务端事件 `sequence` 在插入时由 `attempts.last_sequence + 1` 分配，行锁保证单调。
- 浏览器按 `(attemptId, sequence)` 和 `(attemptId, chunkSeq)` 两个游标补拉。

## 10. 重启

### 服务端重启

内存中没有事实。重启后重新 `LISTEN`，reaper 继续，Runner 和浏览器重连后各自对账。正在 `queued` 的 Attempt 等 Runner 下一次领取。

### Runner 重启

Agent 子进程随之消失。Runner 启动后读取本地状态，对每个活跃 Attempt 先提交 worktree 改动，再发 `attempt.failed { code: 'agent_crashed', retryable: false }`。用户从 `last_commit` 重试。不尝试恢复 session。

### 浏览器刷新

从 `GET /api/v1/runs/{id}` 取快照，再按游标补拉事件和转写，重新订阅。

## 11. 测试要求

- 全部计时用注入的 `Clock`，测试中手动推进；
- `fake` adapter 可脚本化：产生 frame、请求权限、崩溃、超时；
- 必须覆盖的场景：同一 Attempt 两次领取只成功一次；profile 已有活跃 Attempt 时不领取；心跳停止 45 秒后 `lost`；启动前 `lost` 自动重试且不超过 3 次；启动后 `lost` 不自动重试；取消幂等；重连后 outbox 重发且无重复；`clientSeq` 缺口触发 nack；stale Attempt 的消息被拒绝且 Runner 收到 `attempt.stale`。
