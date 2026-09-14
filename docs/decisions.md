# 架构决策记录

格式：背景、决策、备选方案、风险、结果。状态取 Accepted、Amended（已修订，见备注）、Superseded（被取代）、Deferred（推迟）。

## ADR-028：新功能必须使用独立分支与 Git worktree

- 状态：Accepted
- 日期：2026-09-14

### 背景

直接在 `main` 或共享 checkout 上开发功能，会把未完成改动、验收环境和其他任务混在一起，增加误提交、互相污染和无法安全回退的风险。

### 决策

- 每个新功能、行为变更和 bug 修复必须创建独立 Git 分支与独立 Git worktree。
- 禁止直接在 `main` 或其他共享集成分支上实现功能。
- 创建分支和 worktree 后，编辑、测试、构建和提交全部在该 worktree 中进行。
- 分支名使用 `feature/<slug>`、`fix/<slug>` 或 `chore/<slug>` 前缀。
- 交付时必须报告分支名、worktree 路径和提交 SHA。

### 备选方案

- 直接在主 checkout 修改：操作简单，但无法隔离未完成变更；否决。
- 只创建分支、不创建 worktree：仍会争用同一工作目录和依赖状态；否决。

### 风险

独立 worktree 增加目录和分支管理成本。接受；隔离边界优先于少量操作成本。

### 结果

后续所有新功能开发按本规则执行；阶段一既有提交不追溯重写。

---

## ADR-001：Task、Run、Attempt 分离

- 状态：Amended（0.2 增加 Turn）
- 日期：2026-06-17，修订 2026-09-03

### 背景

一个任务会多次执行、失败后重试、关联多个分支或 PR。

### 决策

Task 是长期意图；Run 是一次工作会话；Attempt 是一次实际执行；Turn 是 Attempt 内一次 prompt 与响应。

### 备选方案

- 只有 Task 和 Run：重试和多轮对话无处安放。
- Task 直接挂 Turn：无法表达"在哪台机器、哪个 worktree 上"。

### 风险

四层实体让 API 和 UI 更复杂。缓解：Run 状态是 Attempt 的投影，UI 主要围绕 Run 和 Turn。

---

## ADR-002：本地与云端统一为 Runner

- 状态：Deferred（被 ADR-019 取代其时机）
- 日期：2026-06-17

### 背景

本地和云端 Agent 的区别在执行位置、凭据和生命周期。

### 决策（0.1）

统一 Runner 接口，kind 为 local、vps、cloud。

### 0.2 备注

方向保留，但在有云端 Worker 的真实需求之前不设计该抽象。阶段 1 到 4 只有 `local` 和 `vps`，二者协议完全相同。见 ADR-019。

---

## ADR-003：ACP 作为 Agent 接入协议

- 状态：Amended（0.2 增加 SDK 回退）
- 日期：2026-06-17，修订 2026-09-03

### 背景

需要支持 Claude Code、Codex 和自定义 Agent，不希望业务层绑定某家 API。

### 决策

adapter 层统一实现 `AgentAdapter` 接口；首选通过 ACP（Agent Client Protocol）连接 engine。

### 备选方案

- 直接使用各家 SDK：每个 engine 一套事件模型，业务层难以中立。
- MCP：它是 Agent 调工具的协议，不是宿主调 Agent 的协议。
- 自定义 stdio 协议：需要为每个 engine 写桥接，等于自己重做 ACP。

### 风险

ACP 桥接的成熟度因 engine 而异。缓解：`AgentAdapter` 接口是我们自己的；阶段 1 若 Claude Code 的 ACP 桥接不够稳，用 Agent SDK 实现同一接口，`capabilities.protocol` 报 `sdk`。业务层不感知。

---

## ADR-004：PostgreSQL 作为权威，不用 CRDT

- 状态：Accepted
- 日期：2026-06-17

### 背景

领取、lease 和状态机需要强一致。

### 决策

PostgreSQL 是 Task、Run、Attempt、Turn 的唯一权威。CRDT 不在阶段 1 到 5 的范围内。

### 备选方案

Loro/Flock 等 local-first 数据面：调度排他性无法由并发合并保证。

### 风险

无离线编辑。接受。

---

## ADR-005：唤醒不是事实

- 状态：Accepted
- 日期：2026-06-17

### 决策

`LISTEN/NOTIFY` 和 WebSocket 推送只是提示。Runner 每 30 秒兜底领取，浏览器重连后按游标补拉。

### 备选方案

只靠推送：任何一次丢失就是丢任务。

---

## ADR-006：Run 创建时冻结执行规范

