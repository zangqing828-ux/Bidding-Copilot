# Sprint 05 Spec：后台任务、Linux Runtime 与导出

## 1. Sprint 结果

保留业务的耗时任务可以在 Linux Web 服务中运行，通过 SSE 向浏览器推送进度；OpenCode 或 Pi 至少一套 Runtime 稳定可用；Mermaid/HTML 图片和 Word 导出可在浏览器下载。

## 2. 前置条件

- Sprint 04 为 `PASS`。
- 账号 workspace context 已覆盖 Store、文件和配置。
- Docker 基础环境允许安装 Chromium、LibreOffice 和中文字体。

## 3. 后台任务与 SSE

- 复用 `taskService.cjs` 的 callback subscription。
- 新增账号维度的 task ownership。
- SSE 连接只订阅当前账号事件。
- 页面加载顺序保持“先读 Store，再订阅事件，再请求 active tasks”。
- SSE 断开不取消后台任务。
- 浏览器重连时通过 active task 和持久化状态恢复展示。
- 服务器重启后，对失去 active runtime 的 running 状态给出可解释的恢复或重试提示。

建议接口：

```text
GET  /api/events
GET  /api/tasks/active
POST /api/tasks/:type/start
POST /api/tasks/:id/pause
POST /api/tasks/:id/resume
POST /api/tasks/:id/cancel
```

实际路由可以按现有 bridge 分组，事件和权限语义必须一致。

## 4. Linux Agent Runtime

- `prepare-opencode-binary.cjs` 增加 `linux-x64`。
- `prepare-opencode-tools.cjs` 增加 Linux 的 `rg`、`fd`、`jq`。
- 校验下载资产名、可执行权限和运行时路径。
- Docker 构建阶段准备固定版本，运行时不依赖临时下载。
- 保留 Pi Runtime 作为现有可选项。
- OpenCode 失败时不自动切换 Pi，沿用当前产品规则。

## 5. 图片渲染与导出

- 把 `localImageRenderService.cjs` 中 Electron `BrowserWindow` 渲染替换为环境适配器。
- Electron adapter 继续使用现有实现。
- Web adapter 使用 Playwright/Chromium。
- Mermaid 与可信 HTML 在本地浏览器内渲染后导出图片。
- Word 导出继续复用 `exportService.cjs` 的文档生成逻辑。
- 导出产物进入当前账号目录，并通过受控 download ID 返回。
- 需要 LibreOffice 的转换在容器内执行，超时与失败写入任务状态。

## 6. AI 与 Agent 服务

- AI、Agent 只读取当前账号解密后的配置。
- 任务启动时绑定账号、workspace、runtime 和 queue scope。
- 事件、日志、任务记录都带内部 workspace ID。
- 浏览器日志不包含 Prompt、正文、Key 和服务端绝对路径。

## 7. SDD 方案

- 模式：SDD Heavy。
- 开发工包 A：task ownership、SSE、active task 恢复。
- 开发工包 B：Linux OpenCode 与工具准备。
- 开发工包 C：Chromium 渲染 adapter、Word 导出下载。
- A/B/C 可在接口冻结后并行；`package.json`、Docker 依赖和共享 service 修改由主线程集成。
- 审查：Terra High + Sol Medium。
- Terra 重点：任务串号、事件泄漏、进程重启、子进程、超时、导出资源和 Linux 兼容。
- Sol 重点：运行时依赖、恢复语义和部署复杂度。

## 8. 验收标准

- 两账号同时运行任务时只收到自己的事件。
- 页面刷新后能恢复当前任务和进度。
- SSE 断线重连不重复启动任务。
- Linux 容器内至少一套 Agent Runtime 完成目录或正文生成测试。
- 暂停、恢复、取消沿用现有业务语义。
- Mermaid、HTML 图片可生成。
- Word 文件可生成并下载。
- 文件下载后内容、图片和目录结构正确。
- Electron 现有渲染与导出路径保持通过。
- 子进程、浏览器和临时文件在成功、失败、取消后正确释放。

## 9. 验证

自动化覆盖：

- SSE 账号隔离和重连。
- active task 恢复。
- 任务互斥组。
- Linux tool resolution。
- renderer adapter 接口。
- 导出 download ownership。

命令：

```bash
cd client
npm run build
npm run verify-opencode-tools
npm run test:web-tasks
npm run test:web-export
```

容器冒烟：

```bash
docker build -t bidding-copilot-web:test .
docker run --rm bidding-copilot-web:test node client/scripts/verify-opencode-tools.cjs
```

手动业务流：

- 上传测试标书。
- 运行标书分析和目录生成。
- 观察 SSE 进度并刷新页面。
- 生成含 Mermaid 的 Word 并下载打开。

## 10. 回滚

- 保留 Electron renderer adapter。
- Web renderer adapter 与 Linux Runtime 以新增路径接入。
- 导出失败不覆盖已有业务正文。
- 回滚时保留账号工作区和已生成文件。

## 11. Sprint 06 交接物

- 可运行的 Web 业务主链路。
- SSE 事件与恢复证据。
- Linux Runtime 验证记录。
- 导出样例和冻结 commit SHA。
