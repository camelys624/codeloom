# 实现状态与交接

- 日期：2026-09-18
- 对应文档：0.6 加 ADR-027；阶段 2 Run 体验增强
- 用途：接手剩余工作的人从这里开始。本文只讲"做了什么、验到什么程度、还剩什么"，设计依据看各专题文档。

## 1. 一句话状态
阶段 1 Pi 真实 engine 与核心 Run 体验已验收；阶段 2 已完成应用壳、Task 看板拖拽、Run 时间线/转写工具、累计 Diff 文件树和轻量语法高亮，并新增 Runner 状态与生命周期管理、Prometheus 指标端点。服务端仍是 PostgreSQL 唯一事实，浏览器通过已有 Run 快照、事件、transcript 游标和新增 Runner 状态 REST 接口获取数据。

## 2. 已完成

每项列出代码位置、验证方式和验证状态。"已验证"指本轮在本地跑过并通过。

### 2.1 工具链与仓库

| 项 | 位置 | 验证 | 状态 |
|---|---|---|---|
| Bun workspace、锁文件、Node.js 22 约束 | `package.json`、`bun.lock` | `bun install --frozen-lockfile` | 已验证 |
| TypeScript 项目引用构建 | `tsconfig.json`、各包 `tsconfig.json` | `bun run typecheck` | 已验证 |
| argon2id 原生模块冒烟 | `scripts/smoke-native.mjs` | `bun run smoke:native` | 已验证 |
| 文档与代码类型对照 | `scripts/check-contract-docs.mjs` | `bun run check:contracts`，36 个类型 | 已验证 |
| Prettier | `.prettierrc.json` | `bun run format:check` | 已验证 |
| CI | `.github/workflows/ci.yml` | 远程运行 #8 通过：宿主 PostgreSQL、build、双迁移、契约检查和排除本机 Pi 进程测试后的 28 个测试通过 | 已验证 |

### 2.2 `packages/contracts`

全部实体、状态机转换表、Runner 与浏览器两套 WebSocket 消息、REST 输入输出、`AgentAdapter` 接口，zod 4。

- 位置：`packages/contracts/src/`，入口 `index.ts`。
- 有界 JSON 校验 `isBoundedJson`（`validation.ts`）防循环引用、getter、深度与字节数，测试覆盖。
- 2026-09-10 变更（ADR-027）：`engine` 加 `pi`；新增 `AgentProtocol = 'acp' | 'sdk' | 'rpc'`。
- 验证：`packages/contracts/test/contracts.test.ts` 10 个测试，已验证。

### 2.3 `apps/web/server/db`

- `migrations/0001_initial.sql`：18 张业务表，租户复合外键贯穿所有表；部分唯一索引保证一个 Run 一个活动 Attempt、一个 AgentProfile 一个被领取的 Attempt；触发器锁死 Run 冻结 spec、终态 Attempt 和审计表；`updated_at` 自动维护。
- `migrate.ts`：advisory lock 加校验和，一个事务里应用全部待应用迁移并 bootstrap 首个 Workspace；可作 CLI（`bun run db:migrate`）或库函数调用。
- 2026-09-10 变更：`agent_profiles.engine` CHECK 加 `pi`。
- 验证：`migrate.test.ts` 8 个测试、远程 CI #8 和全套本地 `bun run test` 均已通过；本地 `bun run db:migrate` 双迁移已验证。

### 2.4 `packages/agent-adapters`

- `claude-code.ts`：真实 ACP 客户端，桥接固定 `@agentclientprotocol/claude-agent-acp@0.75.1`。完成 `initialize`、`session/new`、权限模式映射、按 `configOptions` 选模型、权限请求往返、取消、空闲超时、每 Turn 输出上限。
- `pi.ts`：Pi 原生 RPC JSONL 客户端；启动 `pi --mode rpc`，传递模型/思考级别，解析文本、思考、工具执行、usage 和终态事件；临时 extension 将 Pi 的 `tool_call` 接到统一审批回调，并约束 worktree 路径与 shell 策略。
- `acp-transport.ts`：自写的严格 JSON-RPC 传输层，不用 SDK 的 connection（SDK 会把畸形消息原样打日志）。
- `process.ts`：基于 Linux `/proc` 的进程树监督与清理。**只支持 Linux。**
- `redaction.ts`：按 engine 的环境变量白名单 `ENGINE_ENV_ALLOWLIST`、按行脱敏 `RedactedLines`、结构化脱敏 `Redactor`。
- `fake.ts`：脚本化的 fake adapter，只从 `@agent-workspace/agent-adapters/fake` 导入，不进生产入口。
- `spike.ts`：ADR-018 Claude ACP 门禁程序。
- 验证：`redaction` 4 个、Claude wire peer 1 个、Pi capability 1 个、Pi RPC 启动 1 个；`bun run gate:pi` 已通过 10 Turn、权限往返、取消和进程清理；用户浏览器验收通过；真实 Claude 门禁未通过。


### 2.5 `apps/web/server`

