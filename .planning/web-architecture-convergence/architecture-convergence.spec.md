# Web 架构收敛 Spec

状态：Draft for implementation
基线：`main@e71e87c633de`（PR #3 已合并）
前置：`project.md` 的 2026-07-24 锁定决策
后续：本 Spec 验收通过后，才能执行 `.planning/yibiao-brand-cleanup/brand-cleanup.spec.md`

## 1. 目的

把 PR #3 的 Web 运行骨架收敛为可在 Linux/Docker 中独立完成真实业务的 Web 产品，同时保留 Electron 作为迁移期适配器和回归基线。

“完成”必须意味着用户通过 MainQuest 登录后，能够在浏览器中导入材料、配置模型、执行技术方案/知识库/查重/废标任务、看到账号内进度、刷新后恢复状态并导出 Word。接口存在、Store 可读写、mock 登录、返回可解释的 `500/501` 或容器 health 通过都不是完成。

## 2. 当前事实与问题

### 2.1 已具备的基线

- `client/server/` 已提供 Express、OAuth/session、workspace registry、上传、下载、SSE、health/readiness 和 bridge 路由。
- `client/src/shared/runtime/installRuntimeBridge.ts` 可在浏览器安装 Web Bridge。
- 每个账号映射到随机 workspace ID，工作区下创建独立 SQLite、文件目录和加密配置。
- Docker 与 CI 能构建并启动 Web 容器。
- 资源下载、投标机会和插件管理已从产品侧菜单、路由和页面删除。

### 2.2 阻断真实交付的问题

- `client/server/workspace/webServices.cjs` 仍注入 AI、Agent、知识库和查重 stub。
- `client/server/routes/bridge.cjs` 的任务启动、文件导入和知识库匹配仍抛“尚未实现”，`ai/agent/export` 未注册并返回 `501`。
- Web workspace 直接导入 `client/electron/services/*.cjs`。可复用业务逻辑与 Electron dialog、BrowserWindow、app path、native ABI 尚未形成稳定边界。
- 上传端点只返回 file ID，没有把账号内 file ID 安全接入文档解析和业务 Store。
- Docker 镜像没有完整的 Chromium/Playwright、LibreOffice、OpenCode Linux binary、`rg/fd/jq`。
- `localImageRenderService.cjs` 仍依赖 Electron `BrowserWindow`；`exportService.cjs` 仍依赖 Electron保存对话框。
- readiness 未验证真实运行时；现有 Web 测试中仍有“验证占位错误”的测试，不能证明业务成功。
- 真实 MainQuest 环境、反向代理回调、无权限账号和产品授权尚未联调。
- 旧开发说明把 Renderer/Main 视为本地可信边界；该假设不适用于公网 Web API。

## 3. 目标与非目标

### 3.1 目标

1. 建立运行环境无关的 bridge contract 与 portable core。
2. Web server 只通过显式 adapter 装配文件、AI、Agent、渲染和导出能力。
3. 账号数据、任务、事件和临时产物端到端隔离。
4. 在 Linux 容器中完成真实主业务链路。
5. 用诚实的自动化测试和生产相近 smoke 阻断回归。
6. Electron 通过同一 core 和桌面 adapter 保持现有构建/关键 smoke。

### 3.2 非目标

- UI 组件、布局、交互和信息架构重做。
- 深色模式。
- 多实例、共享任务队列、对象存储或 Kubernetes。
- 恢复已经删除的三个产品能力。
- 在本 Spec 内进行品牌全量重命名。
- 未经单独决策删除 Electron 发布链路。

## 4. 目标边界

```text
client/src
  -> shared bridge types
  -> Web HTTP adapter | Electron preload/IPC adapter
  -> portable application services
  -> ports: config / files / AI / agent / render / export / task events
  -> Web adapters (Linux, per-account) | Electron adapters (desktop)
  -> per-account SQLite and filesystem
```

### 4.1 Portable core

