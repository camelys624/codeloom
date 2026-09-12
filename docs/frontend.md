# 前端架构与 UI 借鉴方案

- 状态：Accepted（阶段 1 基线）
- 版本：0.6
- 日期：2026-09-06
- 关联决策：[decisions.md](./decisions.md) ADR-023、ADR-024、ADR-025、ADR-026
- 变更：0.6 根据 0.5 评审（[open-issues.md](./open-issues.md) D 节）补齐路由、数据层、Diff 与转写渲染四项决策；Circle 由"移植"改为"借鉴与逐组件重写"并移到阶段 2；生产静态文件改由 Fastify 托管，反向代理推迟到阶段 4。

## 1. 决策摘要

| 项 | 决策 | 依据 |
|---|---|---|
| 构建 | React 19 + TypeScript + Vite；Tailwind v4（`@tailwindcss/vite`）；shadcn/ui 用 CLI 生成 | ADR-023、ADR-026 |
| 包管理 | Bun workspace 安装依赖与执行脚本；生产运行时 Node.js 22 | ADR-023 |
| 路由 | React Router 7，library 模式（`createBrowserRouter`），无 SSR；筛选、排序、视图等 URL 参数用 nuqs 的 react-router 适配器 | ADR-026 |
| 服务端数据 | TanStack Query 持有 REST 快照与变更；每个打开的 Attempt 一个内存 `AttemptStream` 持有事件与转写游标 | ADR-026 |
| 实时 | 浏览器 WebSocket `/ws/client`；消息只做两件事：使快照 query 失效、向 `AttemptStream` 追加 | ADR-026、§3.3 |
| Diff | react-diff-view 解析 unified diff，按文件懒渲染；不达标切 `@git-diff-view/react` | ADR-026、§4.1 |
| 转写 | `@tanstack/react-virtual` 虚拟列表；frame 合并为渲染段；react-markdown + remark-gfm；shiki 按需加载 | ADR-026、§4.2 |
| 表单 | react-hook-form + `@hookform/resolvers/zod`，直接复用 `packages/contracts` 的 schema | ADR-026 |
| 生产托管 | Fastify 托管 `dist/client`；阶段 4 前置反向代理只终止 TLS，不托管静态文件 | ADR-025 修订 |
| Circle | 视觉与交互参考，阶段 2 起逐组件重写；不复制类型、路由、store | ADR-024 修订 |

Vite 负责开发服务器与构建，Bun 负责安装与脚本，Node.js 22 运行服务端与 Runner。三者职责不重叠。

## 2. 目标目录

```text
apps/web/
  client/                    React SPA（Vite）
    index.html
    src/
      app/                   路由表、应用壳、错误边界、认证引导
      components/            通用 UI（shadcn/ui 生成物）与布局
      features/
        tasks/               Task 列表、详情、创建 Run 表单
        runs/                Run 详情、Turn 列表、审批卡片、追问输入
          transcript/        渲染段、虚拟列表、markdown
          diff/              patch 解析、文件树、逐文件渲染
        runners/             Runner、配对码、AgentProfile
        repositories/        Repository 管理
      lib/
        api/                 REST client（fetch 封装 + contracts 校验）
        ws/                  WebSocket client（重连、订阅、缓冲）
        stream/              AttemptStream：游标、缺口检测、补拉
        format/              时间、大小、token 格式化
      stores/                仅 UI 状态（侧栏、主题、面板、草稿）
    vite.config.ts
  server/                    Fastify 服务端
    src/
      api/                   REST 路由
      ws/                    浏览器和 Runner WebSocket
      services/              领域服务、领取、reaper、审计
      storage/               PostgreSQL 与 BlobStore
      static.ts              dist/client 托管：缓存头、SPA fallback
      main.ts
  dist/
    client/                  Vite 构建产物，生产由 Fastify 托管
    server/                  Fastify 编译产物

packages/contracts/          服务端、Runner、前端共享的 Zod 契约
```

