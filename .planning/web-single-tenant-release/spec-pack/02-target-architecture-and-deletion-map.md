# 目标架构与删除地图

## 1. 架构目标

```text
Browser Renderer
  React pages + Web Bridge
          |
          | authenticated HTTP / SSE
          v
Express Web Adapter
  auth | upload | bridge | tasks/events | downloads
          |
          v
Single TenantContext
  one mutation executor
  one AI queue
  one task orchestrator
          |
          v
Portable Core
  document parse contracts
  bid analysis
  outline
  global facts
  content
  illustration plan
  DOCX builder
          |
          +------------------------+
          |                        |
          v                        v
Linux Adapters               Persistence
AI HTTP Runtime              auth.sqlite
Chromium Renderer            yibiao.sqlite (首发保留现有内部文件协议)
Asset Resolver               uploads/
                             generated-images/
                             exports/
```

## 2. 组件职责

| 层 | 允许 | 禁止 |
|---|---|---|
| Renderer | 页面、交互、Web Bridge、Toast | Node、fs、绝对路径、业务长任务 |
| Express adapter | 认证、输入校验、HTTP/SSE、下载 token | 复制业务规则、直接拼 Prompt |
| TenantContext | 单租户生命周期、任务/队列/Store 装配 | 多 workspace Registry、TTL Sweep |
| Portable core | 业务规则、任务状态、Prompt、DOCX 构建 | Electron、BrowserWindow、dialog、Express |
| Linux adapter | AI HTTP、Chromium、资产路径、字体 | 用户任意路径、外部脚本/网络渲染 |
| Persistence | SQLite 结构状态、文件大对象 | 浏览器 localStorage 保存密钥或正文 |

## 3. 单租户与身份

```text
MainQuest user A ---- session A ----+
                                    |
MainQuest user B ---- session B ----+--> BIDMASTER_TENANT_ID
                                             |
                                             +--> one TenantContext
                                             +--> one business SQLite
                                             +--> one encrypted config
                                             +--> one file root
                                             +--> one task/SSE stream
```

约束：

- MainQuest subject 只用于身份映射和审计。
- 所有授权用户的 `req.tenantId` 固定为部署级 `BIDMASTER_TENANT_ID`。
- session 逐用户独立。
- 业务配置、文件、任务和导出属于租户，不按用户拆分。
- 任务修改经过同一个 mutation executor。
- 首发只运行一个应用实例。

## 4. 任务模型

首发任务类型：

- `bid-analysis`
- `outline-generation`
- `global-facts-generation`
- `content-generation`

全部属于 `technical-plan` group，同一时间只允许一个会改变技术方案状态的任务。

```text
idle
  |
  | start + validate input revision
  v
running --------------------------+
  |                               |
  | pause request                 | success
  v                               v
pausing -> paused -> resume -> running -> success
  |                     |
  | process/container    | model/render/store error
  | interruption         v
  +-------------------> error -- retry --> running
```

状态要求：

- 任务受理、状态变更和业务数据写入必须串行化。
- 每次任务绑定 input revision；旧 revision 结果禁止覆盖新输入。
- 页面刷新通过 Store + SSE 恢复。
- 容器重启时，`running/pausing` 转为 retryable interrupted；已完成章节和计划保留。
- pause 只在安全 checkpoint 生效；已经开始的原子写入先完成。
- 同参数重复 start 返回当前任务；不同参数并发 start 返回 `TASK_CONFLICT`。

## 5. 文档和图片数据流

### 5.1 上传

```text
multipart file
  -> extension allowlist
  -> magic/content check
  -> server-generated file ID
  -> tenant uploads/
  -> upload registry
  -> parser worker
  -> Markdown + parser metadata
  -> technical plan store
```

限制：

- 只允许 `.pdf`、`.docx`、`.txt`、`.md`。
- 文件名只用于显示。
- 浏览器永远不提交服务器路径。
- MIME、扩展名和内容签名需一致。
- 文件数量、单文件大小、解析时间和解压体积有上限。

### 5.2 图片

```text
final section content
  -> illustration planner
  -> persisted IllustrationPlan
        |
        +--> Mermaid code -> trusted local Mermaid page -> PNG
        +--> static HTML -> sanitized isolated page -> PNG
        +--> image model -> response bytes/URL -> bounded download -> image file
  -> persisted asset URL
  -> authoritative outline[*].content
```

Chromium 安全边界：

