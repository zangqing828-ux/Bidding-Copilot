# 追踪矩阵与决策记录

## 1. 41 个 pending 的发布去向

目标：发布候选 `pending=0`。

### 1.1 实现

| Contract | 工作包 | 理由 |
|---|---|---|
| `app.getVersion` | WR-06A | 设置页显示版本 |
| `ai.chat` | WR-06A | 设置页文本模型测试 |
| `ai.testImageModel` | WR-04 | 设置页图片模型测试 |
| `tasks.startOutlineGeneration` | WR-03 | 核心业务 |
| `tasks.startGlobalFactsGeneration` | WR-03 | 核心业务 |
| `tasks.startContentGeneration` | WR-03 | 核心业务 |
| `tasks.pauseContentGeneration` | WR-03 | 核心业务 |
| `systemFonts.list` | WR-05 | 模板和导出 |

### 1.2 标记 removed 并删除 Renderer 调用

| Contract 组 | 数量 | 处理 |
|---|---:|---|
| `events.database.onStatus` | 1 | 桌面数据库状态退出 |
| `events.ai.onHttpError` | 1 | Web 使用请求级 Toast/错误；无全局桌面事件 |
| `events.agent.onStatus` | 1 | 浏览器通用 Agent 入口退出；服务端 OpenCode Foundation 保留 |
| `events.developerTokenStats.onChanged` | 1 | developer 退出 |
| `events.knowledgeBase.onEvent` | 1 | knowledge management 退出 |
| `events.export.onWordExportProgress` | 1 | Web 首发采用调用级状态，不增加独立导出事件 |
| `requiredOnlineServices.getStatus` | 1 | 桌面联网提示退出 |
| `license.*` | 4 | MainQuest Product access 取代本地 license |
| `ai.requestJson` | 1 | Renderer 目录旧实现删除；core 直接使用 server AI Runtime |
| `agent.*` | 6 | 浏览器通用 Agent 入口退出；服务端只允许静态 Task Spec |
| `developerTokenStats.*` | 2 | developer 退出 |
| `developerExpansionReplaceTest.run` | 1 | developer 退出 |
| `file.selectDuplicateCheckFiles` | 1 | duplicate check 退出 |
| `knowledgeBase.*` pending | 6 | independent knowledge management 退出 |
| `duplicateCheck.updateState` | 1 | duplicate check 退出 |
| `tasks.startBidSectionExtraction` | 1 | 多标段退出 |
| `tasks.startRejectionItemsExtraction` | 1 | rejection check 退出 |
| `tasks.startRejectionCheck` | 1 | rejection check 退出 |
| `tasks.startDuplicateAnalysis` | 1 | duplicate check 退出 |

合计：

- 实现：8
- removed：33
- 发布候选 pending：0

### 1.3 当前 implemented、首发需改为 removed

以下 26 个当前已实现 Contract 属于退出产品面，WR-01/06A 必须同步删除 Renderer 调用、
Runtime 装配与持久化入口。它们不计入上面的 41 个 pending：

| Contract 组 | 数量 | 处理 |
|---|---:|---|
| `locals.database.getStatus` | 1 | 桌面数据库 Gate 退出 |
| `knowledgeBase.*` implemented | 11 | 独立知识库管理退出 |
| `duplicateCheck.*` implemented | 4 | 查重退出 |
| `rejectionCheck.*` implemented | 8 | 废标检查退出 |
| `technicalPlan.checkBidSections/selectBidSection` | 2 | 多标段识别与选择退出 |

发布候选 113 个 Contract 的目标计数：

- implemented：36
- removed：77
- pending：0

## 2. 可复用代码与处理

| 子问题 | 已有实现 | 决策 |
|---|---|---|
| OAuth code flow | `server/auth/oauthClient.cjs` | 保留并联调 |
| Product access | MainQuest authorize | 不建设本地 license |
| 单租户 | singleton workspace registry | 保留 |
| SQLite/Store | core stores | 保留并裁剪退出 Store |
| 写入并发 | mutation executor + CAS | 所有技术方案任务复用 |
| task 状态/SSE | task orchestrator + task event port | 扩展四种任务 |
| 文档解析 | server parser worker | 收缩格式 |
| 文本 AI | core aiRuntime | 增加 image provider |
| 目录/事实/正文 | Electron services | `git mv` 到 core |
| 图片计划/生成 | Electron services | `git mv`，改 renderer port |
| Mermaid/HTML 截图 | Electron local renderer | 迁移算法到 Chromium adapter |
| DOCX | Electron exportService | `git mv`，注入 asset resolver |
| 下载 | Web one-time token | 保留 |
| Browser E2E | Playwright | 扩展完整业务链 |
| Docker | Node multi-stage | 保留 OpenCode Foundation 与 Chromium，删除 Electron/Pi；LibreOffice 仅用于 DOCX QA |

