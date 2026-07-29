# 当前实现与差距矩阵

核验基线：`6652dd56c3cce9d4eac101a320120acd4a6a560f`

核验日期：2026-07-28

## 1. 结论

当前项目已经有可运行 Web 骨架和部分真实业务能力，距离发布还缺四块硬能力：

1. 目录、全局事实、正文任务接入 Web。
2. Linux 下 Mermaid、HTML 和 AI 图片完整落盘。
3. 现有高保真 DOCX builder 接入 Web 下载。
4. Web-only 打包、安全依赖、MainQuest staging 与 ECS 验收。

最快路径是移动和裁剪已有业务代码。重写整套产品会重复制造约 1.5 万行已经存在的核心能力，并放大回归面。

## 2. 体量事实

### 2.1 当前单租户基线

从 `origin/main@1c0a17e` 到 `6652dd5`：

- 20 个文件变化
- 706 行新增
- 629 行删除
- 净新增 77 行

这轮单租户收敛已经符合轻量原则。

### 2.2 历史归档候选

从 `origin/main@1c0a17e` 到 `archive/wp-j-complete-20260727`：

- 134 个文件变化
- 31,971 行新增
- 11,384 行删除
- 净新增 20,587 行

老板提出的“超过 7 万行”继续作为历史体量告警保留。当前仓库中可复现、与 Web
发布候选直接对应的 commit range 得到上述 31,971 行新增；若后续定位到另一组明确的
branch/commit range，再追加同口径证据，不用模糊总数替代可复现比较。

新增来源：

| 分类 | 新增 | 删除 | 净增 | 判断 |
|---|---:|---:|---:|---|
| J-Core | 13,526 | 0 | 13,526 | 大部分为 Electron 业务文件复制到 core |
| Agent | 4,302 | 37 | 4,265 | 历史候选不整体迁入；当前 Web OpenCode Foundation 单独保留 |
| 测试/脚本 | 7,152 | 3 | 7,149 | 仅少量可选择复用 |
| Web server | 1,578 | 133 | 1,445 | 需要逐项筛选 |
| 文档 | 1,795 | 4 | 1,791 | 历史过程材料 |
| Renderer | 80 | 66 | 14 | 改动很小 |
| 其他 | 3,538 | 11,141 | -7,603 | 含搬迁和删除 |

目录、全局事实、正文和标段任务的 portable 版本与现有 Electron 文件高度相似：

| 能力 | 现有 Electron 行数 | 归档 portable 行数 | 实质差异 |
|---|---:|---:|---:|
| 目录生成 | 3,646 | 3,876 | +311 / -81 |
| 全局事实 | 890 | 892 | +6 / -4 |
| 正文生成 | 6,185 | 6,208 | +39 / -16 |
| 标段识别 | 276 | 352 | +104 / -28 |

由此得出实施纪律：

- 目录、全局事实、正文使用 `git mv`，再做少量 portable 修订。
- 多标段退出首发，标段识别不迁入。
- Agent 质量分支已从搬迁后的技术方案 core 中裁剪；该动作没有删除服务端 OpenCode Foundation。
- 归档新增的 Sidecar、重复 Runner、run manifest 套件和大量重复测试不成套迁入；当前 `client/server/agent/` 只保留已经验证的 Web Foundation。

## 2.1 2026-07-29 OpenCode 实际代码快照

当前 `main@5b9dfa3` 的 OpenCode Foundation 已进入 Web 生产装配：

- `client/server/agent/` 有 9 个模块、约 2,008 行，覆盖 Proxy、Runner、Coordinator、任务目录、Task Spec、结果提交和服务生命周期。
- `workspaceRuntimeFactory.cjs` 创建租户级 `agentService`，`server/index.cjs` 负责进程级 Coordinator 的拒绝新任务与有序关闭。
- Docker production image 固定 checksum 下载 OpenCode，安装 `prlimit`、`rg`、`fd`、`jq`；readiness 缺失任一关键依赖即返回 503。
- Agent 专项测试约 1,154 行，另有真实 OpenCode `agent-e2e` target 验证两轮 tool-call、安全结果读取和任务目录清理。
- Web Contract 已删除通用 `agent.*` 和 `events.agent.*`，浏览器不能直接运行 Agent。
- `businessAgentTaskRegistry.cjs` 当前强制生产 Task Spec 注册表为空；目录、全局事实、正文和图片任务直接调用 Web AI Runtime，尚未接入 OpenCode。