- Mermaid 只加载镜像内 bundled script。
- Mermaid 源码以 Markdown `mermaid` 代码块保存，正文和导出共用同一权威内容。
- HTML 图禁止 `<script>`、`iframe`、`object`、`embed`、表单和外部资源。
- HTML 图使用关闭 JavaScript 的独立 BrowserContext。
- 所有 context 拦截 `http:`、`https:` 和 `file:` 请求。
- 每张图限制源码长度、视口、最大高度、超时和重试次数。
- Browser/Page 在成功、错误、暂停和关闭路径都必须释放。
- AI 图片优先接收 bytes/base64；必须下载 URL 时复用 endpoint policy，逐次 DNS/redirect
  校验并拒绝 loopback、私网、link-local、云 metadata 和非 HTTP(S) 地址。

### 5.3 DOCX

```text
outlineData.outline[*].content
  + template config
  + asset resolver
       |
       v
portable DOCX builder
  -> headings/numbering/paragraphs/tables/images
  -> Buffer
  -> tenant exports/<uuid>.docx
  -> one-time token
  -> authenticated browser download
```

权威来源固定为 `outlineData.outline[*].content`。导出服务不得从旧缓存或平行正文读取。

## 6. portable core 搬迁地图

| 现有来源 | 目标 | 处理 |
|---|---|---|
| `electron/services/outlineGenerationTask.cjs` | `core/technical-plan/outline/outlineGenerationTask.cjs` | `git mv`，裁剪 Agent recovery |
| `electron/services/globalFactsTask.cjs` | `core/technical-plan/content/globalFactsTask.cjs` | `git mv`，修正 core import |
| `electron/services/contentGenerationTask.cjs` | `core/technical-plan/content/contentGenerationTask.cjs` | `git mv`，裁剪 Agent 模式 |
| `electron/services/contentIllustrationPlanning.cjs` | `core/technical-plan/content/contentIllustrationPlanning.cjs` | `git mv`，图片计划改为普通 AI JSON 请求 |
| `electron/services/contentIllustrationGeneration.cjs` | `core/technical-plan/content/contentIllustrationGeneration.cjs` | `git mv`，渲染器改为 port |
| `electron/services/exportService.cjs` | `core/export/docxBuilder.cjs` | WR-05 `git mv`，移除 app/dialog/路径 |
| Electron utils 中被上述业务使用的纯函数 | 对应 `core/` 模块 | 逐文件移动；禁止整目录复制 |
| `electron/services/localImageRenderService.cjs` | `server/render/headlessImageRenderer.cjs` | 复用算法，替换 BrowserWindow 为 Chromium |
| Electron AI image provider 逻辑 | `core/imageRuntime.cjs` 或 `core/aiRuntime.cjs` | 只迁入当前设置页可配置的 provider |

## 7. Web adapter

新增或收敛为以下 adapter：

- `technicalPlanTaskService`：替换现有 Web task stub，装配四个首发任务。
- `headlessImageRenderer`：唯一新增的独立 adapter，实现 Mermaid/HTML render port。
- `webExportService`：升级现有简单导出服务，调用 portable DOCX builder、写租户文件、创建 download token。
- `systemFonts.list`：作为 export/runtime 的小型方法返回镜像内批准字体，不新增独立 service。
- `oauthClient`：保留现有实现，只负责 OAuth code flow 和 `/me`。

adapter 禁止出现：

- Prompt 正文
- 业务状态机副本
- Electron import
- Agent import
- 任意用户绝对路径

## 8. 删除地图

### 8.1 用户产品面删除

- `client/src/features/business-bid/`
- `client/src/features/knowledge-base/`
- `client/src/features/duplicate-check/`
- `client/src/features/rejection-check/`
- `client/src/features/developer/`
- 对应 menu、router、navigation type、Prompt 和 CSS 孤儿代码
- 多标段配置、知识库选择和 Agent 修复模式
- 桌面 update、license、GPU、online-service Prompt

### 8.2 Web Runtime 保留与删除边界

保留：

- `client/server/agent/` 中现有 Web OpenCode Proxy、Runner、Coordinator、Task Workspace、Task Spec、Executor 和 Result Committer。
- OpenCode 固定版本下载、checksum 校验、`prlimit`、`rg`、`fd`、`jq`。
- `workspaceRuntimeFactory.cjs` 的租户 Agent service/lease、`server/index.cjs` 的 Coordinator shutdown 接线。
- readiness 的 Agent Foundation 检查。
- Agent protocol/runtime/coordinator/executor/checksum tests 和真实 `agent-e2e` Docker target。