- `src/app.ts`：Fastify REST、session 认证、CSRF、单 Workspace、Repository、Runner 配对/token 轮换、AgentProfile、Task revision CRUD、Run/Attempt 创建与重试、领取、心跳、reaper、事件/转写幂等接收、审批、Runner/浏览器 WebSocket、artifact 本地 BlobStore、静态托管与 SPA fallback；创建 Run 只接受 `baseRef`，由在线 Runner 解析本地 checkout 的最新 commit，服务端在事务前后复核归属并冻结 `baseCommitSha`。
- `src/db.ts`、`src/mapping.ts`：事务、租户查询和契约实体映射。
- 验证：`bun run typecheck`、`bun run build`；无数据库时 fake Pool 路由冒烟通过，`GET /api/v1/me` 返回 401，静态 `/` 与 SPA fallback 返回 200，`index.html` 为 `no-cache`。
### 2.6 `apps/runner` 与 `packages/git-worktree`

- `apps/runner/src/cli.ts`：`connect`、`repo add`、`daemon`、`status`；凭据 0600、数据目录 0700。
- `apps/runner/src/daemon.ts`：Runner hello/status、15 秒心跳、领取、按 Profile 选择 Claude/Pi adapter、控制消息（含 `attempt.close`）、worktree 与每 Turn commit、事件/转写 outbox、ack/nack 重发、stale 处理；持久化活跃 Attempt 元数据，重启后先提交 worktree 再发 `agent_crashed`；启动阶段收到取消/完成请求时，在 worktree 创建后执行对应终态操作；Runner 重连后消费服务端 hello 中的取消控制。
- `packages/git-worktree/src/index.ts`：隔离 worktree、`baseRef` 的本地 commit 解析、每 Turn commit、diff stats 和 unified patch。
- 验证：`bun run typecheck`、全套 `bun run test`；临时 git 仓库冒烟验证 worktree、commit、diff stats 和 patch；Runner close 回归测试通过。

### 2.7 `apps/web/client`

- Agent Profile 表单可选择 `pi` 或 `claude-code`；Pi 默认使用本机 `pi`，可填写 provider/model pattern。
- `lib/stream.ts`：按 Attempt 的事件/转写游标、live 消息缓冲、历史 hydrate、gap 补拉与去重。
- 验证：Vite production build；浏览器流回归测试 2 个通过；用户实际验证 Run 流断线重连、补拉、去重、硬刷新恢复和核心操作。

### 2.8 文档

0.6 全套加 ADR-027（多引擎接口面与接入顺序）。2026-09-13 新增 Pi 基础真实调用、Runner 终态/重连控制、客户端流恢复和自动重试收口记录。`data-and-events.md` 与 `runner-agent-protocol.md` 记录创建 Run 时由 Runner 解析本地 `baseRef`、冻结 `baseCommitSha` 以及 ref 解析失败语义。`check:contracts` 保证 domain-model.md 与 runner-agent-protocol.md 里的 ts 类型块与代码一致，改类型必须同时改文档。

- `apps/web/client/src/main.tsx`：Circle-inspired 应用壳、可折叠 Sidebar、顶部搜索入口、Command Palette（`⌘K` / `Ctrl-K`）、主题切换和 Task board/list 视图。
- `apps/web/client/src/lib/tasks.ts`：Task 状态列、优先级标签、过滤、排序和用户状态迁移规则；状态迁移复用 `packages/contracts` 的服务端状态机。
- Task 看板：按 backlog、todo、in_progress、needs_review、done、canceled 分列；支持标题/描述搜索、优先级 chips、优先级创建、原生拖拽状态迁移和下拉状态更新；合法迁移由客户端提前阻止，实际更新使用现有 revision 乐观并发接口。
- `apps/web/client/src/lib/timeline.ts`：合并 Attempt 事件与 Turn 的时间线，去除重复 Turn 生命周期事件，支持按文本过滤。
- `apps/web/client/src/lib/transcript.ts`：按 frame 搜索、frame 统计和纯文本下载格式化；Run 页支持转写搜索、下载、思考段折叠和工具/计划折叠。
- `apps/web/client/src/lib/diff.ts`：解析 unified diff 为文件树、hunk、行号和增删统计；支持二进制/重命名标记和代码文件轻量 token 高亮。
- `GET /api/v1/runs/{id}/diff`：服务端按 Attempt/Turn 顺序聚合 patch artifact，限制累计响应为 2 MB 并显式返回 `truncated`；前端按文件折叠展示，超大文件仅显示统计。
- Run 页新增时间线、转写搜索和下载工具、累计 Diff 文件树；事件与转写仍复用现有 `AttemptStream` 游标和重连补拉链路。
- `apps/web/client/src/main.tsx` 的 Runner 页面现在展示在线状态、Load、Worktrees、最近心跳、Agent Profiles 和活跃/最近结束 Attempt，并提供排空、恢复领取、token 轮换和撤销操作；token 只通过一次性提示显示。
- `GET /api/v1/runners/{id}/status` 返回契约化 Runner 状态、负载、worktree 占用、活跃 Attempt 和最近 24 小时已结束 Attempt；`POST /drain`、`POST /resume`、`POST /rotate-token` 补齐阶段二状态管理动作，排空状态在 Runner 重连 hello 时保留。
- `GET /metrics`：Prometheus text format 指标端点，支持可选 `METRICS_TOKEN` Bearer 认证；指标覆盖 Runner、Attempt 状态、丢失、自动重试、领取延迟、事件延迟、转写、审批、Run 活动 Attempt 不变量、Runner nack 和浏览器连接。
- `apps/web/server/src/metrics.ts` 与 `apps/web/server/test/metrics.test.ts`：指标 SQL 聚合、完整 status labels、格式化、数据库失败传播和进程内 Runner 计数测试；部署文档包含 Prometheus 告警表达式。
- `apps/runner/src/daemon.ts`：Runner 启动时拉取完成超过 14 天的 worktree 清理候选，检查干净后通过 `git worktree remove` 删除；脏 worktree 跳过并上报状态，原始 checkout 永不触碰。
- `docs/runner-single-file.md`：记录 `bun build --compile` Linux x64 评估，约 81.7 MB ELF 产物，暂不切换 Node SEA。
- `apps/runner/test/chaos.test.ts`：覆盖浏览器事件乱序/去重和 Runner outbox 写入、重载、ack 删除不变量。
- 验证：Runner 清理测试 2 个通过，混沌不变量测试 2 个通过；`bun build --compile` 产物可执行并成功运行 `status`。
- 阶段 2 收口项已完成：worktree 清理、单文件分发评估、可靠性混沌基础场景；后续仅需扩大多平台混沌矩阵和正式发布工程。

