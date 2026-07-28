# 开发工作包

## 0. 统一执行协议

每个工作包执行以下步骤：

1. 从最新 `codex/web-single-tenant-baseline` 创建 `codex/web-st-<id>-<slug>`。
2. 创建 sibling worktree。
3. 记录包起始 SHA。
4. 先增加或改写失败测试。
5. 只修改本包写入范围。
6. 跑聚焦测试、`npm run build:web` 和 CommonJS syntax check。
7. 统计原始 churn、rename-aware 业务源码、测试/脚本净新增和重复实现扫描结果。
8. 提交一个可独立回滚的 commit。
9. 主集成 worktree review 后以 fast-forward 或 cherry-pick 合入。
10. 跑集成门禁，再删除临时 worktree 和临时分支。

## WR-01：产品表面与 Contract 收口

目标：浏览器只暴露四个首发入口；41 个 pending 都获得明确去向。

主要写入范围：

- `client/src/App.tsx`
- `client/src/app/`
- `client/src/components/`
- `client/src/features/settings/`
- `client/src/features/technical-plan/`
- `client/src/shared/types/navigation.ts`
- `client/shared/bridgeContract.cjs`
- `client/src/shared/api/webBridge.ts`
- `client/server/routes/uploads.cjs`
- 退出功能目录

动作：

1. 菜单和 Router 只保留技术方案、已有方案扩写、模板和设置。
2. 删除桌面 update/license/GPU/online-service Prompt 和 developer mode。
3. 删除多标段选择、知识库选择、Agent repair 选项。
4. 上传 allowlist 收缩为 PDF/DOCX/TXT/MD。
5. 持续验证资源下载、投标机会和插件管理未被重新引入菜单、路由、API namespace 或运行入口。
6. release-required pending 保持 pending，绑定到 WR-03/04/05。
7. 退出能力统一标记 `removed`，Web Bridge 返回 `WEB_BRIDGE_REMOVED`，Renderer 不再调用。
8. 增加 reachability test：菜单、Router、App mount 和 Contract 不得引用退出能力。

预算：

- 净新增上限：100 行
- 预期：净删除超过 5,000 行

聚焦验证：

```bash
cd client
npm run test:web-contract
npm run test:web-contract:strict-guard
npm run test:web-files
npm run build:web
```

退出条件：

- 四个首发入口可达。
- 退出页面、路由、菜单和运行调用为 0。
- DOC/XLS/XLSX 上传拒绝测试通过。
- Contract disposition 与 `06-traceability-and-decisions.md` 一致。

## WR-02：portable core 搬迁与 Agent 分支裁剪

目标：将已经存在的目录、全局事实、正文和配图计划代码移动到 portable core，并移除 Agent/Electron 依赖。DOCX 搬迁留给 WR-05，避免阻塞文本闭环。

主要写入范围：

- `client/electron/services/` 中目录、事实、正文和两份配图来源文件
- `client/electron/utils/` 中实际被复用的纯函数
- `client/core/technical-plan/`
- 对应 characterization tests 和 fixtures

动作：

1. 先用现有 Electron 模块跑标准方案和已有方案扩写 characterization。
2. 用 `git mv` 搬迁，不保留第二份实现。
3. 对照 archive portable diff，只取 core import、port 注入和 bug fix。
4. 删除 Agent recovery、Agent consistency repair、Agent original coverage、Agent HTML 和 developer debug 分支。
5. 图片计划改为 `aiService.collectJsonResponse`，不创建文件型 Agent task。
6. 图片生成通过 `illustrationPorts` 注入 renderer 与 asset persistence。
7. 保留标准/扩写、字数控制、暂停 checkpoint、表格和图片计划行为。

明确不迁入：

- `server/agent-sidecar/`
- `shared/contracts/agent-sidecar/`
- `runManifest` 套件
- Agent quality report
- Sidecar/Runner/doctor/rollback scripts
- 多标段 portable task

预算：

- 净新增上限：500 行
- 现有大文件移动不计为业务源码净新增
- 预期：裁剪后整体净删除

聚焦验证：

```bash
cd client
node scripts/test-electron-task-characterization.cjs
node scripts/test-portable-core.cjs
node scripts/test-task-orchestrator.cjs
find core shared -name '*.cjs' -print0 | xargs -0 -n1 node --check
```

额外 guard：

```bash
! rg -n "electron|BrowserWindow|dialog|ipcRenderer|agentService|OpenCode|Sidecar" \
  core/technical-plan
```

退出条件：

- 非 Agent 业务 characterization 前后一致。
- portable core 不导入 Electron/Express/Agent。
- 旧业务实现没有重复副本。

## WR-03：Web 任务编排与文本业务闭环