- 状态：Amended（0.2 明确 Runner 固定，删除 RunnerPolicy）
- 日期：2026-06-17，修订 2026-09-03

### 决策

`FrozenRunSpec` 包含仓库、基线 commit、Runner、AgentProfile、RunConfig 和初始 prompt。阶段 1 Runner 由用户显式选择，重试不改派。

### 备选方案

冻结 `runnerPolicy` 并在 Attempt 级选 Runner：在只有一两台机器时增加复杂度而无收益。需要时再加，且与冻结原则兼容。

### 风险

Runner 长期离线时 Run 卡在 `pending`。缓解：UI 显示 Runner 离线并允许取消后在其他 Runner 上新建 Run。

---

## ADR-007：每个 AgentProfile 一次一个活跃 Attempt

- 状态：Accepted
- 日期：2026-06-17

### 决策

领取 SQL 中强制。Runner 级并发默认 2。

### 备选方案

不限制：多个 Claude Code 实例竞争同一配置目录和 quota，行为不可预测。

---

## ADR-008：明确执行不经过 LLM triage

- 状态：Accepted
- 日期：2026-06-17

阶段 1 到 5 没有 triage。用户发起的 Run 必须入队。

---

## ADR-009：明确配置才允许自动委托

- 状态：Accepted
- 日期：2026-06-17

阶段 1 没有自动委托，`Task.lastRunConfig` 只是表单默认值。将来加入时是独立显式字段，Agent 无权修改。

---

## ADR-010：不包含 FUSE-backed Agent Workspace

- 状态：Accepted
- 日期：2026-06-17

本地 Runner 用本地目录，云端（阶段 5）用临时 worktree。

---

## ADR-011：唯一客户端是一个 Web 应用，服务端是一个进程

- 状态：Accepted
- 日期：2026-09-03

### 背景

0.1 列出 Web、Desktop、CLI 三种客户端和 control plane、web、scheduler、publisher 多个服务组件。零代码阶段承受不起。

### 决策

- 用户端只有 React SPA。
- 服务端是 `apps/web` 一个 Node 进程：REST、浏览器 WS、Runner WS、业务服务、reaper、审计和静态文件托管；阶段 4 公网部署时前置反向代理只终止 TLS（ADR-025 修订）。

- Runner 的命令行只用于配对、注册仓库和守护进程管理，不是用户操作 Task 的客户端。

### 备选方案

- 桌面端（Electron/Tauri）：Runner 已经在本机，桌面端的价值只剩托盘图标，不值一个应用。
- 独立 CLI 客户端：所有操作在 Web 完成更容易保持一致。

### 风险

单进程在阶段 5 前是单点。接受；协议和数据层已为多实例留好口子。

---

## ADR-012：只用 PostgreSQL，不用 Redis 或 NATS

- 状态：Accepted
- 日期：2026-09-03

### 背景

0.1 全篇"Redis/NATS"未决，且 Runner 在 NAT 后不订阅消息系统，唯一消费者是服务端自己。

### 决策

唤醒和跨实例通知用 `LISTEN/NOTIFY`；转写块直接写 PostgreSQL 表；大对象走 `BlobStore` 接口（阶段 1 本地磁盘）。

### 备选方案

- Redis Pub/Sub：多一个组件，语义与 NOTIFY 相同且不是事务性的。
- NATS JetStream：为一个消费者引入持久流没有意义。

### 风险

`NOTIFY` payload 上限 8000 字节，只传 id；转写写入量大时表膨胀。缓解：按块写入、180 天归档。

---

## ADR-013：Runner 主动领取（pull），没有 offer

- 状态：Accepted
- 日期：2026-09-03

### 背景

0.1 同时描述了 pull 领取和 push offer。

### 决策

服务端只发 `work.available` 提示，Runner 调用 `POST /runners/me/claim`，一条 `FOR UPDATE SKIP LOCKED` SQL 完成领取。没有 `run.offer`、`run.accepted`、`run.declined`。

### 备选方案

push offer：需要处理 offer 超时、拒绝和重派三条路径，收益只是少一个 HTTP 往返。

---

## ADR-014：没有 fencing token，attemptId 即排他标识；lease 由 Attempt 心跳维持

- 状态：Accepted
- 日期：2026-09-03

### 背景

0.1 的 fencing token 挂在 `run_attempts` 行上按行递增，新 Attempt 从 1 开始，无法唯一；同时规定 Attempt 永不复用，使 token 与 attemptId 冗余。0.1 的 lease 60 秒且没有任何续约机制。

### 决策

