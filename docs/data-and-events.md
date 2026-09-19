# 数据存储与事件

- 状态：Accepted（阶段 1 基线）
- 版本：0.6
- 日期：2026-09-06

## 1. 存储组成

```text
PostgreSQL 16     全部业务状态、事件、转写块、审批、审计、会话
BlobStore         patch、artifact、超长日志；阶段 1 为服务端本地磁盘，接口兼容 S3
Runner 本地文件    凭据、仓库映射、活跃 Attempt 记录、未确认消息缓冲
```

没有 Redis、NATS 或独立队列。唤醒用 `LISTEN/NOTIFY`。

## 2. 表

所有租户表带 `workspace_id`、`created_at`；可变表带 `updated_at`。主键为带前缀的随机 id（`ws_`、`usr_`、`repo_`、`rnr_`、`agp_`、`task_`、`run_`、`att_`、`trn_`、`apr_`、`art_`）。

```sql
workspaces            (id, name, slug, created_at)
users                 (id, email UNIQUE, password_hash, display_name, created_at)
sessions              (id, user_id, expires_at, created_at)
workspace_members     (workspace_id, user_id, role, created_at)  PK(workspace_id, user_id)

repositories          (id, workspace_id, name, remote_url, default_ref, status, created_at, updated_at)
                       UNIQUE(workspace_id, remote_url) WHERE remote_url IS NOT NULL

runners               (id, workspace_id, name, kind, status, daemon_version, os, arch,
                       max_concurrency, token_hash, token_rotated_at, previous_token_hash,
                       previous_token_expires_at, last_seen_at, created_by, created_at, revoked_at)
runner_pairing_codes  (id, workspace_id, runner_id, code_hash, expires_at, used_at, created_by, created_at)
runner_repositories   (workspace_id, runner_id, repository_id, access, reported_at, created_at, updated_at)  PK(runner_id, repository_id)

agent_profiles        (id, workspace_id, runner_id, engine, display_name, launch JSONB,
                       default_model, capability_snapshot JSONB, capability_reported_at,
                       created_at, updated_at)

tasks                 (id, workspace_id, title, description, status, priority, repository_id,
                       last_run_config JSONB, revision, created_by, created_at, updated_at)

runs                  (id, workspace_id, task_id, requested_by, status, runner_id, agent_profile_id,
                       repository_id, base_commit_sha, frozen_spec JSONB, current_attempt_id,
                       auto_retry_count, created_at, started_at, finished_at)

attempts              (id, workspace_id, run_id, number, runner_id, agent_profile_id, status,
                       resume_from JSONB, branch_name, base_commit_sha, head_commit_sha,
                       not_before, claimed_at, started_at, finished_at,
                       lease_expires_at, last_heartbeat_at,
                       last_sequence, last_client_seq, last_chunk_seq,
                       enforcement JSONB, cancel_requested_at, error JSONB, created_at)
                       UNIQUE(run_id, number)

turns                 (id, workspace_id, attempt_id, number, prompt, status, usage JSONB,
                       diff_stats JSONB, commit_sha, patch_artifact_id, started_at, finished_at)
                       UNIQUE(attempt_id, number)

run_events            (id BIGSERIAL, workspace_id, run_id, attempt_id, turn_id, sequence,
                       client_seq, type, payload JSONB, occurred_at, created_at)
                       UNIQUE(attempt_id, sequence)
                       UNIQUE(attempt_id, client_seq) WHERE client_seq IS NOT NULL

transcript_chunks     (workspace_id, attempt_id, chunk_seq, turn_id, frames JSONB, frame_count, byte_size, created_at)
                       PK(attempt_id, chunk_seq)

approval_requests     (id, workspace_id, run_id, attempt_id, turn_id, request_id, kind, title,
                       payload JSONB, status, decided_by, decided_at, expires_at, created_at)
                       UNIQUE(attempt_id, request_id)

artifacts             (id, workspace_id, run_id, attempt_id, turn_id, kind, blob_ref,
                       size_bytes, sha256, mime_type, created_at)

audit_events          (id BIGSERIAL, workspace_id, actor_type, actor_id, entity_type, entity_id,
                       kind, data JSONB, created_at)
```

索引：

