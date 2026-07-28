# MainQuest 与 ECS 发布 Runbook

本 Runbook 只定义执行步骤。WR-07 本地 RC 未通过时，禁止执行云端变更。

所有值使用占位符；secret 不写入仓库。

本文件中的 ECS 指一台云服务器主机，使用 Docker Compose 运行单实例 Web 容器。

## 1. 发布拓扑

```text
Internet
   |
HTTPS :443
   |
Nginx / MainQuest Gateway
   |
http://127.0.0.1:3000
   |
BidMaster Web container (single instance)
   |
/srv/bidmaster/data -> /data
```

首发不启用：

- 多副本
- 负载均衡
- Redis
- 共享数据库
- 对象存储

## 2. 外部输入清单

发布前由老板/对应 owner 提供：

| 输入 | 占位符 |
|---|---|
| 公网域名 | `<BIDMASTER_DOMAIN>` |
| MainQuest public base URL | `<MAINQUEST_AUTH_BASE_URL>` |
| MainQuest OAuth client ID | `<MAINQUEST_OAUTH_CLIENT_ID>` |
| MainQuest OAuth client secret | 仅 secret store |
| BidMaster tenant ID | `<BIDMASTER_TENANT_ID>` |
| GHCR image digest | `<IMAGE_DIGEST>` |
| ECS host/SSH profile | `<ECS_HOST>` |
| ECS CPU/内存与容器资源上限 | `<ECS_RESOURCE_LIMITS>` |
| TLS 证书、私钥路径与自动续期 owner | `<TLS_CERT_CONTRACT>` |
| 持久数据目录 | `/srv/bidmaster/data` |
| 备份目录 | `/srv/bidmaster/backups` |
| secret 托管/离线保管位置 | `<SECRET_ESCROW>` |
| 授权用户 A/B | MainQuest owner 创建 |
| 未授权用户 C | MainQuest owner 创建 |

## 3. MainQuest 注册

### 3.1 Product

在 MainQuest Admin 创建 BidMaster Product：

- Product key：`bidmaster`
- Display name：`BidMaster`
- Launch URL：`https://<BIDMASTER_DOMAIN>`
- Product ID：使用 MainQuest 自动生成的 UUID
- 状态：`active`

### 3.2 OAuth Application

创建 OAuth Application 并绑定上一步 Product：

```json
{
  "name": "BidMaster Web",
  "productId": "<MAINQUEST_PRODUCT_UUID>",
  "redirectUris": [
    "https://<BIDMASTER_DOMAIN>/api/auth/callback"
  ]
}
```

记录 client ID；client secret 只进入 ECS secret/env 文件。

### 3.3 用户

- 用户 A：授予 BidMaster Product access。
- 用户 B：授予 BidMaster Product access。
- 用户 C：不授予 BidMaster Product access。

### 3.4 MainQuest 侧验收

- Product ID 为 UUID。
- Application 绑定正确 Product。
- redirect URI 是数组且与线上 callback 完全一致。
- Product 为 active。
- A/B access active。
- C 无 access。
- forced-password-change 用户能完成改密后回到 authorize 链。

## 4. 镜像发布

推荐镜像：

```text
ghcr.io/zangqing828-ux/bidmaster-web:<git-sha>
ghcr.io/zangqing828-ux/bidmaster-web@sha256:<digest>
```

发布要求：

1. 从 WR-07 冻结 SHA 构建。
2. CI 完成 Web、Browser、Docker、dependency audit。
3. 推送 SHA tag。
4. 记录 registry 返回的 digest。
5. ECS compose 只使用 digest，不使用 `latest`。

本地核验：

```bash
docker pull ghcr.io/zangqing828-ux/bidmaster-web@sha256:<digest>
docker inspect ghcr.io/zangqing828-ux/bidmaster-web@sha256:<digest>
```

## 5. ECS 目录

```text
/opt/bidmaster/
  docker-compose.prod.yml
  .env
  deploy-manifest.json

/srv/bidmaster/
  data/
  backups/
```

权限：

- `.env`：`0600`
- data/backups：仅部署用户和容器运行用户可读写
- Nginx 配置只含非 secret 路由值

## 6. Production 环境变量

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=3000