- Attempt 永不复用，服务端校验消息中的 Attempt 是 Run 的当前 Attempt 且非终态，否则回 `attempt.stale`。
- Runner 每 15 秒发 `attempt.heartbeat`，lease 45 秒，reaper 每 15 秒。
- 审批等待期间照常心跳。
- Runner 收到 `stale` 必须杀进程树、停止上报、保留 worktree。

### 备选方案

Run 级单调 token：可行，但比"是否为当前 Attempt"多一个概念且无额外保证。

---

## ADR-015：Agent 启动后不自动重试

- 状态：Accepted
- 日期：2026-09-03

### 背景

coding agent 的一次运行不是幂等作业。自动从头重来会丢掉已完成的工作并重复消耗 token。

### 决策

- `queued`、`claimed`、`preparing` 阶段的可重试失败自动重试，最多 3 次，指数退避。
- `running`、`idle`、`waiting_approval` 阶段的失败、失联、取消只通知用户。
- 用户重试默认从上一个 Attempt 的最后提交继续（`resumeFrom: last_commit`）。
- Runner 每个 Turn 结束提交一次，使"最后提交"有明确定义。

### 备选方案

统一自动重试并附最大次数：在错误的时间重来一次比不重来更糟。

---

## ADR-016：Turn 是核心实体，多轮对话在阶段 1

- 状态：Accepted
- 日期：2026-09-03

### 背景

0.1 的 Run 是一次性的 `running → completed`，用户无法追问。这是 coding agent 平台的核心交互。

### 决策

Attempt 持有 Agent session 和 worktree；Turn 是一次 prompt 与响应，有自己的转写区间、usage、提交和 patch。Attempt 在 Turn 之间处于 `idle`。"完成"是用户动作或空闲超时，不是 Agent 上报。

### 风险

Agent session 长时间保活占用 Runner 资源。缓解：`idleTimeoutMinutes` 默认 120。

---

## ADR-017：本地已有 checkout 作为仓库源

- 状态：Accepted
- 日期：2026-09-03

### 背景

0.1 的数据目录只有 bare clone，凭据来源和 Token Broker 排在阶段 3，阶段 1 无法开始。

### 决策

`agent-runner repo add <path>` 注册用户已有 checkout；Runner 用 `git worktree add` 派生隔离工作区；fetch 和 push 使用用户机器上已有的 git 凭据；服务端只知道 `remoteUrl`，不知道路径。

### 备选方案

Runner 自己 bare clone：需要凭据分发，且用户本地已有的仓库要下载两遍。留给阶段 5 云端。

### 风险

Runner 无法阻止 Agent 用用户凭据 push。如实标注 `gitPush` enforcement 为 `none`。

---

## ADR-018：ACP 优先，Agent SDK 回退

- 状态：Accepted
- 日期：2026-09-03

见 ADR-003 修订。阶段 1 前两天先验证 Claude Code 的 ACP 桥接：稳定完成连续 10 个 Turn、权限请求往返、取消与进程退出清理。若桥接本身不达标则切 SDK 实现，接口不变；上游认证、额度或服务不可用不构成切协议的依据，也不能用 fake adapter 代替门禁。

### 2026-09-07 实施记录：门禁受阻，未通过

- 已实现 `packages/agent-adapters` 的真实 ACP 客户端和 `spike` 可执行程序，使用 Node.js 22；桥接固定为维护中的 `@agentclientprotocol/claude-agent-acp@0.75.1`，内部 Claude Agent SDK 为 `0.3.257`。
- 原型中的旧 `@zed-industries/claude-code-acp@0.16.2` 已移除。修复了小写代理环境变量被 allowlist 丢弃的问题；模型选择使用 `configOptions` / `session/set_config_option`；按 ACP 扩展规则忽略未知扩展通知，并对未知请求返回 `-32601`。
- 真实桥接已完成 `initialize`、`session/new`、权限模式及 `opus` 模型选择。第 1 个真实 Turn 返回 `API Error: Request rejected (429) · Service Unavailable`；通过当前配置代理直接请求同一上游，补齐上游要求的 1M 上下文请求头后返回 HTTP 503。因此连续 10 轮、真实权限往返、真实取消和退出清理尚未验收。
- 协议回归测试已验证配置项模型选择、扩展兼容以及停止一轮后继续同一 session；这些不算真实 Claude 门禁通过。数据库迁移、contracts 与工具链可独立验证。
- 结论：等待已配置 Claude 上游恢复可用后重跑 `SPIKE_MODEL=opus bun run spike:acp`。不因上游 429/503 改用 SDK，不越过 roadmap 门禁实施服务端、Runner 守护进程和 Web UI。
- 当前进程树监督实现依赖 Linux `/proc`。macOS 与 Windows 会显式拒绝启动，不能宣称已满足跨平台 Runner 部署要求。