`apps/web` 是一个可部署单元，client 和 server 在源码层分开。前端不能直接访问数据库、文件系统或 Runner；所有事实数据通过 REST 快照、REST 补拉和客户端 WebSocket 获取。

## 3. 数据与状态边界

### 3.1 服务端状态是唯一事实

Task、Run、Attempt、Turn、事件、转写、审批和 Runner 状态都来自服务端。浏览器刷新或重连时必须重新获取快照，并按 Attempt 游标补拉事件和转写。

前端状态只承担以下职责：

- 弹窗、侧栏、主题、当前视图等 UI 状态（Zustand）；
- URL 中的筛选、排序和视图参数（nuqs）；
- 已从服务端获取的数据缓存（TanStack Query）；
- 每个打开的 Attempt 的事件与转写缓冲（`AttemptStream`，内存）；
- 输入框草稿和乐观 UI 状态。

前端不得把 Zustand、localStorage 或内存数组当作持久化事实，也不得在客户端自行推进 Run/Attempt 状态机。

### 3.2 类型边界

所有 API 响应、WebSocket 消息和跨包实体使用 `packages/contracts` 中的 schema 校验，校验失败视为协议错误并上报，不静默吞掉。React 组件依赖可序列化的领域类型，不把图标组件、函数或 mock 对象放进实体数据。

eslint `no-restricted-imports` 禁止 `@/mock-data/*`、`next/*`、`nuqs/adapters/next*`。

### 3.3 Run 页的加载、订阅与补拉

这是前端最容易出错的部分，顺序固定如下，并进入阶段 1 验收。

打开 Run 页：

1. 建立或复用 `/ws/client` 连接，发送 `subscribe { runId }`，从此刻起把收到的 `event` 与 `transcript` 消息按 `attemptId` 放入缓冲，暂不渲染；
2. `GET /api/v1/runs/{runId}` 取快照：Run、Attempts、Turns、pending 审批，以及每个 Attempt 的 `lastSequence` 与 `lastChunkSeq`；
3. 为当前 Attempt 创建 `AttemptStream`，`GET /attempts/{id}/events?after=0` 取全部状态事件（每个 Attempt 几十条），`GET /attempts/{id}/transcript?beforeChunk=<lastChunkSeq+1>&limit=200` 取转写尾部；事件游标设为已收到的最大 `sequence`，转写游标设为 `lastChunkSeq`；
4. 排空缓冲：`sequence` 或 `chunkSeq` 小于等于对应游标的丢弃，其余按序追加；
5. 进入 live。

live 期间：

- 每条 `event` 若 `sequence == 游标 + 1` 则追加并推进游标；若大于则先把它放回缓冲，`GET events?after=<游标>` 补拉后再排空缓冲；小于等于则丢弃；
- `transcript` 消息对 `chunkSeq` 用同一规则，补拉用 `transcript?afterChunk=<游标>&limit=200`，分页直到追平；
- 状态事件到达后使该 Run 的快照 query 失效并重拉（见 §3.4）；转写块不触发失效；
- `run` 消息中 `currentAttemptId` 变化（用户重试产生新 Attempt）时，为新 Attempt 新建 `AttemptStream`，游标从 0 开始，按步骤 3 加载；旧 Attempt 的流保留为只读。

断线重连：

- WebSocket 断开后以指数退避重连（1 秒起，上限 30 秒，带抖动）；
- 重连后重新 `subscribe` 并开始缓冲，重拉快照，`events?after=<事件游标>`、`transcript?afterChunk=<转写游标>` 补拉，排空缓冲，进入 live；不重新拉整份转写；
- 页面在后台超过 5 分钟再回到前台时按重连处理。

去重规则只有两条：`(attemptId, sequence)` 与 `(attemptId, chunkSeq)`；小于等于游标的丢弃。前端不做任何基于时间戳的判断。

查看历史 Attempt：按需用同一组 REST 接口加载，不订阅 live。

### 3.4 状态事件如何进入 UI

