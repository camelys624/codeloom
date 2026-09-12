# 总体架构设计

- 状态：Accepted（阶段 1 基线）
- 版本：0.6
- 日期：2026-09-06
- 变更：继承 0.2 的架构基线与 0.5 的前端工具链。0.6 根据 0.5 评审修订：阶段 1 聚焦 ACP spike 与最小 UI；Circle 借鉴移到阶段 2（ADR-024 修订）；反向代理推迟到阶段 4 且只终止 TLS，静态文件由 Fastify 托管（ADR-025 修订）；Bun 只做安装与脚本并补 `trustedDependencies` 与切 pnpm 的条件（ADR-023 修订）；新增 ADR-026 前端路由、数据层、Diff 与转写渲染。评审记录见 [open-issues.md](./open-issues.md)，决策见 [decisions.md](./decisions.md) ADR-011 到 ADR-026。

## 1. 产品定位

Agent Workspace 是一个面向小团队的 coding agent 任务台：用户在 Web 应用中登记仓库、创建任务、选一台自己的机器和一个 Agent 配置发起 Run，Runner 在隔离的 git worktree 中启动 Agent，用户在浏览器里看转写、批准权限、追加下一句话、查看每一轮的 Diff，最后把结果落成分支或 PR。

核心链路：

```text
Task → Run → Attempt → Turn ⇄ 用户
              │
              └─ Runner → Worktree → Agent(ACP)
```

一个 Run 的核心体验是多轮对话，不是一次性作业。

## 2. 设计原则

### 2.1 Task、Run、Attempt、Turn 分离

- Task 是长期工作意图，有看板状态。
- Run 是用户针对 Task 发起的一次工作会话，冻结仓库、基线 commit、Runner 和 Agent 配置。
- Attempt 是 Run 在 Runner 上的一次实际执行，持有 worktree、分支和 Agent session。
- Turn 是 Attempt 内的一次 prompt 与响应，有自己的转写、usage 和 Diff。
- 一个 Run 可以有多个 Attempt（用户重试）；一个 Attempt 可以有多个 Turn（用户追问）。

### 2.2 PostgreSQL 是唯一事实

Task、Run、Attempt、Turn、事件、审批、Runner 状态都在 PostgreSQL 中。唤醒用 PostgreSQL 的 `LISTEN/NOTIFY`，它在事务提交时才发出，天然具备 outbox 语义。不引入 Redis 或 NATS。Runner 收不到唤醒也不会丢任务，因为它定期主动领取。

### 2.3 一个 Web 应用，一个业务服务进程

用户端只有一个 Web 应用。开发环境将 Vite 前端和 Fastify 服务端分成两个进程；生产环境由 Fastify 同时托管 Vite 构建的静态文件并提供 API 和 WebSocket，仍然是一个进程、一个镜像。阶段 4 公网部署时在前面加一个反向代理，它只终止 TLS 并转发，不承载业务状态，也不托管静态文件。没有独立的 scheduler、worker、publisher 进程。阶段 1 单实例；因为唤醒走 `LISTEN/NOTIFY`，未来多实例不需要改协议。

### 2.4 Runner 是用户机器上的守护进程

Runner 主动出站连接服务端，不需要入站端口。它使用用户机器上已有的 git checkout 作为仓库源，用 `git worktree add` 派生隔离工作区，用用户自己的 git 凭据。服务端不接触仓库凭据和本地路径。

### 2.5 Agent 启动后不自动重试

Agent 启动前的失败（Runner 离线、worktree 创建失败、Agent 进程起不来）可以自动重试。Agent 一旦开始工作，任何失败或失联都只标记状态并通知用户，由用户决定重试，重试默认从上一次的最后提交继续。丢掉一个跑了 20 分钟的 agent 的工作并静默重来，是最糟糕的降级。

### 2.6 不做隐式降级

Runner、Agent、模型或仓库不可用时，Run 明确失败或等待。阶段 1 用户显式选择 Runner，没有候选池和自动改派。

### 2.7 执行接受时冻结配置

Run 创建时保存不可变的 `FrozenRunSpec`：仓库、基线 commit、Runner、Agent Profile、RunConfig 和初始 prompt。重试和恢复使用冻结快照。

### 2.8 先本地，再抽取云端

