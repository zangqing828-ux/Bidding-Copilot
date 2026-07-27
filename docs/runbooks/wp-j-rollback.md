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

## 真实回滚 Smoke

回滚顺序固定为：

1. 关闭 `AGENT_QUALITY_ENABLED`；
2. 重启或切换 Web 版本；
3. 执行 `npm run wp-j:rollback-smoke`；
4. 确认 J-Core 可用后，再停止 `j-agent` Runner。

Smoke 使用临时 SQLite/runtime fixture，不连接生产数据，不修改仓库中的 Compose、CI 或 Sidecar 配置。它会创建并重新打开一个账号 Workspace，验证：

- technical-plan、uploads 等已有目录和上传资产仍在；
- 招标输入、原方案、目录、全局事实和已提交正文仍可读取；
- stage revisions、run manifest、run receipt 和 checkpoint 仍可读取；
- `AGENT_QUALITY_ENABLED=0` 时，J-Core 可以继续写入正文；
- Agent Task Spec 在开关关闭或 Runner 未就绪时均保持 fail closed；
- smoke 输出不包含密钥或临时绝对路径。

本地执行：

```bash
cd client
npm run wp-j:rollback-smoke
git diff --check
```

输出中的 `rollback_smoke` 必须为 `ok`，四项检查均必须为 `ok`。如果 smoke 失败，保留 J-Core 数据并停止回滚流程；不要删除 SQLite、manifest、receipt 或正文来恢复启动。

## 完成判定

- Web health/readiness 正常。
- OAuth 配置未被修改。
- 账号数据卷仍存在。
- doctor 输出不含 secret、Token、绝对路径和完整业务正文。
- 目标版本的 schema 与持久化契约已通过对应 Gate。