### 2026-09-13 实施记录：Pi 基础真实调用已验证

- 用户已在本机实际调用 Pi agent，并确认能够正常获得 agent 返回信息。
- 该结果证明 Pi RPC 启动与基础 prompt/response 链路可用；尚不足以替代阶段 1 的完整门禁记录。连续 10 Turn、真实权限审批往返、取消和进程清理仍需单独验收。

### 2026-09-14 Pi 完整门禁记录

- 执行命令：`bun run gate:pi`。
- 结果：连续 10 Turn 上下文连续性通过；权限请求在批准前没有文件副作用，批准后目标文件写入成功；取消返回 `canceled`；Agent 与 detached tool descendant 在 20 秒内清理。
- 结论：Pi 作为阶段 1 真实 engine 的完整 adapter 门禁通过。用户随后完成浏览器 Run 核心体验验收；Claude ACP 保留为独立外部依赖，不再阻塞 Pi engine 的阶段一结论。

### 2026-09-14 浏览器 Run 核心体验验收

- 用户确认通过：基础生命周期、EnforcementReport、多轮追问、每 Turn Diff、权限批准/拒绝、审批等待、取消、完成、重试、浏览器断线重连、事件/transcript 无缺口无重复、硬刷新恢复。
- 过程中发现重复 patch 内容上传触发 `artifacts_blob_ref_key`；服务端已改为幂等查找并为新 blob 使用唯一引用，失败 Run 重试后 Attempt 成功进入 `idle`。

### 2026-09-14 运行环境演练记录

- 本地 PostgreSQL 16 healthy；两次 `bun run db:migrate` 均返回 `applied: []`。
- 已有 Web 服务端和 Runner daemon 运行；Runner 重启后数据库状态恢复为 online，活跃 Pi Attempt 保持可用，queued Attempt 可继续领取。
- 浏览器 headless 验收受系统缺少 `libnspr4.so` 阻塞，未宣称视觉断线验收通过。
- 远程 CI #8 通过宿主 PostgreSQL 方案完成 build、双迁移、契约检查和 28 个不依赖本机 Pi 进程的测试；Pi 真实 RPC 进程由本地 `bun run gate:pi` 覆盖。

---

---

## ADR-019：先本地，再抽取云端抽象

- 状态：Accepted
- 日期：2026-09-03

### 背景

云端 Worker 改变凭据、仓库获取和生命周期。没有一个跑通的本地实现时，抽象只能靠猜。

### 决策

阶段 1 到 4 只做 `local` 和 `vps` Runner。阶段 5 从实际代码中抽取 Runtime 抽象，加入 `cloud` kind、bare clone 缓存、短期凭据和容器强制。

### 备选方案

现在设计统一抽象（0.1 的做法）：见 ADR-002。

---

## ADR-020：状态事件与转写分流

- 状态：Accepted
- 日期：2026-09-03

### 背景

0.1 把 `agent.text_delta` 作为逐条事件写库，一次 Turn 数千行。

### 决策

`run_events` 只存状态变化，服务端分配 `sequence`；`transcript_chunks` 存 Runner 按 250 毫秒或 64 KB 聚合的块，Runner 分配 `chunkSeq`。两者各有 ack、nack 和游标。

### 备选方案

转写写文件加偏移量：需要服务端管理文件追加和多实例共享，阶段 1 不值。

---

## ADR-021：最小审批在阶段 1

- 状态：Accepted
- 日期：2026-09-03

### 背景

Claude Code 和 Codex 第一次运行就会请求权限。0.1 把审批排在阶段 3，阶段 1 只能 bypass。

### 决策

阶段 1 实现单个权限请求的 allow、deny、allow_always（Attempt 内），24 小时过期。策略版本、自动规则、批量审批留给之后。

---

## ADR-022：ToolPolicy 的请求与强制分离

- 状态：Accepted
- 日期：2026-09-03

### 背景

0.1 的 `ToolPolicy` 看起来可强制执行，但本地 Runner 只能控制 Agent 进程的 cwd 和环境，管不到 Agent 再 spawn 的 shell。

### 决策

`ToolPolicy` 是请求；adapter 上报 `EnforcementReport` 说明每项由 `runner`、`engine` 还是 `none` 强制；Attempt 启动时快照；UI 必须显示。

### 备选方案