## 3. 拒绝迁入的历史候选

以下归档内容不整体进入首发：

- Agent Sidecar protocol/listener/coordinator/token
- 历史重复 Agent Runner、Pi 和桌面 Agent
- 历史 Agent business task registry 与正式业务 Task Spec
- run manifest 与跨进程 task DTO 套件
- Agent quality report/eval
- 多标段 portable task
- WP-J doctor、rollback、sidecar、runner scripts
- 重复的 core 与 Electron 并存结构

允许逐个复用：

- portable import 差异
- 非 Agent characterization fixtures
- 已合入并验证的 `client/server/agent/` OpenCode Foundation、真实 Docker E2E 和安全边界；禁止从归档再复制一套
- pause/resume/restart 测试思路
- Web full-flow Browser E2E 的用户步骤

## 4. 决策表

| ID | 决策 | 状态 | 依据 |
|---|---|---|---|
| D-01 | 纯 Web 首发 | LOCKED | `project.md` |
| D-02 | ECS 单实例单租户 | LOCKED | 单租户 baseline |
| D-03 | 所有授权用户共享业务空间 | LOCKED | 单租户 baseline |
| D-04 | MainQuest 负责 Product access | LOCKED | MainQuest authorize 实现 |
| D-05 | 浏览器通用 Agent 产品入口、Pi、Sidecar 与 Electron 退出；服务端 OpenCode Foundation 保留 | LOCKED 2026-07-29 | 老板最新决策 + 实际代码摸排 |
| D-06 | 四个首发产品入口 | LOCKED | 单租户 baseline |
| D-07 | 图片和高保真 DOCX 为硬 Gate | LOCKED | 单租户 baseline |
| D-08 | 上传仅 PDF/DOCX/TXT/MD | LOCKED | 单租户 baseline |
| D-09 | J-Core 只选择性迁移 | LOCKED | `project.md` |
| D-10 | business source 净新增不超过 3,000 | LOCKED | 单租户 baseline |
| D-10A | 测试/手写脚本不超过 6,000，全部手写代码不超过 9,000 | LOCKED FOR SPEC | 历史体量复盘 |
| D-11 | Playwright-core + Chromium | RECOMMENDED DEFAULT | 最小 Linux adapter |
| D-12 | 现有 docx builder；LibreOffice 仅 QA | RECOMMENDED DEFAULT | 最小生产依赖 |
| D-13 | GHCR + digest 部署 | RECOMMENDED DEFAULT | 可重复分发与回滚 |
| D-14 | 多标段退出首发 | LOCKED | WP-I 浏览器单标段边界 |
| D-15 | 容器重启后转 interrupted，再继续/重试 | LOCKED FOR SPEC | 与当前 Store 恢复语义一致 |

## 5. 外部 Gate

| Gate | 需要输入 | 阻断 |
|---|---|---|
| EXT-01 | BidMaster 公网域名 | MainQuest callback、ECS |
| EXT-02 | MainQuest Product UUID、client ID/secret | ECS Auth |
| EXT-03 | 授权 A/B 与未授权 C | Product access 验收 |
| EXT-04 | ECS 登录、资源上限与持久盘目录 | staging |
| EXT-05 | GHCR package 权限或替代 registry | 镜像分发 |
| EXT-06 | 备份保留周期与 secret escrow | production release |
| EXT-07 | 历史文章公开保留/归档策略 | repo 历史面清理，不阻断 Web runtime |
| EXT-08 | Analytics 实体迁移策略 | Cloudflare 资源改名，不阻断 Web runtime |
| EXT-09 | TLS 证书路径、续期方式与 owner | staging HTTPS |

## 6. 兼容清单