```sql
attempts            (runner_id, status)
attempts            (status, lease_expires_at)  WHERE status IN ('claimed','preparing','running','idle','waiting_approval')
attempts            (runner_id, status, not_before) WHERE status = 'queued'
runs                (workspace_id, task_id, created_at DESC)
tasks               (workspace_id, status, updated_at DESC)
run_events          (run_id, created_at)
approval_requests   (workspace_id, status, created_at)
audit_events        (workspace_id, entity_type, entity_id, created_at)
```

`runs` 中的 `runner_id`、`agent_profile_id`、`repository_id`、`base_commit_sha` 是 `frozen_spec` 的冗余列，供查询用；`frozen_spec` 是权威。`attempts.agent_profile_id` 冗余是为了领取 SQL 的 profile 并发检查。

迁移用复合外键验证 Workspace 及 Run → Attempt → Turn 归属，包括 `runner_repositories` 和 `transcript_chunks` 的间接关联。一个 Run 最多一个非终态 Attempt（含 `queued`）；一个 AgentProfile 最多一个已领取的活跃 Attempt（不含 `queued`）。`frozen_spec` 及其身份/查询冗余列不可修改；审计表禁止 UPDATE、DELETE、TRUNCATE。数据库约束是业务事务检查之外的最后防线。

## 3. 写入事务

### 创建 Run

浏览器调用：

```http
POST /api/v1/tasks/{taskId}/runs
{
  "runnerId": "rnr_…",
  "agentProfileId": "agp_…",
  "baseRef": "main",
  "runConfig": { "…": "…" },
  "initialPrompt": "…"
}
```

请求不再携带 `baseCommitSha`。创建 Run 分为预检和一次数据库事务：

1. 读取 Task 当前 `revision`，校验所选 Runner、Profile 和 Repository；
2. 服务端通过该 Runner 的 WebSocket 发 `repository.resolve_ref`。Runner 只在已注册的本地 checkout 执行 `git rev-parse --verify --end-of-options "<baseRef>^{commit}"`，不自动 fetch；成功返回 `baseCommitSha`；
3. 服务端重新锁定 Task，并复核 Task 的 Repository、Profile 与 Runner 归属；
4. 在一个事务中将解析出的 `baseCommitSha` 写入 `runs` 和 `frozen_spec`（基线在 Run 创建时冻结），插入 `runs`、Attempt #1、`attempt.queued` 和审计记录，并唤醒 Runner。

基线解析失败不创建 Run：Runner 离线返回 409，Runner 报告 ref 不存在或未注册本地仓库返回 422，10 秒未响应返回 504，连接在解析期间关闭返回 503。

### 接收 Runner 事件

一个事务：

1. `SELECT … FOR UPDATE` 该 Attempt，校验归属、当前指针、非终态、`client_seq == last_client_seq + 1`；
2. `last_sequence += 1`，插入 `run_events`；
3. 按事件类型更新 Attempt、Turn、Run 投影、ApprovalRequest、Task；
4. `last_client_seq = client_seq`；
5. `pg_notify('aw_run', {runId, attemptId, sequence})` 供多实例转发给浏览器。

事务提交后回 ack。

### 接收转写块

一个事务：校验同上，插入 `transcript_chunks`，`last_chunk_seq = chunk_seq`，`pg_notify('aw_run', …)`。转写块不更新任何状态。

## 4. 事件表与转写表的分工

| | `run_events` | `transcript_chunks` |
|---|---|---|
| 内容 | 状态变化、Turn 边界、审批、错误 | 文本增量、思考、工具调用与结果、文件变更、usage |
| 频率 | 每个 Attempt 几十条 | 每 250 毫秒一块 |
| 序号 | 服务端分配 `sequence`；Runner 侧 `client_seq` | Runner 分配 `chunk_seq` |
| 用途 | 状态机、时间线、审计 | 转写回放 |
| 单条上限 | payload 64 KB | 块 64 KB，frame 字段 32 KB 截断 |

任何超出上限的内容作为 artifact 上传，事件或 frame 只保留引用。

## 5. 实时通道（浏览器）

