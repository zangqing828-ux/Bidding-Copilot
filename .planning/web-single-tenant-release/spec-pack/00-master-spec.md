# BidMaster Web 单租户发布 Master Spec

状态：`READY_FOR_IMPLEMENTATION`

日期：2026-07-28

最近修订：2026-07-29，WR-06A 保留并验证服务端 OpenCode Foundation

实施基线：`codex/web-single-tenant-baseline@6652dd56c3cce9d4eac101a320120acd4a6a560f`

## 1. 一句话目标

交付一个用户可以在浏览器登录、上传招标文件、完成技术标正文与图片生成、按模板导出高保真 DOCX，并能由 Docker 单实例稳定部署到 ECS 的 BidMaster。

## 2. 发布成功标准

以下条件必须同时成立：

1. MainQuest OAuth Application 绑定 BidMaster Product；有权限用户可登录，无权限用户无法建立 BidMaster session。
2. 两个已授权 MainQuest 用户共享同一个租户业务空间，同时保持各自独立 session 和审计身份。
3. 真实 PDF、DOCX、TXT、Markdown 文件均可上传、解析和持久化；DOC、XLS、XLSX 等范围外格式被明确拒绝。
4. “生成技术方案”和“已有方案扩写”两条流程均可完成：招标分析、目录、全局事实、正文、暂停/继续、局部重试、刷新恢复。
5. Mermaid、HTML 图和 AI 图片真实生成、落盘并进入最终正文。
6. DOCX 保留模板设置、标题编号、段落、表格和图片，可通过已认证的一次性链接下载。
7. 容器重启后，已完成内容保留；中断任务进入可解释、可继续或可重试状态，不能长期伪装为 `running`。
8. Docker production 只允许 MainQuest OAuth；health、readiness、HTTPS、SSE、持久卷、备份和回滚演练通过。
9. 用户可见面、活跃 README、镜像、容器和新写入标识统一为 BidMaster；内部兼容项只允许出现在批准的 allowlist。
10. 生产依赖 high/critical 漏洞为 0；发布候选 Bridge Contract 的 `pending` 数为 0。
11. production image 保留固定 checksum 的 OpenCode Foundation，readiness 和真实 Docker E2E 通过；浏览器通用 Agent 入口关闭，未获审批时生产 Task Spec 注册表为空。

## 3. 首发产品表面

只保留四个用户入口：

- 生成技术方案
- 已有方案扩写
- 模板管理
- 设置

首发不开放：

- 商务标
- 独立知识库管理
- 查重
- 废标检查
- AI 评标
- 开发者页面
- 多标段自动识别与选择
- 浏览器通用 Agent 管理入口、Pi、Sidecar、Agent Quality
- Electron 桌面发行、更新和授权

## 4. 核心执行判断

### 4.1 不重写产品

当前已有可复用基础：

- Renderer 页面与交互
- SQLite Store、input revision CAS、mutation executor
- Web AI Runtime 与文本队列
- Web OpenCode Foundation：固定 binary、AI Proxy、Runner、Coordinator、受限 Task Spec、任务目录与真实 Docker E2E
- 投标解析任务
- 上传 file ID、解析 Worker、SSE、一次性下载
- Electron 中已经运行过的目录、全局事实、正文、配图和 DOCX 业务代码

实施方式固定为：

1. `git mv` 已有业务文件到 portable core。
2. 删除 Electron、Pi、浏览器 Agent 产品入口和退出功能分支；保留服务端 OpenCode Foundation。
3. 只补 Web adapter、输入校验、Linux 图片渲染和验收测试。
4. 归档 `archive/wp-j-complete-20260727` 只用于核对 portable 差异和复用测试思路。

### 4.2 拒绝第二套实现

以下动作直接阻断合入：

- 把 Electron 业务文件复制到 core，同时保留原文件。
- 整体合并 `archive/wp-j-complete-20260727`。
- 引入新的任务框架、数据库、队列、权限系统或前端框架。
- 为首发退出能力保留 Web stub、`501`、占位成功或隐藏路由。
- 为“以后可能使用”新增抽象、配置项、插件点或多实例能力。

## 5. 目标业务链

```text
MainQuest 登录
    |
上传 PDF / DOCX / TXT / Markdown
    |
服务端 file ID + 内容校验 + 解析
    |
招标分析
    |
目录生成 -> 人工编辑 -> 旧正文/图片计划失效
    |
全局事实生成 -> 人工修订
    |
正文生成 -> 暂停/继续 -> 局部重试 -> 刷新/重启恢复
    |
图片计划
    +--> Mermaid -> Chromium PNG
    +--> HTML -> 静态安全页 -> Chromium PNG
    +--> AI 图片 -> 服务端下载/保存
    |
portable DOCX builder + asset resolver
    |
租户 exports 目录 -> 一次性下载 token -> 浏览器下载
```

## 6. 实施里程碑

