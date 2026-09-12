# Agent Workspace

面向小团队的 coding agent 任务台：在一个 Web 应用中登记仓库、创建任务、选一台自己的机器发起 Run，在浏览器里看转写、批准权限、追问、查看每轮 Diff。

## 目标

- 用户端只有一个 Web 应用；开发环境使用 Vite，生产环境由 Fastify 同时托管 Vite 构建的 React SPA 与 API/WebSocket，阶段 4 公网部署时前置反向代理只终止 TLS；服务端是一个 Node 进程加 PostgreSQL。
- Bun 负责 monorepo 的依赖安装和脚本执行；生产服务端与 Runner 使用 Node.js 22，不依赖 Bun runtime API。
- Runner 是用户机器上的守护进程，主动出站连接，使用用户已有的 git checkout 和凭据。
- 每个 Attempt 一个隔离 git worktree 和分支，每个 Turn 提交一次。
- 多轮对话是核心：Run 由若干 Turn 组成，用户随时追问。
- 通过 ACP 接入 Claude Code，之后接 Codex、pi 和自定义 Agent；每个 engine 走它最稳的协议（ACP、SDK 或 engine 原生 RPC），业务层只看 `AgentAdapter` 接口。
- Agent 启动后不自动重试；失败和失联只通知用户，用户从最后提交继续。
- 不用 Redis、NATS、Kubernetes、CRDT。

## 文档（0.6，2026-09-06）

- [总体架构](./docs/architecture.md)
- [领域模型与状态机](./docs/domain-model.md)
- [Runner 与 Agent 协议](./docs/runner-agent-protocol.md)
- [领取、lease 与可靠性](./docs/scheduling-reliability.md)
- [数据存储与事件](./docs/data-and-events.md)
- [安全模型](./docs/security.md)
- [前端架构与 UI 借鉴方案](./docs/frontend.md)
- [部署](./docs/deployment.md)
- [决策记录](./docs/decisions.md)
- [术语表](./docs/glossary.md)
- [评审问题与处理结果](./docs/open-issues.md)
- [实现状态与交接](./docs/status.md)

## 当前实现状态

详见 [实现状态与交接](./docs/status.md)。摘要：

已落地并通过基线自动化检查（2026-09-10）：

- Bun workspace、Node.js 22 / TypeScript 构建、锁文件、CI 定义和 argon2id 原生模块冒烟；
- `packages/contracts`：实体、状态机、事件、消息、REST 游标/快照及 Agent 接口；`check:contracts` 对照文档中的 36 个类型；engine 含 `claude-code | codex | pi | custom`，协议含 `acp | sdk | rpc`（ADR-027）；
- `apps/web`、`apps/runner` 与 `packages/git-worktree`：Fastify API、Runner 守护进程、React SPA、隔离 worktree 和每 Turn patch 链路已落地；创建 Run 时浏览器提交 `baseRef`，服务端通过 Runner 在本地 checkout 解析并冻结 `baseCommitSha`；
- `packages/agent-adapters`：真实 Claude ACP 客户端、门禁程序、按 engine 的环境变量白名单、隔离于生产入口的 fake adapter，以及协议/脱敏回归测试。

**尚不是可使用的完整任务台。** ACP 已握手并建立会话，但当前配置上游在真实第 1 轮返回 `429 Service Unavailable`，直接 API 探测返回 503。门禁未通过；当前服务端、Runner 守护进程和 Web UI 已有最小竖切，但 PostgreSQL 集成测试、真实引擎验收和生产验收仍未完成。当前进程树监督仅支持 Linux。实测经过与限制见 [ADR-018](./docs/decisions.md#adr-018acp-优先agent-sdk-回退)，多引擎接入顺序见 [ADR-027](./docs/decisions.md#adr-027多引擎的接口面先于第二个-adapter)。

### 运行已有实现

需要 Node.js 22、Bun 和 PostgreSQL 16。没有全局 Bun 时，可以用 `npm exec --yes --package=bun -- bun <命令>` 运行下面的 Bun 命令。

```bash
bun install --frozen-lockfile
bun run build
bun run smoke:native
bun run check:contracts

# 将 .env.example 复制为 .env；本地示例配置与 Compose 一致
docker compose -f infra/local/compose.yml up -d
bun run db:migrate
bun run test

# 使用 Runner 机器上的已有 Claude 登录或已配置提供方环境
# 需要上游可用；会调用真实模型，不使用 fake adapter
SPIKE_MODEL=opus bun run spike:acp
```

`DATABASE_URL` 指向现有 PostgreSQL 时，数据库测试使用独立随机 schema，不改业务数据；未设置时使用 Testcontainers 启动 PostgreSQL 16，需要 Docker。`.env` 与凭据不得提交。

门禁在系统临时目录建立独立 git 仓库，不修改项目 checkout；验证连续 10 轮上下文、批准前无工具副作用、真实权限往返、取消和子进程清理。普通 `test` 中的确定性 ACP wire peer 仅用于回归，不能代替此门禁。

## 仓库布局（目标）

```text
apps/
  web/
    client/         React SPA（Vite）
    server/         Fastify 服务端
  runner/           agent-runner 守护进程
packages/
  contracts/        zod schema，所有类型的权威
  agent-adapters/   AgentAdapter 实现
  git-worktree/     worktree 操作
infra/
  local/            docker compose（postgres）
  production/       docker compose（web + postgres；阶段 4 加反向代理）
```

根目录使用 Bun workspace；Vite 只负责 `apps/web/client` 的前端开发与构建。

`apps/control-plane` 和 `packages/observability` 两个 0.1 遗留空目录已移除。

## 边界

阶段 1 到 4 不做：云端 Worker、多仓库 Task、自动委托、Runner 候选池、多实例服务端、CRDT。

阶段 1 只做最小 UI 和一个 Fastify 进程：前两天先做 ACP spike 门禁，Circle 借鉴在阶段 2，反向代理与 TLS 在阶段 4。

本设计吸收了 Lody 和 Cumora 两个项目的经验，但不复制其实现。
