# 领域模型与状态机

- 状态：Accepted（阶段 1 基线）
- 版本：0.6
- 日期：2026-09-06
- 权威定义：`packages/contracts/src/*.ts`。本文类型块与之镜像。

## 1. 核心实体

```text
Workspace（阶段 1 只有一个）
 ├── User / WorkspaceMember
 ├── Repository
 ├── Runner
 │    ├── RunnerRepository        Runner 对某个 Repository 的本地映射（路径只在 Runner 侧）
 │    └── AgentProfile
 ├── Task
 │    └── Run                      冻结 spec
 │         └── Attempt             worktree + 分支 + Agent session
 │              ├── Turn           一次 prompt 与响应
 │              ├── RunEvent       状态事件（服务端分配 sequence）
 │              ├── TranscriptChunk转写块（Runner 分配 chunkSeq）
 │              └── ApprovalRequest
 ├── Artifact
 └── AuditEvent
```

阶段 1 不存在的实体：AgentRole、Delegation、RunnerPolicy、PullRequest、LlmCall。它们在 0.1 中出现过，理由见 [decisions.md](./decisions.md)。

## 2. Workspace 与用户

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type Workspace = { id: string; name: string; slug: string; createdAt: string };

type User = { id: string; email: string; displayName: string; createdAt: string };

type WorkspaceMember = { workspaceId: string; userId: string; role: 'admin' | 'member' };
```

阶段 1 只有一个 Workspace，首次启动时创建。所有租户表仍带 `workspaceId`，查询必须带 Workspace 条件。第一个注册的用户成为 admin。

## 3. Repository

```ts
type Repository = {
  id: string;
  workspaceId: string;
  name: string;
  remoteUrl: string | null;      // 用于跨 Runner 匹配同一仓库；纯本地仓库为 null
  defaultRef: string;            // 例如 main
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
};

type RunnerRepository = {
  runnerId: string;
  repositoryId: string;
  access: 'read' | 'write';
  reportedAt: string;
};
```

Repository 是逻辑对象。本地路径只存在于 Runner 的 `repositories.json`，服务端永远不知道也不传递绝对路径。Runner 执行 `agent-runner repo add <path>` 时读取 `origin` 的 URL，向服务端匹配或创建 Repository，并把 `repositoryId → 本地路径` 写在本地。

## 4. Runner

```ts
type Runner = {
  id: string;
  workspaceId: string;
  name: string;
  kind: 'local' | 'vps';
  status: 'offline' | 'online' | 'draining' | 'revoked';
  daemonVersion?: string;
  os?: string;
  arch?: string;
  maxConcurrency: number;        // 默认 2
  lastSeenAt?: string;
  createdBy: string;
  createdAt: string;
};
```

`online` 等于存在活跃的 Runner WebSocket。连接断开且 60 秒内没有重连则为 `offline`。`draining` 表示不再领取新 Attempt 但让现有 Attempt 完成。`revoked` 使 token 立即失效。

## 5. AgentProfile 与能力

```ts
type AgentProfile = {
  id: string;
  workspaceId: string;
  runnerId: string;
  engine: 'claude-code' | 'codex' | 'pi' | 'custom';
  displayName: string;
  launch:
    | { kind: 'managed' }                                   // adapter 自己知道怎么启动
    | { kind: 'custom'; command: string; args: string[] };  // 用户指定可执行文件
  defaultModel?: string;
  capabilitySnapshot?: AgentCapabilities;
  capabilityReportedAt?: string;
};

type AgentProtocol = 'acp' | 'sdk' | 'rpc';   // rpc：engine 原生 stdio 协议（pi RPC 模式、Codex app-server）