OAUTH_MODE=mainquest
MAINQUEST_AUTH_BASE_URL=https://<MAINQUEST_AUTH_DOMAIN>
MAINQUEST_OAUTH_CLIENT_ID=<CLIENT_ID>
MAINQUEST_OAUTH_CLIENT_SECRET=<SECRET>
MAINQUEST_OAUTH_REDIRECT_URI=https://<BIDMASTER_DOMAIN>/api/auth/callback
PUBLIC_BASE_URL=https://<BIDMASTER_DOMAIN>
TRUST_PROXY_HOPS=1

SESSION_SECRET=<RANDOM_SECRET>
CONFIG_ENCRYPTION_KEY=<RANDOM_KEY>
BIDMASTER_TENANT_ID=<TENANT_ID>
BIDMASTER_DATA_DIR=/data

SESSION_TTL_DAYS=7
UPLOAD_MAX_SIZE_MB=50

BIDMASTER_CPUS=<CPU_LIMIT>
BIDMASTER_MEMORY_LIMIT=<MEMORY_LIMIT>
BIDMASTER_SHM_SIZE=<SHM_SIZE>
```

模型 API key 由用户通过设置页写入加密配置；不放入前端 bundle、Compose 或访问日志。

## 7. Production Compose 合同

```yaml
services:
  web:
    image: ghcr.io/zangqing828-ux/bidmaster-web@sha256:<digest>
    env_file:
      - .env
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - /srv/bidmaster/data:/data
    restart: unless-stopped
    stop_grace_period: 40s
    cpus: "${BIDMASTER_CPUS}"
    mem_limit: "${BIDMASTER_MEMORY_LIMIT}"
    shm_size: "${BIDMASTER_SHM_SIZE}"
    security_opt:
      - no-new-privileges:true
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: "5"
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))
      interval: 30s
      timeout: 5s
      start_period: 20s
      retries: 3
```

容器保持非 root 运行。若 Chromium 需要 `--no-sandbox`，只允许在非 root + container `no-new-privileges` 边界下使用，并由安全测试覆盖。

## 8. Nginx 合同

```nginx
server {
    listen 443 ssl http2;
    server_name <BIDMASTER_DOMAIN>;

    ssl_certificate <TLS_CERT_PATH>;
    ssl_certificate_key <TLS_PRIVATE_KEY_PATH>;

    client_max_body_size 520m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    location /api/uploads {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_request_buffering off;
        proxy_read_timeout 600s;
    }

    location /api/tasks/events {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        add_header X-Accel-Buffering no;
    }
}
```

Host Nginx 终止 TLS。证书签发、续期与到期告警必须在首次 staging 前确定 owner。
`520m` 只覆盖最多 10 个 50 MB 文件加 multipart 开销；应用仍按单文件 50 MB 和最多
10 个文件校验。应用自身会返回 `X-Accel-Buffering: no`；代理配置仍需显式关闭缓冲。

## 9. 首次 staging 部署

```bash
cd /opt/bidmaster
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml config
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs --tail=200 web
```

基础检查：

```bash
curl -fsS https://<BIDMASTER_DOMAIN>/api/health
curl -fsS https://<BIDMASTER_DOMAIN>/api/readiness
curl -sSI https://<BIDMASTER_DOMAIN>/api/auth/login
```

预期：

- health 200。
- readiness 200，data/auth DB/tenant DB/dist/Chromium/fonts 全部 ok。
- login 302 到 MainQuest `/oauth/authorize`。
- state Cookie 带 `Secure; HttpOnly; SameSite=Lax`。

## 10. staging 业务验收

### 10.1 Auth

1. 用户 A 登录成功。
2. 用户 B 登录成功。
3. 用户 C 在 MainQuest authorize 被 `access_denied`，BidMaster 无 session。
4. state mismatch 回调失败。
5. logout 后 session 无法继续访问 `/api/auth/me`。

### 10.2 单租户

1. A 创建测试方案并保存模板。
2. B 登录后能看到该方案和模板。
3. B 的 Cookie 不能替代 A 的 session ID。
4. A/B 同时提交冲突任务时，系统只运行一个并给出明确提示。

### 10.3 完整业务

运行一个小型真实方案：

- PDF 上传
- 招标分析
- 目录
- 全局事实
- 正文
- Mermaid/HTML/AI 图片
- 高保真 DOCX 下载

### 10.4 SSE

- 任务运行时持续观察 15 分钟。
- 浏览器收到心跳和进度。
- 断网后恢复连接，页面从 Store 恢复。

### 10.5 Restart

```bash
docker compose -f docker-compose.prod.yml restart web
```

确认：

- health/readiness 恢复。
- A/B 可重新打开已有数据。
- 已完成图片存在。
- 中断任务显示 retryable interrupted。
- 继续/重试后完成。

## 11. 备份

首发采用冷备份，换取最简单的一致性。

```bash
cd /opt/bidmaster
docker compose -f docker-compose.prod.yml stop web
tar --numeric-owner -C /srv/bidmaster \
  -czf /srv/bidmaster/backups/bidmaster-data-<UTC_TIMESTAMP>-<GIT_SHA>.tar.gz \
  data
