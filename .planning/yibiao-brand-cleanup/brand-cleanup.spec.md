# BidMaster 品牌清理实施 Spec

> 状态：Draft（待 Gate 决策后进入实现）
> 基线：`main@e71e87c`（PR #3 已合并）
> 生成日期：2026-07-24
> 适用仓库：`zangqing828-ux/Bidding-Copilot`
> 前置：Web 架构收敛 Spec 未验收时，只可执行 WP-0 的盘点与 Gate 准备；不得实施或合入 WP-1 至 WP-7。本 Spec 不以 PR #3 的“Web 骨架”状态作为业务完成依据。

## 1. 决策与问题陈述

本项目的对外产品展示品牌统一为 **BidMaster**，仓库的唯一公开地址为
`https://github.com/zangqing828-ux/Bidding-Copilot`。旧域名、推广链接和 Star
诱导必须断开；资源下载、投标机会、插件管理及其应用端入口保持删除。

这不是一次 `yibiao -> bidmaster` 的全仓库文本替换。旧标识同时存在于以下四种
不同性质的对象中：

1. 用户可见品牌、README、安装包和外链；这些应改为 BidMaster 或移除。
2. 发布与运维元数据，例如 Docker 用户、环境变量、CI Secret、Analytics 资源；
   它们会影响部署和线上资源，应逐项迁移。
3. 兼容性与持久化协议，例如 Cookie、`window.yibiao`、SQLite 文件名、正文中的
   `yibiao-asset://`；它们已经被浏览器、Electron 客户端或用户数据引用，必须有
   双读、迁移和回滚路径。
4. 历史档案、进度日志、旧文章和基础设施实体；它们不能被改写为“从未发生”，也
   不得保留为活跃推广入口。

原 `.planning/yibiao-brand-cleanup/plan.md` 以 PR #3 之前的 Electron 代码、文件
存在性和行号为基础，且假设 Web 尚未引入身份和部署边界。该文件只作为历史输入，
不作为实施清单。本 Spec 以 `e71e87c` 的现状和下文可重复执行的扫描命令为准。

## 2. 现状证据（PR #3 后复扫）

### 2.1 Web 不是完整业务交付

- `client/server/app.cjs` 已提供 Express Web 服务、受保护的 `/api/bridge`、上传、
  下载令牌和 SSE；`Dockerfile` 与 `docker-compose.yml` 已提供 Docker 运行形态。
- `client/server/config.cjs` 在 production 强制 `OAUTH_MODE=mainquest`、HTTPS、
  MainQuest OAuth 参数、`SESSION_SECRET` 和配置加密主密钥。`auth/*.cjs` 已按
  MainQuest subject 建账号和 server-side session。
- `client/server/workspace/workspaceContext.cjs` 已把工作区隔离在
  `<data>/users/<workspaceId>/workspace`，复用 SQLite store；`test-web-workspace`
  已覆盖两个 workspace 的隔离。
- 但 `client/server/routes/bridge.cjs` 明确将 AI、Agent、导入、导出及多个任务启动
  处理为“未实现”错误/501。`client/server/workspace/webServices.cjs` 仍是 Web stub。
  因此 PR #3 是 Web runtime、登录和部分 store bridge 的骨架，不是完整 Web 业务完成。

**结论：** 任何会把页面或运行时伪装为“已完整迁移”的品牌改动，均不得在 Web 架构
Spec 的功能收敛之前合入。架构验收前只允许准备清单、Gate 和候选 diff，不允许合入
纯文案或仓库元数据变更，更不能用改名掩盖 501、stub 或缺失的账号隔离验收。

### 2.2 品牌痕迹与高风险契约

在 `e71e87c` 上执行 `git grep` 的基线计数如下（计数的是匹配行，不是唯一文件）：

| 搜索项 | 匹配行 | 代表性位置 | 风险分层 |
| --- | ---: | --- | --- |
| `yibiao`（不区分大小写） | 564 | `client/`、Analytics、文档、文章、历史日志 | 全部四层 |
| `易标` | 80 | 登录页、包元数据、README、历史资料 | 展示/档案 |
| `openbidkit`（不区分大小写） | 93 | release、Analytics、文档 | 元数据/基础设施 |
| `window.yibiao` | 192 | Renderer、preload 类型、Electron bridge | ABI 契约 |
| `YIBIAO_` | 97 | Web 配置、Docker、release、工具运行器 | 运维/兼容 |
| `yibiao_session` | 19 | auth 与 Web tests | 浏览器会话协议 |
| `yibiao_oauth_state` | 16 | auth 与 Web tests | OAuth state 协议 |
| `FB208/OpenBidKit_Yibiao` | 25 | package publish、README、Analytics | 外链/发布 |

关键实例：

- `client/package.json` 仍将包名、`appId`、`productName`、产物名和 GitHub publish
  指向旧品牌/旧仓库。
- `client/src/app/menuConfig.ts` 仍有 `githubStarNotice`，把未完成的商务标、图片
  知识库和 AI 评标引向旧仓库；这不符合“无 Star 诱导”。投标机会入口在当前菜单中
  已不存在，不能按旧方案的行号继续修改。