| 旧标识 | reader | writer | 首发状态 | 删除条件 |
|---|---|---|---|---|
| `window.yibiao` | Renderer | Web bridge installer | allowlist | 独立 ABI 迁移 Spec |
| `yibiao.sqlite` | SQLite Store | SQLite Store | 保留内部文件协议 | 维护窗口备份迁移与回滚通过 |
| `yibiao-asset://` | DOCX/preview resolver | 无 | 只读 fallback | 已确认无旧正文或迁移完成 |
| `YIBIAO_DATA_DIR` | config fallback | 无 | deprecation allowlist | 已确认无旧部署 |
| `YIBIAO_WEB_DIST_DIR` | config fallback | 无 | deprecation allowlist | 已确认无旧部署 |
| `yibiao_session` | auth migration reader/clearer | 无 | 强制重新登录或短兼容 | 老 session 过期 |
| `yibiao_oauth_state` | callback migration reader/clearer | 无 | 最多一次登录窗口 | 老 state TTL 过期 |
| Analytics project/binding | Analytics | Analytics | 保留实体 | Analytics owner 批准迁移 |
| 历史文章旧品牌 | docs history | 无 | 历史 allowlist | 老板批准归档/删除 |

active scan 必须排除本文件和品牌 Spec；任何未列入此表的旧 token 都是失败。

## 7. 需求到工作包

| 发布需求 | 工作包 | 验收 Gate |
|---|---|---|
| 四入口 Web 产品 | WR-01 | G-A |
| 无重写/无重复核心 | WR-02 | G-B |
| 文本完整闭环 | WR-03 | G-C |
| 三类图片 | WR-04 | G-D |
| 高保真 DOCX | WR-05 | G-E |
| Web-only、安全、品牌 | WR-06A/06B | G-F |
| 本地稳定运行 | WR-07 | G-G |
| MainQuest Product | WR-08 | G-H |
| ECS 发布与恢复 | WR-08 | G-I |

## 8. 真实失败模式核对

| 代码路径 | 生产失败 | 测试 | 错误处理 | 用户可见 |
|---|---|---|---|---|
| OAuth authorize | Product 无权限 | staging E2E | MainQuest 403 | Auth access denied |
| OAuth token | 超时/错误 secret | integration | 固定安全错误 | 登录失败可重试 |
| upload | ZIP bomb/伪装 | integration | 删除临时文件 | 明确失败 |
| parser | Worker 超时 | integration | 终止并回收 | 明确失败 |
| task start | 两用户并发 | integration/E2E | `TASK_CONFLICT` | 已有任务提示 |
| task write | stale revision | integration | CAS 拒绝 | 输入变化提示 |
| content | container restart | Docker E2E | interrupted + checkpoint | 继续/重试 |
| Mermaid | 模型代码持续非法 | integration | 有界修复后 error | 单图失败 |
| HTML | 恶意外链/script | security test | sanitize/abort | 单图失败 |
| AI image | URL 超时/大文件 | integration | bounded download | 可重试 |
| DOCX asset | 文件缺失 | integration | warning/error policy | 导出提示 |
| download | token replay | Browser E2E | 404 | 链接失效 |
| SSE | proxy buffering | staging | no-buffer + heartbeat | 进度恢复 |
| backup | 包损坏 | restore drill | checksum + fail closed | 运维阻断 |

没有允许“无测试 + 无错误处理 + 静默失败”的发布路径。

## 9. 实施任务

- [ ] **T1 P0**：WR-01 收口产品表面和 41 个 pending 去向。
- [ ] **T2 P0**：WR-02 用 `git mv` 建立单份 portable core，删除 Agent 分支。
- [ ] **T3 P0**：WR-03 接通四种技术方案任务和恢复语义。
- [ ] **T4 P0**：WR-04 完成三类图片的 Linux 生成与安全边界。
- [ ] **T5 P0**：WR-05 完成高保真 DOCX 和一次性下载。
- [ ] **T6 P0**：WR-06A/06B 分两次提交删除 Electron/Pi/退出 runtime，保留并验证 OpenCode Foundation，清零 high 漏洞和 active 旧品牌。
- [ ] **T7 P0**：WR-07 通过真实文件、真实模型的本地 RC。
- [ ] **T8 P0**：WR-08 完成 MainQuest/ECS staging、备份和回滚。

## 10. 开始实施前的最终核对

- [ ] 基线仍为 `6652dd5` 或其已审查后继提交。
- [ ] 主实现 worktree clean。
- [ ] archive tag 可读，但没有 merge/cherry-pick。
- [ ] WR-01 分支和 worktree 已按命名创建。
- [ ] D-11/D-12/D-13 没有被新的老板决策覆盖。
- [ ] 云端权限尚未使用；WR-08 以前只做本地。