只支持能强制的项：阶段 1 几乎没有可强制的项，等于删掉整个策略。

---

## ADR-023：Vite + Bun 的前端工具链

- 状态：Amended（0.6 补 trustedDependencies、Runner 安装方式与切换到 pnpm 的条件）
- 日期：2026-09-06，修订 2026-09-06

### 背景

Circle 提供了大量可借鉴的 React UI，但它基于 Next.js 且只是纯前端 mock 模板。我们的服务端、Runner 和 WebSocket 协议已经按 Fastify + React SPA 设计，需要一个不引入 Next.js 服务端耦合的前端工程。团队同时希望使用 Vite 或 Bun。

### 决策

- `apps/web/client` 使用 React、TypeScript、Vite，作为独立 SPA 开发和构建；
- 根目录使用 Bun workspace 管理依赖和执行脚本；
- `apps/web/server` 和 `apps/runner` 的生产运行时保持 Node.js 22，不使用 Bun runtime API；
- 开发时 Vite 与 Fastify 分进程，Vite 代理 `/api` 和 `/ws/client`；生产时由 Nginx 托管 Vite 静态产物，代理 `/api`、`/ws/client` 和 `/ws/runner` 到 Fastify；
- Bun 是工具链选择，不改变 REST、WebSocket、Runner 或数据库协议。

### 备选方案

- **Next.js 全栈**：可以直接使用 Circle 的路由结构，但会让前端框架决定服务端部署和 WebSocket 边界，且需要迁移现有 Fastify 设计。
- **只用 npm 或 pnpm + Vite**：可行，但不符合当前希望统一使用 Bun workspace 和脚本的偏好。
- **Bun 作为生产 runtime**：启动快，但会扩大 Node.js 兼容性、原生依赖和部署风险；现阶段没有收益。
- Fastify 静态托管：可以作为开发或单容器部署的 fallback，但生产推荐将静态文件交给 Nginx，减少 Node 进程的静态文件职责；

### 风险

Bun 的 workspace 行为、锁文件和部分 CLI 生态与 npm/pnpm 存在差异。缓解：CI 固定 Bun 版本并使用 frozen lockfile；服务端和 Runner 只依赖 Node.js 22 兼容 API；生产镜像仍使用 Node.js 22。

### 0.6 修订

- Bun 只做安装与脚本的决定不变，但补三条硬约束：
  - Bun 默认不执行未信任依赖的安装脚本。首次 `bun install` 后运行 `bun pm untrusted`，把项目确实需要安装脚本的包（原生模块，如 argon2）写入根 `package.json` 的 `trustedDependencies`，再重新安装；
  - CI 在 `bun install --frozen-lockfile` 之后用 Node.js 22 运行冒烟脚本，逐个 `require` 原生模块并调用一次，再执行 `vite build` 与服务端启动；
  - 构建镜像与运行镜像使用同一 Debian 基线，原生模块在与运行阶段相同的 glibc 下安装。
- Runner 面向用户的安装方式改为 `npm install -g @agent-workspace/runner`，用户机器只需要 Node.js 22，不需要 Bun。0.5 的 `bun add -g` 与"Runner 只依赖 Node.js 22"矛盾。开发者仍可用 Bun 执行 Runner 的开发脚本。
- Runner 单文件分发（Node SEA 或 `bun build --compile`）在阶段 2 评估，不进入阶段 1。
- 切换条件：工具链检查若在一个工作日内无法通过 `trustedDependencies` 修复，切换到 pnpm workspace。代码尚未存在时切换成本接近零，越晚越高。
- 原决策中"生产时由 Nginx 托管 Vite 静态产物"一句失效：生产静态文件改由 Fastify 托管，见 ADR-025 修订。
- 说明：0.5 选择 Bun 的理由是团队偏好，不是工程论证；本修订把风险约束写实，保留偏好。

---

## ADR-024：Circle 作为 UI 来源，不作为产品基线

- 状态：Amended（0.6 改为借鉴与逐组件重写，移到阶段 2）
- 日期：2026-09-06，修订 2026-09-06

### 背景

`~/study/circle` 的 Sidebar、任务列表/看板、筛选、详情页、Diff 和响应式布局与产品方向高度匹配，但仓库没有后端、数据库、认证、真实 API 或 Agent 执行层。它的数据模型和 Zustand store 是展示模板，不能承载 Task → Run → Attempt → Turn 的可靠性语义。

### 决策

主仓库继续使用 Agent Workspace 自己的领域模型、`packages/contracts`、Fastify、PostgreSQL、Runner 和 Agent adapter。Circle 只作为 MIT License 的 UI 参考和选择性移植来源：

