# AGENTS.md

## 1. 文档作用与优先级

本文件是 Bidding Copilot 仓库的项目级开发契约，适用于主线程、子代理和所有 AI Coding 工具。

进入仓库后按以下顺序读取：

1. 本文件。
2. `client/开发说明.md`。
3. 当前任务对应的 Spec。
4. 涉及 Web v1 时读取 `.planning/web-mainquest-v1/README.md` 和对应 Sprint Spec。
5. 涉及部署或 CI 时读取 `docs/web-deployment.md` 与 `.github/CI.md`。

规则优先级：

1. 老板在当前任务中的明确指令。
2. 当前任务已确认的 Spec 和验收标准。
3. 本文件。
4. `client/开发说明.md` 与其他仓库文档。
5. 现有代码惯例。

发现文档、代码和测试互相冲突时，先报告冲突和影响，不要静默选择一种口径继续开发。

## 2. 项目目标

项目以现有 Bidding Copilot 桌面端为业务基础，交付可在浏览器访问和通过 Docker 部署的 Web v1。

Web v1 的四个核心目标：

1. 支持 Linux 容器运行、健康检查、持久化、备份和回滚。
2. 保留现有前端组件、布局、交互和信息架构，只执行 MainQuest MQDS v4.1 Light 色板适配。
3. 接入 MainQuest OAuth，建立服务端会话，并按 MainQuest 账号隔离配置、数据库和业务文件。
4. 完整移除资源下载、投标机会、插件管理三个功能及其前端入口、路由和应用侧运行链路。

Web v1 首版只支持浅色模式。深色模式、组件重做、布局重排、交互重构、响应式重设计均不进入当前范围。

## 3. 产品范围

### 3.1 保留能力

- 技术方案生成与已有方案扩写。
- 招标文件导入、解析和分析。
- 知识库。
- 标书查重。
- 废标项检查。
- 文本模型、生图模型和必要的运行配置。
- 后台任务、进度通知、暂停恢复和可解释失败状态。
- Mermaid/HTML 图片渲染。
- Word 导出和浏览器下载。
- 既有 Analytics 埋点、聚合和看板能力。

### 3.2 删除能力

- 资源下载。
- 投标机会。
- 插件管理。

删除要求覆盖：

- 菜单、页面、路由、工具栏、设置项、帮助入口和用户可见文案。
- Renderer 调用、Bridge/IPC 暴露和应用侧启动链路。
- 仅服务于上述功能的应用依赖和运行时代码。

开源仓库元数据、历史提交和独立 Analytics 服务不在删除范围内。发现保留业务仍依赖待删除代码时，暂停当前工包并升级给主线程裁决。

## 4. 代码范围与技术栈

- `client/`：当前产品代码，包含共享 Renderer、Electron 桌面运行时和 Web 服务端。
- `client/src/`：Vite + React + TypeScript Renderer。
- `client/electron/`：Electron Main、preload、IPC 和桌面端服务，使用 CommonJS。
- `client/server/`：Web 服务端、OAuth、会话、账号工作区、HTTP Bridge、上传下载和 SSE，使用 CommonJS。
- `analytics/`：独立 Cloudflare Workers 埋点服务和 Dashboard。
- `sql/`：数据库结构说明；运行时 migration 仍以对应服务代码为准。
- `.planning/web-mainquest-v1/`：Web v1 的总控方案和 7 个 Sprint Spec。

仓库根目录没有 `package.json`。客户端命令必须先进入 `client/`。

## 5. 双运行时架构

桌面端和 Web 端共享 Renderer 与业务语义，同时保留各自的运行时适配层。

```text
React Renderer
      |
window.yibiao
      |
      +-- Electron preload / IPC --> Electron adapters
      |
      +-- Browser bridge / HTTP --> Web adapters
                                      |
                                      +-- MainQuest OAuth session
                                      +-- Account workspace
                                      +-- Linux runtime
```

强制边界：

- Renderer 不直接访问 Node、`fs`、`path`、`ipcRenderer` 或服务端绝对路径。
- Renderer 只通过 `window.yibiao` 使用业务能力。
- Bridge 类型以 `client/src/shared/types/ipc.ts` 为权威；新增或修改 API 时同步 preload、HTTP Bridge 和类型定义。
- `client/electron/ipc/*.cjs` 只注册和转发 IPC，业务逻辑放在服务层。
- 可复用业务核心不得在模块加载阶段依赖 `electron`、`BrowserWindow`、`dialog` 或 Electron `app`。
- Electron 专属能力放入 Electron adapter；Web 专属能力放入 Web adapter。
- Web 进程必须在未安装 Electron 生产依赖的 Linux 容器中正常启动。
- 不得通过把 Electron 安装进 Web 生产镜像来掩盖运行时耦合。

