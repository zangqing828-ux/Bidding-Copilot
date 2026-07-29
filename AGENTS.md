# AGENTS.md

## 必读与权威顺序

- 初次进入仓库，依次阅读 `project.md`、本文件、`client/开发说明.md`。
- 当前实施必须阅读 `.planning/web-single-tenant-release/baseline.md`。
- 追溯旧 Web 架构事实时，可阅读 `.planning/web-architecture-convergence/architecture-convergence.spec.md`。
- 涉及品牌、命名、外链、发布元数据或兼容标识时，必须阅读 `.planning/yibiao-brand-cleanup/brand-cleanup.spec.md`。
- 冲突时采用以下权威顺序：老板最新明确决策 > `project.md` 的锁定决策 > 单租户首发基线 > 本文件 > 两份历史 Spec > 旧 Sprint 文档、历史计划和代码注释。
- `.planning/web-mainquest-v1/`、`.planning/yibiao-brand-cleanup/plan.md`、两份历史 Spec 均不能单独证明当前范围或完成状态。

## 当前基线

- 实施起点：`origin/main@1c0a17eec348ffaeed1d7e1d0633483bf75fa2fb`。
- 集成分支：`codex/web-single-tenant-baseline`。
- 起点标签：`baseline/web-single-tenant-start-20260728`。
- 旧 WP-J 整合候选只通过 `archive/wp-j-complete-20260727` 保留为选择性迁移来源，禁止整体合并。
- 每个工作包从集成分支创建独立 `codex/web-st-*` 分支和 worktree；集成前必须提交验证证据。
- 首发业务源码净新增预算为 3,000 行；单工作包净新增超过 1,000 行时暂停并复审范围。

## 不可偏移的产品决策

- 交付形态为浏览器可完整使用、可由 Docker 单实例部署到 ECS 的纯 Web 应用。
- MainQuest OAuth 负责登录和 Product 访问授权；所有获授权用户共享同一个租户业务空间，同时保留各自独立 session 和身份记录。
- 首发用户可达范围只包含：生成技术方案、已有方案扩写、模板管理、设置。
- 首发主链路固定为：登录 -> 上传材料 -> 需求分析 -> 大纲 -> 事实材料 -> 正文 -> 图片 -> 高保真 DOCX -> 下载。
- 图片生成和高保真 DOCX 属于首发硬门槛；文本降级导出不能作为完成证据。
- 首发上传格式只支持 PDF、DOCX、TXT、Markdown。
- 产品展示品牌统一为 `BidMaster`，仓库地址统一为 `https://github.com/zangqing828-ux/Bidding-Copilot`。
- 资源下载、投标机会、插件管理及其菜单、路由、页面和运行入口保持删除。
- Electron 桌面发行、桌面回归 Gate、Agent Sidecar、Agent Runner、OpenCode/Pi、Agent Quality、多 workspace、多租户、知识库管理、查重、废标检查和 AI 评审均退出首发范围。
- 任何返回 `501`、stub、mock、占位成功、只验证错误码或尚未接入真实业务的用户可达能力，都不得标记为完成。
- 当前按无生产存量数据执行；一旦发现需保留的数据，立即停止破坏性数据改动并恢复迁移 Gate。

## 仓库范围

- `client/src/`：React Renderer，只面向 Web 正式交付。
- `client/server/`：Web 服务端、MainQuest OAuth、session、单租户上下文、上传/下载、SSE 和 Web 运行时装配。
- `client/core/`、`client/shared/`：运行环境无关的业务服务、契约、Prompt 和路径规则。
- `client/electron/`：历史能力来源。只允许选择性抽取可移植业务代码，禁止新增 Electron 产品能力或让 Web 依赖 Electron API。
- `analytics/`：独立 Cloudflare Worker 与 Dashboard，不属于首发 Web 运行时；没有对应 Spec 时不得顺手修改。
- 根目录没有 `package.json`；客户端命令从 `client/` 执行。

## 架构约束