- 不得导入 `electron` 包，不得调用 `dialog`、`BrowserWindow`、`app.getPath()`、`shell`。
- 接收显式 `workspaceRoot`、Store、配置、时钟、ID、logger 和环境 adapter。
- 承载业务规则、AI 请求队列、任务状态机、解析编排、导出编排和持久化策略。
- 所有 adapter contract 有类型/契约测试；不得靠运行时猜测参数形状。

### 4.2 Web adapter

- HTTP 请求先完成 session 认证，再把账号绑定到服务端生成的 workspace ID。
- file ID、download ID、task ID 必须按当前 workspace 解析；浏览器不得传服务器绝对路径。
- 对请求体、文件数量/类型/大小、枚举和资源所有权做边界校验。
- 错误响应只返回稳定 code 和可公开信息，不泄露密钥、路径、正文、上游响应或 stack。

### 4.3 Electron adapter

- preload/IPC 只做协议适配；dialog、BrowserWindow 和桌面路径留在 Electron adapter。
- 迁移期间通过同一业务 contract 调用 portable core。
- 不新增只在 Electron 中可用的新业务功能。

## 5. 工作包与实施顺序

所有工作包按依赖顺序集成；只有文件所有权不重叠时才并行。每个工作包必须有独立提交、聚焦验证和回滚边界。

### WP-A：契约冻结与“失败测试先行”

范围：

- 盘点 Renderer 实际调用的 bridge namespace/method、输入、输出、事件和错误。
- 建立一份运行环境无关的 contract manifest，标记 `implemented/pending/removed`。
- 为所有保留主链路补充 Web contract tests；对发布候选禁止 `pending`。
- 把三个已删除能力加入 negative tests：菜单、路由、bridge 和应用服务均不可恢复。

验收：

- contract manifest 覆盖 Renderer 所有调用；未知 namespace/method 被拒绝。
- 当前 stub/501 对应测试以“预期失败”证明缺口，不能写成通过即完成。
- 无任意方法调用、原型属性访问或任意文件路径入口。

### WP-B：Portable core 与运行时装配

范围：

- 从 `electron/services` 中识别纯 Store/业务服务，迁入或封装到运行环境无关目录。
- 定义 config、file parser、AI、agent、renderer、exporter、task event ports。
- `workspaceContext` 通过 factory 显式注入真实实现，不再创建 Web stub。
- 统一资源关闭：SQLite、agent runtime、队列、临时目录和 SSE 订阅。

约束：

- 先保持外部 bridge 行为，不在此包改 UI 或品牌命名。
- 可暂时由 Electron adapter 代理旧实现，但 portable core 不得反向导入 Electron。

验收：

- 静态检查证明 core 不含 Electron import。
- 同一 contract test suite 可运行在 Web adapter 与 Electron adapter。
- workspace context 创建/释放 100 次无句柄、数据库或临时目录泄漏。

### WP-C：真实配置、AI 与任务服务

范围：

- 从账号加密配置读取文本模型、生图模型和运行参数。
- 将现有 AI 请求、重试、并发队列、token 统计和 scope pause/resume 收敛到 portable service。
- 在每个 workspace 创建独立或明确限额的队列；禁止跨账号暂停、事件或统计串扰。
- 接通技术方案、知识库匹配、查重和废标的真实 task methods。
- 任务启动立即落盘，阶段变化持续落盘，重启后把不可继续的 running 状态转为明确可恢复/失败状态。

安全：

- API Key 仅服务端解密使用；接口和日志不回传明文。
- 上游错误做脱敏归一化；保留内部关联 ID 供排查。
- 定义账号并发、全局并发、超时、取消和队列饥饿策略。

验收：

- 使用可控测试模型服务完成成功、429 重试、5xx、超时、暂停和取消测试。
- 两账号并发任务的配置、事件、Store 和 token 统计互不串扰。
- 技术方案至少一条真实生成链路不再命中 stub/501。

### WP-D：上传、解析与业务导入

范围：

- 建立账号内 upload registry：file ID 对应真实路径、原文件名、类型、大小、hash、账号和生命周期。
- file ID 解析必须使用规范化路径与 `path.relative` 边界，拒绝绝对路径、`..`、兄弟目录和其他账号资源。
- 接通招标文件、已有方案、知识库、查重文件和废标文件导入。
- 复用文档解析 core；本地解析/MinerU 由 adapter 与配置选择。
- 定义失败清理、重复上传、临时文件保留和业务接管后的生命周期。