目标：在 Web 中完成目录、全局事实、正文、暂停/继续、局部重试和恢复。

依赖：WR-01、WR-02。

主要写入范围：

- `client/server/workspace/webServices.cjs`
- `client/server/workspace/workspaceRuntimeFactory.cjs`
- `client/core/taskOrchestrator.cjs`
- `client/core/stores/technicalPlanStore.cjs`
- `client/shared/bridgeContract.cjs`
- Web task tests 和 browser E2E

动作：

1. 建立一个 `technicalPlanTaskService`，只注册四种首发任务。
2. 复用当前 bid-analysis 的 CAS、mutation executor、SSE 和 close 语义。
3. 接入 outline/global-facts/content runner。
4. 所有 start 输入在 bridge 边界验证；拒绝未知字段和超限数组/文本。
5. 启用 input revision，目录或输入变化后旧任务无法回写。
6. 目录编辑、添加、删除后清空旧正文、事实依赖缓存和图片计划。
7. pause、resume、retry、single-section regenerate 使用现有页面参数。
8. 启动时恢复中断任务：保留 checkpoint，状态转为 retryable interrupted。
9. 删除 `createWebTaskServiceStub` 和可达 `WEB_CAPABILITY_PENDING`。
10. 将四个 task contract 标记 `implemented`。

预算：

- 净新增上限：700 行

聚焦验证：

```bash
cd client
npm run test:task-orchestrator
npm run test:workspace-mutation-executor
npm run test:web-tasks
npm run test:web-contract
npm run test:web-browser -- --grep "technical plan"
npm run build:web
```

必须覆盖：

- 标准方案完整文本链。
- 已有方案扩写完整文本链。
- pause -> paused -> resume -> success。
- 刷新后 active task 回放。
- 局部重试只修改目标小节。
- 两个 session 并发写入的冲突与串行化。
- stale revision 无法覆盖新目录。
- 容器/进程中断后的 retryable state。

退出条件：

- 真实模型在本地完成两条文本链。
- 页面没有调用 pending task。
- Store 中正文权威源与页面一致。

## WR-04：Linux 图片渲染与 AI 生图

目标：Mermaid、HTML 图和 AI 图片均可在 Docker Linux 环境生成、持久化和重跑。

依赖：WR-03。

主要写入范围：

- `client/core/technical-plan/content/`
- `client/core/aiRuntime.cjs` 或最小 `imageRuntime.cjs`
- `client/server/render/`
- `client/server/workspace/workspaceRuntimeFactory.cjs`
- `client/core/stores/technicalPlanStore.cjs`
- `client/package*.json`
- `Dockerfile`

动作：

1. 增加 production `playwright-core`，镜像安装 Chromium 和 Noto CJK 字体。
2. 实现单例 Browser + 按任务 BrowserContext；关闭路径释放全部资源。
3. Mermaid 使用镜像内脚本，限制 diagram type、节点和渲染时间。
4. HTML 使用现有 `cheerio` 执行标签、属性和样式 allowlist；关闭 JavaScript，阻断所有网络与本地文件请求。
5. 迁入当前设置支持的 image provider，复用 AI queue 和 endpoint policy。
6. image response 优先使用 bytes/base64；URL 下载复用 endpoint policy，限制协议、DNS/IP、
   redirect、类型、字节数、尺寸和超时，拒绝私网、loopback、link-local 和云 metadata。
7. `ai.testImageModel` 标记 implemented。
8. 生成文件先写临时文件，再原子 rename；失败不保留半文件。
9. IllustrationPlan 和每张图状态持续落盘。
10. 重跑图片只清理上一轮生成块和对应 assets。

预算：

- 净新增上限：500 行

聚焦验证：

```bash
cd client
npm run test:web-ai-runtime
node scripts/test-web-image-renderer.cjs
node scripts/test-web-illustrations.cjs
npm run test:web-browser -- --grep "illustration"
docker build -t bidmaster-web:wr04 .
```

必须覆盖：

- Mermaid 正常、语法错误修复、最终失败。
- HTML 正常、脚本/外链拒绝、超高页面拒绝、超时。
- AI 图片正常、超限、错误 MIME、下载超时、DNS rebinding、redirect 到私网和 metadata 地址。
- pause、重启和 rerun illustrations。
- renderer 资源释放。

退出条件：

- 三类图片各至少一张真实落盘。
- 页面刷新后仍可预览。
- 最终正文包含可由 DOCX resolver 读取的 asset URL。

## WR-05：高保真 DOCX 与浏览器下载

目标：Web 调用已有高保真 builder，完整保留模板、编号、表格和图片。

依赖：WR-03；完整图片验收依赖 WR-04。

主要写入范围：

