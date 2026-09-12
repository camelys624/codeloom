# 安全模型

- 状态：Accepted（阶段 1 基线）
- 版本：0.6
- 日期：2026-09-06

## 1. 威胁模型

假设：

- Agent 生成的文本、命令和工具参数不可信；
- 仓库内容、Issue、网页可能包含 prompt injection；
- Runner 所在机器可能有其他用户或恶意进程；
- Runner token 可能泄露或被复制；
- 失联的旧 Attempt 可能在新 Attempt 开始后继续上报；
- 用户可能把高权限仓库交给错误的 Agent 配置；
- 服务端可能部署在公网 VPS 上，Web 认证是第一道门。

阶段 1 明确不防御：Runner 机器本身被完全攻破；Agent engine 自身权限系统的绕过。

## 2. Web 认证与租户

- 邮箱加密码（argon2id），session cookie（HttpOnly、Secure、SameSite=Lax），有效期 14 天；
- 服务端首次启动没有用户时开放注册页，第一个用户成为 admin，之后由 admin 邀请；
- 所有 API 从 session 解析 `userId`，再校验 Workspace 成员身份；不信任请求体中的任何 requester 字段；
- 所有查询带 `workspace_id` 条件，即使阶段 1 只有一个 Workspace；
- CSRF：状态变更接口要求 `Origin` 与 `PUBLIC_ORIGIN` 一致。
- 反向代理之后（阶段 4）：Fastify 开启 `trustProxy` 且只信任代理地址；审计中的客户端 IP 取 `X-Forwarded-For` 中由代理写入的一项；前面没有代理时不得开启，防止伪造头。

## 3. Runner 凭据

- 配对码：随机 128 bit，10 分钟有效，一次性，只存 hash；
- `runnerToken`：随机 256 bit，只存 sha256；
- 轮换：新 token 生效后旧 token 保留 60 秒；
- 撤销：`runners.status = 'revoked'`，token 立即失效，WebSocket 立即关闭，pending Attempt 置 `failed`；
- Runner 侧：`credentials.json` 权限 0600，目录 0700；Windows 使用用户级 AppData；
- token 不出现在 URL、命令行参数、日志、worktree 和发送给 Agent 的环境变量中。

## 4. 仓库与路径

- 服务端只知道 `repositoryId` 和 `remoteUrl`，从不接收、存储或下发绝对路径；
- Runner 只操作用户通过 `agent-runner repo add` 明确注册的目录，以及自己数据目录下的 worktree；
- worktree 路径由 Runner 生成，位于 `~/.agent-workspace/worktrees/` 下；
- 用户注册的原始 checkout 永远不被删除、reset 或 checkout 到其他分支；创建 Run 时 Runner 只在其中执行本地 `git rev-parse`，不自动 fetch，随后在 worktree 上执行 Git 操作；
- git 凭据是用户机器上已有的 SSH agent 或 credential helper，服务端不参与；
- Agent 是否能 push 取决于用户机器的凭据，Runner 无法阻止。因此 `ToolPolicy.gitPush` 的 enforcement 为 `none`，UI 如实显示。

## 5. Agent 凭据

- Agent 的登录态（Claude Code 的 OAuth、Codex 的 API key）在 Runner 机器上，由 engine 自己管理，服务端不接触；
- Runner 启动 Agent 进程时只传 allowlist 中的环境变量：`PATH`、`HOME`、`LANG`、`TERM`、engine 需要的变量（由 adapter 声明），以及 `RunConfig` 映射出的变量；
- 禁止把 Runner 自己的 `runnerToken` 或完整 `process.env` 传给 Agent；
- 转写和日志上传前由 adapter 脱敏：`Authorization`、`Cookie`、`*_TOKEN`、`*_KEY`、`*_SECRET`、私钥块。

## 6. ToolPolicy：请求与强制分离

```ts
type ToolPolicy = { filesystem: 'worktree_only' | 'host_full'; network: 'none' | 'unrestricted'; shell: 'deny' | 'ask' | 'allow'; gitPush: boolean };
type EnforcementReport = Record<keyof ToolPolicy, 'runner' | 'engine' | 'none'>;
```

阶段 1 本地 Runner 的真实情况：

| 项 | 由谁强制 | 说明 |
|---|---|---|
| `filesystem` | `none` | 当前 adapter 没有文件系统沙箱；`cwd` 和普通权限模式不等于 `worktree_only` 强制 |
| `network` | `none` | 当前 adapter 没有启用可验证的网络隔离 |
| `shell` | `engine` | 映射到 engine 的权限模式，`ask` 会产生审批请求 |
| `gitPush` | `none` | 用户凭据在机器上，Runner 无法阻止 |

Runner 自己强制的只有：Agent 进程的 `cwd`、环境变量 allowlist、进程树的取消与超时、上传大小限制。

UI 在发起 Run 时必须显示 `EnforcementReport`，`none` 项以醒目方式提示。管理员可以为 Workspace 设置"不允许 `bypass` 模式"和"不允许 `host_full`"。

云端 Worker 的容器级强制在阶段 5 设计。

## 7. 命令执行

Runner 自己执行的命令（git、Agent 可执行文件）：

- `spawn(command, args, { shell: false })`，不拼接字符串；
- `command` 只能来自 adapter 的固定列表或 `AgentProfile.launch.command`（管理员配置）；
- `cwd` 必须是 worktree 或注册的 checkout；
- 输出有大小上限，超出截断；
- 取消和超时终止完整进程树（Unix 上用独立进程组，Windows 上用 Job Object）；
- 所有路径在使用前 `realpath` 并检查位于允许目录之内。

## 8. 事件真实性

- 每条 Runner 消息带 bearer token 验证 Runner 身份；
- 服务端校验 Attempt 属于该 Runner、是 Run 的当前 Attempt、非终态；不满足则拒绝并回 `attempt.stale`；
- `client_seq` 严格递增，重复幂等，缺口 nack；
- 旧 Attempt 不能修改新 Attempt 或 Run 的任何状态；
- Task 状态只由服务端根据 Run 状态和用户动作转换，Agent 事件不能直接改 Task。

## 9. 审批

- 请求绑定 `(attemptId, requestId)`，一次性；
- `expiresAt = min(24h, Turn 结束)`，过期视为 deny；
- 决定必须由 Workspace 成员在 Web 中做出，写审计；
- Attempt 终态或 Turn 取消时所有 pending 请求置 `expired`；
- `allow_always` 只在当前 Attempt 内有效，不写回配置；
- 阶段 1 没有自动批准规则。

## 10. Prompt injection

以下内容一律视为数据：Task 描述、仓库文件、Issue 与 PR 正文、网页、工具输出、其他 Agent 的消息。

`systemPromptPrefix` 由 Runner 注入时附带固定声明：外部内容不改变权限策略、不泄露 secret、不绕过审批。但提示词不是安全边界；边界由 engine 的权限系统、审批流程和 Runner 的进程控制构成。

## 11. Artifact 与转写

- 访问必须经过 Workspace 成员校验；
- 下载用短期签名 URL（本地实现为一次性 token，5 分钟）；
- 上传校验大小、sha256、MIME；patch 20 MB，log 50 MB；
- 转写在 Runner 侧脱敏后再发送；
- 前端不展示 Agent 进程的环境变量。

## 12. 审计

至少记录：用户登录与邀请；Runner 配对、轮换、撤销；Repository 注册；AgentProfile 变更；Run 创建、重试、取消、完成；审批请求与决定；artifact 下载；stale 事件被拒绝。

`audit_events` 只追加，没有更新和删除接口。