- `README.md`、`README.en.md`、`.github/workflows/star-history.yml`、release workflow、
  `analytics/worker/src/constants.js` 仍包含旧仓库、旧域名、推广或 Star History。
- `client/server/config.cjs`、`systemDatabase.cjs`、`sessionStore.cjs` 和 Docker 已使用
  `YIBIAO_DATA_DIR`、`yibiao_session`、`yibiao_oauth_state` 及运行用户 `yibiao`。
- `client/shared/workspacePaths.cjs` 与 Electron SQLite migration 仍使用
  `workspace/yibiao.sqlite`；富文本、导出和图片解析还使用 `yibiao-asset://`。

### 2.3 已删除功能与不要误删的基础能力

当前终端应用已删除三项产品能力：资源下载/资源市场、投标机会、插件管理；应用端菜单
中没有“投标机会”，PR #3 后 Web 客户端也没有这三项能力的入口。此状态必须保持，并以
路由、菜单、bridge namespace 和打包产物共同验收。

`client/server/routes/downloads.cjs` 与 `/api/downloads` 不是“资源下载”产品功能，
而是已登录用户下载自己工作区内导出/生成文件的受限传输能力；`httpClient.ts` 用它
完成文件导出。不得因产品功能下线误删此路由。Analytics Dashboard 的 plugins 管理
页是独立运维面，不是终端应用入口；是否退役该后台能力需要 Analytics owner 的
单独 Gate，不能由本次品牌 PR 静默删除。

## 3. 目标与非目标

### 3.1 目标

1. 所有当前用户可见的产品名称、页面标题、登录页、发布说明和活跃公开文档统一显示
   `BidMaster`；不展示“易标”“Yibiao”或“OpenBidKit”。
2. 所有活跃公开仓库链接、release publish 配置和 GitHub 引导统一到
   `zangqing828-ux/Bidding-Copilot`；删除旧域名、推广、中转站和 Star 诱导。
3. 在不破坏 MainQuest OAuth、账号到 workspace 映射、Docker volume、现有数据库、
   Web/Electron bridge 或 CI Secret 的前提下，建立受控的内部标识迁移路径。
4. 保持 Web + Docker 为目标交付形态；MainQuest OAuth 和按账号隔离数据是不可降级
   的正式边界。
5. v1 的视觉改动只允许 MQDS **浅色**配色 token 和品牌文字/资产替换；不得改组件、
   布局、交互，不实现深色模式。
6. 输出可独立审查、可回滚、可自动验证的工作包，而不是一份不可审查的大替换提交。

### 3.2 非目标

- 不在本 Spec 中补齐 Web AI、Agent、文件解析、任务执行或导出能力；这些属于架构
  Spec，且是品牌实施的前置。
- 不因改品牌重构 React 组件、菜单信息架构、交互、页面布局，或引入 MQDS 深色模式。
- 不把所有历史提交、历史文章内容、旧数据库行、Cloudflare 资源名或第三方系统名做
  机械全局替换。
- 不删除 `/api/downloads`、用户自己的工作区文件下载能力，或未经 Analytics owner
  授权的独立 Analytics Dashboard 功能。
- 不猜测新的域名、支持邮箱、MainQuest OAuth client、Analytics 资源名、发布签名
  key 或 Electron `appId`；这些均为 Gate。

## 4. 命名矩阵与迁移原则

### 4.1 唯一命名标准

| 对象层 | 旧值示例 | 目标/处理 | 迁移规则 |
| --- | --- | --- | --- |
| 用户可见产品名 | 易标、Yibiao Bid Toolbox、OpenBidKit | `BidMaster` | 直接替换；不保留旧名 fallback |
| 公开仓库 | `FB208/OpenBidKit_Yibiao`、`yibiaoai/yibiao-simple` | `zangqing828-ux/Bidding-Copilot` | 活跃链接/发布配置直接改；旧 URL 不作为推广入口 |
| 新域名、邮箱 | `yibiao.pro`、`agnet.top`、旧邮箱 | **Gate：由老板确认** | 确认前删除链接或使用相对路径；不得编造新值 |
| Web OAuth 协议 | `MAINQUEST_*`、授权端点与 redirect URI | 保持 MainQuest 名称 | 外部 IdP 契约，不能品牌化替换 |
| Web session/state Cookie | `yibiao_session`、`yibiao_oauth_state` | 建议目标 `bidmaster_session`、`bidmaster_oauth_state` | 双读/双清/兼容窗口后再单写；见 8.2 |
| Web 数据目录 env | `YIBIAO_DATA_DIR`、`YIBIAO_WEB_DIST_DIR` | 建议目标 `BIDMASTER_*` | 新旧双读，新的优先；Docker/CI 同次切换；见 8.1 |
| 工作区 SQLite 文件 | `yibiao.sqlite` | 建议目标 `bidmaster.sqlite` | 有状态迁移；不得直接 rename 线上 volume；见 8.3 |
| 富文本 asset URL | `yibiao-asset://` | 建议目标 `bidmaster-asset://` | reader 双协议，writer 切新协议，历史内容按需迁移；见 8.4 |
| Electron renderer bridge | `window.yibiao`、`YibiaoBridge` | **Gate：默认本轮保留** | 它是已发布 ABI；若迁移必须双 alias 和版本化弃用 |
| Electron package identity | `yibiao-client`、`com.yibiao.openbidkit` | **Gate：待桌面端存量策略** | `appId` 改动会改变 userData 路径，必须迁移/回滚演练 |
| Cloudflare/Analytics 实体 | `openbidkit-*`、`yibiao-client` | **Gate：Analytics owner** | display/UA 可改；binding、D1、R2、AE 名称不可直接替换 |
| CI Secret 与签名 key | `YIBIAO_LICENSE_*` | **Gate：Release owner** | app 先兼容双变量，再在 GitHub 配置侧换名；不可只改 workflow |
| 历史档案 | `progress.md`、`task_plan.md`、`文章/` | 保留真实历史或归档/删除 | 禁止改写事实；移除其中的活跃推广链接需 Gate |