## 6. Renderer 与前端规范

- Renderer 入口保持 `client/src/main.tsx -> AppProviders -> App -> AppRouter`。
- 功能代码放 `client/src/features/<feature>/`。
- 跨功能能力放 `client/src/shared/`，且 `shared/` 不引用 feature。
- Prompt 统一放在 `client/src/shared/prompts/` 或 Main 侧对应服务中。
- 用户可见文案使用中文。
- UI 使用现有全局 CSS 和 Radix 基础组件，不引入 Tailwind。
- 成功、失败、警告和普通提示统一使用 `shared/ui/ToastProvider`。
- 禁止新增 `alert`；确认类交互优先复用项目内 Radix Dialog。
- 页面根容器保持 `height: 100%` 和 `min-height: 0`，长内容在页面内部滚动。
- `FloatingToolbar` 作为覆盖层使用，不为它额外保留大段空白。
- AI 生成 Markdown 默认关闭 raw HTML；只有明确展示可信本地 HTML 时才能局部开启。

## 7. MQDS v1 视觉规范

当前版本的准确口径是“MQDS v4.1 Light 色板适配”。

允许修改：

- CSS 颜色变量。
- 背景色、文字色、边框色、图标色。
- 状态语义色。
- SVG 的 `fill` 和 `stroke`。
- 仅由颜色构成的阴影或渐变。

禁止修改：

- React 组件结构和 JSX 层级。
- 页面布局、尺寸、间距和响应式断点。
- 字体、字号、字重、圆角和按钮形态。
- 动画、过渡、交互和业务状态逻辑。
- 为追求完整 Paper Architecture 而增加表面、光效或组件重构。

v1 基础色：

| 用途 | 色值 |
| --- | --- |
| 页面与卡片背景 | `#ffffff` |
| 次级背景 | `#f3f4f6` |
| 主文字 | `#111827` |
| 次文字 | `#6b7280` |
| 弱文字 | `#9ca3af` |
| 边框 | `#e5e7eb` |
| 主操作 | `#000000` |
| 成功文字 / 背景 | `#166534` / `#dcfce7` |
| 警告文字 / 背景 | `#92400e` / `#fef3c7` |
| 错误文字 / 背景 | `#991b1b` / `#fee2e2` |

普通装饰不得继续使用蓝色、青色或紫色。状态色只能出现在对应状态、风险和校验场景。

视觉验收必须覆盖保留页面矩阵，并提供截图证据。只通过 CSS 搜索无法证明页面视觉完成。

## 8. MainQuest OAuth 与会话

- 生产环境使用 OAuth Authorization Code 流程。
- OAuth Client Secret、Session Secret、配置加密密钥只存在于服务端环境变量或密钥系统。
- 前端 bundle、日志、错误响应和仓库文件不得出现真实密钥、Token 或用户文档正文。
- `state` 必须随机生成、短期有效、单次使用，并与浏览器登录尝试绑定。
- 会话 Cookie 在生产环境启用 `HttpOnly`、`Secure` 和合适的 `SameSite`。
- 反向代理部署必须正确配置 `trust proxy`、公开基础 URL 和精确回调地址。
- 登录完成后通过 MainQuest 用户稳定 ID 映射本地账号。
- 产品访问权限由 MainQuest Auth 中 OAuth Application 与 Product 的绑定关系控制；应用侧配置和部署文档必须与实际注册信息一致。
- mock OAuth 仅服务于本地开发和自动测试，不能作为真实 MainQuest 联调证据。

真实 OAuth 验收至少覆盖：

- 正常登录、回调、刷新和退出。
- 错误或重放 `state`。
- 授权码交换失败。
- 无产品权限账号。
- 反向代理 HTTPS 回调。
- 会话过期和服务端撤销。

## 9. 账号工作区与文件流

每个账号拥有独立工作区：

```text
<data-root>/
├── auth.sqlite
└── users/
    └── <workspace-id>/
        ├── user_config.json
        ├── workspace/
        │   └── yibiao.sqlite
        ├── uploads/
        ├── exports/
        └── logs/
```

规则：

- 账号身份从服务端会话获取，禁止信任浏览器传入的账号 ID 或工作区路径。
- Renderer 不接收服务端绝对路径。
- 上传接口返回业务文件 ID；后续导入、解析和检查通过文件 ID 关联。
- 下载接口使用账号归属的业务下载 ID，不接受浏览器传入的任意文件路径。
- 上传入口校验大小、扩展名、MIME 和文件名；进入内部服务后的业务参数按项目既有可信边界处理，避免重复校验。
- 临时文件需要定义成功、失败、超时和取消后的清理策略。
- 两个账号同时工作时，配置、SQLite、上传、导出、任务事件和日志不得串用。

