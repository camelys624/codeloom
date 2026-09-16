# Runner 与 Agent 协议

- 状态：Accepted（阶段 1 基线）
- 版本：0.6
- 日期：2026-09-06
- 权威定义：`packages/contracts/src/protocol.ts`

## 1. 目标

一个协议同时服务用户笔记本和用户 VPS 上的 Runner。Runner 主动出站，服务端不需要访问 Runner 的任何端口。协议按整数 `protocolVersion` 协商，服务端支持当前版本和前一个版本。

## 2. 两条通道

```text
Runner → 服务端   HTTPS /api/v1/…      配对、领取、上传 artifact、快照对账
Runner ⇄ 服务端   WSS   /ws/runner     hello、状态、心跳、事件、转写、控制消息
```

WebSocket 是主通道。领取走 HTTPS POST 是为了让它天然幂等且易于重试；上传走 HTTPS 是为了不阻塞控制消息。断开后 Runner 以指数退避重连（1s 起，上限 30s，带抖动），重连后执行 §11 的对账。

所有请求带 `Authorization: Bearer <runnerToken>`。

## 3. 配对

用户在 Web 中创建 Runner，得到一次性配对码（10 分钟有效，只能兑换一次，服务端只存 hash）。在目标机器执行：

```bash
agent-runner connect --server https://aw.example.com --pair <code> --name my-laptop
```

```http
POST /api/v1/runners/pair
{ "pairingCode": "...", "name": "my-laptop", "daemonVersion": "0.2.0", "os": "linux", "arch": "x64" }
```

```json
{ "runnerId": "rnr_…", "workspaceId": "ws_…", "runnerToken": "awr_…" }
```

`runnerToken` 是长期 bearer token，服务端只存 sha256。Runner 写入 `~/.agent-workspace/credentials.json`（0600）。轮换：

```http
POST /api/v1/runners/me/rotate-token   →   { "runnerToken": "awr_…" }
```

旧 token 在 60 秒后失效。用户在 Web 中撤销 Runner 后所有 token 立即失效，正在进行的 WebSocket 被关闭。没有 refresh token 与 access token 的区分。

Web 管理端补充以下同源接口（均要求已认证 Workspace 成员和同源 `Origin`）：

```http
GET  /api/v1/runners/{runnerId}/status
POST /api/v1/runners/{runnerId}/drain
POST /api/v1/runners/{runnerId}/resume
POST /api/v1/runners/{runnerId}/rotate-token
POST /api/v1/runners/{runnerId}/revoke
```

状态响应包含 `runner`、`load`、`worktrees`、`activeAttempts` 和最近 24 小时的 `staleAttempts`。`drain` 让 Runner 停止领取新 Attempt，但保留现有 Attempt 和 WebSocket；Runner 重连时服务端不会把 `draining` 改回 `online`。`resume` 根据当前 WebSocket 连接恢复为 `online` 或 `offline`。`rotate-token` 返回新 token，旧 token 保留 60 秒；`revoke` 立即清除 token 并关闭现有 WebSocket。

## 4. 注册仓库

```bash
agent-runner repo add ~/code/my-repo            # 读取 origin URL
agent-runner repo add ~/code/scratch --name scratch --no-remote
```

```http
POST /api/v1/runners/me/repositories
{ "remoteUrl": "git@github.com:org/repo.git", "name": "repo", "defaultRef": "main", "access": "write" }
```

```json
{ "repositoryId": "repo_…", "created": false }
```

服务端按 `(workspaceId, remoteUrl)` 匹配已有 Repository，没有则创建。Runner 把 `repositoryId → 本地路径` 写入 `~/.agent-workspace/repositories.json`。路径不会发送给服务端。

### 4.1 创建 Run 时解析基线

创建 Run 的 REST 请求只提交 `baseRef`，不接受浏览器提供的 commit SHA。服务端先校验 Task、Repository、Runner 和 AgentProfile，再通过已连接的 Runner WebSocket 请求：

```text
repository.resolve_ref { requestId, repositoryId, ref }
```