### 4.2 强制规则

- 所有“目标”技术名在写代码前必须进入一个兼容性清单：旧名、读端、写端、数据存储
  位置、兼容截止版本、owner、测试与回滚方法缺一不可。
- 在兼容窗口内，读取顺序必须是 **新值优先、旧值 fallback**；日志必须报告使用了
  fallback，但不得输出 secret、Cookie 值或用户数据。
- 同一对象不能出现“写新名但读端只支持旧名”或“CI 先删旧 secret、程序尚未支持新
  secret”的中间状态。
- MainQuest 的协议字段、subject、OAuth endpoint、注册 redirect URI 与账号主键不
  因产品改名而改名。
- 文档中的品牌扫描必须排除本 Spec 和明确标为历史兼容说明的文件；验收看的是活跃
  表面是否干净和 allowlist 是否最小，而不是盲目追求全仓零匹配。

## 5. 依赖与执行顺序

```text
Web 架构 Spec 验收
  ├─ Web 完整功能矩阵、bridge 真正实现、账户隔离与 Docker 运行验收
  └─ 确认哪些 Electron ABI/数据格式仍由 Web 共用
       ↓
品牌 WP-0（清单与 Gate）
       ↓
WP-1 展示品牌 + WP-2 活跃外链/仓库元数据 + WP-3 下线功能护栏
       ↓
WP-4 Web/Docker/OAuth 兼容迁移 ──┐
WP-5 Desktop/持久化协议迁移 ─────┼─ 仅在各自 Gate 批准后
WP-6 Analytics/Release 基础设施 ─┘
       ↓
WP-7 档案处置、回归、灰度和回滚演练
```

### 5.1 架构 Spec 的硬前置关系

进入任何品牌实施 PR 前，架构 Spec 至少必须给出并通过以下证据。架构验收前只允许
WP-0 形成盘点、Gate 记录和不合入的候选 diff：

1. **功能真值表**：每个 Web 菜单项/bridge namespace 标明“已实现、暂不暴露、明确
   未支持”。任何已暴露但仍然稳定返回 501/stub 的业务项，要先由架构 Spec 实现或
   从 Web 可达面移除，不能通过换标题掩盖。
2. **账号隔离**：MainQuest subject -> account -> workspace 的数据路径、上传、下载、
   SSE、任务、配置和 SQLite 均有双账号回归测试；不得回退到全局 workspace。
3. **运行形态**：Docker build、production startup 配置校验、持久化 volume、health /
   readiness、Web CI 测试和容器启动检查均通过。
4. **协议所有权**：架构 Spec 为 `window.yibiao`、`yibiao.sqlite`、asset URL、Cookie
   和 `YIBIAO_*` 给出消费者图。没有消费者图，不进入技术标识迁移。

WP-1/2 可在前置收敛期间准备候选清单或 diff，但不得实施、合入或发布；WP-1 至 WP-7
全部必须等待上述 gate。

## 6. 可审查工作包

每个工作包独立 PR（或有独立 commit、测试记录和回滚说明）。不得将不同风险层混在
一个“rename all”提交中。

### WP-0：再扫描、分类清单与实施 Gate

**目的：** 冻结 PR 实施所依据的事实，而不是沿用旧 plan 行号。

**文件边界：** 新增 `.planning/yibiao-brand-cleanup/inventory/` 下的机器可读清单、
兼容 allowlist 和每一项 owner；不改运行代码。

**行为边界：**

- 以 `main` 的目标 commit 执行第 10 节扫描，按展示、元数据、兼容协议、历史档案、
  基础设施归类。
- 为每个 token 写明“改、保留、双读迁移、归档、等待 Gate”之一；无归类项不得实施。
- 记录本 Spec 第 11 节所有 Gate 的批准人、值、日期和关联 issue/PR。

