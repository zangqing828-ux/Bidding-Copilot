# Sprint 07 Spec：容器部署与整体验收

## 1. Sprint 结果

产出可重复构建、可通过 Docker 启动、具有健康检查、持久化和回滚说明的 Web v1 发布候选，并完成全部保留业务回归。

## 2. 前置条件

- Sprint 01 至 06 全部为 `PASS`。
- 正式域名、端口、OAuth 回调和部署环境已确定。
- 生产密钥由安全渠道提供。
- 外部生产发布需要老板另行授权。

## 3. 部署范围

建议新增：

```text
Dockerfile
docker-compose.yml
.dockerignore
.env.example
client/server/health/readiness.cjs
docs 或 .planning 中的 Web 部署说明
```

容器包含：

- Node 运行时。
- Web 生产静态资源。
- `better-sqlite3` 运行依赖。
- Chromium 与 Playwright 运行依赖。
- LibreOffice。
- 中文字体。
- OpenCode Linux 二进制和 `rg/fd/jq`。

## 4. 运行要求

- 非 root 用户运行应用。
- `/data` 为唯一业务持久卷。
- `/api/health` 提供 liveness。
- readiness 检查数据目录、系统库和关键运行时可用性。
- 环境变量缺失时启动失败并列出缺失配置名。
- 服务监听 `0.0.0.0`，公开地址由 `PUBLIC_BASE_URL` 指定。
- 正确设置 `trust proxy`。
- 日志输出到 stdout/stderr，敏感内容脱敏。
- 优雅关闭停止接收新任务，并在超时内释放 SQLite、Chromium 和子进程。

## 5. 最小配置

`.env.example` 只包含占位符：

```text
NODE_ENV=production
PORT=3000
PUBLIC_BASE_URL=
DATA_ROOT=/data
MAINQUEST_AUTH_BASE_URL=
MAINQUEST_OAUTH_CLIENT_ID=
MAINQUEST_OAUTH_CLIENT_SECRET=
MAINQUEST_PRODUCT_ID=
MAINQUEST_OAUTH_REDIRECT_URI=
SESSION_SECRET=
CONFIG_ENCRYPTION_KEY=
```

任何真实值都不提交。

## 6. SDD 方案

- 模式：SDD Heavy。
- 开发工包 A：Dockerfile、依赖、非 root 运行和健康检查。
- 开发工包 B：compose、配置模板、持久卷和部署文档。
- 开发工包 C：端到端验收脚本和发布检查单。
- A/B 可并行；C 在镜像可运行后开始。
- 审查：Terra High + Sol Medium。
- Terra 重点：密钥、持久化、权限、健康检查、进程退出、回滚和业务回归。
- Sol 重点：部署复杂度、单实例假设和交付完整性。

## 7. 完整验收场景

### 7.1 身份

- 正常登录。
- 无权限账号。
- state 错误。
- 会话过期。
- 主动退出。

### 7.2 数据隔离

- 账号 A 创建数据。
- 账号 B 无法查看。
- 账号 A 重新登录仍可查看。
- 容器重启后数据仍在。

### 7.3 保留业务

- 技术方案生成。
- 已有方案扩写。
- 知识库导入和检索。
- 标书查重。
- 废标项检查。
- 模板与导出格式。
- Word 导出下载。

### 7.4 任务与恢复

- SSE 进度。
- 页面刷新。
- 断线重连。
- 暂停、恢复、取消。
- 进程重启后的可解释状态。

### 7.5 视觉

- 页面矩阵全部为 MQDS 浅色。
- 旧蓝紫品牌主色无残留。
- 组件与布局保持 Sprint 05 基线。
- 无深色模式入口。

### 7.6 删除能力

- 菜单无三个入口。
- 路由无三个页面。
- 浏览器 bundle 和服务端启动无插件管理链路。
- `analytics/` 服务保持存在。

## 8. 发布门

必须全部通过：

```bash
cd client
npm ci
npm run build
npm run build:web
npm run test:web
```

容器：

```bash
docker compose build
docker compose up -d
curl -fsS http://127.0.0.1:3000/api/health
docker compose restart
curl -fsS http://127.0.0.1:3000/api/health
docker compose down
```

安全检查：

- 前端 bundle 搜索 OAuth secret、session secret、配置主密钥。
- 普通日志搜索 API Key、Token、Prompt 和绝对用户路径。
- 两账号越权测试。
- 上传大小、类型和路径测试。

Electron 回归：

```bash
cd client
npm run build
npm run smoke:electron-native
```

## 9. 回滚

- 每个镜像使用不可变版本号和 Git SHA。
- 部署前备份 `/data/system` 和 `/data/users`。
- 回滚只切换镜像，持久卷不删除。
- schema migration 必须在 Sprint 04 起持续验证向前兼容。
- 回滚演练至少完成一次。

## 10. 交付物

- Dockerfile 和 compose。
- `.env.example`。
- 构建与启动说明。
- 数据备份和回滚说明。
- OAuth 配置清单。
- 端到端验收记录。
- SDD 执行 manifest。
- 最终冻结 commit SHA。

## 11. 最终 SDD manifest

最终报告至少包含：

```text
Mode
Mode evidence
Developer packages
Implementation models
Adversarial reviewer
First-principles reviewer
Repair model
Model route verified
Quota debit verified
Worker sessions
Reviewer calls
Measured wall time
Token accounting
Changed files or commits
Verification
Verdict
Residual risk
```

## 12. 完成边界

Sprint 07 `PASS` 代表仓库内已形成可部署发布候选。推送远端、创建 PR、注册 MainQuest OAuth 应用和生产发布均需要单独指令。