Runner 在 `repositories.json` 对应的本地 checkout 中执行本地 `git rev-parse`，不自动拉取远程仓库。成功解析后，服务端把返回的 `commitSha` 写入 `runs.base_commit_sha` 和 `frozenSpec.baseCommitSha`，随后创建 Attempt #1。服务端在落库前重新锁定 Task 并复核 Repository、Runner 和 Profile 归属，避免解析期间的配置变更覆盖冻结规范。

解析请求由服务端等待最多 10 秒；Runner 离线、响应失败、超时或连接关闭时，Run 创建失败且不产生部分记录。

## 5. 连接与 hello

WebSocket 建立后 Runner 先发：

```json
{
  "type": "runner.hello",
  "protocolVersion": 1,
  "daemonVersion": "0.2.0",
  "os": "linux",
  "arch": "x64",
  "maxConcurrency": 2,
  "agents": [
    {
      "agentProfileId": "agp_…",
      "engine": "claude-code",
      "capabilities": { "protocol": "acp", "engineVersion": "…", "models": ["…"],
                        "supports": { "cancel": true, "steer": false, "permissionRequests": true, "fileEvents": true, "planUpdates": true },
                        "enforcement": { "filesystem": "engine", "network": "engine", "shell": "engine", "gitPush": "none" } }
    }
  ],
  "repositories": [ { "repositoryId": "repo_…", "access": "write" } ],
  "activeAttemptIds": ["att_…"]
}
```

服务端回复：

```json
{ "type": "server.hello", "protocolVersion": 1, "runnerId": "rnr_…", "serverTime": "…",
  "attempts": [ { "attemptId": "att_…", "disposition": "continue" | "stale",
                  "controls": [ { "type": "attempt.cancel", "attemptId": "att_…" } ] } ] }
```

`attempts` 是对 `activeAttemptIds` 逐个的裁决。`stale` 的处理见 §10。

之后 Runner 每 30 秒发一次：

```json
{ "type": "runner.status", "load": { "active": 1, "capacity": 2 } }
```

在线状态由 WebSocket 存活决定，`runner.status` 只更新负载显示。

## 6. 领取

服务端在 Attempt 变为 `queued` 的事务提交后通过 `NOTIFY` 唤醒持有该 Runner 连接的进程，进程向 Runner 发：

```json
{ "type": "work.available" }
```

Runner 收到后，或每 30 秒兜底一次，调用：

```http
POST /api/v1/runners/me/claim
{ "capacity": 1 }
```

```json
{
  "attempts": [
    {
      "attempt": { "id": "att_…", "runId": "run_…", "number": 1, "branchName": "aw/8f3a1c2d/a1",
                   "baseCommitSha": "…", "resumeFrom": { "kind": "base" }, "leaseExpiresAt": "…" },
      "frozenSpec": { "…": "…" }
    }
  ]
}
```

领取是一条 SQL，见 [scheduling-reliability.md](./scheduling-reliability.md) §3。返回空数组表示没有工作。`capacity` 是 Runner 当前还能接的数量，服务端会再按 Runner 的 `maxConcurrency` 和每个 AgentProfile 一个活跃 Attempt 的规则取较小值。

## 7. Attempt 心跳

从领取成功到 Attempt 终态，Runner 每 15 秒发一次：

```json
{ "type": "attempt.heartbeat", "attemptId": "att_…" }
```

服务端把 `leaseExpiresAt` 设为 `now() + 45s`。心跳不是事件，不落 `run_events`。`waiting_approval` 期间照常心跳，因为 Agent 进程仍然活着。

## 8. 状态事件

```json
{
  "type": "attempt.event",
  "attemptId": "att_…",
  "clientSeq": 12,
  "event": { "type": "turn.completed", "turnId": "trn_…", "occurredAt": "…",
             "payload": { "usage": { "…": 0 }, "diffStats": { "files": 3, "additions": 40, "deletions": 5 },
                          "commitSha": "…", "patchArtifactId": "art_…" } }
}
```

- `clientSeq` 在 Attempt 内从 1 严格递增，由 Runner 分配。
- 服务端为每条事件分配 `sequence`（Attempt 内单调，含服务端自己产生的事件），浏览器游标用 `sequence`。
- 服务端回 `{ "type": "ack", "kind": "event", "attemptId", "clientSeq" }`。
- 若收到的 `clientSeq` 不等于 `lastClientSeq + 1`，回 `{ "type": "nack", "kind": "event", "attemptId", "expectedClientSeq" }`，Runner 从该序号重发。重复的 `clientSeq` 幂等忽略并 ack。
- Runner 把未 ack 的事件写在本地 `outbox.jsonl`，重连后重发。

