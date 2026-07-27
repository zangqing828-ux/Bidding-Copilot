# AGENTS.md

## 必读与权威顺序

- 初次进入仓库，依次阅读 `project.md`、本文件、`client/开发说明.md`。
- 涉及 Web 架构收敛时，必须阅读 `.planning/web-architecture-convergence/architecture-convergence.spec.md`。
- 涉及品牌、命名、外链、发布元数据或兼容标识时，必须阅读 `.planning/yibiao-brand-cleanup/brand-cleanup.spec.md`。
- 冲突时采用以下权威顺序：老板最新明确决策 > `project.md` 的锁定决策 > 两份当前 Spec > 本文件 > 旧 Sprint 文档、历史计划和代码注释。
- `.planning/web-mainquest-v1/` 和 `.planning/yibiao-brand-cleanup/plan.md` 是历史输入，不再作为当前实施范围或“已完成”证明。

## 不可偏移的项目决策

- 产品交付目标是可通过浏览器使用、可由 Docker 部署的 Web 应用；Web 不是 Electron 页面预览模式。
- MainQuest OAuth 是 Web 正式账号入口；每个 MainQuest 账号拥有独立配置、SQLite、文件、任务和导出空间。
- PR #3（基线提交 `e71e87c633de`）只完成 Web 运行骨架、认证/工作区基础设施和部分 Store bridge，不代表 Web 主业务链路完成。
- 实施顺序固定为：先完成 Web 架构收敛和真实业务闭环并通过验收，再执行品牌清理。不得用改名、换文案或删除旧标识掩盖架构缺口。
- 产品展示品牌统一为 `BidMaster`，仓库地址统一为 `https://github.com/zangqing828-ux/Bidding-Copilot`；旧品牌、旧域名、推广链接和 Star 诱导按品牌 Spec 清理。
- 品牌清理分开处理用户可见品牌与兼容性标识。禁止对持久化协议、数据库、环境变量、OAuth/CI 配置、云资源名做无迁移方案的全局替换。
- v1 前端保留现有组件、页面结构、布局和交互，只使用 MainQuest MQDS 浅色配色；不做深色模式、组件重做或信息架构重排。
- 资源下载、投标机会、插件管理及其产品侧菜单、路由、页面和运行入口保持删除，后续不得重新引入。
- Electron 仅作为迁移期兼容与回归基线；不新增 Electron-only 产品能力。是否最终删除桌面交付需由老板另行决策。
- 任何返回 `501`、stub、mock、占位成功、只验证错误码或尚未接入真实业务的能力，都不得标记为完成。

## 仓库范围

- `client/src/`：React Renderer，Web 与 Electron 共用界面。
- `client/server/`：Web 服务端、MainQuest OAuth、会话、账号隔离、上传/下载、SSE 和 Web 运行时装配。
- `client/electron/`：现有桌面适配器与待抽离的业务服务；不能继续把 Electron API 带入可复用 core。
- `client/shared/`：跨 Web/Electron 的运行环境无关契约与路径规则。
- `analytics/`：独立 Cloudflare Worker 与 Dashboard，不属于 Web 主运行时。产品侧删除插件管理不授权顺手删除 Analytics；如需调整，必须在对应 Spec 中明确。
- 根目录没有 `package.json`；客户端命令从 `client/` 执行。

## 架构约束

- 目标分层是 `Renderer -> runtime bridge -> portable core -> environment adapters`。
- Renderer 不直接访问 Node、`fs`、`path`、`ipcRenderer`；浏览器走 Web Bridge，Electron 走 preload bridge。
- 业务规则、Store、AI 队列、任务状态机和导出编排应逐步移到运行环境无关的 core；Electron dialog、BrowserWindow、app paths 和 shell 只能存在于 Electron adapter。
- Web 请求是安全边界。旧文档中的“本地客户端内部可信、无需校验”不适用于 `client/server/`。所有 Web API 必须做认证、授权、账号隔离、输入大小/类型校验和路径边界校验。
- 浏览器不得提交或读取任意服务器绝对路径。上传文件使用服务端生成的 file ID，并在当前账号工作区内解析。
- API Key、OAuth secret、session、用户文档正文和完整模型响应不得出现在浏览器 bundle、普通访问日志或错误响应中。
- 多账号上下文不得共享可变配置、任务队列、事件流、临时文件或导出结果；缓存必须以 workspace ID 为边界并可正确释放。
- Prompt 统一放在 `src/shared/prompts/` 或 portable core 的对应模块；不要在组件内硬编码大段 prompt。
- 新增或修改 bridge API 时，同步维护运行环境无关的接口类型、Web dispatcher、Electron preload/IPC 适配和契约测试。