删除：

- `client/server/agent-sidecar/`、`client/agent-runner/` 等历史重复实现，如当前分支仍存在。
- Electron OpenCode/Pi runtime、桌面 Agent registry、自检 UI、developer Agent 页面和 release 打包链。
- 浏览器通用 Agent Bridge、任意 prompt/path/runtime/output 参数入口；这些入口当前已经由 WR-01 删除。
- knowledge base、duplicate、rejection 的 Web runtime 装配。

生产 Task Spec 注册表在没有单独批准的业务 Agent 工作包时保持为空。保留 OpenCode Foundation 不能被描述为“当前技术方案主链路已经使用 Agent”。

### 8.3 pure Web 收口后删除

在业务核心完成移动并通过 characterization tests 后：

- `client/electron/`
- Electron preload/main/update/license/runtime
- Electron builder 配置与 release pipeline
- Electron native smoke
- `electron`、`electron-builder`、`electron-updater`
- `@earendil-works/pi-*`

### 8.4 依赖删除

- `xlsx`
- 仅 Agent 使用的 `js-yaml` 等依赖
- 仅桌面发行使用的依赖
- 被新 Web renderer 替代后无调用者的 Electron 图像依赖

删除前必须运行引用扫描；仍有 release 路径调用者时，先移动最小依赖。

## 9. 品牌与兼容 allowlist

首发目标：

- 新写入 asset URL 使用 `bidmaster-asset://`。
- Web Cookie 使用 `bidmaster_session`、`bidmaster_oauth_state`。
- Docker/Compose 使用 `BIDMASTER_DATA_DIR`、`BIDMASTER_WEB_DIST_DIR`。
- package、镜像、容器、日志、README 和公开链接使用 BidMaster。
- Docker 运行用户如需改名，保持原 numeric UID/GID；发现既有 volume 时先验证文件所有权和回滚。

允许暂存的内部兼容项：

| 标识 | 原因 | 首发处理 |
|---|---|---|
| `window.yibiao` / `YibiaoBridge` | Renderer 内部 ABI，机械重命名回归面大 | 保留并列入扫描 allowlist，不出现在 UI/日志 |
| `yibiao.sqlite` | 当前业务 Store 文件协议，可能伴随 WAL/SHM | 首发保留文件名；独立迁移 Gate 批准后再改 |
| `yibiao-asset://` reader | 兼容旧 Markdown/fixture | 只读兼容；writer 写新协议 |
| 旧 env reader | 防止本地旧 `.env` 直接失效 | 新值优先、旧值 fallback，并输出无 secret 的 deprecation 日志 |
| Analytics resource/binding key | 独立系统和历史数据 | 保留实体名，只改显示和 User-Agent |
| 历史文章/计划中的旧品牌 | 真实历史 | 不参与活跃面扫描；移除活跃推广链接 |

若确认从未存在旧 Web 部署和需保留数据，可在 WR-06B 直接清理旧 Cookie 与旧 env fallback；实施前记录该确认。

## 10. 失败行为

| 失败 | 服务端行为 | 用户可见行为 | 恢复 |
|---|---|---|---|
| session 过期 | 401，不执行业务 | 返回登录页 | 重新登录 |
| 上传伪装格式 | 400，删除临时文件 | 明确“内容与扩展名不匹配” | 换正确文件 |
| 解析超时 | 任务失败，不写空成功 | 显示失败文件与原因 | 重试/换文件 |
| 模型超时 | 保留 checkpoint | 显示可重试错误 | retry/resume |
| 并发任务冲突 | `TASK_CONFLICT` | 提示已有任务 | 等待或暂停 |
| stale revision | 拒绝写入 | 提示输入已变化 | 重新生成 |
| Mermaid 无法修复 | 单图 error，正文保留 | 提示图片失败 | 单独重跑图片 |
| HTML 渲染越界 | 中止该图并释放 Page | 提示图片失败 | 调整/重跑 |
| AI 图片下载失败或 SSRF 地址 | 不发起越界请求，不写损坏文件 | 提示图片失败 | 修正 provider/重试 |
| DOCX 构建失败 | 不创建 token | 提示导出失败 | 修复图片/模板后重试 |
| 容器重启 | 标记 interrupted | 显示可继续/重试 | 继续任务 |
| SSE 断开 | Store 保持权威 | 自动重连并重新 load | 无需重跑任务 |
