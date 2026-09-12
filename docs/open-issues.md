# 架构评审：问题清单与处理结果

- 评审日期：2026-09-03 的 0.1 评审；2026-09-06 的前端工具链补充评审（0.3 到 0.5）；2026-09-06 的 0.5 前端与部署评审；2026-09-10 的首批代码评审
- 处理版本：文档 0.6 加 ADR-027
- 状态：0.1 的 17 项中 15 项已在 0.2 中解决，2 项推迟；0.3 新增前端工具链和 UI 来源决策，0.4 新增 Nginx 决策，0.5 对齐版本；0.5 评审的 6 项中 5 项在 0.6 中解决，1 项不属于文档；代码评审 7 项中 1 项已解决，其余归入交接工作包

0.1 的原始标注已随文档重写移除。本文保留作为决策依据。

---

## A. 模型与状态机

### I-01 Run 与 Attempt 状态机混在一起 — 已解决

Run 状态改为当前 Attempt 的投影（8 值），细粒度阶段只在 Attempt 上。`RunStatus`、`AttemptStatus`、`TurnStatus`、`TaskStatus` 全部定义，Attempt 和 Task 各有完整转换表。`expired`、`needs_attention`、`stale`、`lost` 中只保留 `lost` 作为状态，`stale` 改为对消息的裁决。`created`、`accepted`、`queued` 合并为 Attempt 的 `queued`。见 [domain-model.md](./domain-model.md) §8、§9、§12。

### I-02 Runner 是冻结的还是可调度的 — 已解决

阶段 1 Runner 固定，`RunnerPolicy` 删除，M4 改为"第二台机器完成一个 Run"，Runner 离线时的迁移为"取消后在另一台新建 Run"。见 ADR-006 修订。

### I-03 push 与 pull 并存 — 已解决

只保留 pull。见 ADR-013、[runner-agent-protocol.md](./runner-agent-protocol.md) §6。

### I-04 fencing token — 已解决

删除。attemptId 即排他标识，服务端校验"当前 Attempt 且非终态"，否则 `attempt.stale`。见 ADR-014。

### I-05 lease 无续约 — 已解决

Attempt 心跳 15 秒，lease 45 秒，审批期间照常心跳，Runner 收到 `stale` 的强制动作已定义。见 ADR-014、[scheduling-reliability.md](./scheduling-reliability.md) §5。

### I-06 事件序号作用域 — 已解决

游标全部按 Attempt：`events?after=<sequence>`、`transcript?afterChunk=<chunkSeq>`。服务端分配 `sequence`，Runner 的 `clientSeq` 只用于幂等和缺口检测。缺口处理选定为 nack 加重发。见 [data-and-events.md](./data-and-events.md) §5、§9。

### I-07 类型与表悬空 — 已解决

全部类型在 [domain-model.md](./domain-model.md) 中定义并声明以 `packages/contracts` 为权威；全部表带字段。多仓库字段删除，阶段 1 单仓库。

## B. 产品层

### I-08 无多轮对话 — 已解决

新增 Turn 实体、`attempt.prompt` 消息、`turn.*` 事件、`idle` 状态。见 ADR-016。

### I-09 重试语义 — 已解决

启动前自动重试最多 3 次；启动后只由用户重试，默认从 `last_commit` 继续；分支按 Attempt 命名；每 Turn 提交。见 ADR-015。

### I-10 仓库 clone 归属 — 已解决

用户已有 checkout 作为源，`agent-runner repo add`，凭据用用户自己的。见 ADR-017。

### I-11 审批阶段 — 已解决

最小审批进阶段 1。见 ADR-021。

### I-12 text_delta 逐条落库 — 已解决

转写按块写 `transcript_chunks`。见 ADR-020。

### I-13 ToolPolicy 可执行性 — 已解决

请求与强制分离，`EnforcementReport` 如实展示。见 ADR-022。

## C. 文档工程

### I-14 ADR 无备选方案 — 已解决

全部 ADR 补备选方案和风险；新增 ADR-011 到 ADR-026。

### I-15 Redis 还是 NATS — 已解决

都不用。见 ADR-012。

### I-16 术语 — 已解决

新增 [glossary.md](./glossary.md)，删除外部项目黑话。

### I-17 小型不一致 — 已解决

