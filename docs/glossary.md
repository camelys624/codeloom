# 术语表

| 术语 | 含义 |
|---|---|
| Workspace | 权限和资源边界。阶段 1 只有一个。 |
| Repository | 逻辑仓库，由 `remoteUrl` 识别。服务端不知道它在任何机器上的路径。 |
| Runner | 用户机器上的守护进程 `agent-runner`，主动连接服务端，领取并执行 Attempt。kind 为 `local` 或 `vps`；`cloud` 在阶段 5。 |
| RunnerRepository | 某个 Runner 对某个 Repository 的访问声明。路径只在 Runner 本地。 |
| Engine | 具体的 coding agent 产品：`claude-code`、`codex`、`custom`。 |
| Provider | 模型供应商，例如 Anthropic、OpenAI。一个 engine 可能接多个 provider。文档中除 `provider_rate_limit`、`provider_auth` 错误码外不使用该词。 |
| AgentProfile | 某台 Runner 上某个 engine 的安装与启动方式，含能力快照。 |
| AgentAdapter | Runner 内的代码模块，把一个 engine 接成统一接口。 |
| ACP | Agent Client Protocol，宿主与 coding agent 之间的协议。首选接入方式。 |
| Agent session | Runner 内进程级的 Agent 上下文，与 Attempt 一一对应。不是数据库实体。 |
| Task | 长期工作意图，有看板状态。 |
| Run | 用户针对 Task 发起的一次工作会话，冻结 spec。状态是当前 Attempt 的投影。 |
| Attempt | Run 在 Runner 上的一次实际执行，持有 worktree、分支和 Agent session。永不复用。 |
| Turn | Attempt 内一次 prompt 与响应，有自己的转写区间、usage、提交和 patch。 |
| FrozenRunSpec | Run 创建时冻结的执行规范。 |
| RunConfig | 用户可选的 Agent 运行配置：模型、权限模式、ToolPolicy、超时。 |
| ToolPolicy | 用户对 Agent 能力的请求。是否真正强制见 EnforcementReport。 |
| EnforcementReport | adapter 上报的每项 ToolPolicy 由谁强制：`runner`、`engine`、`none`。 |
| lease | Attempt 的存活租约，由 Runner 每 15 秒心跳维持，45 秒过期。 |
| reaper | 服务端定时任务，把 lease 过期的 Attempt 标为 `lost`。 |
| stale | 服务端对一条 Runner 消息的裁决：该 Attempt 已不是当前或已终态。Runner 收到后必须停止。 |
| 状态事件 | `run_events` 中的一条记录，表示状态变化。服务端分配 `sequence`。 |
| 转写块 | `transcript_chunks` 中的一条记录，含一批 Agent 输出 frame。Runner 分配 `chunkSeq`。 |
| frame | 转写块中的一个元素：`text_delta`、`tool_call` 等。 |
| clientSeq | Runner 为状态事件分配的 Attempt 内序号，用于幂等和缺口检测。 |
| outbox（Runner） | Runner 本地未被服务端 ack 的消息缓冲。 |
| BlobStore | 大对象存储接口。阶段 1 本地磁盘。 |
| Artifact | patch、文件或日志，存在 BlobStore，元数据在数据库。 |
| worktree | `git worktree add` 从用户 checkout 派生的隔离工作目录，每个 Attempt 一个。 |
| resumeFrom | 重试时新 Attempt 的起点：`base` 或上一个 Attempt 的最后提交。 |
| Vite | React SPA 的开发服务器、模块热更新和生产构建工具；不负责生产 API 或 Runner。 |
| Bun | 根目录的 JavaScript/TypeScript 包管理与脚本工具；本项目不依赖 Bun runtime 作为生产运行时。 |
| React SPA | 浏览器端单页应用。由 Vite 构建，生产由 Fastify 托管静态文件并提供 API/WebSocket。 |
| Circle | `~/study/circle` 中的 MIT License Linear 风格前端模板；只作为视觉与交互参考，阶段 2 起逐组件重写借鉴。 |
| 反向代理 | 阶段 4 公网部署时的入口，只终止 TLS 并转发 HTTP 与 WebSocket，不托管静态文件。首选 Caddy，Nginx 等价。 |
| UI 借鉴 | 参考 Circle 的视觉与交互，用本项目的 contracts、路由和数据层逐组件重写。不复制其类型、路由或 store。 |
| AttemptStream | 浏览器内存中一个 Attempt 的事件与转写缓冲，持有 `sequence` 与 `chunkSeq` 两个游标，负责缺口检测、去重与补拉。不是事实来源。 |
| 渲染段 | 前端把连续 frame 合并后的渲染单元：文本段、思考段、工具卡片等。与 `transcript_chunks` 的块无关。 |
