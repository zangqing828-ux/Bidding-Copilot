# WP-J：技术方案文本草稿闭环测试计划

状态：Approved — follows reviewed `wp-j.spec.md`
基线：`origin/main@1c0a17eec348ffaeed1d7e1d0633483bf75fa2fb`

## 1. 测试原则

- 测试必须覆盖真实成功、失败、竞态、隔离、恢复和资源边界；
- fake AI、fake Agent 和 HTTP 直接调用可用于单元测试，不能替代真实 Chromium 与真实 OpenCode sidecar 门禁；
- 每个任务先验证输入冻结，再验证写回 CAS；
- 任何 Agent validator、operation 或 ledger 失败都必须证明业务零写入或完整 rollback；
- 所有账号隔离测试至少使用两个 Workspace；
- 所有路径测试都要断言响应、日志和持久化状态不包含服务器绝对路径。
- J-Core 与 J-Agent Quality 分开给出证据；Agent 不可用时，J-Core 主链必须保持可用。
- Spec 容量预算逐项覆盖等于上限和超过上限两组测试；超限禁止截断后成功。

## 2. PR J-1 Gate

### 2.1 契约

- 五个任务 DTO 接受合法输入；
- 未声明字段、错误枚举、超长字符串、负数和超上限数量被拒绝；
- 生产 DTO 永远不接受 `debug_force_outline_agent_repair`，test harness 可通过独立注入强制 repair；
- camelCase Renderer payload 只在 adapter 层映射一次；
- 当前六类 Renderer 动作逐项映射到规范 DTO；
- 同时出现多个动作、缺必填字段、内部保留字段和未知字段均被拒绝；
- Web 与 Electron bridge 对外类型一致。

### 2.2 Portable Core

- portable 技术方案模块静态扫描不导入 `electron/`；
- 多标段、选段和目录 fixture 与 Electron 基线一致；
- 标准技术方案与已有方案的目录阶段各有 characterization fixture；
- 目录硬约束和字数控制有确定性测试；
- Electron 对应 adapter 回归通过；
- 真实 Chromium 完成“招标分析 -> 标段选择 -> 目录生成”。

### 2.3 阶段版本与 Store

覆盖以下状态变化：

| 操作 | 预期 |
| --- | --- |
| 替换招标文件 | 全部阶段失效，`source_revision` 增加 |
| 改招标分析配置 | 目录及下游失效，`analysis_revision` 增加 |
| 替换目录 | 全局事实、正文、配图计划和 render receipt 失效 |
| 编辑目录标题/描述/层级/父子关系 | 全局事实、正文、配图计划和 render receipt 全部失效 |
| 增删目录节点或语义重排 | 全局事实、正文、配图计划和 render receipt 全部失效 |
| 经证明无语义影响的显示层排序 | 所有结果保留，不递增 `outline_revision` |
| 编辑全局事实 | 正文、配图计划和 render receipt 失效 |
| 编辑正文 | `content_revision` 增加，配图计划和 render receipt 失效 |
| 替换手动知识文档内容 | 活动任务 manifest 失效，旧任务禁止写回 |
| 切换模型或生成配置 | 活动任务 manifest 失效，旧任务禁止写回 |
| 升级 prompt/template version | 活动任务 manifest 失效，旧任务禁止写回 |

测试还必须覆盖：

- migration 后旧 Workspace 可读取；
- migration 重跑幂等；
- 旧 `contentIllustrationPlan.items[*].generation` 被无损拆为计划与 legacy render receipt；
- revision CAS 成功；
- 旧 revision 写回返回 `TASK_INPUT_CHANGED`；
- mutation executor 排队期间输入变化；
- `run_manifest` hash 规范化和持久化；
- canonical JSON 的键、数组、null、数字、UTF-8 与 SHA-256 fixture 固定；
- 知识文档内容 hash、模型快照、prompt 版本和生成配置竞态；
- SQLite operation fault injection 完整 rollback；
- 关闭并重开数据库后版本与任务状态一致。

## 3. PR J-2 Gate

### 3.1 J-Core 正文链

- 全局事实、逐章正文、字数调整、checkpoint 和审校顺序 fixture 与 Electron 基线一致；
- 单标段从目录完成到正文草稿落盘；
- 已有方案 `original-only` 不新增目录节点；
- 已有方案 `ai-complement` 只在允许范围补充目录；
- J-Core 全程不调用生产 Agent；
- Sidecar 未启动、readiness 失败时 J-Core 仍可完成。

### 3.2 暂停、继续与恢复