状态事件不在客户端解释为状态转换。收到任何 `event` 后，使该 Run 的快照 query 失效，由 TanStack Query 重新拉取 Run、Attempts、Turns 与 pending 审批。快照小、事件每 Attempt 几十条，代价可接受，且客户端永远显示服务端算出的状态。

事件本身进入 `AttemptStream`，供时间线显示。阶段 2 若快照变大，再改为精确 patch 缓存。

### 3.5 认证引导

session cookie 是 HttpOnly，前端读不到。应用启动先请求 `GET /api/v1/me`，401 则进入登录页；所有状态变更请求带同源 `Origin`，由服务端做 CSRF 校验。

## 4. Diff 与转写渲染

### 4.1 Diff

- 输入：Turn 的 patch artifact（unified diff），通过签名 URL 下载；整 Run 累积 Diff 在阶段 2；
- 解析：react-diff-view 的 `parseDiff`，按文件生成文件树与增删统计；
- 渲染：文件默认折叠，展开时才挂载 diff 组件；单文件超过 500 行展开前提示；单文件超过 5000 行或 patch 超过 2 MB 只显示统计与下载链接；
- 语法高亮阶段 1 不做，阶段 2 用 shiki 的 tokenizer 接入；
- 验收：50 个文件、3000 行的 patch 首屏 1 秒内可交互；不达标切换到 `@git-diff-view/react`（自带虚拟滚动），接口不变。

### 4.2 转写

渲染单位是"渲染段"，不是 frame，也不是 `transcript_chunks` 的块：

| 渲染段 | 来源 frame | 显示 |
|---|---|---|
| 文本段 | 连续 `text_delta` | markdown |
| 思考段 | 连续 `thought_delta` | 默认折叠 |
| 工具卡片 | `tool_call` 与同 `callId` 的 `tool_result` 配对 | 可折叠；被 Runner 截断的输出显示 log artifact 链接 |
| 文件变更 | `file_changed` | 聚合到 Turn 头部的文件列表，不逐条显示 |
| 计划 | `plan_updated` | 替换式显示最新一份 |
| usage | `usage` | Turn 尾部 |
| 警告 | `warning` | 行内提示 |

规则：

- 只有进行中的最后一段随新 chunk 重新渲染，已完成的段 memo；
- markdown 用 react-markdown + remark-gfm，禁用原始 HTML，链接加 `rel="noopener noreferrer"`；代码块用 shiki 按需加载，未加载前显示等宽纯文本；
- 虚拟列表用 `@tanstack/react-virtual`，动态高度测量；新内容到达时用户在底部则跟随，否则显示"有新内容"按钮；
- 每个 Attempt 内存最多保留最近 2000 个 frame 对应的段，超出丢弃最早的并记录最小已加载 `chunkSeq`，向上滚动到顶时用 `beforeChunk` 补拉；
- 转写内容一律视为数据，不渲染 HTML，不执行脚本，不展示环境变量。

## 5. Circle 的借鉴边界

`~/study/circle` 是 MIT License 的 Linear 风格前端模板，**没有后端、数据库、认证或真实 API**。它是视觉与交互参考，不是移植来源，也不是本项目的仓库基线。抽样核对的结论见 ADR-024 的 0.6 修订。

### 5.1 借鉴清单

| 类别 | 内容 | 处理 |
|---|---|---|
| Circle 自有，值得借鉴 | 应用壳与两行 header 布局；Sidebar 结构、折叠与设置态切换；主题 token 与命名主题；详情页右侧属性栏；列表/看板的分组、排序、空组与"隐藏列"处理；移动端单栏返回模式 | 阅读源码后用本项目的类型、路由和数据层重写 |
| 第三方库，直接按库接入 | shadcn/ui（CLI 生成）、bazza/ui data-table-filter、react-resizable-panels、react-dnd、cmdk、sonner、lucide-react | 按库文档接入，不从 Circle 复制 |
| 不适用 | Issue/Project/Cycle/Initiative/Triage/Review/Agent 的 mock 业务与类型；`diff-view.tsx`（只渲染预切好的行数组，无解析）；Inbox 的删除占位；Next.js App Router、Server Component；nuqs 的 Next 适配器 | 不看 |

