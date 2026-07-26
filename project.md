# BidMaster / Bidding Copilot 项目说明

## 文档地位

本文件记录项目级目标与已经确认的长期决策，是后续规划、实现和审查的产品基线。除老板新的明确决策外，不得用旧 README、旧 Sprint 文档、历史代码结构或兼容实现覆盖这里的结论。

当前实施文档：

- Web 架构收敛：`.planning/web-architecture-convergence/architecture-convergence.spec.md`
- 品牌清理：`.planning/yibiao-brand-cleanup/brand-cleanup.spec.md`

## 项目目标

基于 Bidding Copilot 现有投标业务能力，交付一个可在浏览器完成核心标书工作流、可使用 Docker 部署、通过 MainQuest OAuth 登录并按账号隔离数据的 `BidMaster` Web 产品。

目标不是给 Electron UI 外挂一个 HTTP 壳，而是建立能够在 Linux 容器中独立完成文件导入、AI/Agent 任务、进度恢复、图片渲染、Word 导出和下载的 Web 运行时。

## 2026-07-24 锁定决策

1. **架构优先。** PR #3 已合并，但只作为 Web 基线；其中的 stub、`500/501` 占位和缺失 Linux 运行时均是待完成项。先完成架构 Spec，再进入品牌清理。
2. **Web 是目标交付形态。** 正式候选必须能通过 Docker 在 Linux 启动并完成真实主业务链路。Electron 暂时保留为兼容/回归适配器，不新增桌面专属能力。
3. **账号边界固定。** Web 使用 MainQuest OAuth；账号配置、SQLite、上传、任务、SSE、临时文件和导出物必须隔离。
4. **UI 范围固定。** v1 不换组件、不改页面结构和交互，只应用 MainQuest MQDS 浅色配色；不做深色模式。
5. **删减范围固定。** 资源下载、投标机会、插件管理及其产品侧前端入口、路由和运行入口保持删除。
6. **品牌目标固定。** 用户可见产品名统一为 `BidMaster`，代码仓库统一指向 `zangqing828-ux/Bidding-Copilot`，旧品牌域名、推广链接和 Star 诱导清除。
7. **品牌清理不是全局替换。** 用户可见文案、发布元数据、外链先清理；持久化协议、数据库、环境变量、OAuth/CI、云资源和历史档案按兼容与迁移策略处理。没有迁移、回滚和验证证据，不得重命名。
8. **完成口径固定。** mock 可通过、接口存在、容器能启动或错误码可解释都不等于业务完成。只有真实成功路径、失败路径、账号隔离、重启恢复和交付验收全部通过，才可标记完成。

## PR #3 后的事实基线

基线提交：`e71e87c633de`（Merge pull request #3）。

已经具备：

- Express Web 入口、静态资源托管、health/readiness 基础端点。
- MainQuest OAuth 代码骨架、mock 登录、服务端 session 和账号到 workspace 的映射。
- 每账号目录、SQLite/Store 初始化、加密配置存储。
- 上传/下载与 SSE 基础路由。
- Renderer Web Bridge、Dockerfile、Compose 和 CI 的 Web 测试/Docker 启动检查。
- 资源下载、投标机会、插件管理的产品侧页面与入口删除。
- MQDS 浅色配色第一轮。

尚未完成：

- 真实 Web AI 服务与技术方案、知识库、查重、废标任务。
- 上传 file ID 到文档解析和各业务导入流程的连接。
- Linux Agent Runtime 与工具链。
- Chromium/Playwright 图片与 Mermaid 渲染。
- LibreOffice/Word 导出与浏览器下载闭环。
- 真实 MainQuest OAuth 环境联调。
- 能证明真实成功链路、SSE 归属、账号隔离和重启恢复的 E2E 门禁。

因此，PR #3 不得在后续文档中描述为“7 个 Sprint 完整交付”或“Web v1 完成”。

## WP-I PR I-1 当前分支事实（2026-07-26）

以下事实仅适用于 `codex/wp-i-business-task-agent-spec` 的 PR I-1 实施分支，尚不构成 `main` 已合入或 Web v1 完成的声明。

- 已建立运行环境无关的 Task Orchestrator；Electron 的八类既有任务以 characterization 测试守住生命周期行为。
- Web 已接通“招标文件解析”任务：严格 DTO、输入版本 CAS、每 Workspace 单一 mutation executor、持久化任务状态与 SSE 回放共同覆盖该主链。
- 浏览器 E2E 已验证上传后的招标文件可进入解析流程、启动任务、刷新后读取结果。该 E2E 使用 test-only AI 响应，不能替代接入用户模型配置后的线上调用验收。
- Docker 镜像已通过 mock OAuth 的 health/readiness、登录后 `technicalPlan.loadState`，以及生产配置下的 MainQuest authorize 跳转与 Secure state Cookie 冒烟；readiness 同时确认内置 Agent runtime 所需二进制与工具可用。
- 知识库、查重、废标、技术方案后续阶段和其他 Web 业务任务继续保持 pending；浏览器 Agent 能力也继续保持 pending。
- 首个正式 Agent 业务任务开放前，必须单独通过 OS 级隔离 Release Gate：非 root、只读输入、独立可写目录、egress deny、`no_new_privs`、seccomp 与资源配额。当前应用级权限测试不代表该 Gate 已完成。
- 品牌清理仍冻结，等待 I-1、I-2 两轮架构实施和相应验收完成。

## 目标架构

```text
Browser Renderer
      |
Runtime-neutral bridge contract
      |
Portable application/core services
      |
+----------------------+----------------------+
| Web adapters         | Electron adapters    |
| HTTP/OAuth/upload    | preload/IPC/dialog   |
| Linux task runtime   | desktop runtime      |
| headless render      | BrowserWindow render |
+----------------------+----------------------+
      |
Per-account SQLite + files + encrypted config
```

关键原则：

- portable core 不导入 Electron。
- Web adapter 把认证账号绑定到唯一 workspace context。
- 环境差异通过明确 adapter 注入，不在业务服务中散布运行时判断。
- Renderer 的 Web/Electron bridge 对外保持同一业务契约；不支持的能力在开发期必须可见，在发布候选中不得保留主链路占位。

## 实施顺序与 Gate

1. 冻结并实现架构 Spec，补齐真实 Web 主链路。
2. 通过架构验收：Docker/Linux、MainQuest、双账号隔离、任务恢复、导入、生成、渲染和导出。
3. 冻结兼容矩阵与迁移输入。
4. 实施品牌 Spec。
5. 通过品牌验收和完整回归后，才生成 `BidMaster` 发布候选。

如果架构实现改变持久化格式、bridge 契约、环境变量或部署拓扑，品牌 Spec 必须先更新再执行；不得并行猜测最终命名边界。

## v1 非目标

- 深色模式和黑白主题切换。
- 组件库替换、页面重做、信息架构重排。
- 多实例横向扩容、共享数据库、对象存储和组织/团队后台。
- 恢复资源下载、投标机会或插件管理。
- 未经明确决策删除 Electron 兼容层。
- 未经基础设施迁移计划重命名或删除线上 Cloudflare 资源、GitHub Secrets、OAuth 应用或持久卷。