**验收：** 计数和文件清单可复现；不存在仅写“全局替换”的任务；所有高风险 token
都有 owner、测试和回滚记录。

### WP-1：用户可见 BidMaster 品牌（浅色 UI 不改结构）

**目的：** 清理产品显示文字，保持既有组件、布局和交互不变。

**候选文件边界（以 WP-0 重扫为准）：**

- `client/index.html`、`client/src/features/auth/LoginGate.tsx`、侧边栏、页面 title、
  Electron window/preload 中的 `appName`、授权用户可见文案。
- `client/package.json` 中 `description`、`productName`、`artifactName` 等展示字段；
  `client/electron/resources/`、DMG 使用说明和当前发布说明。
- 当前 README、`README.en.md`、`SECURITY.md`、`CONTRIBUTING.md` 和 `docs/` 中的
  活跃产品介绍。

**行为边界：**

- 仅替换用户可见字符串/品牌素材引用和 `client/src/styles/tokens.css` 中已声明的 MQDS
  浅色 token；禁止重命名现有 `--yb-*` 内部 token，禁止修改 React 组件层级、CSS 布局、
  菜单行为和任何深色模式/深色语义样式。
- 登录页在 MainQuest 登录前后的标题均为 BidMaster；不会改变 `/api/auth/login`、
  callback 或退出行为。
- 不在技术调试日志、内部 provider id 或历史记录中做无差别替换。

**验收：** 登录页、窗口标题、侧边栏、静态 HTML、当前 README 和 release 可见名称
只展示 BidMaster；`npm run build:web` 通过，人工浅色视觉回归无布局变化。

### WP-2：仓库、外链、推广和 Star 诱导断开

**目的：** 让当前产品和发布渠道只导向目标仓库，不再把用户带到旧品牌资产。

**文件边界：** `README*`、活跃 `docs/`、`client/package.json` publish、
`.github/workflows/release.yml`、`.github/workflows/star-history.yml`、当前应用内的
外链/notice 配置、Analytics 中用于公开仓库统计的常量。

**行为边界：**

- 删除 `githubStarNotice` 与所有“开发中请点 Star”提示；未完成能力的可达性由架构
  功能真值表决定，不借外链替代产品行为。
- 所有仍需保留的 GitHub issue、release、compare、badge 链接指向
  `zangqing828-ux/Bidding-Copilot`。
- 删除或禁用 Star History workflow、Star History/Trendshift/DeepWiki 等推广 badge，
  以及 `yibiao.pro`、`agnet.top`、`s.markup.com.cn` 等未经当前确认的外链。新域名
  未确认前不放占位链接。
- GitHub release 仍可发布，但 publish owner/repo、MSI 元信息和 release 文案必须随
  canonical repo 一并校正。不要通过改 GitHub Actions Secret 名称来完成此包。

**验收：** 点击所有终端应用可见入口不会打开旧仓库、旧域名、推广或 Star 页面；
活跃文档/CI 不含旧 GitHub URL；目标仓库 release dry-run/配置检查通过。

### WP-3：已下线功能的持续删除护栏

**目的：** 使后续架构和品牌工作不会重新暴露已经裁撤的能力。

**文件边界：** `client/src/app/menuConfig.ts`、`AppRouter`、导航 type/config、Web
bridge namespace/路由注册、打包入口及针对这些面向终端用户的测试。

**行为边界：**

- 不新增或恢复“资源下载/资源市场”“投标机会”“插件管理”任一产品能力的菜单、深链接、
  路由、API namespace、feature import 或安装包入口。
- 保留 `POST/GET /api/downloads`，因为它只为账号工作区内的导出文件传输服务；其路径
  边界、认证和所有权测试不得删除。
- Analytics Dashboard plugins 页面不在本包修改范围；该后台是否退役须走 WP-6 的
  Analytics Gate。

**验收：** 静态路由/菜单/bridge 扫描为零；无未登录或跨 workspace 的下载；现有
`test:web-files` 继续验证下载路径隔离。

### WP-4：Web、Docker 与 MainQuest OAuth 标识兼容迁移

**目的：** 在不破坏已部署 Web、Cookie 和数据 volume 的条件下，逐步从 YIBIAO 运维
命名迁移到 BIDMASTER 命名。

**文件边界：** `client/server/config.cjs`、`client/server/auth/`、
`client/server/database/`、`client/server/workspace/`、`client/shared/workspacePaths.cjs`、
`Dockerfile`、`docker-compose.yml`、`.env.example`（若存在）、`docs/web-deployment.md`、
Web tests、CI Docker run 配置。

**行为边界：**

- `MAINQUEST_*`、OAuth request/response 字段、账号的 `mq_subject`、`workspace_id`、
  redirect URI 逻辑保持不变。只更新产品展示和经批准的本地命名，不改变 IdP 协议。
- 先落地环境变量的双读和启动诊断，再切 Docker、CI、部署文档；严禁先删
  `YIBIAO_DATA_DIR` 再升级已有容器。