- 移植通用 shadcn/ui、Sidebar、主题、Command Palette 和布局模式；
- 借鉴 Task 列表/看板、筛选、详情属性栏、Activity Feed、Resizable panel 和 unified Diff；
- 不移植 Circle 的 Next.js App Router、Server Component、mock-data 业务模型或内存 CRUD store；
- 移植后的组件必须依赖共享 contracts、API client 和服务端 WebSocket；
- 保留 Circle 的 MIT 版权声明，并单独核对 Logo、图片、字体等第三方资源的许可证。

### 备选方案

- **直接在 Circle 上开发**：前端启动快，但会把 mock 数据层和 Next.js 结构带入核心系统，后续替换成本高。
- **完全从零重写前端**：边界最清晰，但重复投入大量成熟的 UI 和交互工作。
- **当前架构 + 选择性移植**：保留可靠性和领域模型，同时复用 UI 经验，是阶段 1 的折中方案。

### 风险

移植组件可能把 Circle 的 mock 类型、组件函数或浏览器本地 store 隐式带入生产代码。缓解：阶段 1 验收要求移植组件不再依赖 `mock-data`，所有跨进程数据经过 contracts schema 校验；前端边界记录在 [frontend.md](./frontend.md)。

### 0.6 修订

- 措辞由"移植"改为"借鉴与逐组件重写"。抽样核对四个文件的结论：业务组件的类型全部来自 `mock-data`；跳转依赖 `next/link` 与 `next/navigation`；URL 状态依赖 nuqs 的 Next 适配器；`diff-view.tsx` 只渲染预切好的行数组，没有 diff 解析；Inbox 的删除操作是 `console.log` 占位；Circle 自己的 AI_GUIDE 建议"保留 mock-data 的类型"，与本项目"依赖 contracts"的规则相反。
- 真实可复用面：应用壳与 header 布局、Sidebar 结构、主题 token 与命名主题、详情页属性栏、列表/看板分组排序逻辑、移动端单栏返回模式。筛选 chips、可拖拽面板、拖拽、命令面板分别是 bazza/ui、react-resizable-panels、react-dnd、cmdk，直接按库接入；shadcn/ui 用 CLI 生成。Circle 的价值是把这些库组合得好看。
- 领域不重合：Circle 是 Issue/Project/Cycle/Initiative/Triage/Review；本项目的核心屏幕（转写流、审批卡片、每 Turn Diff、Runner 配对、EnforcementReport）在 Circle 中没有对应物，从零实现。
- 时机移到阶段 2。阶段 1 用 shadcn/ui 默认样式完成最小 UI，不做视觉打磨；阶段 1 验收不含任何 Circle 相关项。
- 强制：eslint `no-restricted-imports` 禁止 `@/mock-data/*`、`next/*`、`nuqs/adapters/next*`；借鉴文件头部注明来源与 MIT 声明，汇总到 `THIRD_PARTY_NOTICES.md`。
- 借鉴清单与重写规则见 [frontend.md](./frontend.md) §5。

---

## ADR-025：Nginx 托管前端并代理后端

- 状态：Amended（0.6 推迟到阶段 4；代理只终止 TLS，静态文件由 Fastify 托管）
- 日期：2026-09-06，修订 2026-09-06

### 背景

Vite 生成的 React SPA 是纯静态资源，不需要由 Node.js 进程提供。生产环境还需要稳定处理 TLS、静态资源缓存、SPA history fallback，以及浏览器和 Runner 的长连接 WebSocket。

### 决策

生产拓扑采用 Nginx 作为公网入口：

- Nginx 终止 TLS，并托管 `dist/client`；
- `/api/*` 代理到 Fastify；
- `/ws/client` 和 `/ws/runner` 代理到 Fastify，并转发 WebSocket upgrade；
- Nginx 负责 SPA fallback，API 和 WebSocket 路径在 fallback 之前匹配；
- Fastify 只负责 REST、WebSocket、业务服务、reaper、审计和 BlobStore，可绑定内部地址；
- Nginx 与 Fastify 可以在同一台机器或 Docker Compose 的不同容器中；
- Fastify 静态托管作为单容器/开发 fallback 保留，但不是生产默认方案。

Nginx 与 Fastify 必须发布同一版本的前端和 `packages/contracts`。Runner 通过公网 HTTPS/WSS 域名连接 Nginx，不访问 Fastify 内部端口。

### 备选方案

