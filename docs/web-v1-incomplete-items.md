# Web MainQuest v1 未完成项清单

> 记录于 Sprint 01-07 集成后，PR #3 合入前。这些项不阻断 v1 骨架合入，但需后续迭代完成。

## P1：Linux Agent Runtime + Chromium 渲染 + LibreOffice Word 导出

**来源**：Sprint 05 工包 B/C（缩减范围时跳过）

- `prepare-opencode-binary.cjs` 只支持 Windows/macOS，缺 `linux-x64`
- `prepare-opencode-tools.cjs` 缺 Linux 的 `rg`/`fd`/`jq`
- Dockerfile 未安装 Chromium、LibreOffice、OpenCode
- `localImageRenderService.cjs` 的渲染 adapter 仍依赖 Electron BrowserWindow（已延迟加载，Web 端调用会抛错）
- `exportService.cjs` 的 Word 导出仍调用 Electron dialog（Web 端返回 501）
- Mermaid/HTML 图片渲染在 Web 端不可用

**建议**：新增 Sprint 08 或纳入 v1.1，在 Docker 环境内完成 Playwright/Chromium + LibreOffice 安装和适配器实现。

## P1：真实 AI 请求能力

**来源**：Sprint 05（aiService 为占位 stub）

- `server/workspace/webServices.cjs` 的 `createWebAiServiceStub` 所有方法 reject
- bridge dispatcher 的 `tasks.startXxx` 全部抛错（"Web 端任务启动尚未实现"）
- `ai.chat`/`ai.requestJson` 返回 501
- 技术方案生成、目录生成、正文生成、查重分析、废标检查等业务任务无法执行

**建议**：创建 Web 端真实 aiService，复用 `electron/services/aiService.cjs` 的 HTTP 请求逻辑，配置从 `encryptedConfigStore.loadDecrypted()` 读取。需处理 AI 请求队列、重试、token 统计。

## P1：文件上传解析链路

**来源**：Sprint 04（上传端点已实现，业务适配未接入）

- `server/routes/uploads.cjs` 可接收 multipart 上传，返回 fileId
- 但 `technicalPlan.importTenderDocument`、`knowledgeBase.uploadDocuments`、`rejectionCheck.importDocument`、`duplicateCheck` 文件选择仍返回 501
- 需要把上传后的 fileId 转为服务端文件路径，调用 `fileService.parseDocumentWithConfig` 解析
- 知识库上传需要 SSE 进度推送（Sprint 05 SSE 已有骨架）

**建议**：在 bridge dispatcher 中增加文件导入适配层，接收 fileId → 解析 → 写入 Store。

## P2：真实 MainQuest OAuth 环境验收

**来源**：Sprint 03（代码完整，缺真实联调）

- OAuth 授权码流程、state CSRF、会话管理代码已完成
- mock 模式端到端验证通过
- 缺真实 MainQuest Auth 环境的登录/回调/无权限账号/反向代理回调验收
- 需要在 MainQuest Auth Admin 注册 Bidding Copilot OAuth Application

**建议**：部署到测试环境后完成真实 OAuth 联调。

## P2：测试体系诚实性

**来源**：外部审查指出"把失败状态计为成功"

- `test:web-tasks` 测试 5 断言"任务启动返回 500"——这是验证占位行为，不是验证业务完成
- `test:web-export` 断言"导出返回 501"——同上
- SSE 隔离测试只建立空连接，未验证事件归属
- 缺少真实业务 E2E 测试（技术方案完整生成 + Word 下载）

**建议**：在 P1 项完成后，把占位测试改为真实业务测试，新增端到端验收脚本。

## P2：Electron ABI 双向回归

**来源**：外部审查指出 ABI 切换不可靠

- `prestart:web`/`predev:web` 重建 Node ABI，`prestart`/`presmoke:electron-native` 重建 Electron ABI
- 但 CI 未执行 `smoke:electron-native`，无法发现 ABI 回归
- 建议 CI 在 Web 测试后执行 Electron ABI 恢复 + native smoke

**建议**：CI 增加 `npm run smoke:electron-native` 步骤（在 Web 测试之后、ABI 恢复之后）。

## P2：Docker 镜像运行时依赖

**来源**：Sprint 07（Dockerfile 基础完成，缺运行时依赖）

- Dockerfile 未安装 Chromium（Mermaid/HTML 渲染需要）
- Dockerfile 未安装 LibreOffice（Word 导出转换需要）
- Dockerfile 未安装 OpenCode Linux 二进制和 rg/fd/jq（Agent Runtime 需要）
- readiness 检查未覆盖这些运行时依赖

**建议**：在 P1 Linux Runtime 完成后，更新 Dockerfile 安装这些依赖，readiness 增加检查。