- Cookie 迁移采用双读、双清、兼容期双写（或明确的强制重新登录 Gate）策略。新的
  server 必须接受旧 cookie；回滚到旧 server 时用户不会因只收到新 cookie 被永久
  登出。
- 运行用户、volume 名、container 名仅在运维 Gate 批准后变更，并验证 named volume
  仍挂载同一数据目录；不要把 Docker 重命名误当作数据已迁移。

**验收：** CI/local 的 mock OAuth 覆盖登录、退出、state 校验和既有 workspace 回归；
G2 批准的受保护 staging 环境必须另行完成 MainQuest 实际登录、退出、回调 state 校验。
同一已存在 data volume 升级前后读取到相同账号/workspace；两账号上传、下载、SSE、
配置和 store 隔离；Docker health/readiness 通过。mock 成功不能替代 MainQuest staging
验收。

### WP-5：桌面端 ABI 与持久化协议迁移（仅批准后）

**目的：** 处理 `window.yibiao`、`yibiao.sqlite`、`yibiao-asset://`、Electron `appId`
等高风险契约，而不是把它们误作为纯品牌文案。

**文件边界：** Electron preload/main、`client/src/shared/types/`、Renderer 调用点、
`electron/services/`、`shared/workspacePaths.cjs`、SQLite migration、asset URL parser/
writer、导出解析、测试 fixture、packaging 配置。

**行为边界：**

- 默认本轮 **不改** `window.yibiao`。如产品决定对外暴露 `window.bidmaster`，preload
  必须同时提供旧 alias 至少一个明确版本周期，类型定义和所有测试同步；移除 alias
  只能在 telemetry/升级率满足 Gate 后进行。
- 对 asset URL，reader 同时解析 `yibiao-asset://` 与新协议，writer 只在所有 reader
  可用后写新协议；不得用正则批量改用户 Markdown/HTML。
- 对 SQLite，先实现离线/维护窗口迁移器和幂等 marker，再执行文件改名。迁移器必须
  使用 SQLite 一致性备份，而不是在运行时直接 `mv` WAL 数据库文件。
- `appId`、package name、默认 userData 路径的修改必须由桌面端存量用户策略批准；
  否则只改 productName/installer 展示字段，保留 stable identity。

**验收：** 旧 Electron 用户数据可升级打开；旧资产 URL、旧 bridge 调用和新写入数据
均可读；迁移可重复执行；降级/恢复按第 9 节演练，无数据丢失。

### WP-6：Analytics、CI 与发布基础设施

**目的：** 改正用户可见和发布元数据，同时避免破坏 Cloudflare 统计、license 与线上
数据资源。

**文件边界：** `analytics/worker/`、`analytics/dashboard/`、`.github/workflows/`、
release 脚本、`wrangler*.jsonc`、部署文档和基础设施变量清单。

**行为边界：**

- GitHub repo URL、HTTP User-Agent、默认产品展示名、仪表盘可见品牌可按 WP-0 清单
  修改。
- D1/R2/Analytics Engine binding、项目名、历史数据表和 Cloudflare resource id 默认
  保留，直至 Analytics owner 批准有数据迁移/retention/rollback 的独立方案。
- release 程序可以先支持 `BIDMASTER_LICENSE_*` 与 `YIBIAO_LICENSE_*` 双变量；只有
  在仓库 Secret/Variable 已配置新值、官方构建验证成功后才移除旧读取。Secret 值永不
  进入仓库、日志或 Spec。
- CI 必须继续运行 renderer build、`test:web-auth`（当前为 mock OAuth）、Web
  workspace/tasks/files/export tests、Docker build 与 mock 启动健康检查；品牌改动不能
  降低原有门禁。MainQuest staging OAuth 属于 G2 的受保护发布前 Gate，不得伪称为当前
  CI 已覆盖的能力。

**验收：** CI 的 `client`、`analytics_worker`、`analytics_dashboard` 与 `quality_gate`
成功；Analytics Worker/Dashboard 的 `wrangler deploy --dry-run` 通过且不改动 Cloudflare
实体；官方 release staging 读取新/旧兼容配置的预期路径明确，旧 Cloudflare 数据连续
可查。

### WP-7：档案处置、发布与回归

**目的：** 在不篡改历史的前提下完成对外清理、灰度和可审计交付。

**文件边界：** `progress.md`、`task_plan.md`、`文章/`、旧截图/手册、历史文档索引、
release notes，以及 WP-0 产生的 allowlist/迁移记录。

**行为边界：**

- 已经是历史记录的名称和链接不得被伪造性替换；按 Gate 选择“保留并加历史声明”、
  “移入 `docs/history/`”或“从公开工作树删除、仍由 Git history 保留”。
- 任何仍公开保留的历史页面必须不含可点击的旧推广/Star/域名入口，或带明确的历史
  上下文并经 Gate 批准。
- 发布先在 staging Docker volume 与 MainQuest staging client 上演练，再按批准的
  maintenance/灰度计划进入生产。

**验收：** 活跃面扫描通过、allowlist 仅含批准的协议/档案项、迁移/回滚演练记录齐全、
发布后监控无 OAuth/login/workspace 失败峰值。

