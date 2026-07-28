# BidMaster Web 单租户首发基线

状态：LOCKED
锁定日期：2026-07-28
起始提交：`origin/main@1c0a17eec348ffaeed1d7e1d0633483bf75fa2fb`
实施分支：`codex/web-single-tenant-baseline`
基线标签：`baseline/web-single-tenant-start-20260728`
历史候选标签：`archive/wp-j-complete-20260727`

## 1. 首发目标

交付可在浏览器完整使用、可由 Docker 单实例部署到 ECS、通过 MainQuest Auth 登录的 BidMaster Web 应用。

首发业务闭环固定为：

1. MainQuest 授权登录。
2. 上传并解析招标文件。
3. 招标分析与投标范围确认。
4. 目录生成、编辑和失效控制。
5. 全局事实生成与人工修订。
6. 正文生成、暂停、继续、局部重试和刷新恢复。
7. Mermaid、HTML 图和 AI 图片生成。
8. 按模板导出高保真 DOCX 并下载。

## 2. 单租户合同

- 一个 ECS 部署对应一个 BidMaster 租户。
- 获得 BidMaster Product 权限的 MainQuest 用户共享同一业务空间。
- MainQuest subject 继续作为登录身份；服务端 session 保持逐用户独立。
- 业务侧只保留一个 TenantContext、一个加密配置、一个 SQLite、一个文件根目录、一套任务队列和一条租户级 SSE 流。
- 首发只运行一个 Web 应用实例，不启用横向多副本。
- MainQuest Auth 负责 Product 访问授权；BidMaster 不重复建设产品授权系统。

内部可以暂时沿用 `workspaceId` 参数名，但值固定为部署级 tenant ID。只有用户可见、运维可见和新写入的活跃标识需要在首发完成 BidMaster 清理。

## 3. 首发保留范围

- React Renderer 与现有技术方案页面结构。
- MainQuest OAuth、服务端 session 和最小账号映射。
- portable core、SQLite Store、input revision CAS、mutation executor 和任务持久化。
- 上传 file ID、路径边界校验、加密模型配置和 Web AI Runtime。
- 生成技术方案、已有方案扩写、模板管理和设置。
- Docker Web Runtime、health、readiness、SSE 和受认证下载。
- `analytics/` 作为独立系统保留，除品牌与契约适配外不改业务范围。

## 4. 首发退出范围

- Electron 桌面发行、Electron Builder、桌面更新与桌面回归 Gate。
- Agent Sidecar、Agent Runner、OpenCode/Pi 产品能力和 Agent Quality。
- 多 workspace Registry、TTL Sweep、多租户公平调度和逐用户业务目录。
- 商务标、独立知识库管理、查重、废标检查、AI 评标和开发者页面。
- 多实例横向扩容、共享数据库、对象存储、组织后台和角色权限后台。
- DOC、WPS、XLS、XLSX 首发上传；如需恢复，必须先补安全解析链和容器依赖。

## 5. 代码集成纪律

- `origin/main@1c0a17e` 是唯一实施起点。
- `archive/wp-j-complete-20260727` 只作为 J-Core 和测试证据来源，禁止整体合并。
- 按文件和业务能力迁移 J-Core；Sidecar、桌面兼容和重复夹具不得随迁。
- 可复用大文件使用 `git mv` 或抽取 adapter，避免复制后形成重复实现。
- 首发业务源码净新增预算为 3,000 行；单工作包净新增超过 1,000 行时暂停并复审。
- 测试、fixture、生成物和文档单独统计，不得混入业务源码体量结论。

## 6. Worktree 隔离

- 主目录继续保留用户已有未跟踪内容，不作为本轮实施目录。
- 主实施 worktree 固定为 `Bidding-Copilot-web-single-tenant`。
- 每个后续工作包从 `codex/web-single-tenant-baseline` 创建独立 `codex/web-st-*` 分支和 sibling worktree。
- 并行工作包不得写入同一主模块；集成前必须提交、验证并返回 commit SHA。
- 只有主实施 worktree负责集成、冲突裁决、完整门禁和发布候选。

## 7. 完成门槛

- 真实 MainQuest 授权用户成功登录，无 Product 权限用户被拒绝。
- 两个授权用户共享同一租户业务数据，会话保持独立。
- 使用真实 PDF/DOCX 和真实模型完成首发业务闭环。
- 图片真实生成并持久化，DOCX 保留模板、编号、表格和图片。
- 页面刷新、任务暂停继续和容器重启后状态可恢复。
- 非法上传、模型超时、渲染失败、导出失败和会话过期均有明确错误。
- 生产依赖 high 级漏洞清零。
- 用户可见与运维活跃面完成 BidMaster 品牌清理。
- Docker production 只允许 MainQuest OAuth；ECS HTTPS、SSE、持久卷、备份和回滚演练通过。

## 8. 数据假设

当前按“尚无必须迁移的生产业务数据”执行。发现已有需保留的生产数据或活跃桌面用户时，立即暂停路径、Cookie、SQLite 和 bridge 标识迁移，先补迁移与回滚方案。
