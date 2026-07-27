# Agent Runner Sidecar 基础镜像

这组文件提供 WP-J T6/T7 的独立 Runner 基础设施：

- `Dockerfile` 只复制 Sidecar Protocol、Runner API 和安全策略依赖；
- 容器默认使用 UID/GID `10001`，不以 root 运行；
- `seccomp/agent-runner.json` 默认拒绝系统调用，并且不允许主动 `connect`；
- `client/agent-runner/securityPolicy.cjs` 固化只读根目录、只读输入、独立可写输出、无新增权限、能力集清空和资源预算。

生产装配时必须由 Integration Lane 额外提供：

- 仅加入 `agent-internal` 的网络拓扑和出站拒绝；
- `--read-only`、独立输出目录、tmpfs、`cap_drop: [ALL]`、`no-new-privileges`、seccomp、PID/CPU/内存配额；
- 经过校验的 OpenCode 版本与完整性信息。

当前镜像只承载协议与 Runner API 骨架，不宣称已经完成 OpenCode 进程编排、生产 Compose 装配或正式 Agent Task Spec 开放。上述集成属于 T8-T12 / Integration Lane，不能通过本目录的静态文件替代。
