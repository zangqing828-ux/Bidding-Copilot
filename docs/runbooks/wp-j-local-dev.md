# WP-J 本地开发与验收 Runbook

## 适用范围

本 Runbook 用于 WP-J 技术方案主链路的本地开发、聚合门禁和 Docker 基线验证。J-1 当前覆盖：

- 多标段识别与选段；
- 招标分析到目录生成；
- 页面刷新后的账号工作区恢复；
- Web 与 Electron 共用 portable core，环境差异停留在 adapter。

J-2 正文生成和 J-3 Agent Quality 尚未进入本 Runbook 的完成口径。

## 前置条件

- Node.js 22；
- Docker Desktop；
- 从仓库 `client/` 目录执行 npm 命令；
- 首次运行先执行 `npm ci`。

测试与本地开发只能使用 mock OAuth 和测试密钥。不要把生产 OAuth Secret、API Key 或用户文件写入仓库。

## 本地启动

终端 A：

```bash
cd client
npm run dev:web
```

服务地址：

- Web UI：`http://127.0.0.1:5173`
- Web API：`http://127.0.0.1:3000`
- Mock 登录：访问 UI 后按登录流程进入，默认由 `OAUTH_MODE=mock` 提供。

如 5173 或 3000 已被占用，先停止占用进程；`dev:web` 使用固定端口，端口冲突会直接失败。

## J-1 聚合门禁

终端 B：

```bash
cd client
npm run wp-j:gate:j1
```

通过标准：

- shared DTO、RunManifest、adapter mapping 全部通过；
- 多标段与目录 portable runner 通过；
- Store schema、stage revision、CAS 和插图凭据迁移通过；
- Web 技术方案成功链、输入变化拒写和持久化恢复通过；
- Renderer build 通过。

真实浏览器链路：

```bash
cd client
npm run test:web-technical-plan-browser
```

该测试启动 Chromium，完成 mock 登录、多标段识别、选择第二标段、招标分析、目录生成和刷新恢复。验收结果必须只包含已选标段内容。

## 全量回归

```bash
cd client
npm run test:web
npm run test:web-browser
npm run build
npm run audit:production
```

保留 Electron 兼容时执行：

```bash
cd client
npm run smoke:electron-native
npm rebuild better-sqlite3 --runtime=node
```

最后一条命令用于恢复 Web/Node ABI。

## Docker 验证

从仓库根目录执行：

```bash
docker build -t bidding-copilot-web:wp-j-local .
docker run -d --name bidding-copilot-wp-j-local -p 3010:3000 \
  -e NODE_ENV=test \
  -e OAUTH_MODE=mock \
  -e WEB_BID_ANALYSIS_TEST_MODE=1 \
  -e SESSION_SECRET=local-test-secret \
  -e CONFIG_ENCRYPTION_KEY=local-test-key \
  -e YIBIAO_DATA_DIR=/data \
  bidding-copilot-web:wp-j-local
curl -fsS http://127.0.0.1:3010/api/health
curl -fsS http://127.0.0.1:3010/api/readiness
```

验证结束后清理临时容器：

```bash
docker stop bidding-copilot-wp-j-local
docker rm bidding-copilot-wp-j-local
```

不要删除 Docker volume 或账号工作区数据。

## 常见故障

### better-sqlite3 ABI 不匹配

现象通常包含 `NODE_MODULE_VERSION`。执行：

```bash
cd client
npm rebuild better-sqlite3 --runtime=node
```

### J-1 返回 TASK_INPUT_CHANGED

说明任务运行期间，招标文件、选段、招标分析、知识选择、目录配置或运行配置发生变化。刷新页面并重新启动当前步骤。该错误是 CAS 主动拒绝旧结果覆盖新状态。

### Docker readiness 失败

执行：

```bash
docker logs bidding-copilot-wp-j-local
```

重点检查数据目录权限、SQLite migration、mock OAuth 环境变量和 3000 端口监听。

### 浏览器测试失败

执行：

```bash
cd client
npx playwright install chromium
npm run test:web-technical-plan-browser
```

保留 Playwright trace 和截图；不得用跳过断言或改成 HTTP-only 测试的方式消除失败。