验收：

- 支持声明范围内的 PDF/DOCX/XLSX/Markdown 等格式。
- 上传后可进入对应 Store 并在页面刷新后读取。
- 覆盖越权 file ID、伪扩展名、超限、损坏文件、解析超时和并发删除。
- 双账号无法导入、读取或下载对方文件。

### WP-E：Linux Agent Runtime

范围：

- 明确 v1 至少一个受支持 runtime；OpenCode 与 Pi 是否同时支持作为实施 gate。
- 构建并校验 Linux binary 与 `rg/fd/jq` 工具。
- 每任务使用账号隔离的临时 workspace；限制路径、环境变量、输出大小、超时和进程树。
- Agent proxy 读取当前账号配置，日志脱敏，任务结束可靠清理。
- readiness 检查 runtime binary、工具和自检状态。

验收：

- 非 root 容器中 runtime self-check 通过。
- 两账号任务目录、会话、输出和日志互不可见。
- 超时/取消会终止子进程树；容器重启后无僵尸状态。
- 至少一条核心生成任务通过 Agent Runtime 完成并写回业务 Store。

### WP-F：Headless 渲染、Word 导出与下载

范围：

- 定义 renderer adapter；Electron 使用 BrowserWindow，Web 使用固定版本 Chromium/Playwright。
- Mermaid/HTML/本地图片渲染禁止访问账号工作区外路径和未允许的外网资源。
- 把导出服务拆成“生成文件”和“选择保存位置”；Web 只生成账号内导出物并返回一次性/受权 download ID。
- 在 Docker 安装固定版本字体、Chromium、LibreOffice 及必要依赖。
- 导出进度进入当前账号 task/SSE。

验收：

- 浏览器完成含中文、表格、本地图片、Mermaid 的 Word 导出并下载。
- 并发导出不串文件；下载过期、重复、越权和中断行为明确。
- readiness 能真实发现 Chromium/LibreOffice 不可用。
- Electron 导出回归通过。

### WP-G：OAuth、会话与部署硬化

范围：

- 在测试 MainQuest 环境验证 authorize、callback、token、用户信息和产品访问权限。
- 明确 subject 映射规则；email 变化不得创建新的账号空间。
- 校验 state、redirect URI、cookie `HttpOnly/Secure/SameSite`、session 轮换/过期/退出。
- 反向代理 host/proto 信任仅限已知拓扑；生产禁用 mock OAuth。
- 定义 session 清理、账号禁用和 workspace context 回收。
- 配置持久卷、备份、恢复、日志、资源上限和优雅关闭。

验收：

- 正常登录、无产品权限、state 错误、callback 重放、session 过期和退出全部通过。
- 生产配置缺 secret、仍为 mock、回调不匹配或数据目录不可写时 fail closed。
- 容器重启后账号数据存在，session 行为符合策略。

### WP-H：诚实 CI 与发布候选 Gate

范围：

- 保留 TypeScript build、CJS syntax、Web tests、Docker build/run、audit。
- 增加 Electron ABI 恢复和 `smoke:electron-native`。
- 增加 production-like Docker E2E：真实解析、受控 AI、任务/SSE、渲染、Word 下载。
- 增加双账号隔离、重启恢复、删除能力 negative test 和敏感信息扫描。
- readiness 必须覆盖实际启用的 runtime，不允许把缺少关键依赖记为 warn。

发布候选 Gate：

- 保留主链路不再返回 `WEB_CAPABILITY_PENDING`、`500` 占位或调用 stub。
- 所有自动化门禁通过，且有一次真实 MainQuest 测试环境联调记录。
- Docker 以非 root 用户运行，持久卷备份/恢复演练通过。
- Electron build/smoke 通过，或已有老板批准的独立退役决策。

## 6. 数据、隔离与恢复

### 6.1 账号身份