docker compose -f docker-compose.prod.yml start web
```

备份后：

```bash
tar -tzf /srv/bidmaster/backups/bidmaster-data-<UTC_TIMESTAMP>-<GIT_SHA>.tar.gz > /dev/null
sha256sum /srv/bidmaster/backups/bidmaster-data-<UTC_TIMESTAMP>-<GIT_SHA>.tar.gz
curl -fsS https://<BIDMASTER_DOMAIN>/api/readiness
```

数据备份不包含 `.env`。每次发布前必须确认 `CONFIG_ENCRYPTION_KEY`、`SESSION_SECRET` 和
MainQuest client secret 已在批准的 secret store 或离线保管位置存在可恢复副本。
其中 `CONFIG_ENCRYPTION_KEY` 丢失会导致模型配置无法解密，属于恢复阻断项。

保留策略由运维 owner 确认；未确认前至少保留首次发布前、每次升级前和最近三份。

## 12. 恢复演练

在独立目录执行，禁止覆盖当前 data：

```bash
mkdir -p /srv/bidmaster/restore-test
tar -xzf /srv/bidmaster/backups/<BACKUP_FILE> \
  -C /srv/bidmaster/restore-test
```

用不同宿主端口启动同 digest，把 `/srv/bidmaster/restore-test/data` 挂到 `/data`。
测试容器使用与备份对应的 `CONFIG_ENCRYPTION_KEY`；session secret 可保持一致，也可轮换后
要求用户重新登录。

验证：

- readiness
- A/B 账号映射
- 测试方案
- 模板
- 图片
- DOCX 导出

演练完成后停止测试容器；保留校验日志，删除临时恢复目录前确认无唯一数据。

## 13. 镜像回滚

发布前记录：

```json
{
  "gitSha": "<GIT_SHA>",
  "imageDigest": "sha256:<NEW_DIGEST>",
  "previousImageDigest": "sha256:<OLD_DIGEST>",
  "backupFile": "<BACKUP_FILE>"
}
```

回滚步骤：

1. 停止新任务受理。
2. 冷备份当前 `/data`。
3. Compose image 改回 `<OLD_DIGEST>`。
4. `docker compose up -d`。
5. health/readiness/Auth/已有数据检查。
6. 若新版本改变持久化协议且旧版本无法读取，停止应用并恢复升级前备份。

禁止在应用运行写入时直接覆盖 SQLite 或文件目录。

## 14. 发布后观察

首个 24 小时检查：

- health/readiness
- OAuth 成功/失败率
- 401/403/5xx
- SSE 连接与断线
- AI/renderer/export 错误
- `/data` 空间
- 容器内存峰值、OOM/restart 和 Chromium 残留进程

日志只记录事件、状态码、task ID、耗时和安全摘要；不记录用户正文、API key、OAuth code、Cookie 和完整模型响应。

## 15. Staging 签字表

| 项 | 结果 | 证据 | Owner |
|---|---|---|---|
| image digest |  |  |  |
| health/readiness |  |  |  |
| MainQuest A/B/C |  |  |  |
| 两用户共享租户 |  |  |  |
| 完整业务链 |  |  |  |
| 三类图片 |  |  |  |
| 高保真 DOCX |  |  |  |
| SSE 15 分钟 |  |  |  |
| restart recovery |  |  |  |
| backup/restore |  |  |  |
| old digest rollback |  |  |  |
| 日志脱敏 |  |  |  |