```text
WSS /ws/client
→ { "type": "subscribe", "runId": "run_…" }
← { "type": "event", "attemptId", "sequence", "event": {...} }
← { "type": "transcript", "attemptId", "chunkSeq", "turnId", "frames": [...] }
← { "type": "run", "run": {...} }          Run 投影变化时的快照
```

重连补拉：

```http
GET /api/v1/runs/{runId}                                   快照：Run、Attempts、Turns、pending 审批，以及每个 Attempt 的 lastSequence、lastChunkSeq
GET /api/v1/attempts/{attemptId}/events?after=<sequence>
GET /api/v1/attempts/{attemptId}/transcript?afterChunk=<chunkSeq>&limit=200     向后补拉（重连、追平）
GET /api/v1/attempts/{attemptId}/transcript?beforeChunk=<chunkSeq>&limit=200    向前翻页（首屏加载尾部、向上滚动）
```

游标都以 Attempt 为作用域。快照中的 `lastSequence`、`lastChunkSeq` 来自 `attempts` 表的同名列，作为快照的附加字段返回，不进入 Attempt 实体类型。前端不把当前画面当作状态来源；浏览器侧"先订阅并缓冲、再快照、再补拉、再排空缓冲"的顺序见 [frontend.md](./frontend.md) §3.3。

## 6. 唤醒通道

```text
aw_wake   { kind: 'work', runnerId }                         Attempt 进入 queued
aw_run    { runId, attemptId, sequence? , chunkSeq? }        供其他实例转发给浏览器
aw_runner { runnerId, status }                               Runner 上下线
```

payload 只含 id，不含内容；接收方按 id 回查。

## 7. BlobStore

```ts
interface BlobStore {
  put(key: string, body: Readable, meta: { size: number; sha256: string; mimeType: string }): Promise<void>;
  get(key: string): Promise<Readable>;
  signedUrl(key: string, ttlSeconds: number): Promise<string>;   // 本地实现返回带一次性 token 的服务端 URL
  delete(key: string): Promise<void>;
}
```

key 由服务端生成：

```text
ws/<workspaceId>/run/<runId>/att/<attemptId>/turn/<turnId>/patch.diff
ws/<workspaceId>/run/<runId>/att/<attemptId>/log/<artifactId>
```

阶段 1 实现写 `DATA_DIR/blobs/`。上传后服务端校验大小、sha256 和 MIME。删除 Run 时按引用清理。

## 8. 保留与清理

- `transcript_chunks`：默认保留 180 天；服务端每小时按 Attempt 把超过保留期的块打包为 `log` artifact，MIME 为 `application/x.codeloom-transcript+jsonl`，归档头声明 workspace、Run、Attempt 和格式版本，成功创建 artifact 后删除对应行；单个 artifact 最大 50 MB，超过时分批归档。
- 归档通过 `GET /api/v1/attempts/{id}/transcript-archives` 查询，原始 artifact 下载仍使用现有 artifact 下载接口。
- worktree：Run `completed` 后 14 天由 Runner 启动时和每小时清理任务检查；先确认工作区无未提交改动，再执行 `git worktree remove`。结果写入 Attempt 的 `cleanup_status`，脏 worktree 标记 `skipped_dirty` 并保留；`failed`、`lost`、`canceled` 的 worktree 不自动清理；
- 用户注册的原始 checkout 永远不是清理目标；
- `runner_pairing_codes`：过期 1 天后删除；
- `sessions`：过期后删除。

## 9. Runner 本地文件

```text
~/.agent-workspace/
├── config.json               server URL、runnerId、数据目录、并发上限
├── credentials.json          runnerToken（0600）
├── repositories.json         repositoryId → { path, remoteUrl, access }
├── state/
│   └── attempts/<attemptId>.json       状态、branch、worktree 路径、turn 列表、idle since
│   └── attempts/<attemptId>.outbox.jsonl  未 ack 的事件与转写块
├── worktrees/<repositoryId>/<attemptId>/
└── logs/
```

本地文件不是事实来源。重连后以服务端的 `server.hello` 裁决为准。写入使用先写临时文件再 rename。

## 10. usage 与成本

usage 记录在 `turns.usage`，Run 和 Task 级汇总用查询得到。阶段 1 不建独立的 LLM 调用账本；平台自己没有 LLM 调用。