事件的 `turnId` 只放在 `event` 信封上，不在 `payload` 中重复。下表花括号仅列出 `payload` 字段；`turn.*` 和 `approval.requested` 必须提供信封 `turnId`。

Runner 产生的事件类型：

```text
attempt.preparing        { detail }
attempt.started          { enforcement, engineVersion }
turn.started             { number, prompt }
turn.completed           { usage, diffStats, commitSha, patchArtifactId }
turn.failed              { error, attemptContinues: boolean }
turn.canceled            { usage? }
approval.requested       { requestId, kind, title, payload, expiresAt }
attempt.completed        { headCommitSha, reason: 'user' | 'idle_timeout' }
attempt.failed           { error }
attempt.canceled         { headCommitSha? }
```

服务端产生的事件类型：

```text
attempt.queued
attempt.claimed
approval.resolved        { requestId, decision, decidedBy }
attempt.cancel_requested { scope: 'turn' | 'attempt' }  scope=turn 时信封 turnId 必填
attempt.lost
attempt.stale_detected   { fromRunnerId }        诊断
```

## 9. 转写块

Agent 的高频输出不走状态事件：

```json
{
  "type": "attempt.transcript",
  "attemptId": "att_…",
  "chunkSeq": 41,
  "turnId": "trn_…",
  "frames": [
    { "t": "text_delta", "text": "…" },
    { "t": "tool_call", "callId": "…", "tool": "Bash", "input": { "…": "…" } },
    { "t": "tool_result", "callId": "…", "output": "…", "truncated": false },
    { "t": "file_changed", "path": "src/a.ts", "add": 12, "del": 3 },
    { "t": "thought_delta", "text": "…" },
    { "t": "plan_updated", "plan": { "…": "…" } },
    { "t": "usage", "usage": { "…": 0 } },
    { "t": "warning", "code": "…", "message": "…" }
  ]
}
```

- Runner 每 250 毫秒或累积 64 KB 刷一块，`chunkSeq` 在 Attempt 内严格递增。
- 单个 frame 的字符串字段超过 32 KB 时截断并标记 `truncated: true`，完整内容作为 `log` artifact 上传。
- ack 和 nack 规则与事件相同，`kind: "transcript"`。
- 服务端整块写入 `transcript_chunks` 并原样转发给订阅该 Run 的浏览器。
- 各 frame 可带 `truncated` 和完整日志的 `logArtifactId`；字符串按 UTF-8 字节计数，不按 JavaScript 字符数。单块最多 1024 个 frame，JSON 深度最多 32、节点最多 16384。

## 10. 控制消息（服务端到 Runner）

```text
work.available        {}
repository.resolve_ref { requestId, repositoryId, ref }             解析本地 checkout 的 ref
attempt.prompt        { attemptId, turnId, text }                   用户追加一句
turn.cancel           { attemptId, turnId }                         停止这一轮
attempt.cancel        { attemptId }                                 取消 Run
attempt.close         { attemptId, reason: 'user' }                 用户点完成
approval.resolved     { attemptId, requestId, decision: 'allow' | 'deny' | 'allow_always' }
attempt.stale         { attemptId, reason }                         见下
```

Runner 对 `repository.resolve_ref` 回：

```text
repository.ref_resolved { requestId, repositoryId, ref, commitSha }
repository.ref_failed   { requestId, repositoryId, ref, error }
```

`requestId` 由服务端生成并在这组消息中保持不变。Runner 必须回传原始 `repositoryId` 和 `ref`；服务端会校验响应属于发起请求的 WebSocket，且只接受匹配的响应。`repository.ref_failed` 的 `error` 只用于诊断，服务端不据此写入 Run。

`attempt.stale` 在以下情况发出：Attempt 不存在、不属于该 Runner、不是其 Run 的当前 Attempt、已终态。Runner 收到后必须：

