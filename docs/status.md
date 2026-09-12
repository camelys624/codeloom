# 实现状态与交接

- 日期：2026-09-10
- 对应文档：0.6 加 ADR-027
- 用途：接手剩余工作的人从这里开始。本文只讲"做了什么、验到什么程度、还剩什么"，设计依据看各专题文档。

## 1. 一句话状态

工具链、类型契约、数据库 schema、Fastify 服务端、Runner 守护进程、Vite React 前端和 Claude Code ACP 适配器已落地；类型、构建、契约、静态托管和 Git worktree 冒烟已通过。真实 Claude 门禁仍被上游 429/503 阻塞；PostgreSQL 集成测试因本机没有 Docker 或 `DATABASE_URL` 未运行。**已有可启动的阶段 1 竖切，但尚未完成生产验收。**

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
| CI | `.github/workflows/ci.yml` | 目录不是 git 仓库，CI 从未运行 | 未验证 |
| 本地 PostgreSQL Compose | `infra/local/compose.yml` | 需要 Docker | 未验证 |

### 2.2 `packages/contracts`

全部实体、状态机转换表、Runner 与浏览器两套 WebSocket 消息、REST 输入输出、`AgentAdapter` 接口，zod 4。

- 位置：`packages/contracts/src/`，入口 `index.ts`。
- 有界 JSON 校验 `isBoundedJson`（`validation.ts`）防循环引用、getter、深度与字节数，测试覆盖。
- 2026-09-10 变更（ADR-027）：`engine` 加 `pi`；新增 `AgentProtocol = 'acp' | 'sdk' | 'rpc'`。
- 验证：`packages/contracts/test/contracts.test.ts` 8 个测试，已验证。

### 2.3 `apps/web/server/db`

- `migrations/0001_initial.sql`：18 张业务表，租户复合外键贯穿所有表；部分唯一索引保证一个 Run 一个活动 Attempt、一个 AgentProfile 一个被领取的 Attempt；触发器锁死 Run 冻结 spec、终态 Attempt 和审计表；`updated_at` 自动维护。
- `migrate.ts`：advisory lock 加校验和，一个事务里应用全部待应用迁移并 bootstrap 首个 Workspace；可作 CLI（`bun run db:migrate`）或库函数调用。
- 2026-09-10 变更：`agent_profiles.engine` CHECK 加 `pi`。
- 验证：`migrate.test.ts` 8 个测试需要 Docker（Testcontainers）或 `DATABASE_URL`。本轮执行时 Testcontainers 报 `Could not find a working container runtime strategy`，因此数据库测试未运行；本机仍需接入 PostgreSQL 后重跑。

### 2.4 `packages/agent-adapters`

- `claude-code.ts`：真实 ACP 客户端，桥接固定 `@agentclientprotocol/claude-agent-acp@0.75.1`。完成 `initialize`、`session/new`、权限模式映射、按 `configOptions` 选模型、权限请求往返、取消、空闲超时、每 Turn 输出上限。
- `acp-transport.ts`：自写的严格 JSON-RPC 传输层，不用 SDK 的 connection（SDK 会把畸形消息原样打日志）。
- `process.ts`：基于 Linux `/proc` 的进程树监督与清理。**只支持 Linux。**
- `redaction.ts`：按 engine 的环境变量白名单 `ENGINE_ENV_ALLOWLIST`（2026-09-10 从 Claude 专用常量改来；`codex` 与 `pi` 的列表是占位）、按行脱敏 `RedactedLines`、结构化脱敏 `Redactor.json`。
- `fake.ts`：脚本化的 fake adapter，只从 `@agent-workspace/agent-adapters/fake` 导入，不进生产入口。
- `spike.ts`：ADR-018 门禁程序，`SPIKE_MODEL=opus bun run spike:acp`。
- 验证：`test/redaction.test.ts` 4 个、`test/claude-code.test.ts` 1 个（确定性 wire peer，Linux only），已验证。**真实门禁未通过**，见 ADR-018 实施记录。


### 2.5 `apps/web/server`

- `src/app.ts`：Fastify REST、session 认证、CSRF、单 Workspace、Repository、Runner 配对/token 轮换、AgentProfile、Task revision CRUD、Run/Attempt 创建与重试、领取、心跳、reaper、事件/转写幂等接收、审批、Runner/浏览器 WebSocket、artifact 本地 BlobStore、静态托管与 SPA fallback。
- `src/db.ts`、`src/mapping.ts`：事务、租户查询和契约实体映射。
- 验证：`bun run typecheck`、`bun run build`；无数据库时 fake Pool 路由冒烟通过，`GET /api/v1/me` 返回 401，静态 `/` 与 SPA fallback 返回 200，`index.html` 为 `no-cache`。

### 2.6 `apps/runner` 与 `packages/git-worktree`

