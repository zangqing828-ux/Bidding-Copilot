# WP-J Agent Sidecar Runbook

## 目标

WP-J 将 Web Runtime 与 Agent Runner 拆成两个容器：Web 负责账号、工作区和业务请求；Runner 只加入 `agent-internal` 网络，承载 Sidecar Protocol V1 的内部接口。

当前阶段提供协议、Token、Runner API、容器安全边界和运维门禁。正式业务 Task Spec、OpenCode 进程编排和生产 Agent 能力需要后续工作包完成后再开启。

## 拓扑与启动

Web 同时连接：

- `web-egress`：Web 对外提供 HTTP，并访问 OAuth、AI 等外部服务。
- `agent-internal`：内部网络，启用 Docker `internal: true`。

Runner 只连接 `agent-internal`，Compose 不声明 `ports`。浏览器和反向代理不能直接访问 Runner。

```bash
cp .env.example .env
export YIBIAO_SIDECAR_SECRET="$(openssl rand -hex 32)"
docker compose --profile j-agent build
docker compose --profile j-agent up -d
```

只启动 Web 时：

```bash
docker compose up -d web
```

此时 Web 的 Agent feature flag 默认关闭，readiness 会将 Sidecar 标记为 `disabled`。

启用 Sidecar readiness：

```bash
AGENT_QUALITY_ENABLED=1 docker compose --profile j-agent up -d
```

## 安全边界

Runner 服务具备以下部署约束：

- UID/GID `10001`，禁止 root。
- 根文件系统只读，输出目录单独挂载为可写 volume。
- `tmpfs` 仅提供受限临时空间。
- `no-new-privileges`、`cap_drop: ALL`、seccomp profile。
- PID、CPU、内存、文件描述符和进程数上限。
- Runner 无公开端口；网络只允许内部网络。
- Sidecar Token 绑定 workspace、generation、execution、Task Spec、manifest 和 HTTP method/path。
- secret 只通过部署环境注入，任何 doctor、diagnose、readiness 输出都不打印 secret。

安全策略源文件：

- `client/agent-runner/securityPolicy.cjs`
- `docker/agent-runner/seccomp/agent-runner.json`
- `docker-compose.yml`

## 验证

```bash
cd client
npm run test:web-agent-sidecar-security
npm run test:web-agent-sidecar-e2e
npm run wp-j:doctor
npm run wp-j:readiness
npm run wp-j:diagnose
```

结构化输出只包含检查名、状态、协议版本和脱敏消息，不输出账号目录、Token、密钥、Prompt 或完整模型响应。

## 故障处理

1. `agent_sidecar` 为 `disabled`：确认是否需要 `AGENT_QUALITY_ENABLED=1`，并启动 `j-agent` profile。
2. `/api/readiness/agent-quality` 返回 `503` 或 `agent_sidecar` 为 `blocked`：先执行 `npm run wp-j:diagnose`，再检查 `docker compose --profile j-agent ps` 和 Runner 日志。此时主 `/api/readiness` 仍只反映 J-Core，不会因 Sidecar 阻断返回 503。
3. secret 缺失：重新注入 `YIBIAO_SIDECAR_SECRET`，不要把值写入仓库或日志。
4. seccomp 或资源限制导致 Runner 无法启动：先执行静态门禁，确认修改只发生在 Runner 配置，不放宽 Web 容器边界。
5. Sidecar 版本不匹配：确认 Web 与 Runner 来自同一提交，检查 `SidecarProtocolV1` 与 `version`。

## 当前发布边界

此 Runbook不代表 Agent 业务链路已经开放。浏览器 Agent API、正式 Task Spec、OpenCode tool-call E2E 和多实例调度仍需通过 WP-J 的后续 Gate。