## 7. 数据与兼容策略

### 7.1 账号与工作区：不迁移身份主键

`accounts.mq_subject` 是 MainQuest 身份的稳定映射；`accounts.workspace_id` 和
`users/<workspaceId>/workspace` 是隔离边界。品牌迁移不得重新生成这些 UUID、不得以
邮箱替换 subject、不得合并用户目录，也不得把每账号的配置退回共享路径。

所有涉及数据库/路径的实现必须同时证明：

- 同一个 MainQuest subject 在升级后仍指向原 workspace；
- 两个 subject 之间无法通过 bridge、upload、downloads 或 SSE 读取彼此数据；
- `auth.sqlite` 的 schema 不因品牌名而重建或清空；
- `CONFIG_ENCRYPTION_KEY` 的加密格式保持兼容，密钥轮换不夹带在品牌 PR 内。

### 7.2 Cookie 迁移

Cookie 名虽然不是常规 UI 文案，但它是已部署浏览器的协议。若 Gate 批准从
`yibiao_session` / `yibiao_oauth_state` 迁移到 `bidmaster_*`，按以下两个 release
执行：

1. **兼容 release：** session/state 读取新名优先、旧名 fallback；login 成功后写新旧
   session；logout、state 清理同时清除新旧名称。测试覆盖旧 cookie 登录、旧 state
   callback、new->old rollback。
2. **收口 release：** 在批准的兼容期和旧版本使用率门槛后，仅写新名；旧名 fallback
   继续保留一个明确版本周期，之后才删除。删除前须有监控/客服回归证据。

Cookie 值、`SameSite`、`HttpOnly`、`Secure`、TTL、path 与 state 双重校验均不因改名
而放宽。

### 7.3 SQLite 文件与 Docker volume

`yibiao.sqlite` 位于持久化 workspace，可能伴随 WAL/SHM 文件。批准改名时：

1. 先在与生产同版本的 volume snapshot 上运行预检：磁盘空间、WAL checkpoint、
   `PRAGMA integrity_check`、schema version、可恢复备份。
2. 进入批准的维护窗口，暂停写入，使用 SQLite backup/VACUUM INTO 创建
   `bidmaster.sqlite`，验证行数/关键表/`integrity_check`，再写入幂等迁移 marker。
3. 只在验证成功后切换应用配置；旧文件作为只读可恢复备份保留到批准的 retention
   期限。不得对运行中的 `*.sqlite-wal` 使用文件级 rename。
4. 回滚必须在停止写入后从新库一致性备份恢复旧路径，或回滚到保留旧库；必须明确
   RPO=0 的维护窗口责任人。

在 Web 尚未生产或没有存量数据时，是否允许 reset 仍需 Gate；没有书面确认时按有数据
迁移执行。

### 7.4 内容标记、Asset URL 与 bridge ABI

正文中的 section/illustration/rejection 标记和 `yibiao-asset://` 可能已保存于用户
Markdown、HTML、SQLite 字段或导出文件。实现必须采用“新写、双读、延后清理”，不
对用户目录做全量文本替换。对每种标记增加 fixture：旧输入、新输入、混合输入、导出
和回读。

`window.yibiao` 是 Renderer 与 Electron preload 的 ABI，当前在 Web 登录检测及大量
Renderer 调用中仍被使用。除非 WP-5 Gate 明确批准，不将它作为品牌展示问题处理。
若批准改名，旧/新 alias、`YibiaoBridge`/新类型、preload 暴露、Vite window 类型和
Electron smoke 都必须同一 PR 验收。

## 8. 外链、CI、OAuth 与 Analytics 决策

| 主题 | 已定决策 | 实施动作 | 不可擅自决定的项 |
| --- | --- | --- | --- |
| GitHub | 统一新仓库 | 改活跃链接、publish、badge、release 目标 | 无 |
| Star/推广 | 断开 | 删除 Star notice、Star History workflow、推广 badge/中转 | 历史文章是否公开保留 |
| 旧域名 | 断链/本地化 | 移除当前外链，使用相对路径 | 新域名和邮箱 |
| MainQuest OAuth | 正式边界 | 保留 `MAINQUEST_*`，验证 staging/prod redirect | client id、redirect URI、owner |
| Cookie | 需要安全迁移 | 双读/双写/双清，兼容期后收口 | 新 cookie 名和兼容期长度 |
| CI | 不降级 | 保留 Web tests + Docker 启动检查；更新变量时双支持 | Secret/Variable 实际迁移时间 |
| Analytics | 统计能力保留 | 改 display/UA 可见值；资源实体默认不动 | D1/R2/AE 重命名与数据迁移 |
| Electron 发布 | 展示可改，identity 谨慎 | `productName` 可随品牌；`appId` 后置 | 新 appId、存量迁移策略 |

## 9. 迁移、灰度与回滚

### 9.1 发布顺序

1. 在 staging 建立 production-like Docker volume 的可恢复 snapshot，验证 WP-4
   兼容 release 和 Web 架构测试。