- `client/electron/services/exportService.cjs`
- `client/electron/utils/` 中 DOCX 实际使用的纯函数
- `client/core/export/`
- `client/server/export/webExportService.cjs`
- `client/server/routes/downloads.cjs`
- `client/server/workspace/`
- `client/shared/bridgeContract.cjs`
- export tests 和 fixtures

动作：

1. 先运行现有 DOCX characterization，再用 `git mv` 将 builder 搬到 `core/export/`。
2. builder 接收 `assetResolver` 和 progress callback，移除 `app/dialog` 与任意路径访问。
3. 删除 `simpleDocxBuilder` 发布路径；必要时只留测试 fallback，release guard 禁止引用。
4. Web export 从 Store 重新读取最新 `outlineData.outline[*].content`。
5. asset resolver 只解析当前 tenant 下批准的 asset URL。
6. builder 返回 Buffer、warnings 和结构统计。
7. 文件写入 tenant exports，生成一次性、短 TTL、认证绑定 token。
8. 下载成功、过期或 workspace close 后删除临时导出。
9. 实现 `systemFonts.list`，只返回镜像内批准字体。
10. 导出进度在 Web 页面采用本地阶段状态；首发不增加独立导出队列。

预算：

- 净新增上限：400 行

聚焦验证：

```bash
cd client
npm run test:web-export
npm run test:web-browser -- --grep "export"
node scripts/test-docx-structure.cjs
```

高保真 fixture 必须包含：

- 至少三级标题和编号
- 普通段落、粗体、列表
- 表格
- Mermaid PNG
- HTML PNG
- AI PNG
- 页眉、页脚、页码和模板字体

退出条件：

- DOCX ZIP 结构、styles、numbering、relationships 和 media 断言通过。
- 高保真 builder 可在纯 Node 测试中输出 Buffer，旧 Electron 文件不再存在。
- LibreOffice headless 可打开并转 PDF，无损坏提示。
- 视觉抽检确认标题、表格和图片无明显错位。
- 一次性 token 无法重放。

## WR-06A：Web-only Runtime、安全依赖与 CI

目标：生产镜像只包含 Web 首发运行时，依赖安全，Contract 无 pending。

依赖：WR-04、WR-05。

主要写入范围：

- `client/server/`
- `client/package*.json`
- `Dockerfile`
- `.github/workflows/`

动作：

1. 删除 Agent、Sidecar、Runner、Electron 和退出 Store 的运行时装配。
2. 删除整个 Electron 产品链和无调用依赖。
3. Docker 删除 OpenCode、jq、rg、fd 和 agent-e2e；加入 Chromium。
4. readiness 改查 data、auth DB、tenant DB、dist、Chromium、字体；检查结果缓存。
5. shutdown 删除 Agent coordinator，保留 HTTP、SSE、TenantContext 顺序关闭。
6. CI 删除 Electron/Agent jobs，加入完整 Web、Docker、图片、DOCX 和 high audit Gate。
7. 更新 direct/transitive dependencies，high/critical 清零。
8. 完成 `app.getVersion`、`ai.chat` 和设置页模型测试 Contract。

预算：

- 净新增上限：250 行
- 预期：净删除数万行

聚焦验证：

```bash
cd client
npm ci
npm run build:web
npm run test:web
npm run test:web-browser
npm audit --omit=dev --audit-level=high
find server core shared scripts -name '*.cjs' -print0 | xargs -0 -n1 node --check
cd ..
docker build -t bidmaster-web:local .
```

退出条件：

- production dependency high/critical 为 0。
- runtime image 无 Electron、OpenCode、Pi、Agent、XLSX。
- readiness 无 Agent 检查且 Chromium self-check 通过。
- Contract `pending=0`。
- 本包以独立 commit 合入，可在不回滚品牌兼容改动的情况下单独回滚。

## WR-06B：MainQuest Auth、品牌与兼容收口

目标：MainQuest 错误边界安全，用户与运维活跃面统一为 BidMaster，内部协议按 allowlist 保留。

依赖：WR-06A。

主要写入范围：

- `client/server/auth/`
- `client/server/config.cjs`
- `client/src/`
- `docker-compose.yml`
- 活跃 README/docs
- Analytics 显示/UA，排除资源实体

动作：

1. MainQuest callback 错误采用固定安全文案，不输出 code、token 或 secret。
2. Cookie、env、asset writer、Docker 用户、package、README、仓库链接切到 BidMaster。
3. `window.yibiao`、`yibiao.sqlite` 等内部兼容项进入精确 allowlist。
4. 删除 Star notice、Star History、旧域名、Trendshift、DeepWiki 和推广入口。
5. 先核验是否存在需保留的生产数据或旧 Web 部署；若存在，按品牌 Spec 执行双读、双清、UID/GID 与 volume 兼容 Gate。
6. 保留 `yibiao.sqlite` 文件协议；首发不夹带 SQLite/WAL 文件改名。