结论：OpenCode 当前是已经可运行但尚未挂载正式业务 Task Spec 的服务端执行底座。WR-06 必须保留并持续验证该底座，同时保持浏览器入口关闭。

## 3. 能力盘点

| 能力 | 当前状态 | 证据 | 发布差距 |
|---|---|---|---|
| React Web Shell | 已实现 | `client/src/`、Vite build | 仍暴露退出菜单、路由和桌面 Prompt |
| MainQuest OAuth | 代码骨架已实现 | authorize/token/me、state Cookie、session | 未完成真实 Product 绑定联调 |
| 单租户 TenantContext | 已实现 | 单例 registry、固定 tenant ID | 需纳入最终全链回归 |
| 用户 session | 已实现 | 独立 session SQLite | Cookie 仍为旧命名；未做真实会话过期 E2E |
| 共享业务空间 | 已实现 | 账号统一写入 deployment tenant ID | 需两个真实授权用户验收 |
| 上传 file ID | 已实现 | upload registry、随机文件名、签名探测 | 已收缩为 PDF/DOCX/TXT/MD；需最终安全回归 |
| 文档解析 | 已实现 | Worker + PDF/DOCX/TXT/MD parser | 需真实大文件、错误和超时测试 |
| 加密模型配置 | 已实现 | server encrypted config store | 需日志和浏览器泄漏审计 |
| Web 文本 AI Runtime | 已实现 | 文本队列、endpoint policy、JSON 修复 | 真实模型全链尚无通过证据 |
| 招标分析 | 已接入真实 runtime | Web task + CAS + persistence | 浏览器 E2E 使用测试 AI |
| 目录生成 | Web 已实现 | `tasks.startOutlineGeneration` + portable core | 需真实模型 RC |
| 全局事实 | Web 已实现 | `tasks.startGlobalFactsGeneration` + portable core | 需真实模型 RC |
| 正文生成 | Web 已实现 | start/pause/resume/retry + persistence | 需真实模型与重启 RC |
| 图片计划与生成 | Web portable core 已接通 | WR-04 task + Chromium adapter | 不依赖 OpenCode；需真实 RC 复核质量 |
| AI 生图 | Web illustration port 已实现 | provider + asset persistence | 需真实图片模型 RC |
| 高保真 DOCX | Web 已实现 | portable builder + Web asset resolver | 需 LibreOffice 与视觉 RC |
| 浏览器下载 | 已实现 | 高保真 builder + 一次性 token | 需完整业务 RC |
| SSE | 已实现 | tenant 级 task event + heartbeat | 需完整任务与 Nginx 现场测试 |
| Docker | 已包含 Web、Chromium、中文字体和 OpenCode Foundation | Node 22 多阶段镜像 | WR-06 删除 Electron/Pi 并收紧依赖；LibreOffice 仅作为 DOCX QA 工具另行装配 |
| readiness | 已检查 data/system DB/dist/OpenCode 工具链 | OpenCode 缺失返回 503 | 需补 Tenant DB、Chromium、字体并缓存结果 |
| CI | 有 Web build/test/Docker smoke 和真实 OpenCode E2E | `.github/workflows/ci.yml` | 删除 Electron/Pi Gate，保留 Agent Foundation Gate |
| ECS | 未执行 | 无发布证据 | 等本地 RC |

## 4. 产品表面状态

WR-01 已删除商务标、文档知识库、查重、废标检查、AI 评标、开发者页面、旧 GitHub Star 引导，以及 GPU、桌面更新、license、开发者模式等桌面提示。当前用户入口收缩为生成技术方案、已有方案扩写、模板管理和设置。