- `apps/runner/src/cli.ts`：`connect`、`repo add`、`daemon`、`status`；凭据 0600、数据目录 0700。
- `apps/runner/src/daemon.ts`：Runner hello/status、领取、心跳、控制消息、Claude adapter、事件/转写 outbox、ack/nack 重发、stale 处理；持久化活跃 Attempt 元数据，重启后先提交 worktree 再发 `agent_crashed`。
- `packages/git-worktree/src/index.ts`：隔离 worktree、每 Turn commit、diff stats 和 unified patch。
- 验证：`bun run typecheck`；临时 git 仓库冒烟验证 worktree、commit、diff stats 和 patch；临时状态/outbox 冒烟验证并发写入、ack 和重启状态读取。

### 2.7 `apps/web/client`

- Vite + React 19 + React Router 7 + TanStack Query；登录、Task/Repository、Run、EnforcementReport、转写、审批、取消/完成/重试、每 Turn Diff、Runner 配对、Repository 与 AgentProfile 管理。
- `lib/stream.ts`：按 Attempt 的事件/转写游标、缓冲、顺序补拉与去重。
- 验证：Vite production build；Vite dev server 首页 HTTP 200。浏览器 daemon 不可用，未做 Chromium 视觉验证。
### 2.8 文档

0.6 全套加 ADR-027（多引擎接口面与接入顺序）。`check:contracts` 保证 domain-model.md 与 runner-agent-protocol.md 里的 ts 类型块与代码一致，改类型必须同时改文档。


## 3. 未完成

按依赖顺序排。W2 到 W4 的代码已落地，但数据库集成、真实引擎和阶段 1 完整验收仍未完成。

### W1 数据库测试跑通与环境

- 前置：无。
- 做：装 Docker 或提供 `DATABASE_URL`，跑 `bun run test` 全绿，`bun run db:migrate` 连跑两次第二次 `applied: []`；`git init`，首个提交，让 CI 真正跑一次。
- 当前：本机 Testcontainers 找不到容器运行时，8 个数据库测试未运行。
- 验收：CI 绿。

### W5 真实 Claude 门禁

- 入口：ADR-018、ADR-027。
- 做：上游恢复后跑 `SPIKE_MODEL=opus bun run spike:acp`，结果写入 ADR-018。Claude 上游一周内不恢复则改用 codex-acp 接 Codex 跑同一套门禁（需先写 Codex adapter，见 W6）。
- 依赖：无。
- 验收：roadmap 阶段 1 验收第 1、9 条。**fake adapter 跑通不算。**

### W6 第二个 engine（阶段 3，ADR-027）

- 前置：W5 有一个真实 engine 过门禁，W2、W3 成为 `AgentAdapter` 的真实调用方。
- 做：先把 `claude-code.ts` 拆成通用 ACP 会话加引擎 profile（模式名映射、`_meta` 选项、工具名提取、env 列表），再接 Codex（codex-acp 或 app-server，`protocol` 分别报 `acp` 或 `rpc`）；pi 最后，需要 pi extension 把工具调用转发到 Runner 才能满足 `permissionMode: 'ask'`。
- 做之前核对 `ENGINE_ENV_ALLOWLIST` 里 `codex` 与 `pi` 的占位列表。
- 门禁程序 `spike.ts` 按 engine 参数化，每个 engine 都跑 10 轮、权限往返、取消、清理。

## 4. 已知问题

本轮代码评审仍保留以下未解决项，按严重程度排。已完成项和验证边界见 §2，详细见 open-issues.md E 节。

1. ACP SDK 版本劈叉：适配器用 `@agentclientprotocol/sdk@0.14.1` 校验一个内部依赖 sdk `1.4.0` 的桥接，strict schema 遇到新字段会杀会话。W5 跑真实门禁时最可能在这里暴露。
2. `/proc` 全量扫描每会话每 100 毫秒一次，并发会话开销线性增长；双 fork 后 100 毫秒内被收养的进程会漏掉。
3. `claude-code.ts` 用正则从错误文本猜 `provider_auth` 与 `provider_rate_limit`。
4. `attempts_one_active_profile_idx` 意味着一个 Runner 只配一个 AgentProfile 时并发恒为 1，与 `max_concurrency` 的语义要在文档里说清。
5. Runner 重启后的活跃 Attempt 对账代码已实现，但尚未用 PostgreSQL/真实 WebSocket 完成端到端演练；该演练受 W1 环境阻塞。
6. W2 到 W4 的 PostgreSQL 集成和 fake adapter 场景未在本机执行；无 Docker 或 `DATABASE_URL` 时不能声称阶段 1 可靠性验收通过。

## 5. 接手第一天

```bash
bun install --frozen-lockfile
bun run build && bun run typecheck && bun run check:contracts && bun run format:check
bun run smoke:native
docker compose -f infra/local/compose.yml up -d
cp .env.example .env
bun run db:migrate && bun run db:migrate      # 第二次应输出 applied: []
bun run test                                  # 13 个单元测试 + 8 个 DB 测试
```

数据库可用并通过上述检查后，执行 W1 的双迁移和完整测试；再按 §3 处理 W5/W6。W2 到 W4 的代码入口和验证记录在 §2.5 到 §2.7。