type AgentCapabilities = {
  protocol: AgentProtocol;
  engineVersion: string;
  models: string[];
  supports: {
    cancel: boolean;
    steer: boolean;
    permissionRequests: boolean;
    fileEvents: boolean;
    planUpdates: boolean;
  };
  enforcement: EnforcementReport;   // 见 §7
};
```

AgentProfile 绑定一个 Runner，因为它描述的是"那台机器上装的那个 Agent"。Runner 在每次 `runner.hello` 时上报能力快照。Profile 不保存 API Key 或任何 secret；Agent 的登录态在 Runner 机器上。

一个 AgentProfile 同时只执行一个 Attempt（`attempts_one_active_profile_idx`）。Runner 的 `maxConcurrency` 是上限，实际并发不超过该 Runner 上 Profile 的数量；要在一台机器上并行跑两个 Claude Code，就建两个 Profile。

## 6. Task

```ts
type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'needs_review' | 'done' | 'canceled';

type Task = {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority?: 'urgent' | 'high' | 'medium' | 'low';
  repositoryId: string | null;   // 阶段 1 单仓库
  lastRunConfig?: RunConfig;     // 上一次手动发起 Run 的配置，仅作默认值
  revision: number;              // 每次编辑 +1，Run 冻结时记录
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};
```

`lastRunConfig` 只是下一次发起 Run 时的表单默认值。阶段 1 没有自动委托；将来加入时它是一个独立的显式字段，Agent 无权修改。

## 7. RunConfig 与 ToolPolicy

```ts
type RunConfig = {
  agentProfileId: string;
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  permissionMode: 'ask' | 'auto_edit' | 'bypass';   // adapter 映射到各 engine 的模式
  toolPolicy: ToolPolicy;
  systemPromptPrefix?: string;
  idleTimeoutMinutes: number;    // 默认 120
  maxTurnMinutes: number;        // 默认 60
};

type ToolPolicy = {
  filesystem: 'worktree_only' | 'host_full';
  network: 'none' | 'unrestricted';
  shell: 'deny' | 'ask' | 'allow';
  gitPush: boolean;
};

type Enforcement = 'runner' | 'engine' | 'none';
type EnforcementReport = Record<keyof ToolPolicy, Enforcement>;
```

`ToolPolicy` 是用户的请求。谁在强制它由 `EnforcementReport` 说明，来自 adapter 的能力上报，并在 Attempt 启动时快照到 `Attempt.enforcement`。`none` 表示这一项只是传给 Agent 的建议，UI 必须原样展示。当前 Claude ACP adapter 报告 `shell: engine`，`filesystem`、`network`、`gitPush` 均为 `none`；设置工作目录和普通权限模式不能证明文件系统或网络隔离。详见 [security.md](./security.md) §6。

## 8. Run

```ts
type FrozenRunSpec = {
  taskId: string;
  taskRevision: number;
  repositoryId: string;
  baseRef: string;
  baseCommitSha: string;
  runnerId: string;              // 阶段 1 由用户显式选择，不可改派
  agentProfileId: string;
  engine: AgentProfile['engine'];
  runConfig: RunConfig;
  initialPrompt: string;
};

type RunStatus =
  | 'pending'            // 尚无 Attempt 进入 running
  | 'active'             // 当前 Turn 正在执行
  | 'idle'               // Agent 就绪，等待用户下一句
  | 'waiting_approval'   // 等待用户批准
  | 'completed'          // 用户完成或空闲超时关闭；不可重试
  | 'failed'             // 可由用户重试
  | 'canceled'           // 可由用户重试
  | 'lost';              // Runner 失联；可由用户重试

type Run = {
  id: string;
  taskId: string;
  workspaceId: string;
  requestedBy: string;
  status: RunStatus;
  frozenSpec: FrozenRunSpec;
  currentAttemptId?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
};
```

`RunStatus` 是 `currentAttempt.status` 的投影，映射见 §12。它不重复 Attempt 的领取和准备细节。

## 9. Attempt

```ts
type AttemptStatus =
  | 'queued' | 'claimed' | 'preparing'
  | 'running' | 'idle' | 'waiting_approval'
  | 'completed' | 'failed' | 'canceled' | 'lost';