- MainQuest immutable subject 是外部身份主键；本地生成的 account/workspace ID 是存储边界。
- email、name、companyName 是可变 profile，不得用作目录名或授权判断。
- OAuth access token 不进入业务 SQLite；除非 MainQuest 协议要求，登录完成后不长期保存。

### 6.2 Workspace

- 每账号独立：加密配置、SQLite、uploads、assets、agent workspace、temporary files、exports。
- 所有服务从 workspace context 获取路径，不读全局可变“当前用户”。
- registry 必须有空闲回收和关闭机制，不能永久缓存所有账号连接。

### 6.3 任务恢复

- 任务状态至少包含 queued/running/pausing/paused/succeeded/failed/cancelled 与阶段信息。
- 进程内 active task 与持久化状态不一致时，不得静默标记成功。
- v1 若不支持跨进程继续执行，重启后应转为明确可重试状态并保留已完成结果。

## 7. 错误与可观测性

- API 返回稳定错误码；中文 message 可展示，但不作为程序分支唯一依据。
- 每个请求/任务有 correlation ID；日志包含账号内部 ID 的不可逆短标识，不包含 email、密钥、正文和完整上游响应。
- 记录 OAuth、上传、解析、任务、Agent、渲染、导出的开始/结束/耗时/结果码。
- 生产日志级别、保留期和下载权限在部署文档中明确。

## 8. SDD 实施规则

模式：SDD Heavy。原因是改动跨认证、服务端、持久化、native runtime、导出与部署，失败可能造成越权、数据丢失或不可交付。

- 开发包按 WP-A 至 WP-H 切分；共享 contract/core 的包串行，其余只在写入范围无交叉时并行。
- 实现 worker 使用独立 worktree；主线程按依赖集成并冻结 SHA。
- 每个完整集成批次由 Terra High 做实现风险审查、Sol Medium 做第一原则审查。
- 修复由单一集中 worker 接收裁决后的清单；不得把两个 reviewer 的原始意见直接并行修改同一文件。
- 每个工作包返回行为变化、文件、测试、commit SHA 和未决风险。

## 9. 决策 Gate

实施前必须明确：

1. v1 Linux Agent Runtime：只保证 OpenCode，还是 OpenCode + Pi。
2. MainQuest OAuth 的真实 endpoint、scope、产品权限字段、immutable subject 字段和退出协议。
3. 用户自带模型 Key 的支持范围，以及账号/全局并发和成本上限。
4. 上传格式、单文件/单账号容量、留存和备份策略。
5. 导出物有效期和下载次数。
6. 是否允许渲染器访问外网资源；默认应为不允许。
7. Electron 兼容保留到哪个发布节点；未确认前继续回归。

这些 gate 不阻止 WP-A/WP-B 的契约与边界工作，但阻止对应运行时进入发布候选。

## 10. 整体验收场景

至少执行以下场景并保存证据：

1. 两个 MainQuest 测试账号分别登录，创建不同模型配置和工作区。
2. 账号 A 上传招标文件，完成解析、分析、目录、全局事实、正文和图片计划。
3. 页面在任务中刷新，状态与进度恢复；账号 B 看不到任何 A 的事件或数据。
4. 账号 A 使用知识库、查重和废标检查各完成一条真实成功链路。
5. 生成含图片、Mermaid、中文和表格的 Word，下载后打开检查。
6. 对上游 429/5xx/超时、损坏文件、越权 file/download ID、过期 session 做失败验证。
7. 任务运行中重启容器，验证状态收敛和可重试行为。
8. 删除能力的菜单、路由、页面和 bridge 均不存在。
9. 运行完整 CI、Docker readiness、敏感信息扫描和 Electron smoke。

只有上述场景均通过，架构 Spec 才能标记 `PASS`，并允许品牌 Spec 进入实施。

## 11. 回滚

- 每个工作包独立提交，schema 变化必须向前兼容并附备份/恢复脚本。
- 新 adapter 先通过 feature flag 或装配选择接入；确认成功后再删除 stub。
- 运行时或导出依赖失败时回滚对应 adapter，不回滚已验证的数据隔离和安全边界。
- 不使用“恢复到返回 501”作为发布回滚方案；该状态只能回到非发布开发基线。