- **Fastify 同时托管静态文件**：部署组件少，但 Node 进程承担静态文件、缓存和 SPA fallback；保留为简单部署 fallback。
- **Nginx 只做反向代理，前端也由 Fastify 提供**：无法充分利用 Nginx 的静态缓存和职责分离，收益较低。
- **单独的 CDN**：阶段 1 增加域名、缓存失效和部署复杂度；有公网流量需求后再考虑。

### 风险

Nginx 配置错误可能导致 SPA 路由返回 404、WebSocket 被当作普通 HTTP 请求或 Cookie/Authorization 头丢失。缓解：将配置纳入 `infra/production`，对静态 fallback、API 和两个 WebSocket upgrade 做部署验收；Nginx 上游超时不低于 120 秒。

### 0.6 修订

- 推迟到阶段 4。阶段 1 到 3 的服务端运行在用户机器或内网上，没有公网入口；`@fastify/static` 托管 `dist/client` 加 SPA fallback 与缓存头覆盖到阶段 3。
- 反向代理只终止 TLS 并转发 HTTP 与 WebSocket，不托管静态文件、不做 SPA fallback。静态文件与缓存头始终由 Fastify 负责，代理没有"前端版本"，0.5 中"Nginx 与 Fastify 必须发布同一版本"的约束消失。
- 0.5 样例的缺陷与处理：无证书签发与续期方案且证书文件不存在时 Nginx 起不来（Caddy 内建 ACME，或 Nginx + certbot webroot 与定时续期）；`index.html` 无 `no-cache`，发版后旧 index 指向不存在的 hash 文件导致白屏（由 Fastify 统一设置缓存头）；未开启 Fastify `trustProxy`（`TRUST_PROXY=true`，见 security.md §2）；Compose 中拉取的服务端镜像 tag 与宿主机构建的前端产物版本耦合靠人工（只剩一个应用镜像，问题消失）。
- 首选 Caddy：一份配置同时完成 TLS、续期与 WebSocket 转发，少一个 certbot 组件；已有 Nginx 运维习惯时用 Nginx，两者需满足 [deployment.md](./deployment.md) §2.2 的同一组规则。
- 备选方案补充：Nginx 托管静态文件（0.5 决策）放弃，收益只有静态缓存，代价是多一份必须与服务端同步发布的产物。

---

## ADR-026：前端路由、数据层、Diff 与转写渲染

- 状态：Accepted
- 日期：2026-09-06

### 背景

0.5 的 frontend.md 决定了构建工具与包管理，却没有决定前端真正的架构问题：路由、服务端数据在客户端的表示与断线补拉、真实 git patch 的渲染、每 250 毫秒一块的转写流的渲染与内存控制。Circle 的所有组件依赖 Next 路由，路由未定则借鉴无从开始。

### 决策

- 路由：React Router 7，library 模式（`createBrowserRouter`），不用 framework 模式与 SSR；筛选、排序、视图等 URL 参数用 nuqs 的 react-router 适配器。
- 服务端数据：TanStack Query 持有 REST 快照与变更；WebSocket 状态事件只使对应 Run 的快照 query 失效，客户端不推进状态机；转写块进入每个打开的 Attempt 一个的内存 `AttemptStream`，持有 `sequence` 与 `chunkSeq` 游标，负责缺口检测、去重与按游标补拉。顺序固定为"先订阅并缓冲、再快照、再补拉、再排空缓冲"，见 [frontend.md](./frontend.md) §3.3。
- 协议补充：Run 快照返回每个 Attempt 的 `lastSequence`、`lastChunkSeq`；转写接口增加 `beforeChunk` 向前翻页，见 [data-and-events.md](./data-and-events.md) §5。
- Diff：react-diff-view 解析 unified diff；按文件懒渲染，默认折叠；单文件超过 5000 行或 patch 超过 2 MB 只显示统计与下载。验收：50 个文件、3000 行的 patch 首屏 1 秒内可交互；不达标切换到 `@git-diff-view/react`，接口不变。
- 转写：`@tanstack/react-virtual` 虚拟列表；连续 frame 合并为渲染段（文本、思考、工具卡片、计划、usage）；只有进行中的最后一段随 chunk 重渲染；react-markdown + remark-gfm，禁用原始 HTML，shiki 按需加载；每个 Attempt 内存保留最近 2000 个 frame，向上滚动按 `beforeChunk` 补拉。
- 其他：Tailwind v4（`@tailwindcss/vite`）、shadcn/ui 由 CLI 生成、react-hook-form + zod resolver 复用 contracts schema。

### 备选方案