- 目标分层为 `Renderer -> Web runtime bridge -> portable core -> Web adapters`。
- Renderer 不直接访问 Node、`fs`、`path`、`ipcRenderer`；浏览器只通过 Web Bridge 调用业务能力。
- Electron dialog、BrowserWindow、app paths、shell 和 IPC 不能进入 portable core 或 Web runtime。
- Web 请求是安全边界。所有 Web API 必须做认证、Product 授权、输入大小/类型校验和路径边界校验。
- 浏览器不得提交或读取服务器绝对路径；上传文件使用服务端生成的 file ID，并在固定 TenantContext 中解析。
- API Key、OAuth secret、session、用户文档正文和完整模型响应不得进入浏览器 bundle、普通访问日志或错误响应。
- 授权用户共享同一个 TenantContext、SQLite、文件目录、任务队列和 SSE 业务事件；用户 session 与身份审计保持独立。
- 进程内只能存在一个可复用 TenantContext；不得继续构建按账号动态创建的 workspace registry。
- Prompt 统一放在 `src/shared/prompts/` 或 portable core 对应模块，不在组件内硬编码大段 Prompt。
- 修改 bridge API 时，同步维护运行环境无关的接口类型、Web dispatcher 和契约测试。

## UI 约束

- UI 使用全局 CSS + Radix 基础组件，不使用 Tailwind。
- v1 保留现有组件、DOM 结构、布局几何和核心交互，只允许按 MainQuest MQDS 浅色 token 调整配色。
- 产品导航只保留首发范围；删除退出范围时，不借机重做信息架构。
- 用户可见文案使用中文；产品名保持 `BidMaster`。
- 成功、失败、警告和普通消息统一使用 `shared/ui/ToastProvider`，不要新增 `alert`。
- 页面根容器保持 `height: 100%` / `min-height: 0`，长内容在页面内部滚动。

## 数据与流程

- Web 数据根目录由配置注入；一个部署只解析一个固定 TenantContext。
- 用户配置由服务端加密保存；浏览器 `localStorage` 只允许保存轻量 UI 偏好。
- 结构化业务状态进入租户 SQLite；大文本、上传文件、图片和导出物进入租户目录。
- 技术方案正文展示和导出以 `outlineData.outline[*].content` 为权威来源。
- 长任务必须在服务端执行并持续落盘；页面刷新后从 Store 恢复，再通过租户 SSE 回放 active task。
- 目录重新生成、编辑、添加或删除后，必须清空旧正文内容、生成缓存和失效的图片计划。
- Mermaid 以 Markdown `mermaid` 代码块保存；Web 导出使用 Linux headless adapter，不依赖 Electron `BrowserWindow`。

## 开发与验证

- 安装：`cd client && npm ci`。
- Web 构建：`npm run build:web`；若脚本尚未收敛，先运行当前 `npm run build` 并记录差距。
- Web 聚焦测试：`npm run test:web`。占位错误测试不能替代真实成功路径和失败路径。
- CommonJS：只检查 Web 首发实际使用的 `server`、`core`、`shared` 和 `scripts`。
- Docker development smoke：从仓库根执行 `docker build -t bidmaster-web:local .`，以 mock OAuth 启动容器，检查 `/api/health`、`/api/readiness` 和登录后的真实 Store 调用。
- Docker production smoke：以 `NODE_ENV=production`、`OAUTH_MODE=mainquest` 启动，检查 readiness、OAuth authorize 跳转、Secure Cookie、SSE、上传、任务恢复和导出下载。
- 修改 Web native 依赖后验证 Linux Node ABI；Electron ABI 不属于首发 Gate。
- 修改依赖后运行 `npm audit --omit=dev --audit-level=critical`；已知关键漏洞必须清零。
- 完成标准必须包含真实成功链路、边界/失败链路、跨用户共享租户数据、session 隔离、持久化、重启恢复、图片和高保真 DOCX 验证。

## 变更纪律

- 默认先做最小工作包，保持每一处改动都能追溯到当前首发目标。
- 只选择性迁移旧分支中的必要能力；禁止整分支回灌和大规模重写。
- 保留用户已有改动，禁止清理未归档的脏工作区、修改未授权云资源或触碰仓库 Secrets。
- 删除分支或 worktree 前必须核验工作区洁净度、提交可恢复性和远程 PR 状态。
- 实施中发现必须扩大范围时停在 Gate，记录证据并请求老板决策。