## 10. 后台任务、AI、Agent 与导出

- 耗时 AI、文件解析、批处理、生成、检查、渲染和导出都在服务端后台任务中执行。
- Renderer 只负责启动任务、订阅事件、读取 Store 快照和展示状态。
- 任务启动后立即持久化 `running` 状态，并在关键阶段持续写入 Store。
- 页面刷新或 SSE 重连后，通过 active task 与持久化状态恢复展示。
- 服务进程重启后，失去 active runtime 的运行态必须变成可解释、可重试的状态。
- SSE 事件必须按账号和任务归属隔离。
- Web AI 服务使用账号工作区内的加密配置，保留既有队列、重试、Token 统计和暂停语义。
- Linux 镜像内至少有一套 Agent Runtime 可以稳定完成核心生成任务。
- Chromium/Playwright、LibreOffice、Agent 二进制及 `rg`、`fd`、`jq` 等运行依赖在构建阶段固定准备。
- Word 导出、Mermaid/HTML 图片渲染和下载必须在 Linux 容器中完成真实验证。

占位 stub、固定返回、模拟成功结果和“调用后得到预期错误”只能用于骨架阶段，不能作为业务完成证据。

## 11. 数据与存储

- 桌面端配置继续保存到 Electron `userData/user_config.json`。
- 桌面端业务工作区继续保存到 Electron `userData/workspace/`。
- Web 端配置和业务数据保存到当前账号工作区。
- 结构化业务状态进入 SQLite 或功能专用 Store。
- 大文本、原始上传文件和图片资产保存为文件，SQLite 保存路径、hash、计数和结构化状态。
- Renderer 的 `localStorage` 只保存轻量 UI 偏好。
- 技术方案正文展示和 Word 导出以 `outlineData.outline[*].content` 为权威来源。
- SQLite 表结构变化时同步运行时 migration 和 `sql/workspace_schema.sql`。
- Main 侧文件读写显式使用 UTF-8，并把 Windows 中文路径作为桌面端默认场景。

## 12. 七个 Sprint 与变更控制

Web v1 严格按以下顺序承接：

| Sprint | 结果 |
| --- | --- |
| 01 | 基线冻结与资源下载、投标机会、插件管理删减 |
| 02 | Web 运行时与浏览器 Bridge |
| 03 | MainQuest OAuth、会话和接口保护 |
| 04 | 账号工作区与浏览器文件流 |
| 05 | 后台任务、Linux Runtime、渲染和导出 |
| 06 | MQDS v4.1 Light 色板适配 |
| 07 | Docker 部署与完整业务验收 |

执行规则：

- 每个 Sprint 的完整范围以 `.planning/web-mainquest-v1/<sprint>.spec.md` 为准。
- 后续 Sprint 不得替前一 Sprint 补充其核心缺口后继续宣称顺序完成。
- 如需缩减范围，先更新对应 Spec、状态、PR 描述和验收口径，并取得老板确认。
- 未经确认不得把缺失工作移动到新增 Sprint、v1.1 或“后续优化”。
- 骨架完成、接口存在、类型通过或测试脚本全绿都不能单独代表 Sprint 完成。
- 当前未完成项以 `docs/web-v1-incomplete-items.md` 为状态参考；关闭每项时必须附真实验证证据并同步更新文档。

## 13. Subagent、分支与 worktree

- Web v1 集成工作在独立分支和独立 worktree 中进行。
- 集成分支为 `feature/web-mainquest-v1`；主仓库 `main` 上的用户改动不得被覆盖。
- 每个 Sprint 或可独立审查的工包使用独立分支和 worktree。
- 新分支默认使用 `codex/` 前缀；已有 SDD 分支沿用其现有命名。
- 启动子代理前明确：目标、所有权文件、禁改范围、依赖、验证命令和完成定义。
- 两个子代理不得同时修改同一文件或同一共享契约。
- 子代理完成后返回 commit SHA、变更摘要、验证结果和残余风险。
- 主线程逐提交审查并集成，禁止直接接受“已完成”的口头结论。
- Sprint 通过后再清理临时 worktree；集成分支保留到 Web v1 整体验收结束。

## 14. 编码与改动纪律

- 先定义成功标准和验证方法，再修改代码。
- 只修改当前任务要求直接涉及的文件。
- 不顺手重构、改名、格式化或清理无关代码。
- 新抽象层、新框架和新依赖需要明确收益；能用现有结构完成时优先复用。
- 发现必须扩大范围时，先说明原因、影响和替代方案，再等待裁决。
- 功能异常先复现并定位根因；必要时增加定向日志，禁止靠猜测修复。
- 开发阶段只执行已确认的 Spec；新产品想法记录为建议，未经确认不进入实现。
- 保留桌面端既有行为，Web 适配不得破坏 Electron 构建、启动、IPC 和 native 模块。
- 密钥、账号、Token、生产数据库、原始日志和构建产物禁止提交。

