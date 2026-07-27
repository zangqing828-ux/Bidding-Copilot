# Agent Runner Sidecar 基础镜像

这组文件提供 WP-J T6/T7 的独立 Runner 基础设施：

- `Dockerfile` 只复制 Sidecar Protocol、Runner API 和安全策略依赖；
- 容器默认使用 UID/GID `10001`，不以 root 运行；
- `seccomp/agent-runner.json` 默认拒绝系统调用，仅在 `agent-internal` 网络命名空间内允许连接 Web internal AI Proxy；
- `client/agent-runner/securityPolicy.cjs` 固化只读根目录、只读输入、独立可写输出、无新增权限、能力集清空和资源预算。

生产装配时必须由 Integration Lane 额外提供：

- 仅加入 `agent-internal` 的网络拓扑和出站拒绝；
- `--read-only`、独立输出目录、tmpfs、`cap_drop: [ALL]`、`no-new-privileges`、seccomp、PID/CPU/内存配额；
- 经过校验的 OpenCode 版本与完整性信息。

Runner 进程会使用固定 checksum 资产启动 OpenCode，任务目录限定在有界临时根目录，完成、取消、超时和关闭都会清理。生产 Compose 必须继续提供 `agent-internal` internal network、无公开端口、read-only root、seccomp、no-new-privileges、cap_drop 和资源上限。