## UI 约束

- UI 使用全局 CSS + Radix 基础组件，不使用 Tailwind。
- v1 只允许按 MQDS 浅色 token 改配色；不得改变组件、DOM 结构、布局几何、交互路径或信息架构。
- 用户可见文案使用中文；产品名保持 `BidMaster`。
- 成功、失败、警告和普通消息统一使用 `shared/ui/ToastProvider`，不要新增 `alert`。
- 页面根容器保持 `height: 100%` / `min-height: 0`，长内容在页面内部滚动。

## 数据与流程

- Web 数据根目录由配置注入；账号映射到服务端生成的稳定 workspace ID，实际数据位于该账号独立目录。
- Web 端用户配置必须服务端加密保存；浏览器 `localStorage` 只允许保存轻量 UI 偏好。
- 结构化业务状态进入账号独立 SQLite；大文本、上传文件、图片和导出物进入该账号目录。
- 技术方案正文展示和导出以 `outlineData.outline[*].content` 为权威来源。
- 长任务必须服务端执行并持续落盘；页面刷新后从 Store 恢复，再通过当前账号 SSE 回放 active task。
- WP-I PR I-1 已接通 Web `tasks.startBidAnalysis`；其余 Web 业务任务继续按 contract 标记 pending。该任务使用严格 DTO、input revision CAS 与每 Workspace 单一 mutation executor，调用方不得绕过这些边界直接写 Store。
- 目录重新生成、编辑、添加或删除后，必须清空旧正文内容、生成缓存和失效的图片计划。
- Mermaid 以 Markdown `mermaid` 代码块保存；Web 导出使用 Linux headless 渲染 adapter，不依赖 Electron `BrowserWindow`。

## 开发与验证

- 安装：`cd client && npm ci`。
- TypeScript/Renderer：`npm run build`。
- Web 聚焦测试：`npm run test:web`。占位错误测试不能替代真实业务成功路径和失败路径测试。
- CommonJS：`find electron scripts server -name '*.cjs' -print0 | xargs -0 -n1 node --check`。
- Docker development smoke：从仓库根执行 `docker build -t bidding-copilot-web:local .`，以 mock OAuth 启动容器，检查 `/api/health`、`/api/readiness`，登录后调用 `technicalPlan.loadState` 验证 Store Worker 链路。
- Docker production smoke：以 `NODE_ENV=production`、`OAUTH_MODE=mainquest` 启动容器，检查 readiness、OAuth authorize 跳转和 Secure state Cookie；该 smoke 不替代真实 MainQuest 环境联调。
- 改 Web native 依赖后，验证 Node ABI；保留 Electron 兼容时还要恢复 Electron ABI 并运行 `npm run smoke:electron-native`。该脚本在 Linux CI 使用 Electron `--no-sandbox`。
- 改依赖后运行 `npm audit --omit=dev --audit-level=critical`；不能把已知关键漏洞当作普通警告。
- 完成标准必须包含真实成功链路、边界/失败链路、账号隔离和持久化验证。测试如果只证明 `500/501` 可解释，只能说明占位受控。
- 浏览器 Agent 入口在 WP-I 继续保持 pending；首个正式 Agent 业务任务开放前，另行完成非 root、只读输入、egress deny、`no_new_privs`、seccomp 与资源配额的 OS 级隔离 Release Gate。应用级 permission 测试不构成该 Gate 证据。
- Agent Foundation 变更必须通过 `test:web-agent-protocol/runtime/coordinator/executor` 和独立 Docker `agent-e2e`；生产 runtime 镜像不得包含 fixture、受控 Provider 或测试 harness。

## SDD 与变更纪律

- 架构收敛跨 Web、认证、数据、任务、Linux Runtime 和导出，默认按 SDD Heavy 执行；品牌清理按其 Spec 的独立工作包执行。
- 每个并行 worker 使用独立分支/worktree和不重叠的写入范围；完成后提交并返回 commit SHA 与验证证据。
- 主线程负责范围、集成、审查裁决和最终验收；子代理结论不是自动批准。
- 保留用户已有改动，禁止顺手重构、扩大范围或修改未授权的云资源与仓库 Secrets。
- 设计阶段提出新增范围；进入实施后只执行已批准 Spec。发现必须扩展时停在 gate，记录证据并请求决策。