- 运行中暂停后停止调度新章节；
- 已完成章节保留，checkpoint 包含待执行章节与 `RunManifestV1`；
- 继续只执行待完成章节；
- 局部重试只修改目标章节；
- 页面刷新从 Store + SSE 恢复；
- Web 重启将活动任务收口为 `TASK_INTERRUPTED_BY_RESTART`，用户可继续受支持 checkpoint 或重新执行；
- `accepted/queued/validating` 重启后收口为 interrupted；
- `committing` 重启后先查 receipt/ledger，已提交恢复 success，未提交恢复 interrupted；
- 内部状态投影到 Renderer 五态时，任务组锁从 accepted 保持到终态，paused 继续占用；
- 输入、知识文档、模型、prompt 或配置在 mutation queue 等待期间变化时，旧写回返回 `TASK_INPUT_CHANGED`；
- sidecar 不可用时，页面明确显示 Agent 审校/配图计划待开放。
- pause-drain 超过 60 秒返回 `TASK_PAUSE_TIMEOUT`，保留有效 checkpoint 且停止新写入；
- 暂停后模型、知识、prompt 或配置变化时，旧 checkpoint 返回 `TASK_INPUT_CHANGED`。

### 3.3 `RunManifestV1`

- 字段、规范化顺序和 manifest hash fixture 固定；
- stage revision vector 任一元素变化都会改变 manifest hash；
- execution state 的 progress/log/timestamp 变化不改变 manifest hash；
- 同一正文 execution 逐章写入不会因自身 output revision 递增而自我失效；
- 兄弟 execution 或输入变化不能复用 target stage generation；
- 直接 AI 写回校验 workspace generation、revision vector 和 manifest hash；
- Agent envelope 的 `inputHash` 与 ledger `manifest_hash` 可追溯；
- migration 后旧任务不能绕过新 CAS。

## 4. PR J-3 Agent Quality Sidecar Gate

### 4.1 Sidecar 拓扑

- Web 容器可访问 mock MainQuest 和受控模型服务；
- Agent Runner 无法直接访问公网；
- Agent Runner 无法访问云元数据地址；
- Agent Runner 只能访问经过认证的 Web 内部执行端点；
- 一次性 dispatch token 重放失败；
- proxy session capability 在过期、调用/token 超限、任务取消和 Workspace close 后失效；
- Runner 不挂载账号总目录、SQLite、模型配置或 Docker socket；
- 两个 Workspace 的任务包和结果目录互不可见。
- Runner 全局活动任务上限为 1，cleanup 完成前不接受下一任务；
- 内部 listener 拒绝 Cookie、普通 Bridge、OAuth、下载和非 allowlist 路径；
- token method/path/execution/spec/workspace generation/manifest 任一不匹配均被拒绝。
- Web→Runner 创建/取消与 Runner→Web Proxy/capability 四个协议端点均有 schema、版本、错误和幂等测试。

### 4.2 OS 隔离

- Runner 用户为非 root；
- 输入目录只读；
- 输出目录独立可写；
- `no-new-privileges` 生效；
- capabilities 已 drop；
- seccomp 拒绝被禁止的 syscall；
- PID 上限阻止 fork bomb；
- CPU deadline 终止超时任务；
- 内存上限终止超限任务；
- 文件大小和磁盘上限阻止超大输出；
- symlink、hard-link、FIFO、device file 和目录替换攻击失败；
- 任务结束后无残留进程、端口、token 或目录。
- Web production image 不包含 OpenCode、`rg/fd/jq/prlimit`，且 production 不能选择 in-process runner。

### 4.3 生产 Task Spec

六个 Task Spec 分别覆盖：

- 合法输出；
- JSON Schema 失败；
- 未声明输出；
- 超大输出；
- validator 抛错；
- operation 抛错；
- operation 返回 thenable；
- Task Spec 吞掉 operation error；
- revision conflict；
- 同 execution single-flight；
- 不同 envelope conflict；
- commit 后 crash，重启后从 ledger 恢复 receipt；
- 重试不重复 apply；
- Workspace close 与 preparation/apply 竞态；
- deadline 与 owner cancel 竞态。

### 4.4 真实 OpenCode

真实 Docker Agent E2E 至少完成：

1. Sidecar 接收受控任务包；
2. OpenCode 通过内部 AI Proxy 完成多轮 tool-call；
3. 读取只读输入；
4. 写入唯一 `result.json`；
5. Web validator 通过；
6. CAS + transaction 提交业务 fixture；
7. ledger 可恢复 receipt；
8. 所有运行资源清理；
9. 任务日志不包含 token、Key、prompt 原文和绝对路径。

### 4.5 单边崩溃窗口

分别在任务包下发前、Runner 输出后、Web 提交前、事务提交后确认前强制终止 Web 或 Runner，断言：

- token 撤销或过期；
- 运行目录最终清理；
- 未提交结果可安全重试；
- 已提交 receipt 从 ledger 恢复且不重复 apply；
- 用户看到稳定、可重试的终态。

