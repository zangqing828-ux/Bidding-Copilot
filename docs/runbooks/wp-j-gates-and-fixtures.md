# WP-J Gates 与 Fixtures

## 本地门禁

从仓库根目录执行：

```bash
cd client
npm run test:web-agent-sidecar
npm run test:web-image-boundary
npm run test:opencode-checksum
npm run test:wp-j:j2-core
npm run wp-j:gate:j2
npm run wp-j:doctor
npm run wp-j:rollback-smoke
```

Node 语法与现有 Web 门禁仍需执行：

```bash
find server core shared agent-runner scripts -name '*.cjs' -print0 | xargs -0 -n1 node --check
npm run test:web
npm run build:web
```

Docker 可用时补充：

```bash
cd ..
docker compose config
docker build --target production -t bidmaster-web:wp-j .
docker build --target agent-runner -t bidmaster-agent:wp-j .
docker build -f docker/agent-runner/Dockerfile -t bidmaster-agent:wp-j-independent .
```

`wp-j:gate:j2` 包含 J-2 Core、Web contract、portable core 和 Node build；浏览器门禁保持独立执行。

## Fixture 与测试映射

| 门禁 | 覆盖内容 |
| --- | --- |
| `test-wp-j-sidecar-protocol` | Token 绑定、重放、冲突、调用上限、取消幂等 |
| `test-wp-j-sidecar-api` | Runner/Internal HTTP 路由、公开路由拒绝、真实请求响应 |
| `test-wp-j-sidecar-security` | seccomp、身份、Token 类型、路径和结果上限 |
| `test-wp-j-web-image-boundary` | Web production 与 Runner target 的 Docker 分层、工具隔离、Compose 资源边界 |
| `test-opencode-checksum` | 下载归档 checksum 正确值与错误值拒绝 |
| `wp-j-rollback-smoke` | 持久化卷、备份、schema 兼容和回滚文档入口 |

错误 checksum 测试必须保留失败断言，不能通过跳过 Docker 构建或删除 checksum 校验来让门禁变绿。Web 镜像负向测试必须确认 Runner 专用文件和工具没有进入 production target。

## CI Job

WP-J J3 Integration 增加以下 required job：

- `CI / Agent Sidecar Security`：Node 安全测试、Web 镜像边界和 doctor。
- `CI / Agent Sidecar E2E`：Sidecar 协议/API 测试、独立 Runner 镜像构建和非 root 运行检查。

两个 job 都进入 `CI / Quality Gate` 汇总。Linux Docker 行为以远端 CI 为准，本机 macOS 只记录能实际运行的 Node 与静态检查结果。
