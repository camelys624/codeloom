# 路线图

- 状态：Accepted（阶段 1 基线）
- 版本：0.6
- 日期：2026-09-06
- 变更：0.6 阶段 1 前两天设 ACP spike 门禁；Circle 借鉴移到阶段 2；反向代理与 TLS 移到阶段 4；补前端数据层验收。见 [open-issues.md](./open-issues.md) D 节。

## 阶段 1：竖切（约 2 周）

目标：一个用户在自己的机器上连接 Runner，创建 Task，发起 Run，在浏览器里看到首个真实 engine（当前为 Pi）的转写，批准一次权限，追问一句，看到两轮 Diff，点完成。Claude Code ACP 是独立可选 engine，受外部上游可用性影响，不阻塞阶段 1 的 Pi 竖切验收。

### 第 1 到 2 天：ACP spike（门禁）

- 用 `claude-code` adapter 的原型直接驱动 Claude Code 的 ACP 桥接，输出打到终端或一个只有 `<pre>` 的页面；不接数据库，不接 UI；
- 验证：连续 10 个 Turn、权限请求往返、取消、进程退出后的清理；
- 第 2 天结束前把结论写入 ADR-018：达标则继续 ACP；不达标则用 Agent SDK 实现同一 `AgentAdapter` 接口，`capabilities.protocol` 报 `sdk`；
- 门禁之前其余人只做 `packages/contracts` 与数据库迁移，不动 adapter 以外的 Runner 代码。

### 其余实现

- `packages/contracts`：全部实体、消息、事件、错误码的 zod schema；
- 数据库迁移：[data-and-events.md](./data-and-events.md) §2 全部表；
- 工具链：Bun workspace、`trustedDependencies` 与 Node.js 22 原生模块冒烟（ADR-023 修订）、Vite SPA 构建、CI；
- 服务端：注册与登录、单 Workspace、Repository、Runner 配对与 token、AgentProfile、Task CRUD、Run 创建、领取 SQL、心跳与 reaper、事件与转写块的幂等接收、审批、`LISTEN/NOTIFY`、浏览器 WS、artifact 上传、本地 BlobStore、`@fastify/static` 托管 `dist/client`（缓存头与 SPA fallback，[deployment.md](./deployment.md) §2.1）；
- Runner：`connect`、`repo add`、`daemon`、领取循环、worktree 与分支、每 Turn 提交与 patch、outbox 与重连对账、`stale` 处理、`claude-code` adapter（ACP 或 SDK，由门禁决定）；
- 前端：Vite SPA、React Router、TanStack Query、`AttemptStream` 数据层（[frontend.md](./frontend.md) §3.3）；最小 UI：登录、Task 列表与详情、创建 Run（含 EnforcementReport 展示）、Run 详情（转写渲染段、审批卡片、追问、停止这一轮、取消、重试、完成、每 Turn Diff）、Runner 配对页、Repository 与 AgentProfile 管理；shadcn/ui 默认样式，不做视觉打磨；
- `fake` adapter 与集成测试：[scheduling-reliability.md](./scheduling-reliability.md) §11 全部场景，加浏览器数据层的断线补拉场景。

不做：多仓库 Task、自动委托、云端 Worker、PR 创建、Task 看板拖拽、评论、多实例；Circle 借鉴（阶段 2）；反向代理与 TLS（阶段 4）；Diff 语法高亮、转写搜索；Circle 中的 Initiatives、Cycles、Documents、Triage 等非核心功能不进入任何阶段的计划。

验收：