1. 立即终止该 Attempt 的 Agent 进程树；
2. 停止该 Attempt 的一切上报（丢弃 outbox 中的剩余项）；
3. 保留 worktree 和分支，不做任何删除；
4. 把本地记录标为 `stale`，在 `agent-runner status` 中显示。

## 11. 重连对账

Runner 重连后：

1. 发 `runner.hello`，带 `activeAttemptIds`；
2. 服务端对仍存在的 `cancel_requested_at` 生成 `controls`，Runner 在确认 `server.hello` 后执行这些控制消息；
3. 对 `disposition: continue` 的 Attempt 恢复心跳并重发 outbox；
4. 对 `disposition: stale` 的 Attempt 执行 §10；
5. 若 Runner 是进程重启（Agent 子进程已不存在），对每个本地活跃 Attempt：先在 worktree 上提交现有改动，再发 `attempt.failed { code: 'agent_crashed', message: 'runner restarted' }`。不假装 session 还在。

服务端侧不需要额外动作：reaper 会把心跳中断超过 45 秒的 Attempt 标为 `lost`。

## 12. 审批

```text
Agent 请求权限
  ↓ adapter 转为 PermissionRequest
Runner 发事件 approval.requested（Attempt 进入 waiting_approval，心跳继续）
  ↓ 服务端写 approval_requests，推送到浏览器
用户 allow / deny / allow_always
  ↓ 服务端写决定和审计，发 approval.resolved
Runner 把决定交给 adapter，Agent 继续或收到拒绝
```

约束：

- 决定绑定 `(attemptId, requestId)`，一次性；
- `expiresAt = min(now + 24h, Turn 结束)`，过期视为 deny；
- Turn 取消或 Attempt 终态时所有 pending 请求置为 `expired`；
- `allow_always` 只在本 Attempt 内有效，由 adapter 记住，不写回 RunConfig。

## 13. 上传

```http
POST /api/v1/attempts/{attemptId}/artifacts
Content-Type: multipart/form-data
kind=patch turnId=trn_… sha256=… file=@turn-3.patch
```

服务端校验 Attempt 归属和状态、大小上限（patch 20 MB，log 50 MB）、sha256，生成 BlobStore key，返回 `artifactId`。Runner 在 `turn.completed` 事件里引用它。

## 14. Agent adapter 接口

```ts
interface AgentAdapter {
  readonly engine: AgentProfile['engine'];
  probe(input: ProbeInput): Promise<AgentCapabilities>;
  startSession(input: StartSessionInput): Promise<AgentSessionHandle>;
}

type ProbeInput = {
  launch: AgentProfile['launch'];
  env: Record<string, string>;
};

type StartSessionInput = {
  attemptId: string;
  cwd: string;                                   // worktree 路径
  launch: AgentProfile['launch'];
  env: Record<string, string>;                   // Runner 按 allowlist 过滤后的环境
  runConfig: RunConfig;
  onFrame: (frame: TranscriptFrame) => void;
  onPermissionRequest: (req: PermissionRequest) => Promise<PermissionDecision>;
  clock: Clock;
};

interface AgentSessionHandle {
  prompt(input: { turnId: string; text: string; signal: AbortSignal }): Promise<TurnResult>;
  cancelTurn(): Promise<void>;
  close(): Promise<void>;
}

type TurnResult = {
  stopReason: 'end_turn' | 'canceled' | 'max_turn_time' | 'error';
  usage?: UsageSnapshot;
  error?: RunError;
};

type PermissionRequest = { requestId: string; kind: ApprovalRequest['kind']; title: string; payload: JsonValue };
type PermissionDecision = { decision: 'allow' | 'deny' | 'allow_always' };
```

adapter 负责：把 `RunConfig` 映射到 engine 的启动参数和权限模式；校验并脱敏 engine 的原始 payload；把 engine 事件转成 `TranscriptFrame`；上报 `EnforcementReport`；隐藏登录和启动细节。Runner 和服务端不解析任何 engine 私有字段。

首个 adapter 是 `claude-code`，优先通过 ACP（Agent Client Protocol）连接。若 ACP 桥接在阶段 1 验证中不够稳定，用 Agent SDK 实现同一接口，`AgentCapabilities.protocol` 报 `sdk`。协议测试使用一个 `fake` adapter，可脚本化产生 frame、权限请求和失败。