| 里程碑 | 结果 | 进入条件 | 退出证据 |
|---|---|---|---|
| M0 基线 | 单租户基线可重复验证 | 已完成 | `6652dd5`、测试和构建通过 |
| M1 Web 表面收口 | 浏览器只剩四个首发入口 | M0 | 路由/菜单/contract 扫描 |
| M2 文本闭环 | 两条流程完成到正文 | M1 | 真实模型本地 E2E |
| M3 图片与 DOCX | 三类图片进入高保真 DOCX | M2 | 文件证据、DOCX 结构与视觉验收 |
| M4 本地 RC | Docker 单实例完整闭环稳定 | M3 | 本地 RC 证据包 |
| M5 ECS staging | MainQuest、HTTPS、SSE、持久化通过 | M4 | staging 验收与回滚记录 |
| M6 发布候选 | 可按镜像 digest 重放部署 | M5 | release checklist 全绿 |

## 7. 工作包顺序

```text
WR-01 产品表面与 Contract 收口
  -> WR-02 portable core 搬迁与 Agent 分支裁剪
  -> WR-03 Web 任务编排与文本闭环
  -> WR-04 Linux 图片渲染与 AI 生图
  -> WR-05 高保真 DOCX 与下载
  -> WR-06A Web-only Runtime、安全依赖与 CI
  -> WR-06B MainQuest Auth、品牌与兼容
  -> WR-07 本地 Release Candidate
  -> WR-08 ECS staging 与发布候选
```

`WR-04` 与 `WR-05` 在 `WR-03` 合入后可用独立 worktree 并行；它们都完成后才能进入 `WR-06A`，随后顺序执行 `WR-06B`。

## 8. 代码预算

统计范围：

- `client/src/`
- `client/server/`
- `client/core/`
- `client/shared/`
- `client/electron/`（来源移动与删除也纳入）
- `Dockerfile`
- `docker-compose*.yml`
- `.github/workflows/`

测试、fixture、Spec 和生成证据单独统计；任何类别都必须报告，不能用“未计入业务源码”
隐藏总变更体量。

| 工作包 | 净新增上限 | 预期方向 |
|---|---:|---|
| WR-01 | 100 | 大量净删除 |
| WR-02 | 500 | 以文本/配图 core 移动和删除为主 |
| WR-03 | 700 | 小量 Web adapter |
| WR-04 | 500 | Chromium adapter + image runtime |
| WR-05 | 400 | DOCX 搬迁 + Web export adapter |
| WR-06A | 250 | Runtime/依赖/CI，大量净删除 |
| WR-06B | 150 | Auth/品牌/兼容，净删除 |
| 累计 | 3,000 硬上限 | 目标不超过 2,500 |

补充预算：

| 类别 | 目标 | 硬上限 | 停止复审条件 |
|---|---:|---:|---|
| 测试与手写脚本净新增 | 4,000 | 6,000 | 单包超过 1,500 |
| 业务源码 + 测试/脚本 | 6,500 | 9,000 | 累计超过 9,000 |
| fixture、Spec、证据 | 单独报告文件数与字节数 | 无代码行配额 | 出现重复大文件或生成物入库 |

归档中的测试只按具体失败模式选择性复用；禁止成套迁入 7,000 余行历史测试/脚本。

每包统计命令：

```bash
git diff --find-renames=80% --numstat <package-base>...HEAD -- \
  client/src client/server client/core client/shared client/electron \
  Dockerfile 'docker-compose*.yml' .github/workflows

git diff --numstat <package-base>...HEAD -- \
  client/scripts client/e2e
```

每包必须同时报告四组数字：

1. Git 原始 insertions / deletions，解释审查体量。
2. source -> target rename 对照及相似度，区分移动和复制。
3. rename-aware 业务源码与测试/脚本新增、删除和净新增，识别真实新代码。
4. 新文件清单与重复实现扫描结果，防止用“净新增很小”掩盖复制。

任何单包业务源码超过 1,000 行、测试/脚本超过 1,500 行，或排除已识别 rename 后的
原始 source churn 超过 10,000 行，必须先给出：

1. 新增行按文件和能力分类。
2. 无法通过移动、删除或复用解决的证据。
3. 缩减方案及其业务影响。
4. 老板明确批准。

## 9. 技术选择

### D1：Linux 图片渲染

采用 `playwright-core + Debian Chromium`。现有 Electron 渲染逻辑迁移为 Web adapter；复用现有 `cheerio` 做标签、属性和样式 allowlist，模型生成 HTML 禁止外部网络、脚本、iframe 和本地文件读取。

理由：已有 Playwright 测试和 `cheerio` 依赖；只替换运行环境 adapter；无需维护第二套绘图引擎或增加 HTML sanitizer 依赖。

### D2：DOCX

复用现有 `docx` builder，抽离 Electron `dialog/app` 和路径访问，注入 Web asset resolver。LibreOffice 只用于发布验收中的打开/转 PDF 检查，不进入生产运行时。