Web Contract 当前 `113 total / 2 pending`，剩余 `app.getVersion` 和 `ai.chat` 归 WR-06A；浏览器 `agent.*` 已明确 removed。

## 5. Web Runtime 装配裁决

`workspaceRuntimeFactory.cjs` 当前还创建：

- knowledge base store/service
- duplicate check store/stub
- rejection check store

Agent coordinator、lease、service、readiness 和 shutdown 接线属于保留范围。它们共同保证 OpenCode 任务的租户生命周期、拒绝新任务、取消和资源释放；WR-06 只删除浏览器入口、Pi、Sidecar、Electron Agent 和重复实现。

`readiness.cjs` 对 OpenCode、`rg`、`fd`、`jq`、`prlimit` 的检查继续作为发布 Gate。生产镜像缺少 Agent Foundation 时应明确判定为不可发布。

## 6. Docker 与依赖风险

当前 Dockerfile：

- 复制整个 `client/electron/`
- 下载 OpenCode
- 安装 jq、ripgrep、fd
- 保留 agent-e2e target
- 使用旧 Docker 用户和旧数据目录变量
- 已安装 Chromium 和中文字体

当前生产依赖审计结果：

- 11 个漏洞
- 8 个 high
- 3 个 moderate

high 来源包含：

- `adm-zip`
- Pi 依赖链中的 `brace-expansion`
- `electron-updater`
- `js-yaml`
- Pi 依赖链中的 `linkify-it`
- `undici`
- `xlsx`，且当前版本无修复

删除 Pi、Electron updater 和 XLSX 可以清除对应风险，不需要删除 OpenCode Foundation。OpenCode 服务端模块只依赖 Node 内置模块和现有 Web AI Runtime；其余直接依赖升级后重新审计。

## 7. MainQuest Auth 事实

MainQuest 在 OAuth Application 绑定 Product 后，会在 `/oauth/authorize` 执行：

1. OAuth Application 状态检查。
2. redirect URI 白名单检查。
3. Product active 检查。
4. 用户是否拥有 active Product access 检查。
5. 通过后才签发 authorization code。

因此 BidMaster 只需：

- 使用绑定 BidMaster Product 的 client ID/secret。
- 注册精确 callback：`<PUBLIC_BASE_URL>/api/auth/callback`。
- 完成 code exchange、`/oauth/me` 和本地 session。
- 验证无权限用户无法获得 authorization code，也无法创建本地 session。

产品 ID 必须由 MainQuest 生成 UUID；MariaDB 的 `redirectUris` 字符串兼容逻辑属于 MainQuest 侧发布检查。

## 8. 当前测试能力

已有：

- `npm run test:web`
- `npm run build:web`
- CommonJS syntax check
- Chromium 招标分析 E2E
- Chromium简单 DOCX 下载 E2E
- Docker mock OAuth + 投标分析 smoke
- Docker production OAuth 跳转 smoke

当前证据边界：

- 浏览器招标分析使用 `WEB_BID_ANALYSIS_TEST_MODE=1`。
- DOCX E2E 只检查 ZIP 文件头。
- 尚未覆盖目录、全局事实、正文、图片、高保真格式、真实 MainQuest、真实模型和 ECS。

## 9. 发布阻断项

| 阻断项 | 严重度 | 解除方式 |
|---|---|---|
| 发布页面可进入退出功能 | P0 | WR-01 |
| 41 个 Bridge Contract pending | P0 | WR-01/03/04/05 |
| 目录/事实/正文 Web 任务缺失 | P0 | WR-02/03 |
| 图片依赖 Electron/Agent | P0 | WR-04 |
| Web DOCX 为简单 fallback | P0 | WR-05 |
| Docker/readiness 依赖 Agent | P0 | WR-06A |
| 生产依赖 8 个 high | P0 | WR-06A |
| MainQuest Product 未联调 | P0 | WR-08 |
| 无本地真实全链 RC | P0 | WR-07 |
| 无 ECS 持久化/回滚证据 | P0 | WR-08 |
