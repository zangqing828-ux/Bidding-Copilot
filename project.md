# BidMaster / Bidding Copilot 项目说明

## 文档地位

本文件记录项目级目标与已经确认的长期决策，是后续规划、实现和审查的产品基线。除老板新的明确决策外，不得用旧 README、旧 Sprint 文档、历史代码结构或兼容实现覆盖这里的结论。

当前实施文档：

- Web 单租户首发基线：`.planning/web-single-tenant-release/baseline.md`
- Web 架构收敛：`.planning/web-architecture-convergence/architecture-convergence.spec.md`
- 品牌清理：`.planning/yibiao-brand-cleanup/brand-cleanup.spec.md`

其中 `.planning/web-single-tenant-release/baseline.md` 记录 2026-07-28 最新锁定决策；与旧 Spec 冲突时，以该基线为准。

## 项目目标

基于 Bidding Copilot 现有投标业务能力，交付一个可在浏览器完成核心标书工作流、可使用 Docker 单实例部署到 ECS、通过 MainQuest OAuth 登录的单租户 `BidMaster` Web 产品。

目标是在 Linux 容器中独立完成文件导入、AI 任务、进度恢复、图片渲染、Word 导出和下载。

## 2026-07-28 锁定决策

1. **纯 Web 首发。** Electron、桌面发行和桌面回归 Gate 退出首发；portable core 中可复用能力继续保留。
2. **单租户单实例。** 一个 ECS 部署对应一个租户；获得 BidMaster Product 权限的 MainQuest 用户共享同一业务空间。
3. **Auth 只做一层。** MainQuest Auth 负责登录和 Product 访问授权；本地只保留用户 session、身份映射和必要审计信息。
4. **J-Core 选择性迁入。** `origin/main@1c0a17e` 是实施起点；旧 `wp-j-complete` 仅作为来源，不整体合并。
5. **Agent 退出首发。** Agent Sidecar、Agent Runner、OpenCode/Pi 和 Agent Quality 不进入首发运行时。
6. **首发表面收缩。** 只开放生成技术方案、已有方案扩写、模板管理和设置。
7. **交付完整。** 图片生成和高保真 DOCX 属于首发硬门槛；文本降级导出不能作为完成。
8. **安全格式收缩。** 首发上传只支持 PDF、DOCX、TXT 和 Markdown。
9. **品牌统一。** 用户可见与运维活跃面统一为 BidMaster；若发现需保留的生产数据，先执行迁移 Gate。
10. **体量受控。** 首发业务源码净新增预算 3,000 行；单工作包净新增超过 1,000 行时暂停复审。

完整合同、退出范围、隔离方式与完成门槛见 `.planning/web-single-tenant-release/baseline.md`。

## 2026-07-24 历史决策

以下内容保留为历史背景；与 2026-07-28 决策冲突的部分已失效。

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

## WP-I PR I-1 当前修复状态（2026-07-26）

以下状态仅适用于 `codex/wp-i-business-task-agent-spec` 的 Draft PR #7，尚不构成 `main` 已合入、完整 CI 通过或 Web v1 完成的声明。

- 已建立运行环境无关的 Task Orchestrator、输入版本 CAS、每 Workspace 单一 mutation executor 与持久化任务状态/SSE 回放；其修复版仍待当前门禁复核。
- 浏览器招标解析仅开放单标段链路；多标段识别和选标段在 Web 继续保持不可达，Electron 兼容能力与历史数据保留。
- 浏览器 E2E、Docker 业务 smoke、Electron native smoke、production OAuth smoke 与 production audit 必须在修复提交上全绿后，才可描述为已验证。
- 知识库、查重、废标、技术方案后续阶段和其他 Web 业务任务继续保持 pending；浏览器 Agent 能力也继续保持 pending。
- 首个正式 Agent 业务任务开放前，必须单独通过 OS 级隔离 Release Gate：非 root、只读输入、独立可写目录、egress deny、`no_new_privs`、seccomp 与资源配额。当前应用级权限测试不代表该 Gate 已完成。
- 品牌清理仍冻结，等待 I-1、I-2 两轮架构实施和相应验收完成。

## WP-I-2 Agent Execution Foundation 状态（2026-07-27）

- 已建立受限 Task Spec、进程级 Coordinator、Workspace 生命周期、SQLite 幂等账本、CAS 与原子提交边界。
- Linux OpenCode Runner 已具备只读输入、安全输出读取、`prlimit`、有界日志、进程组终止和清理。
- 独立 `agent-e2e` Docker target 使用真实 OpenCode 完成 Responses/Chat 适配、两轮 tool-call、结果文件安全读取与目录清理；最终 runtime target 不包含测试 harness。
- 浏览器 Agent API 和生产 Task Spec 注册表继续保持关闭；egress deny、`no_new_privs`、seccomp、cgroup 内存硬限制仍属于后续 Release Gate。

## 目标架构

```text
Browser Renderer
      |
Runtime-neutral bridge contract
      |
Portable application/core services
      |
Web adapters
HTTP / MainQuest OAuth / upload / SSE
AI Runtime / headless Chromium / DOCX export
      |
Single TenantContext
SQLite + files + encrypted config
```

关键原则：

- portable core 不导入 Electron。
- Web adapter 把所有授权账号绑定到同一个 TenantContext。
- 环境差异通过明确 adapter 注入，不在业务服务中散布运行时判断。
- 发布候选的用户可达面不得保留 `pending`、stub 或占位成功。

## 实施顺序与 Gate

1. 锁定单租户首发基线并建立隔离 worktree。
2. 选择性迁入 J-Core，删除多 workspace、Agent 和桌面发行链。
3. 完成真实 MainQuest、真实 AI、图片和高保真 DOCX。
4. 收口上传安全、Web-only 包装和 BidMaster 品牌。
5. 通过本地真实闭环后部署 ECS staging。
6. 完成 HTTPS、SSE、持久化、备份和回滚验收后生成发布候选。

如果架构实现改变持久化格式、bridge 契约、环境变量或部署拓扑，品牌 Spec 必须先更新再执行；不得并行猜测最终命名边界。

## v1 非目标

- 深色模式和黑白主题切换。
- 组件库替换、页面重做、信息架构重排。
- 多实例横向扩容、共享数据库、对象存储和组织/团队后台。
- 恢复资源下载、投标机会或插件管理。
- Electron 桌面发行和 Agent 产品能力。
- 未经基础设施迁移计划重命名或删除线上 Cloudflare 资源、GitHub Secrets、OAuth 应用或持久卷。