预算：

- 净新增上限：150 行
- 预期：净删除

聚焦验证：

```bash
cd client
npm run test:web-auth
npm run test:web-single-tenant
npm run test:web-files
npm run test:web-contract
npm run build:web
cd ..
docker build -t bidmaster-web:local .
```

退出条件：

- active brand scan 只剩批准的 compatibility/history allowlist。
- MainQuest login/callback/logout 错误不泄漏敏感值。
- Docker numeric UID/GID 和既有 volume 兼容证据齐全。
- 仓库、镜像、容器、README 和用户可见链接统一为 BidMaster。
- 本包以第二个独立 commit 合入，不与 WR-06A squash。

## WR-07：本地 Release Candidate

目标：在本机 Docker 中用真实文件和真实模型完成发布闭环，再冻结 RC。

依赖：WR-06B。

写入范围：

- 测试、fixture、CI 和 release evidence
- 只允许修复验收发现的发布阻断 bug

动作：

1. 构建 `bidmaster-web:<git-sha>`。
2. 使用独立临时数据目录启动 mock OAuth production-like 容器。
3. 两个 mock 用户验证共享租户和独立 session。
4. 用真实 PDF 和 DOCX 分别跑标准方案与已有方案扩写。
5. 使用真实文本模型和真实图片模型。
6. 执行 pause/resume、刷新、两个浏览器、错误输入和任务冲突。
7. 在正文生成中重启容器，验证 interrupted -> resume/retry。
8. 生成三类图片和高保真 DOCX。
9. 执行备份、删除测试容器、从备份恢复到新容器。
10. 生成 evidence manifest，记录 SHA、镜像 digest、命令和结果。

退出条件：

- `04-test-and-release-gates.md` 的 Local RC Gate 全绿。
- 无 mock AI、stub、pending 或手工改数据库。
- 冻结 RC commit 和 image digest。

## WR-08：ECS staging 与发布候选

目标：部署不可变镜像到 ECS，完成 MainQuest、HTTPS、SSE、持久化和回滚验收。

依赖：WR-07。

外部输入：

- 公网域名
- MainQuest BidMaster Product 与 OAuth Application
- 两个授权测试用户、一个未授权测试用户
- ECS SSH/运维入口
- ECS CPU/内存上限
- TLS 证书、续期方式和 owner
- GHCR 或批准的镜像仓库权限
- 持久盘目录与备份保留策略
- `CONFIG_ENCRYPTION_KEY` 等 secret 的托管/离线恢复位置

动作：

1. 发布 SHA 镜像到 registry，记录 digest。
2. MainQuest 注册 callback：`https://<domain>/api/auth/callback`。
3. ECS 只部署一个 Web container 和一个持久化 `/data`。
4. Nginx/Gateway 配置 TLS、上传限制和 SSE no-buffering。
5. 配置 secrets，仅存在 ECS secret/env 文件。
6. 真实授权用户与未授权用户完成 OAuth 验收。
7. 两个授权用户验证共享业务空间。
8. 在 ECS 运行一条真实小型完整业务链。
9. 重启 container，验证 Store、图片、导出和任务恢复。
10. 执行冷备份、恢复和镜像回滚演练。

退出条件：

- `05-mainquest-ecs-runbook.md` staging checklist 全绿。
- 生产发布只需要切换批准的 image digest 和域名配置。
- 回滚在规定窗口内完成，数据可恢复。

## 9. 依赖与并行策略

| 工作包 | 主要模块 | 依赖 |
|---|---|---|
| WR-01 | Renderer、Contract、Upload | M0 |
| WR-02 | portable core | WR-01 |
| WR-03 | task service、Store、SSE | WR-02 |
| WR-04 | image core、renderer adapter、Docker | WR-03 |
| WR-05 | export core、download adapter | WR-03 |
| WR-06A | runtime、dependencies、CI | WR-04、WR-05 |
| WR-06B | auth、brand、compatibility | WR-06A |
| WR-07 | local QA | WR-06B |
| WR-08 | Auth/ECS/registry | WR-07 |

并行 lanes：

- Lane A：WR-01 -> WR-02 -> WR-03
- Lane B：WR-04
- Lane C：WR-05
- Lane D：WR-06A -> WR-06B -> WR-07 -> WR-08

执行顺序：先完成 Lane A；随后 B 与 C 使用独立 worktree 并行；合入后执行 D。

冲突提示：

- WR-04 与 WR-05 都可能读取 asset URL contract，先在 WR-03 锁定接口。
- WR-04 和 WR-06A 都修改 Dockerfile，WR-06A 必须基于 WR-04 已合入结果。