access 统一为 `read | write`；能力统一为结构化 `AgentCapabilities`；token 模型改为单一 `runnerToken` 加轮换；AgentRole 删除；`worktreePolicy` 删除；路线图阶段 4 该条删除。

## D. 0.5 前端与部署评审（2026-09-06）

评审对象：0.3 到 0.5 新增的 ADR-023、ADR-024、ADR-025 与 frontend.md。评审时 `apps/`、`packages/`、`infra/` 为空，无 package.json 与 lockfile，目录不是 git 仓库。

### I-18 阶段 1 交付膨胀，验收未变 — 已解决

Nginx 托管与 Circle 移植进入阶段 1 交付清单，但七条验收全是后端可靠性指标，没有一条用到它们；头号风险 ACP 桥接（ADR-018）在本轮更新中无进展。处理：阶段 1 前两天设 ACP spike 门禁并写入验收；Circle 借鉴移到阶段 2；反向代理移到阶段 4。见 [roadmap.md](./roadmap.md)。

### I-19 Circle "移植"高估复用面 — 已解决

抽样核对显示业务组件类型来自 `mock-data`、路由依赖 Next、Diff 视图无解析、领域与本项目基本不重合。处理：ADR-024 修订为"借鉴与逐组件重写"，列出真实可复用面与第三方库清单，eslint 禁止相关 import。见 [frontend.md](./frontend.md) §5。

### I-20 前端四项核心决策缺失 — 已解决

路由（此前只在 Nginx 样例注释里出现过 React Router）、客户端数据层与断线补拉、Diff 渲染、转写虚拟化与 markdown 均未决策。处理：新增 ADR-026，算法与阈值写入 [frontend.md](./frontend.md) §3.3、§4；快照补 `lastSequence`、`lastChunkSeq`，转写补 `beforeChunk` 翻页，见 [data-and-events.md](./data-and-events.md) §5。

### I-21 Nginx 阶段 1 用不上，样例够不上生产 — 已解决

无 TLS 签发续期方案且证书缺失时 Nginx 起不来；`index.html` 无 `no-cache` 会在发版后白屏；Fastify 未开 `trustProxy`；Compose 中拉取镜像 tag 0.4 与宿主机构建的前端产物版本耦合靠人工。处理：ADR-025 推迟到阶段 4 并改为"代理只终止 TLS，静态文件由 Fastify 托管"，五条代理规则与 Caddy/Nginx 样例见 [deployment.md](./deployment.md) §2。

### I-22 Bun 安装脚本与 Runner 安装矛盾 — 已解决

Bun 默认不执行未信任依赖的安装脚本，原生模块（argon2 等）风险未点名；`bun add -g` 安装 Runner 要求用户机器装 Bun，与"Runner 只依赖 Node.js 22"矛盾。处理：ADR-023 修订，`trustedDependencies` 与 CI 冒烟、Runner 改 `npm install -g`、单文件分发阶段 2 评估、一个工作日修不好切 pnpm。

### I-23 空目录与非 git 仓库 — 不属于文档，待执行

`apps/control-plane`、`packages/observability` 文档已标注可删除但仍存在；目录不是 git 仓库，版本间无法 diff。处理：由团队执行 `rmdir` 与 `git init`，本轮文档更新不改文件系统。

2026-09-07 实施更新：已移除两个遗留空目录，建立 workspace、锁文件、contracts、数据库迁移和 ACP 门禁程序；未自动执行 `git init`。真实 ACP 验证受当前上游服务不可用阻塞，记录见 ADR-018。

## E. 2026-09-10 代码评审

评审对象：2026-09-07 落地的 `packages/contracts`、`apps/web/server/db`、`packages/agent-adapters`。类型检查、单元测试、契约对照、格式检查通过；数据库测试因本机无 Docker 未运行。多引擎决策见 ADR-027，交接清单见 [status.md](./status.md)。

### I-24 ACP SDK 版本劈叉 — 未解决

适配器固定 `@agentclientprotocol/sdk@0.14.1` 并从 `dist/schema/zod.gen.js` 内部路径导入 strict schema，而桥接 `claude-agent-acp@0.75.1` 自身依赖 sdk `1.4.0`，锁文件里两份并存；协议版本检查只有 `=== 1`。桥接发出 0.14.1 未定义的字段时会被判 `Invalid ACP session update` 终止会话。处理：W5 跑真实门禁时优先排查；考虑升级到与桥接一致的 sdk 大版本，或对 `session/update` 用非 strict 解析并只校验用到的字段。

