# Web MainQuest v1 未完成项清单

> 记录于 Sprint 01-07 集成后，PR #3 合入前。这些项不阻断 v1 骨架合入，但需后续迭代完成。

## P1：Linux Agent Runtime + Chromium 渲染 + LibreOffice Word 导出

**来源**：Sprint 05 工包 B/C（缩减范围时跳过）

- Docker 镜像已提供 OpenCode Linux binary 与 `rg`/`fd`/`jq`，并由 readiness 检查；浏览器 Agent 业务能力仍未开放。
- Agent Execution Foundation 已通过真实 OpenCode Docker 两轮 tool-call、安全输出读取和清理；egress deny、seccomp、`no_new_privs` 与 cgroup 内存限制仍待 Release Gate。
- Dockerfile 未安装 Chromium、LibreOffice。
- `localImageRenderService.cjs` 的渲染 adapter 仍依赖 Electron BrowserWindow（已延迟加载，Web 端调用会抛错）
- Web Word 导出与一次性浏览器下载仍需在当前修复提交的完整浏览器和 Docker 门禁中复核。
- Mermaid/HTML 图片渲染在 Web 端不可用

**建议**：新增 Sprint 08 或纳入 v1.1，在 Docker 环境内完成 Playwright/Chromium + LibreOffice 安装和适配器实现。

## P1：真实 AI 请求能力与未接通业务任务

**来源**：Sprint 05（aiService 为占位 stub）

- WP-I PR I-1 已实现 `tasks.startBidAnalysis` 的 Web 执行链，当前 Draft PR #7 正在修复 strict DTO、input revision CAS、单一 mutation executor、SSE 与持久化任务状态的边界问题，完整门禁尚未通过。
- `ai.chat`/`ai.requestJson` 的浏览器入口仍保持 pending。
- 技术方案生成、目录生成、正文生成、知识库、查重和废标检查等业务任务仍未接通。

**建议**：后续业务任务复用现有 Web AI Runtime，并补足各自的真实成功、失败、隔离与恢复验收。

## P1：文件上传解析链路

**来源**：Sprint 04（上传端点已实现，业务适配未接入）

- `server/routes/uploads.cjs` 可接收 multipart 上传，返回 fileId；`technicalPlan.importTenderDocument` 已接通招标文件导入，浏览器 E2E 证据需随当前修复提交复核。
- `knowledgeBase.uploadDocuments`、`rejectionCheck.importDocument`、`duplicateCheck` 文件选择仍返回 501。
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

- `tasks.startBidAnalysis` 的真实 Web runtime 测试与浏览器 E2E正在随 Draft PR #7 修复复核；浏览器 E2E 使用 test-only AI 响应，仍需保留用户模型配置下的集成验收。
- 其余业务任务仍缺真实成功 E2E；不得以其占位错误测试标记完成。

**建议**：在 P1 项完成后，把占位测试改为真实业务测试，新增端到端验收脚本。

## P2：Electron ABI 双向回归（已退役）

**来源**：外部审查指出 ABI 切换不可靠

- WR-06A 已删除 Electron 桌面发行与 `smoke:electron-native`，Electron ABI 不再属于首发 Gate；CI 只验证 Linux Node ABI（`npm rebuild better-sqlite3 --runtime=node`）。

**建议**：仅维护 Web/Node native 依赖的 Linux ABI 验证；如未来重新引入桌面发行，再以新 Gate 方案评估 ABI 回归。

## P2：Docker 镜像运行时依赖

**来源**：Sprint 07（Dockerfile 基础完成，缺运行时依赖）

- Dockerfile 未安装 Chromium（Mermaid/HTML 渲染需要）
- Dockerfile 未安装 LibreOffice（Word 导出转换需要）
- Dockerfile 未安装 OpenCode Linux 二进制和 rg/fd/jq（Agent Runtime 需要）
- readiness 检查未覆盖这些运行时依赖

**建议**：在 P1 Linux Runtime 完成后，更新 Dockerfile 安装这些依赖，readiness 增加检查。