本项目的核心屏幕，转写流、审批卡片、每 Turn Diff、Runner 配对、EnforcementReport 展示，在 Circle 中没有对应物，从零实现。

### 5.2 重写规则

- 类型只来自 `packages/contracts`，不保留任何 `mock-data` 接口；
- 跳转用 react-router 的 `Link` 与 `useParams`，不用 `next/link`、`next/navigation`；
- URL 状态用 nuqs 的 react-router 适配器；
- 代码风格用本项目的 Prettier 配置，不带入 Circle 的 3 空格缩进；
- 每个借鉴文件头部注明来源与 MIT 声明，汇总到仓库根目录 `THIRD_PARTY_NOTICES.md`；
- Geist 字体、Logo、图片等第三方资源单独核对许可证；默认使用系统字体栈。

### 5.3 时机

阶段 1 用 shadcn/ui 默认样式完成最小 UI，不做视觉打磨。阶段 2 起逐组件借鉴。

## 6. 开发与生产流程

### 本地开发

```text
Fastify API/WS       :5181
Vite client          :5173
PostgreSQL           :5432
```

Vite 代理以下路径到 Fastify（WebSocket 代理开 `ws: true`）：

```text
/api/*
/ws/client
```

Runner 直接连接 `http://localhost:5181`，不连接 Vite。浏览器只连接 Vite 提供的同源前端地址。开发环境 Fastify 不托管静态文件。

### 生产构建与托管

1. `bun install --frozen-lockfile`；
2. `vite build` 输出 `apps/web/dist/client`；
3. TypeScript 编译 Fastify 服务端到 `apps/web/dist/server`；
4. Node.js 22 启动 Fastify，`SERVE_STATIC=true` 时由 `@fastify/static` 托管 `dist/client`：
   - `/assets/*`（Vite 带 hash 产物）设 `Cache-Control: public, max-age=31536000, immutable`；
   - `index.html` 设 `Cache-Control: no-cache`；
   - 非 `/api`、非 `/ws`、`Accept` 含 `text/html` 的 GET 回 `index.html`（SPA fallback）；
5. 阶段 4 公网部署时前置反向代理只终止 TLS 并转发，见 [deployment.md](./deployment.md) §2.2。

生产环境不运行 Vite dev server。前端与服务端在同一个进程、同一个镜像中发布，不存在版本不一致。

## 7. 前端实现顺序

1. Vite SPA、路由表、应用壳、错误边界、`GET /api/v1/me` 认证引导、API client 与 contracts 校验；
2. Task 列表与详情、创建 Run 表单（含 EnforcementReport 展示）；
3. Run 详情的数据层（§3.3）与事件时间线，先用纯文本渲染转写验证游标与补拉；
4. 转写渲染段与虚拟列表（§4.2）；
5. 审批卡片、追问、停止这一轮、取消、重试、完成；
6. 每 Turn Diff（§4.1）；
7. Runner 列表与配对码、Repository、AgentProfile；
8. 阶段 2：Circle 借鉴、看板拖拽、复杂筛选、时间线、显示设置。

## 8. 工具链约束

- 根目录维护一个 Bun lockfile；CI 使用 `bun install --frozen-lockfile`；需要安装脚本的依赖列入 `trustedDependencies`，见 ADR-023 修订；
- 生产服务端和 Runner 代码只使用 Node.js 22 兼容 API，不依赖 Bun runtime API；
- Vite 的 `VITE_*` 变量全部视为公开配置，不能放 secret；
- `apps/web/client` 不引入数据库驱动、shell 执行、Runner token 或服务端环境变量；
- 每个跨进程边界先更新 `packages/contracts`，再更新 client/server/runner；
- eslint 禁止 import `@/mock-data/*`、`next/*`、`nuqs/adapters/next*`；
- 首个可运行版本必须同时通过：`bun run build`、Node.js 22 生产启动并托管静态文件、浏览器断线 30 秒后重连且事件与转写无缺口无重复（§3.3）。