type Attempt = {
  id: string;
  runId: string;
  number: number;                // 从 1 递增，(runId, number) 唯一
  runnerId: string;
  agentProfileId: string;
  status: AttemptStatus;
  resumeFrom:
    | { kind: 'base' }
    | { kind: 'commit'; sha: string; fromAttemptId: string };
  branchName: string;            // aw/<runShortId>/a<number>
  baseCommitSha: string;         // 本 Attempt 的起点：frozenSpec.baseCommitSha 或 resumeFrom.sha
  headCommitSha?: string;        // 每个 Turn 结束提交后更新
  notBefore?: string;            // 自动重试退避
  leaseExpiresAt?: string;
  lastHeartbeatAt?: string;
  enforcement?: EnforcementReport;
  cancelRequestedAt?: string;
  error?: RunError;
  createdAt: string;
  claimedAt?: string;
  startedAt?: string;
  finishedAt?: string;
};
```

Attempt 永不复用：lease 过期后旧 Attempt 变为 `lost`，重试创建新 Attempt。因此 `attemptId` 本身就是排他标识，没有单独的 fencing token。服务端接收任何 Runner 消息时检查：该 Attempt 存在、属于该 Runner、是其 Run 的 `currentAttemptId`、状态非终态。不满足则回复 `attempt.stale`。

## 10. Turn

```ts
type TurnStatus = 'running' | 'waiting_approval' | 'completed' | 'failed' | 'canceled';

type Turn = {
  id: string;
  attemptId: string;
  number: number;                // 从 1 递增
  prompt: string;
  status: TurnStatus;
  usage?: UsageSnapshot;
  diffStats?: { files: number; additions: number; deletions: number };
  commitSha?: string;            // Turn 结束时 Runner 在 Attempt 分支上的提交
  patchArtifactId?: string;      // 本 Turn 相对上一个 commit 的 patch
  startedAt: string;
  finishedAt?: string;
};

type UsageSnapshot = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  costUsd?: number;
  model?: string;
};
```

Turn 1 的 prompt 是 `frozenSpec.initialPrompt`，由 Runner 在 Agent session 就绪后立即发起。之后每个 Turn 由用户追加。Turn 结束时 Runner 提交一次，这样 `headCommitSha` 和每轮 Diff 都有明确定义，用户开 PR 时可以 squash。

## 11. ApprovalRequest、RunError、Artifact、AuditEvent

```ts
type ApprovalRequest = {
  id: string;
  workspaceId: string;
  runId: string;
  attemptId: string;
  turnId: string;
  requestId: string;             // Agent 侧的请求 id，(attemptId, requestId) 唯一
  kind: 'tool' | 'file_write' | 'shell' | 'network' | 'other';
  title: string;
  payload: JsonValue;            // adapter 已校验、脱敏且有大小限制的 JSON 请求
  status: 'pending' | 'approved' | 'denied' | 'expired';
  decidedBy?: string;
  decidedAt?: string;
  expiresAt: string;             // min(24h, Turn 结束)
  createdAt: string;
};

type RunErrorCode =
  | 'runner_offline' | 'repository_not_registered' | 'worktree_failed'
  | 'agent_start_failed' | 'agent_crashed' | 'turn_timeout'
  | 'provider_rate_limit' | 'provider_auth' | 'invalid_config'
  | 'canceled' | 'lost' | 'unknown';

type RunError = {
  code: RunErrorCode;
  message: string;
  retryable: boolean;            // 只对 Agent 启动前的失败有意义，见 scheduling-reliability.md §6
  detail?: JsonValue;
};

type Artifact = {
  id: string;
  workspaceId: string;
  runId: string;
  attemptId: string;
  turnId?: string;
  kind: 'patch' | 'file' | 'log';
  blobRef: string;               // 服务端生成的 BlobStore key
  sizeBytes: number;
  sha256: string;
  mimeType: string;
  createdAt: string;
};

