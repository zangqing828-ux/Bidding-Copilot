# WP-J 回滚 Runbook

## 回滚原则

回滚只切换应用镜像和 Compose 配置，保留 `web-data` 与 `agent-output` 数据卷。执行前必须确认目标版本支持当前 SQLite schema、RunManifest 和 Store migration。

## 备份

```bash
docker compose stop
docker run --rm \
  -v bidding-copilot_web-data:/data:ro \
  -v "$PWD":/backup \
  alpine tar czf "/backup/bidmaster-data-$(date +%Y%m%d%H%M%S).tar.gz" /data
```

如启用了 Agent profile，同时备份 Runner 输出卷：

```bash
docker run --rm \
  -v bidding-copilot_agent-output:/output:ro \
  -v "$PWD":/backup \
  alpine tar czf "/backup/bidmaster-agent-output-$(date +%Y%m%d%H%M%S).tar.gz" /output
```

实际卷名以 `docker volume ls` 为准；不要删除卷来“修复”版本问题。

## 版本回退

```bash
git fetch origin
git checkout <目标版本>
docker compose build
docker compose --profile j-agent up -d
curl -fsS http://127.0.0.1:3000/api/readiness
```

若目标版本不支持当前 schema，先停止服务，恢复兼容备份，再启动目标镜像。迁移完成后运行：

```bash
cd client
npm run wp-j:rollback-smoke
npm run wp-j:diagnose
```

## Sidecar 回滚

Web 与 Runner 必须使用同一 Sidecar Protocol V1 版本。Web 镜像和 Runner 镜像出现协议不一致时，关闭 `j-agent` profile，保持 Web 主链路运行，随后回退两个镜像到同一提交。

```bash
docker compose --profile j-agent stop agent-runner
docker compose up -d web
```

## 完成判定

- Web health/readiness 正常。
- OAuth 配置未被修改。
- 账号数据卷仍存在。
- doctor 输出不含 secret、Token、绝对路径和完整业务正文。
- 目标版本的 schema 与持久化契约已通过对应 Gate。