2. 先发布纯展示/外链/功能护栏工作包（WP-1/2/3）；它们必须可由普通 git revert
   回退，且不修改用户数据。
3. 发布 Web 兼容 release（WP-4）：新代码仍能读取旧 env/cookie/path，收集 login、
   callback、workspace 和 Docker health 指标。
4. 在批准的维护窗口执行数据库/路径迁移（WP-5）；完成 integrity、双账号隔离、
   导入/导出 fixture 和回滚演练后再逐步收口旧名。
5. Analytics/CI/release 和档案处理在各自 Gate 批准后合入；禁止以生产发布为实验场。

### 9.2 回滚矩阵

| 变更 | 首选回滚 | 数据影响 | 放行条件 |
| --- | --- | --- | --- |
| 展示文案、README、外链 | revert 对应 PR | 无 | 构建与链接扫描通过 |
| 菜单/入口删除 | revert 对应 PR | 无 | 架构真值表仍成立 |
| env 兼容 | 回滚到仍支持旧变量的 release | 无 | 旧变量未提前删除 |
| Cookie 迁移 | 使用双写 release 或清除新旧 Cookie 重新登录 | session 可重建，不丢 workspace | old/new cookie 回归通过 |
| SQLite/path 迁移 | 停写后从一致性备份恢复/反向迁移 | 需维护窗口，RPO=0 | snapshot、integrity 和恢复演练通过 |
| Cloudflare/CI Secret | 恢复旧 binding/旧 Secret，应用仍双读 | 不删云数据 | staging release 成功 |

若出现 OAuth callback 失败、跨账号数据访问、SQLite integrity failure、Docker 无法启动、
关键 CI job 失败或不可解释的登录错误峰值，立即停止后续收口；恢复到最近一个仍双兼容
的版本，并保留日志/volume snapshot 供排查。

## 10. 验证命令

以下命令是每个工作包的最低验证基线；实现 PR 必须按实际改动补充针对性测试。命令从
仓库根目录执行，除非另有说明。

```bash
# 1. 固定在目标基线重新盘点（不要把本 Spec 的文字算成产品残留）
git grep -I -i -n -e 'yibiao' e71e87c -- ':!.planning/yibiao-brand-cleanup/brand-cleanup.spec.md'
git grep -I -i -n -e '易标' e71e87c -- ':!.planning/yibiao-brand-cleanup/brand-cleanup.spec.md'
git grep -I -i -n -e 'openbidkit' e71e87c -- ':!.planning/yibiao-brand-cleanup/brand-cleanup.spec.md'
git grep -I -n -e 'window.yibiao' e71e87c -- ':!.planning/yibiao-brand-cleanup/brand-cleanup.spec.md'
git grep -I -n -e 'YIBIAO_' e71e87c -- ':!.planning/yibiao-brand-cleanup/brand-cleanup.spec.md'
git grep -I -n -E -e '(FB208/OpenBidKit_Yibiao|yibiaoai/yibiao-simple|yibiao\.pro|agnet\.top|trendshift\.io|deepwiki\.com|star-history\.com)' e71e87c -- ':!.planning/yibiao-brand-cleanup/brand-cleanup.spec.md'

# 2. 三项已删除产品能力的终端入口护栏；/api/downloads 为内部传输能力，不在此禁用
if rg -n -i '(资源下载|资源市场|投标机会|插件管理)' client/src client/server; then
  echo '发现已删除产品能力的终端入口或实现痕迹' >&2
  exit 1
fi
if rg -n 'githubStarNotice|OpenBidKit_Yibiao|yibiaoai/yibiao-simple' client/src; then
  echo '发现 Star 引导或旧仓库入口' >&2
  exit 1
fi

# 3. 代码与 Web 回归
cd client
find electron scripts server -name '*.cjs' -print0 | xargs -0 -n1 node --check
npm run build:web
npm run test:web

# 4. Docker 与部署前检查（mock 仅用于 CI/local，不可代替 G2 MainQuest staging）
cd ..
check_container='bidding-copilot-brand-check'
docker rm -f "$check_container" >/dev/null 2>&1 || true
trap 'docker rm -f "$check_container" >/dev/null 2>&1 || true' EXIT
docker build -t bidding-copilot-web:brand-check .
docker run -d --name "$check_container" -p 3000:3000 \
  -e NODE_ENV=development -e OAUTH_MODE=mock \
  -e SESSION_SECRET=brand-check-secret -e CONFIG_ENCRYPTION_KEY=brand-check-key \
  -e YIBIAO_DATA_DIR=/data \
  bidding-copilot-web:brand-check
for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error http://127.0.0.1:3000/api/health; then
    break
  fi
  if [ "$attempt" = 30 ]; then
    docker logs "$check_container"
    exit 1
  fi
  sleep 1
done
curl --fail --silent --show-error http://127.0.0.1:3000/api/readiness

# 5. Analytics / CI（改到相应目录时；与现有 CI 一致，dry-run 不部署）
analytics_check_dir="$(mktemp -d)"
trap 'rm -rf "$analytics_check_dir"; docker rm -f "$check_container" >/dev/null 2>&1 || true' EXIT
(
  cd analytics/worker
  npm ci
  WRANGLER_SEND_METRICS=false npx --no-install wrangler deploy --dry-run \
    --outdir "$analytics_check_dir/worker"
)
(
  cd analytics/dashboard
  npm ci
  WRANGLER_SEND_METRICS=false npx --no-install wrangler deploy --dry-run \
    --outdir "$analytics_check_dir/dashboard"
)

# 6. 每个提交最后执行
git diff --check
```

