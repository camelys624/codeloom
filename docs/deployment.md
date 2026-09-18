# 部署

- 状态：Accepted（阶段 1 基线）
- 版本：0.6
- 日期：2026-09-06
- 变更：0.6 生产静态文件改由 Fastify 托管；反向代理推迟到阶段 4，只终止 TLS 并转发；补 TLS 签发与续期、缓存头、`trustProxy`、镜像构建与 Runner 安装方式。见 [decisions.md](./decisions.md) ADR-023、ADR-025 的 0.6 修订。

## 1. 本地开发

```text
PostgreSQL        :5432   docker compose（infra/local）
apps/web server    :5181   Fastify，REST + WebSocket
apps/web client    :5173   Vite，代理 /api 和 /ws/client 到 5181
apps/runner        本机    Bun 执行开发脚本，Node.js 运行 Runner
```

启动顺序：PostgreSQL、迁移、Fastify 服务端、Vite 前端、Runner。

```bash
docker compose -f infra/local/compose.yml up -d
bun run db:migrate
bun run --filter @agent-workspace/web server:dev
bun run --filter @agent-workspace/web client:dev
bun run --filter @agent-workspace/runner dev -- connect --server http://localhost:5181 --pair <code>
bun run --filter @agent-workspace/runner dev -- repo add ~/code/some-repo
bun run --filter @agent-workspace/runner dev -- daemon
```

开发模式 BlobStore 写 `./.data/blobs`。Vite client 只代理 `/api`、`/ws/client`；Runner 始终直接连接 Fastify 的 `:5181`，不连接 Vite。开发环境 Fastify 不托管静态文件。
局域网访问规则：Vite 开发服务器和 Fastify API 都必须绑定 `0.0.0.0`，禁止绑定 `127.0.0.1`。浏览器通过宿主机局域网 IP 的 `:5173` 访问，例如 `http://192.168.31.234:5173`；Vite 将 `/api/*` 和 `/ws/client` 代理到同机 Fastify。局域网 IP 变化时同步更新 `.env` 的 `PUBLIC_ORIGIN`，否则登录和 CSRF 校验的来源可能不匹配。

首次 `bun install` 后执行 `bun pm untrusted`，把项目确实需要安装脚本的依赖写入根 `package.json` 的 `trustedDependencies` 再重新安装，见 §9。

## 2. 生产拓扑

### 2.1 阶段 1 到 3：一个 Fastify 进程

```text
浏览器 ── HTTP(S) ──► Fastify :5181
                        ├─ 静态文件 dist/client（/assets 长缓存，index.html no-cache，SPA fallback）
                        ├─ /api/*
                        ├─ /ws/client
                        └─ /ws/runner
                              └─ PostgreSQL / BlobStore
```

- 阶段 1 服务端运行在用户自己的机器或内网上，没有公网入口；Runner 连接 `http://<host>:5181`；
- Fastify 静态托管规则：`/assets/*` 设 `Cache-Control: public, max-age=31536000, immutable`；`index.html` 设 `Cache-Control: no-cache`；非 `/api`、非 `/ws`、`Accept` 含 `text/html` 的 GET 回 `index.html`；
- `SERVE_STATIC=true` 是生产默认；`TRUST_PROXY=false` 是默认，前面没有代理时不得开启。

### 2.2 阶段 4 起：公网 VPS，前置反向代理只终止 TLS

```text
浏览器 / Runner ── HTTPS/WSS ──► 反向代理 :443 ──► Fastify 127.0.0.1:5181（静态 + API + WS）
                                                        └─ PostgreSQL / BlobStore
```

代理只做 TLS 终止与转发，不托管静态文件，不做 SPA fallback。静态文件与缓存头始终由 Fastify 负责，因此代理没有"前端版本"，也不需要与服务端同步发布。

Caddy 与 Nginx 都必须满足：

1. 证书自动签发与续期是部署的一部分：Caddy 内建 ACME；Nginx 用 certbot webroot 加定时续期与 reload；
2. 转发 `Upgrade`、`Connection`、`Host`、`X-Forwarded-For`、`X-Forwarded-Proto`；
3. WebSocket 路径使用 HTTP/1.1，关闭 buffering，读写超时不低于 3600 秒；
4. 上传上限不低于 64 MB（patch 20 MB、log 50 MB）；
5. Fastify 设 `TRUST_PROXY=true` 并绑定 `127.0.0.1:5181` 或仅 Docker 内网，不发布到公网。

首选 Caddy：一份配置同时完成 TLS、续期与 WebSocket 转发，少一个 certbot 组件。已有 Nginx 运维习惯时用 Nginx，两者等价。

Caddyfile：

```text
aw.example.com {
    reverse_proxy web:5181
    request_body {
        max_size 64MB
    }
}
```

Nginx 等价配置：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

upstream agent_workspace_web {
    server web:5181;
}