## 3. 未完成

按依赖顺序排。阶段 1 的 fake/协议链路、Pi RPC adapter、Runner dispatch、Profile UI、Pi 完整门禁、浏览器核心验收和远程 CI 已落地/通过；artifact 重复内容幂等已修复并通过重试验证。仅剩真实 Claude ACP 门禁，阻塞来自外部中转站/上游网络，不属于当前代码路径。

### W1 数据库测试跑通与环境

- 前置：无。
- 当前：本地 Docker Compose PostgreSQL 16 healthy；两次迁移输出 `applied: []`；`apps/web/server/db/migrate.test.ts` 8 个测试、远程 CI #8 的 build/双迁移/contracts/28 个非本机 Pi 进程测试全部通过。
- 验收：已通过。远程 CI 为宿主 PostgreSQL 方案，Pi 真实 RPC 进程测试仍由本地 `bun run gate:pi` 验收。

### W5 真实引擎门禁

- Claude：上游恢复后可选地运行 `SPIKE_MODEL=opus bun run spike:acp`；当前不阻塞 Pi engine 的阶段 1 验收。
- Pi：2026-09-14 `bun run gate:pi` 通过：连续 10 Turn、上下文连续性、权限批准前无副作用、批准后副作用发生、取消返回和进程树清理均通过。
- 浏览器：用户已验证 Run 生命周期、EnforcementReport、多轮追问、每 Turn Diff、权限批准/拒绝、审批等待、取消、完成、重试、断线重连、事件/transcript 无缺口无重复和硬刷新恢复。
- 验收：Pi 真实 engine 和浏览器核心 Run 体验通过；Claude ACP 作为外部依赖单独记录。

### W6 第二个 engine（阶段 3，ADR-027）

- 已提前落地 Pi adapter 的最小真实 RPC 接入；基础真实调用和阶段 1 完整 Pi 门禁已验证。仍需补齐完整工具事件记录和长期真实 Run 记录。

## 4. 已知问题

本轮代码评审仍保留以下未解决项，按严重程度排。已完成项和验证边界见 §2，详细见 open-issues.md E 节。

1. ACP SDK 版本劈叉：Claude adapter 仍使用 strict schema 与桥接不同版本，真实 Claude 门禁时优先排查。
2. `/proc` 全量扫描每会话每 100 毫秒一次，并发会话开销线性增长；双 fork 后 100 毫秒内被收养的进程会漏掉。
3. Pi 依赖临时 extension 执行审批和 worktree 路径约束；这是 Pi RPC 的宿主集成边界，不等同于 OS sandbox，UI/EnforcementReport 已如实标为 engine/none。
4. Runner 重启后的活跃 Attempt 对账代码已实现，但尚未用真实 WebSocket 完成端到端演练。
5. Pi provider/model 依赖 Runner 主机的本地安装和凭据；Profile 创建只保存 launch/model，不上传凭据。

## 5. 接手第一天

```bash
bun install --frozen-lockfile
bun run build && bun run typecheck && bun run check:contracts && bun run format:check
bun run smoke:native
docker compose -f infra/local/compose.yml up -d
cp .env.example .env
bun run db:migrate && bun run db:migrate      # 第二次应输出 applied: []
bun run test                                  # 10 个测试文件，29 个测试；另有 `bun run gate:pi`
```

数据库可用并通过上述检查后，阶段一 Pi engine 代码、浏览器核心体验、可靠性和 CI 验收已收口。Claude ACP 门禁仅在上游恢复后补跑，不阻塞进入阶段二。