生产或 staging 还必须执行 MainQuest 实际授权登录、callback、退出、旧/新 cookie 兼容、
两个账号工作区隔离、现存 Docker volume 升级、SQLite integrity 和回滚演练。不得用
mock OAuth 的成功替代 MainQuest staging 验收。

## 11. 验收标准

### 11.1 最终产品验收

- Web 与 Docker 是可部署交付；production 仅允许 MainQuest OAuth，账号数据按
  `mq_subject -> workspace` 隔离，且所有 Web CI、Docker health gate 与 G2 MainQuest
  staging 验收通过。
- 当前用户可见页面、安装包/发布元数据、活跃 README/docs 中的产品名为 BidMaster；
  浅色 MQDS 配色没有组件、布局、交互或深色模式改动。
- 当前应用/README/release/CI 没有旧仓库、旧域名、推广中转、Trendshift/DeepWiki/
  Star History 或 Star 诱导的活跃链接；所有 GitHub 公开链接指向目标仓库。
- 资源下载、投标机会、插件管理不存在于终端应用菜单、路由、可达 API namespace、
  feature import 和发行包入口；工作区文件下载能力仍有认证、路径和账号隔离。
- 兼容清单之外不出现旧 token；清单内每项都有原因、owner、截止版本和测试。历史
  档案不会被伪造改写，也不会意外成为当前推广入口。

### 11.2 迁移验收

- 旧 env、cookie、asset URL、数据库/bridge（如本次批准迁移）在兼容期内均可读；
  新写入遵循批准的新名；对敏感值无日志泄漏。
- 任一数据库/路径/appId 变更都有 staging snapshot、幂等迁移 marker、integrity
  检查、双账号验证及可执行的 RPO=0 回滚演练。
- CI 没有因品牌工作被降级：mock OAuth Web 测试、Docker run health、Analytics checks、
  release quality gate 均继续存在并通过；G2 MainQuest staging OAuth 记录与 CI 结果分开
  保存。

## 12. 阻断 Gate（必须由老板/对应 owner 明确确认）

以下项目没有确认值时，只能停在兼容实现或移除旧链接，不能自行填值：

| Gate | 需要确认的值/决定 | Owner | 阻断的工作包 |
| --- | --- | --- | --- |
| G1 | 新公开域名、支持邮箱、是否有官网 | 老板 | WP-1、WP-2 文档收口 |
| G2 | MainQuest OAuth production/staging client、注册 redirect URI、运维 owner | 老板 + MQ owner | WP-4 生产发布 |
| G3 | Cookie 新名称、双写/旧读的版本与时间长度、是否允许强制重新登录 | 老板 + 架构 owner | WP-4 收口 |
| G4 | 已部署 Web/Docker volume 是否含真实数据；迁移维护窗口与 retention | 老板 + 运维 owner | WP-4/5 数据迁移 |
| G5 | Electron 是否继续支持存量用户；新 `appId`/package identity 与用户数据迁移策略 | 老板 + 桌面端 owner | WP-5 |
| G6 | Analytics D1/R2/AE/binding 是否只保留旧实体，或另行迁移/重命名 | Analytics owner | WP-6 |
| G7 | GitHub release 签名 Secret/Variable 的新命名、双支持窗口和密钥轮换责任 | Release owner | WP-6 |
| G8 | `progress.md`、`task_plan.md`、`文章/` 等历史材料是保留、归档还是从公开树删除 | 老板 | WP-7 |
| G9 | Analytics Dashboard 的插件运维页是否退役；与“应用端插件管理已删除”的边界 | Analytics owner + 老板 | WP-3/6 |

## 13. 实施纪律

1. 先做架构收敛，再进入有状态的品牌迁移；PR #3 完成不等于业务完成。
2. 每个 PR 在描述中列明：所处工作包、影响层、兼容项、Gate、验证命令、回滚方式和
   未解决风险。
3. 不接受“改完后 `rg yibiao` 还有很多，所以继续全替换”的做法。先更新 WP-0 分类，
   再由 owner 批准改变协议。
4. 修改 UI 时只允许 BidMaster 文案、品牌资产和 MQDS 浅色 token；任何组件/布局/
   交互/深色模式变化应被 review 拒绝并拆到独立产品 Spec。
5. 文档、代码、CI、Docker 和运行配置必须一起更新；其中任一层仍指向旧仓库或仅支持
   旧变量时，相关工作包不得宣称完成。
