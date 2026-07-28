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
| Agent | 4,302 | 37 | 4,265 | 首发退出 |
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
- Agent 分支从搬迁后的核心中裁剪。
- 归档新增的 Sidecar、Runner、run manifest 套件和大量重复测试不成套迁入。

## 3. 能力盘点

| 能力 | 当前状态 | 证据 | 发布差距 |
|---|---|---|---|
| React Web Shell | 已实现 | `client/src/`、Vite build | 仍暴露退出菜单、路由和桌面 Prompt |
| MainQuest OAuth | 代码骨架已实现 | authorize/token/me、state Cookie、session | 未完成真实 Product 绑定联调 |
| 单租户 TenantContext | 已实现 | 单例 registry、固定 tenant ID | 需纳入最终全链回归 |
| 用户 session | 已实现 | 独立 session SQLite | Cookie 仍为旧命名；未做真实会话过期 E2E |
| 共享业务空间 | 已实现 | 账号统一写入 deployment tenant ID | 需两个真实授权用户验收 |
| 上传 file ID | 已实现 | upload registry、随机文件名、签名探测 | 当前仍接受 DOC/XLSX |
| 文档解析 | 已实现 | Worker + PDF/DOCX/TXT/MD parser | 需真实大文件、错误和超时测试 |
| 加密模型配置 | 已实现 | server encrypted config store | 需日志和浏览器泄漏审计 |
| Web 文本 AI Runtime | 已实现 | 文本队列、endpoint policy、JSON 修复 | 真实模型全链尚无通过证据 |
| 招标分析 | 已接入真实 runtime | Web task + CAS + persistence | 浏览器 E2E 使用测试 AI |
| 目录生成 | Renderer 已调用 | `tasks.startOutlineGeneration` | Web contract pending |
| 全局事实 | Renderer 已调用 | `tasks.startGlobalFactsGeneration` | Web contract pending |
| 正文生成 | Renderer 已调用 | start/pause/resume/retry | Web contract pending |
| 图片计划与生成 | Electron 代码存在 | 约 778 行 planning/generation | 依赖 Agent 与 Electron renderer |
| AI 生图 | Electron 代码存在 | 多 provider 实现 | Web `generateImage/testImageModel` pending |
| 高保真 DOCX | Electron 代码存在 | 2,216 行 builder | Web 当前只用简单 DOCX fallback |
| 浏览器下载 | 已实现 | 一次性 token，认证后下载 | 需接高保真 builder |
| SSE | 已实现 | tenant 级 task event + heartbeat | 需完整任务与 Nginx 现场测试 |
| Docker | 可构建骨架 | Node 22 多阶段镜像 | 仍装 Agent 工具，未装 Chromium |
| readiness | 已实现基础检查 | data/system DB/dist | 当前错误依赖 Agent Runtime |
| CI | 有 Web build/test/Docker smoke | `.github/workflows/ci.yml` | 仍包含 Electron/Agent Gate，业务 smoke 不完整 |
| ECS | 未执行 | 无发布证据 | 等本地 RC |

## 4. 产品表面泄漏

当前菜单和路由仍包含：

- 商务标
- 文档知识库
- 查重
- 废标检查
- AI 评标
- 开发者页面
- 旧 GitHub Star 引导

应用根组件仍挂载：

- GPU/桌面提示
- 必须联网服务提示
- 桌面更新通知
- 本地 license 提示
- 开发者模式

这些入口会让用户进入 pending、桌面逻辑或退出范围，必须在业务迁移前先关闭。

## 5. Web Runtime 多余装配

`workspaceRuntimeFactory.cjs` 当前还创建：

- knowledge base store/service
- duplicate check store/stub
- rejection check store
- Agent coordinator/lease/service

`server/index.cjs` 优雅关闭仍依赖全局 Agent coordinator。

`readiness.cjs` 会检查 OpenCode、rg、fd、jq、prlimit；这些能力已经退出首发，继续保留会造成生产容器误报不就绪。

## 6. Docker 与依赖风险

当前 Dockerfile：

- 复制整个 `client/electron/`
- 下载 OpenCode
- 安装 jq、ripgrep、fd
- 保留 agent-e2e target
- 使用旧 Docker 用户和旧数据目录变量
- 未实际安装 Chromium

当前生产依赖审计结果：

- 11 个漏洞
- 8 个 high
- 3 个 moderate

high 来源包含：

- `adm-zip`
- Agent 依赖链中的 `brace-expansion`
- `electron-updater`
- `js-yaml`
- `linkify-it`
- `undici`
- `xlsx`，且当前版本无修复

范围收缩可以直接移除 Agent、Electron updater 和 XLSX；其余直接依赖升级后重新审计。

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