## 15. 测试与证据标准

测试名称必须对应真实业务结果：

- 成功路径要求接口返回成功状态，并验证 Store、文件、任务事件或导出物。
- `500`、`501`、stub 错误和“尚未实现”只能写入失败路径或未完成项测试。
- SSE 隔离测试必须实际创建任务和事件，再验证另一个账号无法收到。
- 文件测试必须覆盖成功上传、业务解析、归属隔离、下载和清理。
- OAuth 测试需要区分 mock 自动测试与真实环境联调。
- Docker 测试必须启动生产镜像，并检查 health、readiness 和核心业务。
- Electron native smoke 必须在 Web 测试之后重新验证，防止 `better-sqlite3` ABI 被 Node 重建污染。
- 视觉验收需要浏览器截图和页面矩阵。

禁止用断言“预期返回 500/501”来提高成功测试数量。测试数量只作参考，完成判断依据是业务场景、产物和证据链。

## 16. 本地验证

根据改动范围执行最小充分验证。

Renderer / TypeScript：

```bash
cd client
npm run build
```

CommonJS：

```bash
cd client
find electron scripts server -name '*.cjs' -print0 | xargs -0 -n1 node --check
```

Web 自动测试：

```bash
cd client
npm run test:web
```

Electron native：

```bash
cd client
npm run smoke:electron-native
```

依赖：

```bash
cd client
npm audit --omit=dev
```

Docker：

```bash
docker compose build
docker compose up -d
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS http://127.0.0.1:3000/api/readiness
```

Docker 验证结束后按任务约定决定是否保留服务；不得擅自关闭老板要求持续运行的演示服务。

`npm run build` 的既有 chunk 体积警告不视为失败，命令退出码非零才表示构建失败。

## 17. CI 与发布门禁

所有进入 `main` 的 Pull Request 必须通过 GitHub Ruleset 和稳定检查名 `CI / Quality Gate`。

CI 至少覆盖：

- lockfile 与 diff whitespace。
- `npm ci`。
- Electron、server 和 scripts 的 CommonJS 语法检查。
- TypeScript 与 Vite 构建。
- Web Auth、Workspace、Tasks、Files、Export 测试。
- Docker build、容器启动、health 和 readiness。
- Electron native ABI smoke。
- Analytics Worker 和 Dashboard dry-run。
- critical 生产依赖审计。

Web v1 发布候选还需人工或受控 E2E 证据：

- 真实 MainQuest OAuth 与无权限账号。
- 两账号数据和 SSE 隔离。
- 招标文件导入、知识库、查重、废标检查。
- 技术方案完整生成。
- Mermaid/HTML 图片渲染。
- Word 导出、下载和打开检查。
- 容器重启后的数据持久化。
- 回滚演练。

CI 全绿只说明已配置检查通过。缺少真实业务验收时，PR 状态仍为 `REVISE`。

## 18. Analytics 保护

- 禁止删除、绕过或弱化任何埋点、统计、Analytics Dashboard 展示和 Worker 聚合逻辑。
- 调整埋点字段、页面映射或聚合逻辑时，必须等价保留统计能力并说明影响。
- Worker 配置保留 `keep_vars: true`。
- `ACCOUNT_ID`、`ADMIN_TOKEN`、`ANALYTICS_API_TOKEN` 等密钥不得写入仓库。
- Analytics 部署命令只在对应任务明确授权后执行。

## 19. 完成定义

一个 Sprint 或工包只有同时满足以下条件才能标记 `PASS`：

1. Spec 内全部必做项已实现。
2. 成功路径产生真实业务结果。
3. 失败路径和账号隔离已验证。
4. 对应本地验证通过。
5. CI 所需门禁通过。
6. 桌面端相关回归通过。
7. 文档、配置示例和部署说明与代码一致。
8. 已知限制被如实记录，且不包含该 Sprint 的必做项。
9. 审查意见已处理，相关 conversation 已解决。
10. 主线程复核证据后确认。

若其中任一项缺失，使用 `PARTIAL`、`NOT DONE` 或 `REVISE`，并明确剩余工作。禁止把“骨架已合入”“后续再补”描述为 Sprint 完成。

## 20. 交付报告

每次实现完成后用业务语言报告：

- 做了什么。
- 业务上现在可以完成什么。
- 修改了哪些文件或模块。
- 执行了哪些验证，结果如何。
- 哪些内容没有做。
- 仍有哪些风险、依赖或待老板裁决项。
- 当前分支、commit、远端 PR 和部署状态。

本地测试、远端 CI、PR 可合并状态和生产部署验收必须分别陈述，禁止混写成一个“已完成”。