理由：当前 builder 已覆盖模板、编号、表格和图片；生产容器无需承担 LibreOffice 体积与额外进程。

### D3：MainQuest Product 权限

由 MainQuest OAuth Application 与 Product 的绑定关系在 `/oauth/authorize` 阶段强制校验。BidMaster 不增加本地 license 或 entitlement 表。

理由：MainQuest 已提供产品状态、用户产品权限和授权拒绝；重复实现会制造双重真相源。

### D4：镜像分发

推荐 GitHub Container Registry。镜像同时记录 Git SHA 标签和不可变 digest；ECS 只部署 digest。

理由：仓库与 CI 已在 GitHub，发布物可以重放、审计和回滚。

## 10. 本地与云的边界

- WR-01 至 WR-07 只操作本地仓库、测试容器和本地证据。
- WR-08 才允许操作 MainQuest staging 配置、镜像仓库和 ECS。
- 未获得具体域名、OAuth Application、ECS 登录方式、资源上限、TLS 合同和镜像仓库权限时，WR-08 停在 staging Gate。
- 禁止用 ECS 作为功能调试环境。

## 11. 完成定义

“完成”要求同时提供：

- commit SHA
- 业务源码净新增统计
- 该工作包测试命令与结果
- 真实成功路径证据
- 至少一个失败/边界路径证据
- 回滚方式
- 未完成项列表，若为空则写“无”

通过 mock、接口返回可解释错误、Docker 能启动、页面能打开，均不能单独作为业务完成证明。

## 12. NOT in scope

- 多租户、多实例、对象存储、Redis、共享数据库
- 组织、团队、角色与管理员后台
- Electron 桌面安装包、自动更新、原生文件对话框
- 浏览器通用 Agent 产品入口、Pi、Sidecar、Electron Agent 和 Agent 质量评估；服务端 OpenCode Foundation 保留
- 多标段识别
- 独立知识库、查重、废标、商务标、AI 评标
- DOC、WPS、XLS、XLSX
- 深色模式、组件库替换、页面重排
- Analytics 资源实体、Cloudflare binding、历史数据迁移
- 历史文章内容改写
- 自动扩容和零停机多副本发布

## 13. 工程审查结论

- Scope Challenge：通过。计划只新增一个独立 adapter；其余能力采用原文件移动、现有
  service 升级和退出代码删除。
- Architecture Review：6 项问题已修订，涵盖 SQLite 协议、DOCX 搬迁顺序、WR-06
  回滚边界、图片 SSRF、TLS/停止窗口和上传代理。
- Code Quality Review：4 项问题已修订，涵盖 worktree 命名、原始 churn、测试代码预算
  和 26 个已实现退出 Contract。
- Test Review：测试覆盖图和真实用户路径已写入
  `04-test-and-release-gates.md`；审查后无 silent failure 关键缺口。
- Performance Review：已增加 Chromium 资源回收、容器峰值内存、CPU/内存/shm、日志上限
  和 40 秒停止窗口。
- Adversarial Review：原 P1 全部闭环；`app.getVersion` 删除建议经代码核验后驳回，
  `SettingsPage.tsx` 仍有真实调用。
- TODOS.md：无新增提议；退出能力已经进入 NOT in scope 和删除地图。
- Parallelization：WR-01 -> WR-02 -> WR-03 顺序执行；WR-04/05 可并行；WR-06A ->
  WR-06B -> WR-07 -> WR-08 顺序执行。
- 2026-07-29 WR-06A 复核：代码证明 OpenCode Foundation 已进入 production Docker、
  readiness、TenantContext、shutdown 和真实 E2E。删除底层运行时会损失既有 Agent 平台资产；
  WR-06A 已改为保留并验证 Foundation，只删除浏览器通用入口、Pi、Electron Agent 和重复实现。
- 当前技术方案任务直接使用 Web AI Runtime，生产 Agent Task Spec 注册表为空。WR-06A
  不恢复 WR-02 已裁剪的 Agent 质量分支，也不将 Foundation 描述为已接入标书主链路。

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|---|---|---|---:|---|---|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | 最新范围已由老板锁定 |
| Codex Review | independent adversarial audit | 独立挑战 | 1 | CLEAR | 9 项发现，8 项修订，1 项经代码核验驳回 |
| Eng Review | `/plan-eng-review` | Architecture & tests | 2 | CLEAR | 原 12 项问题已闭环；WR-06 OpenCode 删除边界已纠正，0 critical gap |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | N/A | 首发不改布局和组件 |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | N/A | 本包为发布实施 Spec |

**CODEX:** 对抗复核确认原 P1 全部闭环。

**VERDICT:** ENG + ADVERSARIAL CLEARED，WR-06A 按“保留 OpenCode Foundation、删除 Electron/Pi/退出能力”执行。

NO UNRESOLVED DECISIONS