### I-25 进程树监督的开销与漏网 — 未解决

`process.ts` 每会话每 100 毫秒读一遍全机 `/proc/*/stat`，N 个并发会话 N 倍开销；只靠进程组与父链追踪，双 fork 后 100 毫秒内被 init 收养的进程会漏掉。处理：阶段 2 评估 cgroup 或 `prctl(PR_SET_CHILD_SUBREAPER)`；阶段 1 在 Runner 状态页如实显示扫描代价。

### I-26 错误分类靠正则 — 未解决

`claude-code.ts` 用 `/auth|login|api.?key|401|403/i` 判 `provider_auth`，任何含 `author` 的报错会被误分类。处理：优先用 ACP 错误码与桥接 `_meta`，正则只作最后回退并缩窄。

### I-27 Run 状态双写无约束 — 已实现，待集成验证

`runs.status` 独立存储，contracts 的 `RUN_STATUS_BY_ATTEMPT` 是投影规则，一致性完全靠服务端在同一事务里维护。`apps/web/server/src/app.ts` 已把 Attempt 状态变更与 Run 投影放入同一事务路径；PostgreSQL 集成测试仍需 W1 环境验证。

### I-28 Profile 并发恒为 1 — 文档待补

`attempts_one_active_profile_idx` 是有意设计（一个 AgentProfile 同时只跑一个 Attempt），但意味着一台 Runner 只配一个 Profile 时 `max_concurrency` 无论设多少都是 1。处理：domain-model.md §5 补一句说明，UI 创建 Profile 时提示。

### I-29 `apps/web` 非 workspace 成员 — 已解决

本轮已新增 `apps/web/package.json`，并将 Fastify 服务端、Vite client、Runner 与 git-worktree 加入 Bun workspace；应用依赖不再依赖根目录代挂。

### I-30 `auto_retry_count` 误删已恢复 — 已解决

2026-09-10 评审时误把 `runs.auto_retry_count` 当成与"启动后不自动重试"矛盾的死字段删除。该列服务于 ADR-015 的启动前自动重试（最多 3 次）。已恢复并在列上加注释，ADR-027 记勘误。

### I-31 Runner 重启对账 — 已实现，待集成验证

守护进程已将活跃 Attempt 元数据写入 `state/attempts/*.json`，并在重连后先提交 worktree，再发送 `attempt.failed`（`agent_crashed`）；outbox 写入、ack 和状态文件写入已串行化。仍需在 PostgreSQL/真实 WebSocket 环境演练。

### I-32 阶段 1 数据库验收 — 环境阻塞

服务端、Runner 和前端代码已落地，但 PostgreSQL/Testcontainers 未在本机运行。接入 Docker 或 `DATABASE_URL` 后，必须重跑迁移双跑、数据库测试和 scheduling-reliability.md §11 场景。

---

## 推迟项

| 项 | 归属 | 触发条件 |
|---|---|---|
| RunnerPolicy 候选池与 cloud fallback | 阶段 5 之后 | 有两台以上 Runner 且用户要求自动改派 |
| 云端 Worker 的 Runtime 抽象、bare clone 缓存、Token Broker、容器强制 | 阶段 5 | 阶段 1 到 4 完成 |

## 新的已知风险（0.6）

- ACP 桥接成熟度：ADR-018 给出验证标准和回退；阶段 1 前两天门禁。
- 单进程服务端：阶段 5 前是单点，协议已为多实例留口。
- `gitPush` 无法在本地 Runner 强制：如实展示，管理员可禁用 `bypass` 模式。
- Runner 重启等于 Agent session 丢失：不假装恢复，用户从最后提交重试。
- Bun 默认不执行未信任依赖的安装脚本：原生模块列入 `trustedDependencies`，CI 用 Node.js 22 冒烟；一个工作日修不好切 pnpm（ADR-023 修订）。
- Circle 借鉴可能带入 mock 类型与 Next 依赖：eslint `no-restricted-imports` 强制，阶段 2 验收（ADR-024 修订）。
- 浏览器数据层的订阅、快照与补拉顺序是新的复杂点：算法固定在 frontend.md §3.3，进入阶段 1 验收（ADR-026）。
- 反向代理阶段 4 才引入：TLS 续期、`trustProxy`、超时与上传上限的要求已写入 deployment.md §2.2，引入时按清单验收。