type AuditEvent = {
  id: string;
  workspaceId: string;
  actorType: 'human' | 'runner' | 'system';
  actorId: string;
  entityType: 'task' | 'run' | 'attempt' | 'runner' | 'repository' | 'agent_profile' | 'approval';
  entityId: string;
  kind: string;
  data: Record<string, JsonValue>;
  createdAt: string;
};
```

## 12. 状态机

### Attempt

| 从 | 到 | 触发 | 执行者 |
|---|---|---|---|
| — | `queued` | Run 创建或重试 | 服务端（与 Run 同一事务） |
| `queued` | `claimed` | 领取 SQL 成功 | 服务端 |
| `queued` | `canceled` | 用户取消，尚未领取 | 服务端 |
| `queued` | `failed` | Runner 被撤销或仓库映射消失 | 服务端 |
| `claimed` | `preparing` | 事件 `attempt.preparing` | Runner |
| `preparing` | `running` | 事件 `attempt.started` 且 Turn 1 开始 | Runner |
| `claimed` / `preparing` | `failed` | 事件 `attempt.failed`，启动前错误 | Runner；若 `retryable` 服务端自动创建下一个 Attempt |
| `running` | `waiting_approval` | 事件 `approval.requested` | Runner |
| `waiting_approval` | `running` | 审批决定送达 | 服务端记录，Runner 继续 |
| `running` | `idle` | 事件 `turn.completed` / `turn.canceled` / `turn.failed`（可继续） | Runner |
| `idle` | `running` | 用户追加 prompt，事件 `turn.started` | Runner |
| `idle` / `running` / `waiting_approval` | `completed` | 用户点完成或空闲超时，事件 `attempt.completed` | Runner |
| `idle` / `running` / `waiting_approval` | `failed` | 事件 `attempt.failed`，不可恢复（`agent_crashed`、`provider_auth`），包括空闲时 Runner 重启 | Runner；不自动重试 |
| 任何非终态 | `canceled` | 用户取消，事件 `attempt.canceled` | Runner 确认 |
| `claimed` 到 `waiting_approval` | `lost` | `leaseExpiresAt < now()` | 服务端 reaper |
| 终态 | 任何 | — | 禁止 |

终态：`completed`、`failed`、`canceled`、`lost`。

### Run（投影）

| currentAttempt.status | Run.status |
|---|---|
| `queued`、`claimed`、`preparing` | `pending` |
| `running` | `active` |
| `idle` | `idle` |
| `waiting_approval` | `waiting_approval` |
| `completed` | `completed` |
| `failed` | `failed` |
| `canceled` | `canceled` |
| `lost` | `lost` |

用户对 `failed`、`canceled`、`lost` 的 Run 执行重试时创建新 Attempt 并更新 `currentAttemptId`，Run 回到 `pending`。`completed` 不可重试；要继续工作就创建新 Run。

### Turn

`running → waiting_approval → running → completed | failed | canceled`。`turn_timeout` 到达 `maxTurnMinutes` 时 Runner 取消该 Turn，记为 `canceled`，Attempt 回到 `idle`。

### Task

| 从 | 到 | 触发 | 执行者 |
|---|---|---|---|
| `backlog` | `todo` | 用户 | 用户 |
| `todo` | `backlog` | 用户 | 用户 |
| `backlog` / `todo` / `needs_review` / `done` | `in_progress` | 创建 Run | 服务端 |
| `in_progress` | `needs_review` | 当前 Run `completed` | 服务端 |
| `in_progress` | `in_progress` | Run `failed` / `canceled` / `lost` | 状态不变，UI 显示标记 |
| `needs_review` | `done` | 用户标记完成（阶段 3 起也可由 PR 合并触发） | 用户或服务端 |
| 任何非 `done` | `canceled` | 用户 | 用户 |
| `canceled` | `todo` | 用户重新打开 | 用户 |

Task 状态永远不由 Agent 上报决定。

## 13. 取消的两种粒度

- **停止这一轮**：`turn.cancel`，中断当前 Turn，Attempt 回到 `idle`，用户可以换一句话继续。
- **取消 Run**：`attempt.cancel`，关闭 Agent session，Attempt 进入 `canceled`，worktree 保留。

两者都幂等，都必须由 Runner 确认后才改状态。服务端只记录 `cancelRequestedAt`。