- TanStack Router：类型更强，但 nuqs 与 Circle 借鉴生态偏 react-router，阶段 1 不值额外学习成本。
- 不用 Query、手写 fetch 与缓存：重连补拉与失效逻辑会散落在各页面。
- 事件精确 patch 到 Query 缓存而不是失效：更省请求，但双写易分叉；快照小、事件每 Attempt 几十条，失效重拉代价可接受。阶段 2 若快照变大再改精确 patch。
- diff2html：输出 HTML 字符串，难以接 React 交互（折叠、选择、评论）。
- Monaco diff editor：体积大，多文件场景不适合。
- 转写不虚拟化：一个 Turn 数千 frame 时 DOM 过大，滚动卡顿。

### 风险

- Query 缓存与 WS 增量双写造成分叉。缓解：WS 只触发失效，`AttemptStream` 只存转写与事件序列，两者不互相写。
- 重连补拉的边界条件（订阅与快照之间的事件、游标回退）。缓解：顺序固定并进入阶段 1 验收，用 fake adapter 与断网脚本测试。
- react-diff-view 对超大文件无虚拟化。缓解：上述阈值与切换条件。

---

## ADR-027：多引擎的接口面先于第二个 adapter

- 状态：Accepted
- 日期：2026-09-10

### 背景

团队计划在 Claude Code 之外使用 Codex CLI 和 pi。现有 `packages/agent-adapters` 名义上是 ACP 通用实现，实际把 Claude 私有部分（权限模式名、`_meta.claudeCode` 选项、环境变量 allowlist）和通用 ACP 传输写在一起。同时 `engine` 枚举没有 `pi`，`AgentCapabilities.protocol` 只有 `acp | sdk`，而 pi 的原生接口是 RPC 模式、Codex 的原生接口是 app-server，两者都不是 ACP 也不是 SDK。枚举进了 DB CHECK 和文档，`check:contracts` 又把文档和代码绑在一起，晚改一次是三处联动。

### 决策

- 现在只改接口面：`engine` 增加 `pi`；`protocol` 增加 `rpc`，表示 engine 原生 stdio 协议；环境变量 allowlist 从常量改为按 engine 取（`ENGINE_ENV_ALLOWLIST`），`codex` 与 `pi` 的列表是占位，写对应 adapter 时按 engine 文档核对。项目未部署，直接修改 `0001_initial.sql`，已有本地库需删库重迁。（2026-09-10 勘误：本 ADR 初稿曾把 `runs.auto_retry_count` 当作与「启动后不自动重试」矛盾的死字段删除，这是误读；该列服务于 ADR-015 的启动前自动重试，已恢复。）
- 不在此时拆分通用 ACP 会话与引擎 profile。抽象等第一个真实 engine 通过门禁、服务端与 Runner 成为 `AgentAdapter` 的真实调用方之后再从代码中抽取（同 ADR-019 的理由）。
- 接入顺序：先用 fake adapter 跑通阶段 1 全链路；真实引擎门禁看谁的上游先可用，Claude 上游持续不可用则用 codex-acp 接 Codex 跑同一套门禁；第一个真实引擎过门禁后拆通用 ACP 会话，再接第二个引擎；pi 最后，因为它没有内建权限系统，`permissionMode: 'ask'` 需要额外的 pi extension 把工具调用转发到 Runner，否则 pi 的 adapter 只能接受 `allow` 或 `deny`。
- ADR-003 的「ACP 不稳时用 SDK 回退」只对 Claude 成立。每个 engine 走它最稳的协议，`capabilities.protocol` 如实上报；业务层只看 `AgentAdapter`。

### 备选方案

- 先做通用适配再跑流程：没有真实调用方，抽象靠猜；被 ADR-019 的同一理由否决。
- 用 `custom` 代替 `pi`：`custom` 的含义是「用户指定的任意 ACP 可执行文件」，pi 不说 ACP，混用会让 capability 与 env allowlist 无处挂。
- 新增 `0002` 迁移而不改 `0001`：项目未部署，v1 之前堆积修正迁移是噪音；`migrate.test.ts` 也假设只有一份迁移。

### 风险

- 门禁被 Claude 上游阻塞时间过长，流程跑通后长期只有 fake adapter。缓解：上述 codex-acp 替代路径，一周为限。
- fake adapter 跑通被当作流程跑通。缓解：ADR-018 的「fake 不能代替门禁」在流程层面同样适用，写入阶段 1 验收。
- `codex` 与 `pi` 的 env 占位列表被直接当成事实。缓解：代码注释与本 ADR 均标明占位，adapter 落地时必须核对。