## 5. WP-J 发布验收 Gate

### 5.1 浏览器成功链路

真实 Chromium 运行：

#### 场景 A：单标段技术方案

1. mock MainQuest 登录；
2. 上传招标文件；
3. 导入并解析；
4. 完成招标分析；
5. 生成目录；
6. 生成全局事实；
7. 生成正文；
8. 生成配图计划；
9. 刷新页面；
10. 验证所有结果从 Store 恢复。

#### 场景 B：多标段技术方案

1. 上传多标段 fixture；
2. 识别标段；
3. 选择目标标段；
4. 断言后续分析只使用选中标段；
5. 完成目录、全局事实和正文。

#### 场景 C：已有方案扩写

1. 导入原方案；
2. 选择 `original-only`；
3. 生成正文并验证目录未被扩展；
4. 改为 `ai-complement`；
5. 重新生成并验证目录补充；
6. 运行原方案覆盖审校与修复。

### 5.1.1 质量验收 fixture

固定脱敏 fixture manifest 必须版本化，包含稳定 requirement ID、脱敏证据 hash、期望章节类型和允许的模型配置。执行后生成通过 `quality-report.v1` JSON Schema 校验的机器可判定报告：

| 指标 | 最低要求 |
| --- | --- |
| 硬性招标要求覆盖 | 每条要求映射到目录或正文章节，未覆盖项为 0 |
| 事实一致性 | 同一事实跨章节无冲突；未知事实不得编造 |
| 目录硬约束 | 必需章节存在；`original-only` 不增加原目录节点 |
| 原方案保留 | 输出未映射原文段清单；不得静默丢失 |
| 字数与结构 | 每章在配置容差内；必需表格/配图计划状态明确 |
| 修复状态 | 未完成修复项显示 warning/error，不能标记完全成功 |

CI 使用受控 Provider 保证确定性；发布前使用受控真实模型执行同一 rubric，并保存脱敏结果。两类证据都需要通过。

### 5.2 暂停、继续与重试

- 正文生成中暂停；
- 任务依次进入 `pausing` 和 `paused`；
- 已成功章节保留；
- 暂停后不再调度新章节；
- 继续后只执行待完成章节；
- 单章节失败可重试；
- 指定章节重新生成只改目标章节；
- 内容修复重试不重复成功 operation；
- 配图计划可独立重跑；
- `planIllustrations` 不创建图片、Mermaid/HTML 资产或 render receipt；
- `renderIllustrations` 在 WP-J 返回稳定的未开放能力状态；
- 同一页面连续点击不会创建重复任务。

### 5.3 刷新与重启

- 任务运行时刷新页面，Store + SSE 恢复；
- SSE 断开重连后不重复终态事件；
- 服务重启后 `running/pausing` 变为 `TASK_INTERRUPTED_BY_RESTART`；
- 重启后用户可重新执行；
- 旧 runtime generation 延迟写回被拒绝；
- 已提交 Agent receipt 不重复应用；
- Workspace TTL close 后同账号新 runtime 可正常启动任务。

### 5.4 双账号隔离

同时运行账号 A 与 B：

- 文件、原方案、知识引用、模型配置、任务队列、SSE、目录、全局事实、正文、配图计划和 Agent execution 隔离；
- A 不能使用 B 的 file ID、knowledge document ID、task ID 或 execution token；
- A 的暂停、取消、close 和重启恢复不影响 B；
- 任何响应、日志或 SQLite 公共 DTO 不泄露兄弟 Workspace 信息。

### 5.5 失败路径

- AI queue 满；
- Agent queue 满；
- sidecar 不可用；
- sidecar readiness 失败；
- 模型超时、body 超限和协议错误；
- Agent 超时、取消、输出无效和 sandbox policy 拒绝；
- 输入在生成期间变化；
- SQLite 写入失败；
- SSE 客户端断开；
- 浏览器请求在任务受理前断开；
- Workspace close；
- Docker `SIGTERM`。

所有失败必须产生稳定错误码、可理解中文消息、正确 retryable 标记和可恢复状态。

错误映射 parity test 必须覆盖 Spec 第 10 节的内部错误、Web code、HTTP、retryable 和中文消息。

Sidecar 不可用、readiness 失败或策略缺失时，还必须断言：

- 所有 Agent Quality 动作 fail closed；
- J-Core 的目录、全局事实和正文主链继续可用；
- 页面状态明确区分“文本草稿已完成”和“Agent 审校/配图计划未完成”。

## 6. CI 门禁

### 6.1 Required Jobs

以下矩阵是唯一 CI 口径；每个 job 必须进入 `quality_gate.needs`，并在对应 PR 生效：