server {
    listen 80;
    server_name aw.example.com;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/acme;                 # certbot --webroot -w /var/www/acme
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    http2 on;
    server_name aw.example.com;

    ssl_certificate     /etc/letsencrypt/live/aw.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/aw.example.com/privkey.pem;

    client_max_body_size 64m;

    location ~ ^/ws/(client|runner)$ {
        proxy_pass http://agent_workspace_web;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }

    # 其余全部转发，静态文件、缓存头和 SPA fallback 由 Fastify 负责
    location / {
        proxy_pass http://agent_workspace_web;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

续期：`certbot renew` 由 systemd timer 每日执行，`--deploy-hook "nginx -s reload"`。首次签发前 Nginx 只能起 80 端口的 server；用 `certbot certonly --webroot` 拿到证书后再启用 443 配置。

### 2.3 Compose（阶段 4）

```yaml
services:
  caddy:
    image: caddy:2-alpine
    depends_on: [web]
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./infra/production/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data

  web:
    image: ghcr.io/…/agent-workspace-server:${APP_VERSION}
    expose:
      - "5181"
    environment:
      DATABASE_URL: postgres://aw:…@postgres:5432/aw
      PUBLIC_ORIGIN: https://aw.example.com
      DATA_DIR: /data
      SESSION_SECRET: ${SESSION_SECRET}
      SERVE_STATIC: "true"
      TRUST_PROXY: "true"
    volumes:
      - "aw-data:/data"

  postgres:
    image: postgres:16
    volumes:
      - "aw-pg:/var/lib/postgresql/data"

volumes:
  caddy-data:
  aw-data:
  aw-pg:
```

只有 `web` 镜像包含应用代码与前端产物；代理镜像是官方镜像加一份配置。阶段 1 到 3 的 Compose 去掉 `caddy` 服务，把 `web` 的 `5181` 直接 `ports` 发布到本机或内网。

## 3. 构建与镜像

构建阶段由 Bun 执行，生产进程由 Node.js 22 运行：

```bash
bun install --frozen-lockfile
bun run build          # vite build → apps/web/dist/client；tsc → apps/web/dist/server
node apps/web/dist/server/main.js
```

Dockerfile 多阶段：

- 构建阶段用 `oven/bun` 的 Debian 变体安装依赖并构建；
- 运行阶段用 `node:22-slim`，复制 `apps/web/dist` 与生产 `node_modules`；
- 两个阶段使用同一 Debian 基线，不混用 alpine，保证原生模块与运行阶段的 glibc 一致；
- 镜像 tag 与 `packages/contracts` 版本一起来自同一个 commit。

## 4. 环境变量

```bash
NODE_ENV=production
HOST=0.0.0.0                              # 阶段 4 在代理后面时 127.0.0.1
PORT=5181
DATABASE_URL=postgres://…
PUBLIC_ORIGIN=https://aw.example.com      # 用于 cookie、CSRF 和签名 URL
DATA_DIR=/data
SESSION_SECRET=…                          # 32 字节以上随机
SERVE_STATIC=true                         # 托管 dist/client；开发环境 false
TRUST_PROXY=false                         # 只在反向代理后面设 true
METRICS_TOKEN=…                           # 可选；设置后 /metrics 要求 Bearer token
LOG_LEVEL=info
```

`/metrics` 暴露 Prometheus text format 指标。默认不要求认证，适合只绑定内网或由前置网络策略保护的部署；公网或不可信网络部署应设置 `METRICS_TOKEN`，抓取请求使用 `Authorization: Bearer <METRICS_TOKEN>`。指标查询只读数据库，不写入业务状态。

所有 secret 从环境注入，不提交 `.env`。前端 bundle 不包含任何 secret；`VITE_*` 变量只能放公开配置，前端通过同源路径访问 API。

## 5. Runner 安装

用户机器只需要 Node.js 22，不需要 Bun：

```bash
npm install -g @agent-workspace/runner
agent-runner connect --server https://aw.example.com --pair <code> --name my-laptop
agent-runner repo add ~/code/my-repo
agent-runner daemon
```

单文件分发（Node SEA 或 `bun build --compile`）在阶段 2 评估。

数据目录 `~/.agent-workspace/`（0700），布局见 [data-and-events.md](./data-and-events.md) §9。

作为系统服务：

- **Linux**：systemd user service

```ini
[Unit]
Description=Codeloom Runner
After=network-online.target

[Service]
ExecStart=%h/.local/bin/agent-runner daemon
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

- **macOS**：launchd 用户级 agent，`KeepAlive` 为 true；
- **Windows**：Task Scheduler 登录时启动，隐藏窗口。

升级：`agent-runner daemon` 收到 SIGTERM 后进入 draining，等待活跃 Attempt 结束或 10 分钟超时。重启后按 [runner-agent-protocol.md](./runner-agent-protocol.md) §11 对账。

## 6. 网络与 WebSocket

- 阶段 1 到 3：Fastify 直接监听，Runner 与浏览器连同一个端口；
- 阶段 4：公网只暴露代理的 80/443，代理要求见 §2.2；
- Runner 只需要出站 HTTPS 443。企业代理需要支持 CONNECT 和 WebSocket upgrade。Runner 每 30 秒的 `runner.status` 也起保活作用；
- 浏览器 WebSocket 的重连与补拉规则见 [frontend.md](./frontend.md) §3.3。

## 7. 备份与恢复

- PostgreSQL 每日全量加 WAL 归档，恢复目标 24 小时内任意时间点；
- `DATA_DIR/blobs` 每日同步到对象存储；
- 恢复后：跑迁移、启动 Fastify，reaper 自动处理已过期 lease，Runner 重连对账。没有需要重放的队列；
- 前端静态文件在镜像里，不是业务事实。

## 8. 监控

阶段 1 暴露 `/metrics`（Prometheus text format）。默认不要求应用层认证，因此生产环境应通过内网、反向代理访问控制或设置 `METRICS_TOKEN` 保护；设置 token 后，Prometheus 使用 `Authorization: Bearer <token>` 抓取。当前指标包括：

```text
aw_runners_online
aw_attempts_by_status{status}
aw_attempts_lost_total
aw_auto_retries_total
aw_claim_latency_seconds
aw_event_ingest_lag_seconds
aw_transcript_chunks_total
aw_approvals_pending
aw_runs_with_multiple_active_attempts
aw_runner_messages_total
aw_event_nacks_total
aw_ws_clients
```

`aw_claim_latency_seconds` 是最近 24 小时已领取 Attempt 从创建到领取的平均秒数；`aw_event_ingest_lag_seconds` 是最近 5 分钟事件写入时间减事件发生时间的最大值；`aw_runs_with_multiple_active_attempts` 是违反单个 Run 单个活动 Attempt 不变量的 Run 数量；`aw_runner_messages_total` 和 `aw_event_nacks_total` 是当前服务进程生命周期内的 Runner WebSocket 计数。数据库查询异常时 endpoint 返回 500，不返回伪造的零值。

Prometheus 告警规则可直接使用以下表达式：

```yaml
groups:
  - name: codeloom
    rules:
      - alert: CodeloomRunAttemptInvariantViolation
        expr: aw_runs_with_multiple_active_attempts > 0
        for: 1m
        labels: { severity: critical }
      - alert: CodeloomEventNacksIncreasing
        expr: increase(aw_event_nacks_total[10m]) > 0
        for: 5m
        labels: { severity: warning }
      - alert: CodeloomAttemptsLostIncreasing
        expr: increase(aw_attempts_lost_total[10m]) > 0
        for: 5m
        labels: { severity: warning }
      - alert: CodeloomApprovalsStuck
        expr: aw_approvals_pending > 0 and increase(aw_event_nacks_total[30m]) == 0
        for: 30m
        labels: { severity: warning }
```

## 9. 版本与兼容

- 根目录使用 Bun workspace；CI 使用 `bun install --frozen-lockfile`；
- Bun 默认不执行未信任依赖的安装脚本：需要安装脚本的依赖（原生模块等）必须列入根 `package.json` 的 `trustedDependencies`；CI 在安装后用 Node.js 22 运行冒烟脚本，逐个 `require` 原生模块并调用一次，再执行 `vite build` 与服务端启动；工具链检查一个工作日内修不好则切 pnpm，见 ADR-023 修订；
- 服务端和 Runner 的生产进程使用 Node.js 22；Bun 仅用于安装依赖和构建脚本；
- 服务端和 Runner 用 `protocolVersion` 整数协商，服务端支持 N 和 N-1；
- 数据库迁移向后兼容一个服务端版本，先加列再切换再删列；
- contracts 包版本与服务端一起发布，Runner 依赖它的 N 或 N-1；
- 发布前：类型检查、单元测试、集成测试（testcontainers PostgreSQL + fake adapter）、静态托管的缓存头与 SPA fallback 检查；阶段 4 起再加代理层的两个 WebSocket upgrade 检查。

### 阶段 2 Runner 发布前检查

- 单文件产物分别针对 Linux x64、Darwin arm64、Windows x64 构建；每个目标平台必须在原生主机运行 `status`、`connect`、`repo add` 和 daemon WebSocket smoke。
- 发布产物保存 SHA-256 checksum；代码签名和自动更新不由阶段 2 服务端实现。
- Worktree 清理由 Runner 启动时及每小时执行；清理只作用于服务端明确返回的已完成 Attempt，检查无未提交改动后调用 `git worktree remove`，结果回报服务端并显示在 Runner 状态页。
- 长时混沌验收需要随机杀 Runner、服务端、网络并观察 24 小时不变量；当前仓库已覆盖确定性与随机乱序单元场景，发布前仍需环境级演练。

## 10. 阶段 5 之前不做

Kubernetes、多实例、对象存储、CDN、云端 Worker。反向代理与 TLS 在阶段 4。协议和数据模型已为多实例留好口子（`LISTEN/NOTIFY`、无本地状态），到时只加不改。
