# Codeloom 线上部署手册

本文针对本仓库基于 Multica v0.5.0 的修改版，面向个人与同一组织内部团队。
示例域名为 `codeloom.cc`，不表示域名已经购买、DNS 已经配置或服务已经上线；实际部署时统一替换为自己的域名。

**推荐方案：云服务器只运行平台，Agent 在独立执行机上运行。** 当前的局域网部署不能原样暴露到公网。
不要使用上游一键安装脚本或官方 `latest` 镜像代替本仓库的镜像，否则会丢失默认中文、首次登录直接进入主页等修改。

## 1. 架构与服务器规格

```text
浏览器 ── HTTPS ──> Caddy（云服务器上的 80/443）
                       ├── /ws、/ws/* ──> Go API：127.0.0.1:8180
                       └── 其他请求 ────> Next.js：127.0.0.1:3100
                                             └── API 代理 ──> backend:8080
                                                               │
                                                       PostgreSQL 17
                                                       不发布宿主机端口

独立执行机：Multica daemon + OMP / Claude 等 CLI + Git worktree
                   └── 主动通过 HTTPS / WebSocket 连接平台
```

以下是起步估算，不是负载测试得出的容量承诺：

| 用途 | 起步配置 | 说明 |
| --- | --- | --- |
| 个人或小团队轻量试用，仅平台 | 2 核 / 4GB / 50GB SSD | 应用镜像在本机或 CI 构建 |
| 推荐团队起步，仅平台 | **4 核 / 8GB / 80～100GB SSD** | 给数据库、附件和日志留余量 |
| 独立 Agent 执行机 | 4～8 核 / 8～16GB 起 | 项目编译、测试和浏览器决定实际消耗 |
| 多项目并行构建与浏览器测试 | 8 核 / 16～32GB 起 | 先限制并发，再按真实峰值扩容 |

使用云端模型 API 无需 GPU。自己运行大模型需要另做显存与推理容量规划。
平台上线不代表执行侧全天可用：笔记本休眠、断网或关机会影响执行；无人值守任务需要常驻 worker。

资源评估应分别记录 CPU、容器峰值内存、数据库磁盘增长、附件大小、队列等待和任务耗时。
不要把空载占用当成峰值，也不要把 daemon 默认 20 个并发槽当成机器能承受 20 个构建任务。

## 2. 安全、许可与准备条件