| job_id | Display name | 本地入口 | 生效 PR | Artifact |
| --- | --- | --- | --- | --- |
| `repo_hygiene` | Repository Hygiene | `git diff --check` + hygiene scripts | J-1 | whitespace report |
| `client` | Client Build / Existing Web Gates | `npm run build && npm run test:web` | J-1 | build/test logs |
| `technical_plan_core` | Technical Plan J-Core | `npm run wp-j:gate:j1` | J-1 | fixture + Chromium trace |
| `technical_plan_content` | Technical Plan Content | `npm run wp-j:gate:j2` | J-2 | manifest/quality report + Chromium trace |
| `agent_foundation` | Agent Foundation | 现有 Agent Foundation 命令 | J-1 | protocol/runtime logs |
| `agent_sidecar_security` | Agent Sidecar Security | `npm run wp-j:doctor && npm run test:web-agent-sidecar-security` | J-3 | topology/diagnostic report |
| `agent_sidecar_e2e` | Real OpenCode Sidecar | `npm run test:web-agent-sidecar` | J-3 | OpenCode trace + cleanup report |
| `technical_plan_release` | Chromium Agent Quality | `npm run wp-j:gate:j3` | J-3 | browser trace + quality report |
| `analytics_worker` | Analytics Worker Check | 现有命令 | J-1 | logs |
| `analytics_dashboard` | Analytics Dashboard Check | 现有命令 | J-1 | logs |
| `quality_gate` | Quality Gate | 无 | J-1 | needs 汇总 |

### 6.2 命令基线

以下 npm 命令均在 `[client/]` 执行；Docker/Compose 与 `git diff` 均在 `[repo root]` 执行。

现有命令继续执行：

```bash
cd client
npm run build
npm run test:web
npm run test:web-browser
npm run smoke:electron-native
npm audit --omit=dev --audit-level=critical
```

WP-J 新增命令：

```bash
npm run wp-j:gate:j1
npm run wp-j:gate:j2
npm run wp-j:doctor
npm run wp-j:gate:j3
npm run wp-j:readiness
npm run wp-j:diagnose -- --component seccomp
npm run wp-j:rollback-smoke
npm run test:web-technical-plan-store
npm run test:web-agent-sidecar
npm run test:web-agent-sidecar-security
npm run test:web-technical-plan-browser
```

本地聚合入口与 CI 一一对应：

| PR | 本地命令 | Required CI Job |
| --- | --- | --- |
| J-1 | `npm run wp-j:gate:j1` | `technical_plan_core` |
| J-2 | `npm run wp-j:gate:j2` | `technical_plan_content` |
| J-3 | `npm run wp-j:gate:j3` | `agent_sidecar_security` + `agent_sidecar_e2e` + `technical_plan_release` |

Docker 门禁从仓库根执行，使用固定版本与 checksum 的 OpenCode binary。CI 必须证明错误 checksum、缺失 seccomp、sidecar 非 internal network 或资源限制缺失时 fail closed。

Topology smoke 还必须打印并断言：容器用户、网络成员、公开端口、seccomp profile hash、`no-new-privileges`、capabilities、PID/内存配额和 Runner 挂载列表。输出必须脱敏。

Readiness 契约测试覆盖：

- Agent Quality 默认 `disabled`，J-Core readiness 为 200；
- 配置开启但 Runner 缺失时状态为 `blocked`，J-Core readiness 仍为 200；
- `/api/readiness/agent-quality` 在 Agent Quality 不可用时返回 503；
- `blocked` 状态下所有 Agent Quality 动作返回 `AGENT_SANDBOX_UNAVAILABLE` 或更具体稳定错误；
- 关闭 `AGENT_QUALITY_ENABLED` 并重启后，J-Core 与既有正文继续可用；
- `wp-j:rollback-smoke` 验证目录、全局事实、正文、stage revision 和 manifest 均保留；
- 镜像降级只接受记录在 J-2 证据包中且兼容当前 schema 的 last-green digest；
- doctor 每个失败检查都包含 `code/component/run_id/retryable/message/action/docs`、中文解释和下一条修复命令，且不泄露敏感信息。

## 7. 完成证据包

每个 PR 必须附：

- commit SHA；
- changed files 与范围说明；
- 执行命令及通过结果；
- 失败测试修复前后的证据；
- migration fixture；
- 账号隔离证据；
- 竞态测试列表；
- 未完成范围；
- 回滚方式。

J-3 合并前额外附：

- 三条真实 Chromium 业务录像或 trace；
- Agent sidecar network/OS policy 检查结果；
- Docker `SIGTERM` 与任务重启恢复结果；
- 双账号并发结果；
- Electron 回归结果；
- 全部 required checks 绿色链接。