- 首个真实 engine（Pi）门禁结论在阶段 1 退出前写入 ADR-018；Claude ACP 外部依赖单独记录；
- 同一 Attempt 不会被领取两次；
- Runner 断网 45 秒以上 Run 变 `lost`，用户从 `last_commit` 重试成功；
- Runner 进程重启后 Attempt 变 `failed`，worktree 中的改动已提交；
- 服务端重启后浏览器与 Runner 自动恢复，无重复事件；
- 浏览器断线 30 秒后自动重连，事件与转写无缺口、无重复，快照与游标对账通过（[frontend.md](./frontend.md) §3.3）；
- 取消在 20 秒内终止进程树；
- 用户的原始 checkout 在全部测试后没有任何变化；
- Pi adapter 完成 10 个 Turn、权限往返和取消。
- 用户浏览器验收通过基础生命周期、EnforcementReport、多轮追问、每 Turn Diff、权限批准/拒绝、审批等待、取消、完成、重试、断线重连、事件/transcript 无缺口无重复和硬刷新恢复；
- patch artifact 对重复内容上传幂等，不因相同 patch SHA 使 Attempt 失败。

## 阶段 2：完整 Run 体验与可靠性打磨

- Circle 借鉴：应用壳、Sidebar、主题、Command Palette、列表/看板、筛选 chips，逐组件重写（ADR-024 修订、[frontend.md](./frontend.md) §5）；
- Task 看板（列拖拽）、筛选、优先级；
- Run 时间线（事件 + Turn）；
- 转写回放、搜索、下载；
- 每 Turn Diff 的文件树视图、整 Run 累积 Diff、Diff 语法高亮；Diff 性能验收与库切换判定（ADR-026）；
- Runner 状态页：负载、活跃 Attempt、stale 记录、worktree 占用；token 轮换 UI、Runner draining；**已完成**。
- Runner 单文件分发评估（Node SEA 或 `bun build --compile`）；
- 转写归档任务、worktree 清理任务；
- `/metrics` 与告警规则；
- 混沌测试：随机杀 Runner、服务端、网络，验证不变量。

## 阶段 3：结果落地

- 从 Run 创建分支推送与 PR（Runner 执行 `git push`，用用户凭据；PR 通过 `gh` 或 provider API，token 存在 Runner 侧）；
- Task 与 PR 关联，PR 合并触发 `needs_review → done`；
- Task 评论；
- Task 模板与 RunConfig 预设（取代 0.1 的 AgentRole）；
- 第二个 adapter：第一个真实 engine 过门禁后先拆通用 ACP 会话与引擎 profile，再接 Codex（codex-acp 或 app-server）；pi（RPC 模式，权限需 extension）放最后，见 ADR-027。

## 阶段 4：第二台机器与公网部署

- 公网部署：反向代理终止 TLS（Caddy 首选，Nginx 等价），证书自动续期，`TRUST_PROXY`（ADR-025 修订、[deployment.md](./deployment.md) §2.2）；
- VPS Runner 安装文档与 systemd 单元；
- Runner 能力对比视图；
- Runner 离线时的 Run 迁移：取消后在另一台 Runner 新建 Run 并从指定 commit 开始；
- 多用户：邀请、成员管理、按用户过滤。

## 阶段 5：云端 Worker

- 从阶段 1 到 4 的代码中抽取 Runtime 抽象；
- `cloud` kind Runner：容器镜像、bare clone 缓存、短期 git 凭据、容器级 ToolPolicy 强制；
- 每 Run 一个容器；
- 对象存储 BlobStore；
- 多实例服务端。

## 之后（按需求排序）

- RunnerPolicy 候选池与 cloud fallback；
- 自动委托与后台触发；
- 多 Agent review；
- 多仓库 Task；
- 成本预算；
- CRDT 文档协作。

## 里程碑

- **M1**：阶段 1 验收通过。
- **M2**：阶段 2 混沌测试连续 24 小时不违反不变量。
- **M3**：第一个从 Run 产生的 PR 被合并。
- **M4**：第二台机器上的 Runner 完成一个 Run，且服务端已在公网 VPS 上以反向代理部署。
- **M5**：一个 Run 在云端容器中完成。

## 每阶段验收原则

- 所有状态转换由服务端表驱动约束，见 [domain-model.md](./domain-model.md) §12；
- 所有跨进程消息有 zod schema，服务端和 Runner 都校验；
- 所有写接口幂等；
- 所有异步流程有重连和重启路径，包括浏览器数据层；
- 所有失败显式可见，没有静默降级；
- 所有测试用注入时钟。
