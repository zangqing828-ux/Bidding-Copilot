# Bidding Copilot Web v1 部署指南

## 前置条件

- Docker 和 Docker Compose
- 域名和 HTTPS 证书（由反向代理如 Caddy/Nginx 提供）
- MainQuest Auth 已注册 OAuth Application（获取 client_id / client_secret / product_id）
- 服务器至少 2C2G（推荐 4C4G）

## 配置

1. 复制 `.env.example` 为 `.env`
2. 填入真实值：
   - `PUBLIC_BASE_URL`：你的 HTTPS 域名
   - `MAINQUEST_OAUTH_CLIENT_ID` / `MAINQUEST_OAUTH_CLIENT_SECRET`：MainQuest Auth 注册的 OAuth 应用
   - `MAINQUEST_OAUTH_REDIRECT_URI`：`https://你的域名/api/auth/callback`
   - `SESSION_SECRET`：随机字符串（`openssl rand -hex 32`）
   - `CONFIG_ENCRYPTION_KEY`：随机字符串（`openssl rand -hex 32`）

## 构建与启动

```bash
# 构建镜像
docker compose build

# 启动服务
docker compose up -d

# 验证健康检查
curl -fsS http://127.0.0.1:3000/api/health

# 验证 readiness
curl -fsS http://127.0.0.1:3000/api/readiness
```

## 持久化

- 数据卷 `web-data` 挂载到容器 `/data`
- 系统身份库：`/data/auth.sqlite`
- 账号数据：`/data/users/<workspaceId>/`
- 容器重启后数据保留

## 反向代理

推荐使用 Caddy 自动 HTTPS：

```Caddyfile
your-domain.com {
    reverse_proxy localhost:3000
}
```

## 备份与回滚

### 备份

```bash
# 备份数据卷
docker run --rm -v web-data:/data -v $(pwd):/backup alpine \
    tar czf /backup/yibiao-data-$(date +%Y%m%d).tar.gz /data
```

### 回滚

1. 切换到旧版本镜像：`docker compose pull && docker compose up -d`
2. 持久卷不删除，数据保留
3. schema migration 向前兼容，旧版本可打开当前 schema

## 安全检查

- 前端 bundle 不含 OAuth secret / session secret / 配置主密钥
- 日志不输出 API Key / Token / Prompt / 绝对路径
- 两账号数据隔离验证
- 上传大小（50MB）、类型（.docx/.pdf/.doc/.txt/.md/.xlsx）、路径穿越防护

## 环境变量说明

| 变量 | 必填 | 说明 |
|---|---|---|
| `NODE_ENV` | 是 | 生产环境设为 `production` |
| `PORT` | 否 | 默认 3000 |
| `PUBLIC_BASE_URL` | 是 | HTTPS 域名 |
| `YIBIAO_DATA_DIR` | 否 | 默认 `/data` |
| `OAUTH_MODE` | 是 | 生产必须 `mainquest` |
| `MAINQUEST_AUTH_BASE_URL` | 是 | MainQuest Auth 地址 |
| `MAINQUEST_OAUTH_CLIENT_ID` | 是 | OAuth Client ID |
| `MAINQUEST_OAUTH_CLIENT_SECRET` | 是 | OAuth Client Secret |
| `MAINQUEST_OAUTH_REDIRECT_URI` | 是 | 回调地址 |
| `SESSION_SECRET` | 是 | 会话密钥 |
| `CONFIG_ENCRYPTION_KEY` | 是 | API Key 加密主密钥 |
| `SESSION_TTL_DAYS` | 否 | 默认 7 |
| `UPLOAD_MAX_SIZE_MB` | 否 | 默认 50 |