阶段 1 到阶段 4 只有本地和 VPS Runner。云端 Worker 改变的是凭据、仓库获取方式和生命周期，这三件事在没有真实需求前无法正确抽象。阶段 5 从跑通的本地实现中抽取 Runtime 抽象，而不是现在设计。

### 2.9 契约先于文档

`packages/contracts` 中的 zod schema 是所有实体、消息和事件的权威定义。本目录文档中的类型块与之镜像，代码存在后由 CI 检查漂移。

## 3. 组件

```text
┌───────────────────────────────────────────────────────┐
│  浏览器：React SPA                                     │
│  Task 看板 · Run 详情 · 转写流 · 审批 · Diff · Runner    │
└───────────────┬───────────────────────────────────────┘
                │ HTTPS /api/v1  +  WSS /ws/client
┌───────────────▼───────────────────────────────────────┐
│  apps/web（开发：Vite + Fastify；生产：Fastify 托管静态 + API + WS）│
│  Fastify: REST · 客户端 WS · Runner WS · 业务服务              │
│  领取(SQL) · lease reaper · 审批 · 审计 · BlobStore       │
└───────────────┬────────────────────────┬──────────────┘
                │ SQL + LISTEN/NOTIFY     │ 本地磁盘（阶段 1）
        ┌───────▼────────┐        ┌───────▼────────┐
        │  PostgreSQL 16 │        │  BlobStore      │
        │  唯一事实       │        │  patch/artifact │
        └────────────────┘        └────────────────┘
                ▲
                │ WSS /ws/runner（出站）+ HTTPS 领取/上传
┌───────────────┴───────────────────────────────────────┐
│  apps/runner（用户机器上的守护进程）                       │
│  连接/心跳 · 领取循环 · worktree · Agent adapter · 转写缓冲│
└───────────────┬───────────────────────────────────────┘
                │ git worktree add
        ┌───────▼────────────────┐
        │ 用户已有 checkout        │
        │ ~/code/my-repo          │
        └───────┬────────────────┘
                │ spawn
        ┌───────▼────────────────┐
        │ Claude Code (ACP)       │
        └────────────────────────┘
```

## 4. 组件职责

### apps/web（Fastify 服务端 + React SPA 工程）

- 用户认证、单个 Workspace、成员；
- Repository、Task、Run、Attempt、Turn 持久化；
- Runner 配对、token、在线状态、能力目录；
- Attempt 领取（一条 SQL）、lease reaper、Agent 启动前自动重试；
- 状态事件和转写块的幂等接收、存储、实时转发；
- 审批请求和决定；
- Diff、patch、artifact 的元数据和 BlobStore；
- 审计；
- 生产环境 Fastify 同时托管 `apps/web/client` 的 Vite 构建产物（缓存头与 SPA fallback 见 [deployment.md](./deployment.md) §2.1）；阶段 4 公网部署时前置的反向代理只终止 TLS 并转发，不托管静态文件。

`apps/web/client` 是 React + TypeScript + Vite SPA；`apps/web/server` 是 Fastify 服务端。源码和状态边界分离；生产部署仍是一个 Fastify 进程、一个镜像。

不直接执行命令，不 SSH 到用户机器，不接触仓库凭据。

### apps/runner（守护进程）

- `agent-runner connect`：配对并保存 token；
- `agent-runner repo add <path>`：把本地已有 checkout 注册为仓库源；
- `agent-runner daemon`：维持 WebSocket，领取 Attempt，每 15 秒发 Attempt 心跳；
- 响应 `repository.resolve_ref`，在已注册 checkout 中解析 `baseRef`，不自动拉取远程仓库；
- 创建 worktree 和分支，启动 Agent adapter；
- 把 Agent 事件分成状态事件和转写块发送，本地缓冲未确认的部分；
- 处理追加 prompt、取消、审批结果、关闭；
- 每个 Turn 结束提交一次，生成 patch 并上传；
- 收到 stale 时杀掉进程树、停止上报、保留 worktree。

### 浏览器

- Task 看板；
- Run 详情：转写流、Turn 列表、每轮 Diff、追加输入框、审批卡片、取消和重试；
- Runner 列表和配对码；
- Repository 和 Agent Profile 管理。

## 5. 一个 Run 的生命周期