- 推荐 Ubuntu 24.04 LTS、Linux amd64；本手册的应用镜像以 `linux/amd64` 构建。ARM 服务器必须同时更换镜像目标平台，不能直接使用这些 amd64 产物。
- 构建机：Git、Docker / BuildKit；前后端编译依赖由 Dockerfile 安装。正式发布应从干净的独立工作树构建。
- 服务器：Docker Engine、Docker Compose **2.24.4+**、Node.js **22+**（仅初始化脚本需要）、Caddy、Bash、curl、tar。
- 按 [Docker Ubuntu 安装说明](https://docs.docker.com/engine/install/ubuntu/)、[Node.js 下载说明](https://nodejs.org/en/download)、[Caddy 安装说明](https://caddyserver.com/docs/install#debian-ubuntu-raspbian)安装；本手册假设 Caddy 作为宿主机 systemd 服务运行，而不是容器。
- 部署用户能够运行 `docker`，并具有必要的 sudo 权限。Docker socket / docker 用户组等同于高权限访问，不向不可信成员开放。
- 域名的 A 记录指向服务器 IPv4。只有实际配置了 IPv6 路由和防火墙才添加 AAAA 记录。
- 准备可用的 SMTP 账户、已验证的发件人地址、团队邮箱白名单。按邮件服务商要求设置 SPF / DKIM 等 DNS 记录。
- 安全组仅允许必要入口：80/TCP、443/TCP；SSH 仅允许管理员 IP 或 VPN。**不开放 3100、8180、5432。** Docker 发布端口可能绕过部分主机防火墙，因此下面还会强制绑定回环地址。
- 只供内部使用时优先使用 VPN / 访问限制。本文的公网 DNS + Caddy 自动证书步骤要求证书验证端点可达；仅私网访问时需另行安排 DNS challenge 或受信任证书，不能直接套用公网验证流程。
- 使用中国大陆服务器前，确认域名后缀、注册商实名认证与备案要求。
- 公网地址可访问不等于开放第三方服务：同一组织内部使用不需要商业许可；向组织外用户提供托管服务，即使免费，也受商业许可限制。保留 Multica UI 名称、LOGO、版权以及完整 [LICENSE](../LICENSE) / [NOTICE](../NOTICE)。

执行机与平台分离。不要在持有生产数据库凭据的服务器账户下运行自主编码 Agent；当前没有旧 Codeloom 的逐工具人工审批闭环，worktree 也不是操作系统沙箱。

## 3. 在构建机生成不可变发布包

以下命令在 **Codeloom 修改版仓库根目录**执行。先提交待发布修改；未提交文件不会进入源码归档，却可能进入 Docker 构建上下文，因此必须检查工作树。
本文发布应用镜像为离线 tar 包，不要求先搭建私有镜像仓库；PostgreSQL 镜像在服务器首次启动前单独拉取。

```bash
set -euo pipefail

git status --short
test -z "$(git status --porcelain)" || { echo "请先提交或移走未提交改动"; exit 1; }
export CODELOOM_IMAGE_TAG="$(git rev-parse HEAD)"
export RELEASE_DIR="$(mktemp -d /tmp/codeloom-release.XXXXXX)"

docker build --platform linux/amd64 \
  --build-arg VERSION=v0.5.0-codeloom \
  --build-arg COMMIT="$CODELOOM_IMAGE_TAG" \
  --build-arg DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -f Dockerfile -t "codeloom-backend:$CODELOOM_IMAGE_TAG" .

docker build --platform linux/amd64 \
  --build-arg NEXT_PUBLIC_APP_VERSION="v0.5.0-codeloom.$CODELOOM_IMAGE_TAG" \
  -f Dockerfile.web -t "codeloom-web:$CODELOOM_IMAGE_TAG" .

git archive --format=tar.gz \
  --output="$RELEASE_DIR/source.tar.gz" HEAD
docker image save --output "$RELEASE_DIR/images.tar" \
  "codeloom-backend:$CODELOOM_IMAGE_TAG" \
  "codeloom-web:$CODELOOM_IMAGE_TAG"
printf '%s\n' "$CODELOOM_IMAGE_TAG" > "$RELEASE_DIR/release.txt"
(
  cd "$RELEASE_DIR"
  sha256sum source.tar.gz images.tar release.txt > SHA256SUMS
)
printf '发布包目录：%s\n' "$RELEASE_DIR"
```

如果构建机无法访问 npm / Go 依赖源，参照 [构建代理说明](../SELF_HOSTING.md#隔离隐私与维护)配置**构建侧**代理。
不要将本机 `127.0.0.1:10808` 等代理地址写进线上运行环境，也不要把 `.env.codeloom` 或模型凭据放入镜像。

通过 SSH 传输，替换服务器登录地址；`scp -r` 会把目录放到远端用户的 home 下：

```bash
scp -r "$RELEASE_DIR" deploy@YOUR_SERVER:~/
```

妥善保留发布包。后续使用私有镜像仓库时，可替换传输方式，但仍应固定提交标签或 digest，不能覆写同一发布标签，也不要用 `latest` 或 `:dev` 作为生产版本选择。

## 4. 服务器初始化

下面在**服务器的新登录 Shell**中执行，替换发布包目录为实际路径。

```bash
set -euo pipefail
cd ~/codeloom-release.REPLACE_ME
sha256sum --check SHA256SUMS
export CODELOOM_IMAGE_TAG="$(cat release.txt)"
[[ "$CODELOOM_IMAGE_TAG" =~ ^[0-9a-f]{40}$ ]]

docker image load --input images.tar
sudo install -d -m 0755 "/opt/codeloom/releases/$CODELOOM_IMAGE_TAG"
sudo tar -xzf source.tar.gz -C "/opt/codeloom/releases/$CODELOOM_IMAGE_TAG"
sudo ln -sfn "/opt/codeloom/releases/$CODELOOM_IMAGE_TAG" /opt/codeloom/current
sudo install -d -m 0700 -o "$(id -un)" -g "$(id -gn)" /etc/codeloom
cd /opt/codeloom/current

node scripts/codeloom-init.mjs \
  --origin https://codeloom.cc \
  --bind-address 127.0.0.1 \
  --email you@your-company.example,teammate@your-company.example \
  --output /etc/codeloom/.env.codeloom
printf '\nCODELOOM_IMAGE_TAG=%s\n' "$CODELOOM_IMAGE_TAG" >> /etc/codeloom/.env.codeloom
```

脚本独占创建配置、权限 `0600`，生成新的数据库密码、JWT 与 VCS 加密密钥；不会覆盖已有文件。
**这组初始化步骤只用于全新部署，不用于升级或迁移已有数据库。** 不要照着脚本打印的局域网启动命令直接启动，先完成下面的生产覆盖配置。

编辑 `/etc/codeloom/.env.codeloom`，保留刚生成的密钥，确认以下项目。不要把下表整段覆盖成一个缺少密钥的新文件：

```dotenv
CODELOOM_PUBLIC_ORIGIN=https://codeloom.cc
PUBLIC_HOST=codeloom.cc
BIND_ADDRESS=127.0.0.1
FRONTEND_PORT=3100
BACKEND_PORT=8180

SMTP_HOST=smtp.your-provider.example
SMTP_PORT=587
SMTP_USERNAME=your-smtp-account
SMTP_PASSWORD='replace-with-your-real-smtp-password'
SMTP_FROM_EMAIL=noreply@your-company.example
SMTP_TLS=starttls
SMTP_TLS_INSECURE=false
```

- 初始化脚本从 HTTPS origin 推导 `FRONTEND_PORT=443`，但 TLS 由 Caddy 终止，所以这里必须改为内部 HTTP 端口 **3100**。
- SMTP 示例必须换成真实配置；端口 465 使用 `SMTP_TLS=implicit`。不要关闭证书校验。
- Compose env 文件中的 `$` 可能触发插值；SMTP 密码等包含特殊字符时按 Compose env-file 语法引用，例如单引号，避免密码被误解析。
- `ALLOWED_EMAILS` 使用真实团队邮箱。白名单变更并不等于撤销现存账号或已有令牌，应单独处理离职成员和访问凭据。
- `.env.codeloom`、备份、日志中的验证码均属于敏感信息，不提交到 Git，不发到工单或截图。

## 5. 生产 Compose 覆盖配置

保存以下内容为 `/etc/codeloom/compose.production.yml`。它必须叠加在三个仓库 Compose 文件之后。
当前 LAN overlay 的 daemon/public URL 是 `http://域名:8180`；**只改 origin 不够**，这里显式覆盖成 HTTPS 单域名入口。
`build: !reset null` 和 `pull_policy: never` 防止线上意外源码构建或拉取错误版本。

```yaml
# Codeloom production overlay: host Caddy, imported commit-tagged images.
services:
  postgres:
    logging: &bounded-logs
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"

  backend:
    image: codeloom-backend:${CODELOOM_IMAGE_TAG:?Set the imported release commit}
    build: !reset null
    pull_policy: never
    ports: !override
      - "127.0.0.1:8180:8080"
    environment:
      MULTICA_PUBLIC_URL: ${CODELOOM_PUBLIC_ORIGIN:?Set the HTTPS origin}
      MULTICA_DAEMON_SERVER_URL: ${CODELOOM_PUBLIC_ORIGIN:?Set the HTTPS origin}
    logging: *bounded-logs

  frontend:
    image: codeloom-web:${CODELOOM_IMAGE_TAG:?Set the imported release commit}
    build: !reset null
    pull_policy: never
    ports: !override
      - "127.0.0.1:3100:3000"
    logging: *bounded-logs
```

在每个需要操作服务的 Bash 会话定义下面的函数。
`env -i` 清理当前 Shell 遗留的 Compose 插值变量，避免旧项目的数据库、端口或 origin 覆盖 env 文件；保留 HOME 以供本机 Docker 使用其正常配置。本手册假设连接服务器本机 Docker Engine。

```bash
codeloom() (
  cd /opt/codeloom/current || exit
  env -i PATH="$PATH" HOME="$HOME" docker compose \
    --project-name codeloom \
    --env-file /etc/codeloom/.env.codeloom \
    -f docker-compose.selfhost.yml \
    -f docker-compose.selfhost.build.yml \
    -f docker-compose.codeloom.yml \
    -f /etc/codeloom/compose.production.yml "$@"
)

codeloom config --quiet
codeloom config --images
codeloom pull postgres
codeloom up -d --no-build --pull never
codeloom ps
curl --fail --show-error http://127.0.0.1:8180/healthz
curl --fail --show-error http://127.0.0.1:3100/api/config
```

不要把完整 `codeloom config` 输出复制到聊天或日志，它包含展开后的密钥。
期望：PostgreSQL 不发布端口；应用只绑定 `127.0.0.1:3100/8180`；`/healthz` 的数据库与迁移检查均为 `ok`；`/api/config` 中显示本次版本和正确公开地址。
首次拉取的 PostgreSQL 镜像为上游使用的 `pgvector/pgvector:pg17`；不要换成缺少扩展的普通 PostgreSQL 镜像，也不要直接跨大版本替换数据目录。

## 6. Caddy、HTTPS 与 DNS

在已安装 Caddy 的服务器上，把以下站点块加入 `/etc/caddy/Caddyfile`，不要覆盖其他站点：

```caddyfile
codeloom.cc {
    @multica_ws path /ws /ws/*
    handle @multica_ws {
        reverse_proxy 127.0.0.1:8180 {
            flush_interval -1
        }
    }

    handle {
        reverse_proxy 127.0.0.1:3100
    }
}
```

Next.js 继续负责 HTTP API、上传等同源转发；WebSocket 直接走 Go 后端，避免依赖 Next.js 的 upgrade 代理行为。
`/ws /ws/*` 是路径边界匹配，不要改成会误拦截工作区路径的 `/ws*`。

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
curl --fail --show-error https://codeloom.cc/login -o /dev/null
curl --fail --show-error https://codeloom.cc/api/config
```

Caddy 自动申请和续期公开证书，需要正确 DNS 和可达的验证端口。不要用 `curl -k` 或关闭浏览器证书检查掩盖错误。
保留 Caddy 的配置和证书存储权限；如前置其他代理/CDN，必须一并确认长连接、WebSocket 和客户端地址信任边界。
不建议为起步部署拆分 app/API 域名：跨域 cookie、CSRF 与 Origin 配置更容易出错。

本方案不是静态站点部署；不能只复制前端静态文件，也不使用 Vite 开发服务器。

## 7. 首次登录与 Agent 接入

1. 在 `https://codeloom.cc/login` 输入白名单邮箱，实际收到 SMTP 验证码后登录。
2. 首次登录会复用已有工作区，或创建默认 `Codeloom` 工作区；不会要求填写资料或问卷。
3. 团队共用工作区应通过邀请加入，不会因为同一服务器就自动加入别人的工作区。
4. 在独立执行机配置好 Agent CLI、模型账户和 Git 访问；不要把模型凭据复制到平台服务器来“代登录”。

执行机安装与本发布兼容的 Multica CLI，当前基线为 v0.5.0。Linux amd64 可以从本次后端镜像提取同版本 CLI，不需要启动后端服务：

```bash
# 在已导入同一发布镜像的 Linux amd64 执行机上执行。
# CODELOOM_IMAGE_TAG 设为该发布包 release.txt 中的完整提交号。
mkdir -p "$HOME/.local/bin"
cli_container="$(docker create "codeloom-backend:$CODELOOM_IMAGE_TAG")"
docker cp "$cli_container:/app/multica" "$HOME/.local/bin/multica"
docker rm "$cli_container"
chmod +x "$HOME/.local/bin/multica"
export PATH="$HOME/.local/bin:$PATH"
multica version
```

其他系统使用相应平台的匹配版本二进制；不要在 Windows 原生环境执行 Linux 二进制，也不要误用上游 `--with-server` 安装命令另建一套平台。

```bash
multica setup self-host \
  --server-url https://codeloom.cc \
  --app-url https://codeloom.cc

# setup 会启动 daemon；随后重启以限制并发并避免自动更新脱离固定基线。
multica daemon restart --max-concurrent-tasks 2 --no-auto-update
multica daemon status
multica daemon logs -f
```

以上命令适用于执行机上能完成浏览器授权的环境。远程无界面机器按 CLI 输出的授权/隧道提示操作，或使用受限 PAT 的交互式输入；不要把令牌写入 Shell 历史。
CLI 与 daemon 的本地配置、凭据要持久保存并限制权限；常驻 worker 还需要操作系统服务管理，确保重启后恢复，不要把一次 `daemon start` 当成已经配置了开机自启。

在网页“运行时”确认机器在线，创建 Agent 绑定该运行时，再配置项目仓库。
本地 Git 目录请选择 **worktree** 执行模式；in-place 编码运行有目录串行约束，增加槽位不等于能够安全地同时修改一个工作树。
Agent 自动批准工具并以执行机系统用户权限工作，先使用专用低权限账户与测试仓库验证。

## 8. 上线验收与日常观察

必须在实际域名和真实执行机上完成，不能用一次 `/healthz` 成功代替：

- [ ] TLS 证书有效；从另一台设备访问域名成功；内网应用和数据库端口没有对公网开放。
- [ ] SMTP 验证码正常；白名单外新邮箱不能注册；固定开发验证码未启用。
- [ ] 初次登录直接进入中文任务主页；刷新保留工作区与个人语言选择。
- [ ] 浏览器开发工具中，已认证的 `/ws` 连接升级为 `101`，评论和执行日志实时更新。
- [ ] 运行时在线，Agent 能领取测试任务，执行后回传日志与产物。
- [ ] 两个独立任务并行；同一会话的后续消息正确排队；停止操作真正结束本地执行。
- [ ] 执行机短暂断线后恢复、重新注册和任务状态符合预期；停止不等于撤销已发生的外部操作。
- [ ] 先验证手动任务，再启用定时或 Webhook；自动化没有通用“上次未完成则跳过”的重叠策略，不把 Cron 间隔当作互斥锁。
- [ ] 备份已经异机保存，并在独立恢复环境完成一次恢复演练。

```bash
codeloom ps
codeloom logs --tail=100 backend
codeloom logs --tail=100 frontend
docker stats --no-stream
curl --fail --show-error http://127.0.0.1:8180/healthz
```

监控磁盘、数据库、API 可用性和执行机在线状态。日志可能包含任务内容或验证码，不应公开共享。
生产覆盖文件限制了 Docker JSON 日志轮转，但不限制数据库里的执行记录、附件或 Agent 工作目录；这些仍需容量规划与保留策略。

## 9. 一致性备份

备份至少包含 PostgreSQL、附件和加密密钥；只有数据库备份而丢了 `MULTICA_VCS_SECRET_KEY`，无法正常解密原有 VCS 凭据。
以下示例使用默认数据库用户/库名 `multica`。如修改过，同步修改 `pg_dump` / `pg_restore` 参数。

在维护窗口暂停自动化、停止接收新任务，让活动任务结束，并停止执行机 daemon。
停止前端/API 阻止新写入后再同时备份数据库和本地附件。Caddy 期间返回不可用属于预期；提前通知团队。

```bash
set -euo pipefail
umask 077
BACKUP="$HOME/codeloom-backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP"

codeloom stop frontend backend
codeloom exec -T postgres pg_dump -U multica -d multica -Fc > "$BACKUP/postgres.dump"
codeloom run --rm --no-deps -T --entrypoint tar backend \
  -czf - -C /app/data/uploads . > "$BACKUP/uploads.tar.gz"
cp /etc/codeloom/.env.codeloom "$BACKUP/"
cp /etc/codeloom/compose.production.yml "$BACKUP/"
sudo cat /etc/caddy/Caddyfile > "$BACKUP/Caddyfile"
readlink -f /opt/codeloom/current > "$BACKUP/release-path.txt"
codeloom config --images > "$BACKUP/images.txt"
codeloom exec -T postgres pg_restore --list < "$BACKUP/postgres.dump" > "$BACKUP/postgres.contents.txt"
(
  cd "$BACKUP"
  sha256sum postgres.dump uploads.tar.gz .env.codeloom compose.production.yml Caddyfile \
    release-path.txt images.txt postgres.contents.txt > SHA256SUMS
)
codeloom start backend frontend
```

备份完成后确认健康，再恢复 worker 和自动化。如果任一步失败，停止后续升级操作，查明原因；不要把不完整目录当成可恢复备份。
`pg_restore --list` 只确认归档可读，不能替代实际恢复。通过可信加密备份工具把目录和对应发布包复制到另一台机器/对象存储，限制访问，并按恢复需求制定保留周期。
服务器快照可以作为补充，不能代替独立备份与恢复演练。

### 在独立干净服务器恢复

1. 验证备份校验和，导入**备份对应版本**的应用镜像，解压对应源码到 `/opt/codeloom/releases/<提交号>`，设置 `current` 链接。
2. 恢复 `/etc/codeloom/.env.codeloom` 与生产覆盖文件，保持原密钥、权限 `0600` 和目录权限 `0700`。**不要重新运行初始化脚本生成密钥。**
3. 定义前面的 `codeloom` 函数。在独立、空的目标数据卷上启动 PostgreSQL，恢复数据和附件：

```bash
# BACKUP 设为已解密、校验通过的备份目录。
# 仅用于独立干净目标：不是向正在使用的数据库覆盖恢复。
codeloom pull postgres
codeloom up -d --no-build --pull never --wait --wait-timeout 60 postgres
# Compose 已等待 PostgreSQL 健康检查通过，再确认数据库可连接。
codeloom exec -T postgres pg_isready -U multica -d multica
codeloom exec -T postgres pg_restore \
  -U multica -d multica --exit-on-error --no-owner --no-privileges < "$BACKUP/postgres.dump"
codeloom run --rm --no-deps -T --entrypoint tar backend \
  -xzf - -C /app/data/uploads < "$BACKUP/uploads.tar.gz"
codeloom up -d --no-build --pull never
curl --fail --show-error http://127.0.0.1:8180/healthz
```

4. 按目标环境恢复 Caddy/DNS，验证登录、历史任务、附件下载和加密凭据可用，之后再连接真实执行机。
5. 恢复演练用隔离网络，不连接生产 worker，不向真实收件人发送测试邮件，不触发真实 Webhook/自动化。复制数据库会带来原有自动化，应先在隔离环境关闭或控制它们，再开放外连。

不要在原生产实例执行 `down --volumes` 来“方便恢复”。若目标已有数据，先另做备份并制定替换计划。

## 10. 升级与回滚

### 升级

1. 从新提交构建新的不可变镜像与源码发布包，传输并校验，导入镜像，解压到新的 release 目录；**先不要切换 `current`**。
2. 阅读变更和数据库迁移，在隔离环境验证；暂停自动化/worker，在维护窗口按上一节完成一致性备份。保留旧发布包和镜像。
3. 停止前端/API；将 `/etc/codeloom/.env.codeloom` 的 `CODELOOM_IMAGE_TAG` 改为新提交，再把 `/opt/codeloom/current` 指向同一提交的源码目录。其余密码和加密密钥保持不变。
4. 检查合并配置后启动。后端入口会应用数据库迁移；观察日志和健康检查，不要并行启动多个版本的后端来争抢迁移。

```bash
# 已完成新发布包导入、备份、停写、版本变量和 current 链接切换后：
codeloom config --quiet
codeloom config --images
codeloom up -d --no-build --pull never
codeloom ps
curl --fail --show-error http://127.0.0.1:8180/healthz
curl --fail --show-error https://codeloom.cc/api/config
```

5. 验证登录与一条真实测试任务，再恢复自动化和 worker。CLI/Agent 兼容性有变化时，先在测试 worker 升级验证，再滚动升级其他 worker。

### 回滚

- **仅应用改动且已确认 schema 向后兼容**：停止前端/API，把源码链接和 `CODELOOM_IMAGE_TAG` 一起切回旧版本，再启动验证。
- **存在不兼容迁移或无法确认兼容性**：不能只换回旧镜像。使用升级前一致性备份与旧发布包，在干净目标中恢复数据库、附件与密钥，然后切换入口。期间保持 worker 和自动化停止。
- 数据恢复会丢失备份之后的新写入；回滚前与团队确认恢复点和影响，不盲目执行 down migration。
- 不要通过重新生成 `.env`、改项目名或删除卷修复启动故障；项目名改变会连到另一组数据卷，看起来像“数据全没了”。

## 11. 故障定位与验证边界

| 现象 | 先检查 |
| --- | --- |
| Caddy 证书申请失败 | DNS A/AAAA、80/443 可达性、其他进程占用端口、Caddy 日志 |
| 登录写操作或 WS 返回 403 | `CODELOOM_PUBLIC_ORIGIN`、后端 Origin/CORS、浏览器实际访问域名是否一致 |
| 页面能开但实时数据不更新 | `/ws`、`/ws/*` 转发与 `101`；代理是否支持长连接 |
| daemon 被指向 HTTP 8180 | 生产 overlay 是否最后加载，两个公开 URL 是否覆盖成 HTTPS |
| 验证码收不到 | SMTP/发件人校验、提供商发送日志、网络与 TLS；不启用固定码绕过 |
| 任务长期排队 | 执行机在线、Agent/runtime 绑定、并发额度、目录锁；不是单纯加大平台服务器 |
| 更新后仍是旧界面 | 容器镜像标签与发布提交、是否错误拉取官方镜像、浏览器刷新 |
| 附件或 VCS 凭据不可用 | uploads 卷、数据库是否配套恢复、VCS 加密密钥是否保留 |

本次文档校验已通过：11 个 Bash 代码块的语法检查、初始化脚本生成临时配置、
四层 Compose 实际合并（回环端口、HTTPS origin、无应用构建配置、禁止拉取应用镜像、
数据库无公开端口及日志轮转）、Caddy 配置验证，以及仓库内文档链接检查。
这些检查未启动线上服务、申请公网证书或执行备份恢复；仍需逐项完成上线验收。
仓库此前已验证本机构建、中文登录、工作区/任务持久化及浏览器实时连接；这不代表 `codeloom.cc` 已上线，也不代表已完成公网证书、SMTP 投递、真实 Agent 中断/恢复或生产负载测试。
本文不把旧 Codeloom 的 Task/Run/Attempt/Turn 数据库迁移到 Multica；迁移现有 Multica 部署应走完整备份/恢复，而不是重新初始化空库。

相关资料：[本仓库自托管入口](../SELF_HOSTING.md)、[上游高级配置](../SELF_HOSTING_ADVANCED.md)、[运行时说明](../apps/docs/content/docs/daemon-runtimes.zh.mdx)、[Multica 许可](../LICENSE)。