```text
用户创建 Run（提交 baseRef）
  ↓ 服务端通过 Runner WebSocket 请求 repository.resolve_ref
Runner 在本地 checkout 解析 commit（不 fetch）
  ↓ 服务端冻结 baseCommitSha，Attempt#1 queued
  ↓ NOTIFY → Runner 收到 work.available（或 30 秒轮询）
Runner 领取 → claimed
  ↓ worktree add + 新分支
preparing
  ↓ 启动 Agent session
idle ⇄ running（每个 Turn）
  │      └─ waiting_approval（Agent 请求权限，用户批准或拒绝后回到 running）
  ↓ 用户点"完成"，或 idle 超时
completed
```

异常出口：

- `failed`：Agent 启动前的不可重试错误，或 Turn 中的不可恢复错误；
- `canceled`：用户取消并被 Runner 确认；
- `lost`：Attempt 心跳超时，Runner 失联。

`failed`、`canceled`、`lost` 的 Run 可以由用户重试，产生新 Attempt，默认从上一次最后提交继续。完整状态机见 [domain-model.md](./domain-model.md)。

## 6. 仓库布局（目标）

```text
apps/
  web/
    client/         React SPA（Vite）
    server/         Fastify 服务端
  runner/           agent-runner 守护进程
packages/
  contracts/      zod schema：实体、消息、事件、错误码
  agent-adapters/ AgentAdapter 接口 + claude-code adapter
  git-worktree/   worktree 创建、提交、diff、清理
infra/
  local/          docker compose（postgres）
  production/     docker compose（web + postgres；阶段 4 加反向代理）
docs/
```

`apps/control-plane` 和 `packages/observability` 两个不再使用的 0.1 空目录已在首次实现中移除。

## 7. 技术选型

- 服务端：Node.js 22、TypeScript、Fastify、`ws`；
- 数据库：PostgreSQL 16，Kysely 或 Drizzle 类型化 SQL，SQL 文件迁移；
- 唤醒：`LISTEN/NOTIFY`；
- Blob：`BlobStore` 接口，阶段 1 本地磁盘实现，之后 S3 兼容实现；
- 生产入口：阶段 1 到 3 Fastify 直接监听（本机或内网）并托管静态文件；阶段 4 起前置反向代理只终止 TLS 并转发，首选 Caddy，Nginx 等价（ADR-025 修订）；
- 包管理与脚本：Bun workspace；Bun 只作为开发/构建工具，不作为服务端或 Runner 的生产运行时；需要安装脚本的依赖列入 `trustedDependencies`，CI 用 Node.js 22 冒烟（ADR-023 修订）；
- 前端：React 19、React Router 7（library 模式）、TanStack Query、Zustand（仅 UI 状态）、nuqs（react-router 适配器）、Tailwind v4、shadcn/ui（CLI 生成）、react-diff-view、`@tanstack/react-virtual`、react-markdown + shiki（ADR-026）；
- Runner：Node.js 22，`npm install -g` 单包发布；单文件分发在阶段 2 评估；
- Agent：ACP adapter，首个为 Claude Code；ACP 桥接不稳时用 Agent SDK 实现同一接口；
- Git：用户 checkout + `git worktree`；
- 校验：zod，共享于服务端、Runner 和前端；
- 测试：Vitest 假时钟；集成测试用 testcontainers 起 PostgreSQL；假 Agent adapter 用于协议测试；
- Circle 借鉴边界：[前端架构与 UI 借鉴方案](./frontend.md)；阶段 2 起逐组件重写，只借鉴视觉与交互，不采用其类型、Next.js 路由、mock 数据或状态层（ADR-024 修订）。

不使用：Redis、NATS、Kubernetes、CRDT、消息队列中间件、ORM 关系映射。

## 8. 相关文档

- [领域模型与状态机](./domain-model.md)
- [Runner 与 Agent 协议](./runner-agent-protocol.md)
- [领取、lease 与可靠性](./scheduling-reliability.md)
- [数据存储与事件](./data-and-events.md)
- [安全模型](./security.md)
- [部署](./deployment.md)
- [前端架构与 UI 借鉴方案](./frontend.md)
- [路线图](./roadmap.md)
- [决策记录](./decisions.md)
- [术语表](./glossary.md)
