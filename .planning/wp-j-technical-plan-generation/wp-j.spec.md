# WP-J：技术方案文本草稿闭环 Spec

状态：Approved for implementation — CEO、Engineering、DX 双视角复审已收敛
规划基线：`origin/main@1c0a17eec348ffaeed1d7e1d0633483bf75fa2fb`（PR #9 / WP-I-2 已合并）
上位 Spec：

- `.planning/web-architecture-convergence/architecture-convergence.spec.md`
- `.planning/wp-i-business-task-agent-execution/wp-i.spec.md`
- `.planning/wp-i2-agent-execution-foundation/wp-i2.spec.md`

规划分支：`codex/wp-j-technical-plan-spec`
实施分支：每个实施 PR 单独创建 `codex/wp-j-*` 分支和 worktree。

## 1. 结论

WP-J 交付 Web 端可审阅、可编辑、可恢复的技术方案文本草稿闭环：

```text
招标文件导入
  -> 多标段识别与选择
  -> 招标分析
  -> 目录生成
  -> 全局事实生成
  -> 正文生成、暂停、继续与局部重试
  -> 配图计划落盘
```

本轮复用现有 Renderer 页面、组件、布局和交互，只收敛运行时、契约、任务、持久化和 Agent 隔离。实际图片、Mermaid、HTML 图形渲染与高保真 Word 输出继续由 WP-L 承接。WP-J 完成只代表“文本草稿可用”；只有 WP-L 完成渲染、导出和下载验收后，项目才允许声明“可交付技术方案闭环”。

WP-J 完成后，技术方案页面在 Docker/Linux 环境中必须具备真实成功链路、失败链路、账号隔离、刷新恢复、服务重启收口和可重复执行能力。任何 `pending`、占位成功、假 Agent 或只验证错误码的路径都不能作为完成证据。

### 1.1 已确认前提

- 2026-07-27，老板确认采用独立 Agent Runner sidecar；
- 单容器 Agent 只保留 development/test 兼容用途；
- 生产 Task Spec 只有在 sidecar OS 隔离门禁全绿后才允许注册；
- 该拓扑作为 WP-K 后续 Agent 任务的共用基础设施。

### 1.2 两个交付里程碑

| 里程碑 | 用户价值 | Agent 依赖 | 完成标志 |
| --- | --- | --- | --- |
| `J-Core` | 多标段、目录、全局事实、正文、暂停/继续、局部重试 | 无生产 Agent 依赖 | 结构化 AI 主链在真实 Chromium 与 Docker 中可用 |
| `J-Agent Quality` | 目录修复、跨章节审校、原方案覆盖修复、配图计划 | 独立 sidecar | OS 隔离、真实 OpenCode、Task Spec 与回滚门禁全绿 |

`J-Core` 可以先验收和合并。Agent 质量步骤未开放时，页面必须显示当前能力状态，不得伪造审校或配图计划成功。WP-J 整体完成仍要求两个里程碑都通过。

## 2. 当前事实基线

### 2.1 已具备

- `tasks.startBidAnalysis` 已接入 Portable Task Orchestrator；
- 每账号 Workspace、SQLite、文件、AI 队列、SSE 和 mutation executor 已建立；
- WP-I-2 已交付 Business Agent Executor、Task Spec Registry、Coordinator、CAS、幂等账本和真实 OpenCode Docker gate；
- 浏览器技术方案页面已经包含多标段、目录、全局事实、正文、暂停、继续、局部重试和重新配图的现有交互；
- Electron 任务已经实现上述业务算法，可作为行为基线和迁移输入。

### 2.2 尚未接通

以下 Web Contract 仍为 `pending`：

- `tasks.startBidSectionExtraction`
- `tasks.startOutlineGeneration`
- `tasks.startGlobalFactsGeneration`
- `tasks.startContentGeneration`
- `tasks.pauseContentGeneration`

当前 `client/server/workspace/webServices.cjs` 只装配招标分析任务。技术方案后续阶段仍依赖 Electron 目录中的任务、工具和自由 Agent 调用。

### 2.3 现有实现不能直接复用的原因

1. Electron 任务直接依赖 `electron/utils` 和桌面服务，portable core 不能反向导入 Electron；
2. 目录与正文任务通过自由 prompt 调用 `agentService.runTask()`，不满足静态生产 Task Spec 和受控结果提交约束；
3. `technicalPlanStore` 只有全局 `inputRevision`，目录、全局事实、正文缺少阶段级冻结输入与 CAS；
4. 正文任务同时承担文本生成、审校、配图规划和图片渲染，Web 分层边界不清晰；
5. 当前 Docker 进程虽以非 root 用户运行并使用 `prlimit`，首个生产 Agent 仍缺 egress deny、`no_new_privs`、seccomp 与容器级资源配额。

## 3. 用户结果

### 3.1 标准技术方案

用户导入招标文件后，可以在浏览器完成：

1. 识别单标段或多标段；
2. 多标段场景选择目标标段；
3. 完成招标分析；
4. 按当前配置生成目录；
5. 生成并编辑全局事实；
6. 生成完整正文；
7. 暂停、继续或重试失败章节；
8. 刷新页面后恢复当前任务和已生成内容；
9. 服务重启中断后获得可重试错误，不会永久卡在运行中。

### 3.2 已有方案扩写

用户导入原方案后，可以选择：

- 仅使用原目录；
- AI 补充原目录；
- 参考知识库文档；
- 进行原方案覆盖审校；
- 对指定章节重新生成。

该流程使用同一套 Workspace、Task、CAS、Agent 和持久化边界。

## 4. 目标与非目标

### 4.1 目标

1. 将多标段、目录、全局事实和正文的运行环境无关业务逻辑迁入 portable core；
2. 为五个 Web Task API 冻结严格 DTO、稳定错误码和契约测试；
3. 为技术方案各阶段增加独立输入版本、冻结快照、下游失效规则和 CAS；
4. 使用 WP-I-2 Executor 注册首批生产 Agent Task Spec，禁止浏览器自由 prompt、路径和 output file；
5. 完成首个生产 Agent 的 OS 隔离 Release Gate；
6. 保持现有 Renderer 页面、组件、布局、文案路径和操作方式；
7. 维持 Electron 行为，通过 adapter 复用 portable core；
8. 完成真实 Chromium、Docker、双账号、重启恢复和真实 OpenCode E2E；
9. 为固定脱敏招标 fixture 建立可机读质量门槛，证明内容受招标依据约束。

### 4.2 非目标

- UI 组件、DOM 结构、布局、交互路径或信息架构调整；
- 深色模式；
- 实际 AI 图片、Mermaid 或 HTML 图形渲染；
- 高保真 Word 图文导出；
- 知识库自动匹配、推荐、召回，查重和废标业务闭环；
- Redis、多实例调度、共享数据库或对象存储；
- 浏览器通用 Agent API；
- 恢复资源下载、投标机会或插件管理；
- 品牌清理。

## 5. 锁定架构

### 5.1 技术方案任务分层

```text
Renderer
  -> runtime-neutral task contract
  -> Web Task Service
  -> Portable Technical Plan Orchestrator
       -> stage snapshot reader
       -> AI service
       -> Business Agent Executor
       -> stage validator
       -> Workspace mutation executor
       -> Technical Plan Store
  -> per-account SQLite + files
```

Electron 通过独立 adapter 调用同一 Portable Technical Plan Orchestrator。Portable 模块不得导入 `electron/`、`BrowserWindow`、`ipcRenderer`、桌面对话框或桌面路径 API。

### 5.2 生产 Agent 隔离

首个生产 Agent Task Spec 采用独立 Agent Runner sidecar：

```text
public / model egress network
  |
Web container
  |  authenticated internal execution channel
  |
internal-only agent network
  |
Agent Runner container
  -> OpenCode
  -> per-run readonly input
  -> per-run writable output
  -> no direct internet egress
```

锁定要求：

- Web 容器可访问 MainQuest 与模型服务；
- Agent Runner 只加入 Docker internal network；
- OpenCode 不能直接访问公网、云元数据地址或 Web 以外的内部服务；
- execution 创建使用一次性 dispatch token；多轮模型调用使用独立、短期、受限且可撤销的 proxy session capability；
- 每次执行使用独立临时目录，输入只读、输出单独可写；
- Agent Runner 使用非 root 用户；
- 启用 `no-new-privileges`、capability drop、seccomp、PID/CPU/内存/文件大小/磁盘配额；
- Runner 不挂载账号总目录，不持有 SQLite、OAuth secret、模型 Key 或 Docker socket；
- Web 只向 Runner 发送 Task Spec 生成的有界输入包；
- 任务结束、取消、超时和 Workspace close 后清理运行目录并撤销 token。

单容器应用级权限控制只能作为开发兼容模式，不能开启生产 Task Spec。

#### 5.2.1 可执行部署契约

J-3 开放任何生产 Agent 能力前，仓库必须固定并验证以下拓扑：

| 对象 | 生产约束 |
| --- | --- |
| Web 公共监听 | 只对外暴露 Web/OAuth/业务 API；内部 Runner API 不绑定公共接口 |
| `model-egress` 网络 | Web、受控模型 mock/网关可加入；Runner 禁止加入 |
| `agent-internal` 网络 | Docker `internal: true`；仅 Web 与 Runner 加入 |
| Runner 访问 | 只允许访问 Web 的内部执行端点和 AI Proxy；禁止访问 OAuth、普通业务 API、兄弟服务和宿主 |
| Dispatch token | `aud=agent-runner`，绑定创建路径、workspace generation、execution ID、Task Spec、manifest hash；单次使用；短 TTL |
| Proxy session capability | 绑定 execution、manifest、Task Spec、允许路径、模型调用数与 token 总量；短 TTL；取消、超时、close 后撤销 |
| OS policy | 固定版本和 hash 的 seccomp profile、`no-new-privileges`、cap drop、只读根文件系统、tmpfs、有界 PID/CPU/内存/文件/磁盘 |
| 机密 | Runner 不接收 OAuth/session/模型 Key，不挂载 Workspace、SQLite、Docker socket |
| Readiness | 缺网络隔离、安全策略、配额或 token 校验任一项时，Agent readiness fail closed；J-Core 保持可用 |
| 并发 | J-3 首版 Runner 全局只执行 1 个任务；完成进程退出、token 撤销和目录清理后才释放下一个任务 |

交付物必须包含：

- production Compose 与 Runner image；
- seccomp policy 及完整性校验；
- Docker Desktop、Linux CI、正式 Linux Docker 主机的能力差异说明；
- 一条可重复的 topology/security smoke；
- 回滚到“关闭 Agent Quality、保留 J-Core”的操作说明。

`SidecarProtocolV1` 调用方向固定为：

```text
Web -> Runner  POST   /internal/runner/v1/executions
Web -> Runner  DELETE /internal/runner/v1/executions/{executionId}
Runner -> Web  POST   /internal/agent/v1/chat/completions
Runner -> Web  GET    /internal/agent/v1/executions/{executionId}/capability
```

Runner 只暴露 execution 创建、幂等取消和自身 readiness。Web 使用独立 internal listener 承载 AI Proxy 与 capability 查询；该 listener 只绑定 `agent-internal` 网络，不复用公共 Cookie/session。两个服务均采用 deny-by-default middleware，只放行上述版本化路径。Token/capability 同时绑定 HTTP method、path、execution ID、Task Spec ID、workspace generation 和 manifest hash。协议冻结请求/响应 schema、稳定错误、版本协商、结果 hash、取消幂等、Web/Runner 重连和撤销行为。普通 Bridge、OAuth、下载、公共健康管理和其他业务 API 在内部 listener 上均返回拒绝。

资源限制分两层：

- 容器硬限制：Linux cgroup 的 PID、CPU、内存与只读根文件系统；
- 单任务限制：deadline、模型调用数、token、输入/输出字节、tmpfs 容量和文件数量。

Docker Desktop 只作为开发兼容证据；正式发布 Gate 必须在 Linux Docker 主机验证硬限制。首版采用全局单任务串行，避免一个共享 Runner 同时处理多个账号目录。未来引入多 Agent 并发时，必须另立 Spec 采用每 execution 独立沙箱或 Job 容器。

### 5.3 AI 与 Agent 的决策边界

| 能力 | 执行方式 | 原因 |
| --- | --- | --- |
| 多标段结构化识别 | 受限 AI service + validator | 输入输出固定，不需要 Agent 文件工具 |
| 目录初次生成 | 受限 AI service + portable core | 主链需要低耦合和可恢复 |
| 全局事实生成 | 受限 AI service + schema | 结构化结果可直接校验 |
| 章节正文初次生成 | 受限 AI service + checkpoint | 支持逐章暂停、继续和重试 |
| 目录复杂修复 | Sidecar Agent Task Spec | 需要跨节点读取、诊断和受控修复 |
| 原方案覆盖与跨章一致性修复 | Sidecar Agent Task Spec | 需要全稿交叉审校 |
| 配图计划 | Sidecar Agent Task Spec | 需要全稿级规划，但不生成资产 |

### 5.4 Agent Task Spec

WP-J 首批生产 Task Spec：

| Spec ID | 用途 | 固定输出 |
| --- | --- | --- |
| `technical-plan.outline-repair.v1` | 修复目录结构、遗漏和硬约束 | `result.json` |
| `technical-plan.outline-word-adjust.v1` | 调整叶子章节与字数目标 | `result.json` |
| `technical-plan.content-repair.v1` | 修复指定章节质量或约束问题 | `result.json` |
| `technical-plan.original-coverage-repair.v1` | 修复原方案覆盖缺口 | `result.json` |
| `technical-plan.consistency-repair.v1` | 修复跨章节事实不一致 | `result.json` |
| `technical-plan.illustration-plan.v1` | 生成结构化配图计划 | `result.json` |

每个 Spec 必须：

- 服务端静态注册并版本化；
- 从 Store 权威快照构造输入；
- 使用 JSON Schema 校验结果；
- 通过 CAS + transaction + idempotency ledger 写回；
- 只允许声明的业务 operation；
- 限制输入、输出、模型调用数、总 token 和 deadline；
- 对同一 execution 保证 single-flight；
- 任何 validator 失败都保持零业务写入。

### 5.5 配图边界

WP-J 冻结 `IllustrationPlan v1`，只保存计划字段：

- `plan_version`
- `content_revision`
- `outline_revision`
- `manifest_hash`
- `revision`
- `items[*].item_id`
- `items[*].kind`
- `items[*].image_type`
- `items[*].title`
- `items[*].section_ids`
- `items[*].placement`
- `items[*].priority`
- `items[*].intent` 与 `description`（可选）

最终资产路径、URL、渲染引擎、渲染状态和 render receipt 不属于 `IllustrationPlan v1`。WP-L 只能追加独立 render receipt，不得改变计划字段语义。

现有 `contentIllustrationPlan.items[*].generation` 属于兼容数据。J-1 migration 将计划字段与 generation 字段拆开：计划进入 `IllustrationPlan v1`，已有 generation 信息进入独立 legacy render receipt；Renderer adapter 在 Electron 兼容路径组合展示。迁移必须幂等、可读取旧 Workspace，禁止静默丢弃已有资产引用。

为保持现有页面行为：

- 文本正文成功后，配图计划生成可以独立失败并支持重试；
- 内部动作冻结为 `planIllustrations` 与 `renderIllustrations`；
- WP-J 只实现 `planIllustrations`，WP-L 实现 `renderIllustrations`；
- 现有“重新配图”入口在 WP-J 中映射为 `planIllustrations`；
- 页面中已有图形配置继续保存，并显示“配图计划已生成，图形渲染待开放”；禁止创建虚假图片资产或伪造渲染成功。

## 6. Web Task 契约

### 6.1 `startBidSectionExtraction`

输入：

```ts
type StartBidSectionExtractionInput = Record<string, never>;
```

输出：`BackgroundTaskState`

错误：

- `TASK_INVALID_INPUT`
- `TASK_CONFLICT`
- `TASK_INPUT_CHANGED`
- `TASK_ACCEPTANCE_ABORTED`

### 6.2 `startOutlineGeneration`

输入：

```ts
interface StartOutlineGenerationInput {
  reference_knowledge_document_ids: string[];
  outline_expansion_mode: 'original-only' | 'ai-complement';
  word_control_options: OutlineWordControlOptions;
}
```

规则：

- 知识文档 ID 必须属于当前 Workspace；
- 强制 Agent repair 只允许通过 test harness 注入，永远不进入生产 DTO；
- 运行前冻结招标分析、原方案、知识文档引用、目录模式、字数配置和模型配置；
- 同一冻结输入只允许一个活动 execution。

### 6.3 `startGlobalFactsGeneration`

输入：

```ts
type StartGlobalFactsGenerationInput = Record<string, never>;
```

运行前冻结目录、招标分析和工作流类型。目录版本变化后，旧任务结果不得写回。

### 6.4 `startContentGeneration`

输入采用判别联合：

```ts
type StartContentGenerationInput =
  | {
      action: 'start' | 'regenerate-all';
      generation_options: ContentGenerationOptions;
    }
  | {
      action: 'regenerate-section';
      target_item_id: string;
      requirement: string;
      generation_options: ContentGenerationOptions;
    }
  | { action: 'resume' }
  | { action: 'retry-correction' }
  | { action: 'rerun-illustration-plan' };
```

兼容处理：

- Renderer 当前 payload 由 bridge adapter 按下表一次性映射到严格 DTO；
- portable core 只接收规范字段；
- 未声明字段必须拒绝；
- `requirement`、图片类型字符串、数量和正文配置必须设置长度与范围上限。

| Renderer 当前字段/动作 | 规范 DTO |
| --- | --- |
| 首次生成 + `generationOptions` | `{ action: 'start', generation_options }` |
| `regenerate` | `{ action: 'regenerate-all', generation_options }` |
| `targetItemId` + `requirement` | `{ action: 'regenerate-section', target_item_id, requirement, generation_options }` |
| `{ resume: true }` | `{ action: 'resume' }` |
| `{ retryContentCorrection: true }` | `{ action: 'retry-correction' }` |
| `{ rerunIllustrations: true }` | `{ action: 'rerun-illustration-plan' }` |

同时出现两个动作、缺少动作所需字段、携带未声明字段或浏览器直接发送 snake_case 内部保留字段时，返回 `TASK_INVALID_INPUT`。

### 6.5 手动知识文档边界

WP-J 只支持用户手动选择当前 Workspace 内已解析的知识文档。任务受理时必须校验可读性并冻结 document ID、内容 hash、解析版本和来源记录；文档变更后旧任务不得写回。自动匹配、推荐、召回、相关性排序和知识库业务闭环由 WP-K 承接。

### 6.6 任务状态机

外层任务状态固定为：

```text
idle
  -> accepted
  -> queued
  -> running
  -> pausing
  -> paused
  -> running
  -> validating
  -> committing
  -> success
```

任一可中断阶段可进入 `error`、`cancelled` 或 `interrupted`。规则如下：

| 事件 | 线性化前 | 线性化后 |
| --- | --- | --- |
| 用户暂停 | 停止调度新章节，已开始的单次步骤完成后写 checkpoint 并进入 `paused` | 当前事务原子提交，再进入 `paused` |
| 输入/manifest 变化 | 当前结果拒绝写回，终态 `error/TASK_INPUT_CHANGED` | 已提交结果保留，后续步骤停止 |
| 用户取消 | 终态 `cancelled`，零新增业务写入 | 当前事务完成，随后终止 |
| 超时 | 终态 `error/AGENT_TIMEOUT` 或任务对应 timeout | 当前事务完成，随后终止 |
| Workspace close / SIGTERM | 停止受理、取消排队、等待运行步骤收口 | 等待事务与 cleanup，超 deadline 返回稳定 shutdown error |
| Web 重启 | `running/pausing/validating` 收口为 `interrupted/TASK_INTERRUPTED_BY_RESTART` | ledger 已提交的 receipt 视为成功，不重复 apply |
| Runner 重启 | 未提交结果的 Agent execution 可重试；token 撤销 | 已提交 receipt 从 ledger 恢复 |

章节状态固定为 `pending -> running -> success|error|paused|invalidated`。Agent execution 继续使用 WP-I-2 的 reservation/preparing/queued/running/validating/applying/cleanup 语义；三层状态通过 execution ID 和 checkpoint 关联，禁止相互推断未持久化状态。所有终态事件只发布一次，SSE 重连按 Store 权威状态恢复。

内部 Store 保存完整状态；Renderer 继续使用现有 `running/pausing/paused/success/error` 五态，通过 `stats.phase` 投影 `accepted/queued/validating/committing`，不改变现有组件和交互。任务组锁从 `accepted` 持有到最终终态，`paused` 仍占用技术方案任务组。重启恢复覆盖全部非终态；`committing` 先查询业务 receipt/Agent ledger，再决定 `success` 或 `interrupted`。

Store 还必须持久化：

- `agent_quality_state: unavailable|pending|running|success|warning|error`
- `illustration_plan_state: unavailable|pending|running|success|warning|error`

`contentGenerationTask.success` 只表示文本草稿成功；Agent Quality 与配图计划使用独立状态，页面不得从正文任务状态推断其已完成。

### 6.7 `pauseContentGeneration`

输入：空对象。

语义：

1. 将任务置为 `pausing`；
2. 已进入单次 AI/Agent 原子步骤的请求允许结束；
3. 停止调度新章节；
4. 保存完成章节、待执行章节、冻结输入版本和运行时 checkpoint；
5. 收口为 `paused`；
6. `resume` 从 checkpoint 继续，已成功章节不重复生成。

暂停不是进程级 kill。取消、超时、Workspace close 和服务重启使用独立终态。

pause-drain deadline 默认 60 秒，可通过服务端配置调低。超过 deadline 后任务进入 `error/TASK_PAUSE_TIMEOUT`、`retryable=true`，保留已提交章节与最后一个有效 checkpoint，停止新写入。暂停后模型、知识文档、prompt 或配置发生变化时，旧 checkpoint 不能继续，必须返回 `TASK_INPUT_CHANGED`。

## 7. 阶段版本与持久化

### 7.1 版本模型

新增阶段版本：

| 版本 | 变化来源 | 失效范围 |
| --- | --- | --- |
| `source_revision` | 招标文件、原方案、多标段选择 | 招标分析及全部下游 |
| `analysis_revision` | 招标分析配置或结果 | 目录及全部下游 |
| `outline_revision` | 目录生成、标题/描述/层级/父子关系/增删、语义排序 | 全局事实、正文、配图计划 |
| `facts_revision` | 全局事实生成或编辑 | 正文、配图计划 |
| `content_revision` | 正文生成、编辑或重试 | 配图计划、WP-L 渲染产物 |

只有能够证明章节路径、正文顺序和导出顺序均不变化的显示层纯排序，才允许保留正文。标题、描述、层级、父子关系、增删或语义顺序任一变化时，必须递增 `outline_revision`，并清空全局事实、正文、配图计划和 WP-L render receipt。

#### 7.1.1 统一失效矩阵

| 变化 | 递增版本 | 必须失效 |
| --- | --- | --- |
| 招标文件、原方案、标段选择 | `source_revision` | 招标分析、目录、全局事实、正文、计划、render receipt |
| 招标分析配置或结果 | `analysis_revision` | 目录、全局事实、正文、计划、render receipt |
| 目录标题/描述/层级/父子/增删/语义顺序 | `outline_revision` | 全局事实、正文、计划、render receipt |
| 经证明无语义影响的显示层排序 | 无 | 无 |
| 手动知识文档选择或内容 hash | 对应任务 manifest 变化 | 尚未提交的目录/正文任务作废；已提交结果按用户重新生成动作处理 |
| 全局事实生成或编辑 | `facts_revision` | 正文、计划、render receipt |
| 正文生成、编辑、局部重试 | `content_revision` | 计划、render receipt |
| 生成配置、模型或 prompt/template 版本 | 对应任务 manifest 变化 | 活动旧任务写回拒绝；已提交结果不静默删除 |

### 7.2 任务冻结快照

每个任务受理时持久化不可变 `RunManifestV1`：

- `manifest_version: 1`；
- task ID、execution ID 和 task type；
- workspace runtime generation；
- stage revision vector；
- normalized input hash；
- 招标文件、原方案和手动知识文档的内容 hash；
- 选中标段与上游结果 hash；
- generation config hash；
- prompt/template version；
- model snapshot version/reference；
- output schema version。

新增按 execution 持久化的 run record，至少包含：

- `execution_id`、`task_id`、`task_type`
- `manifest_json`、`manifest_hash`
- `base_stage_vector`
- `target_stage_generation`
- `status`、`checkpoint_json`

任务受理事务一次性领取 `target_stage_generation` 并执行下游失效。逐章写入校验冻结的上游版本、当前 execution ID 和 target generation；任务自身持续写入的输出 revision 不参与后续章节的拒绝条件，避免第一章成功后让第二章自我失效。章节业务结果、章节状态、checkpoint 和阶段版本必须在同一 SQLite transaction 提交。

任务状态、progress、logs、timestamps、checkpoint、错误、Agent receipt 作为 execution state 单独持久化，不参与 manifest hash。JSON 规范化固定键排序、数组顺序、null/缺失语义、数字格式、UTF-8 和 SHA-256。`RunManifestV1` 规范化后生成唯一 manifest hash，并投影到 WP-I-2 Agent envelope 的 `inputHash`；ledger 必须额外持久化 `manifest_hash`。直接 AI 与 Agent 的每次写回必须在 mutation executor 中校验 workspace generation、冻结的上游 stage revision、target generation 和 manifest hash。知识文档替换、模型切换、prompt 升级或配置变更均须让旧结果返回 `TASK_INPUT_CHANGED`，不得覆盖新状态。

### 7.3 重启恢复

本轮不提供跨进程续跑。服务重启后：

- `accepted`、`queued`、`running`、`pausing`、`validating` 收口为 `TASK_INTERRUPTED_BY_RESTART`；
- `committing` 先查询业务 receipt/Agent ledger；已提交则恢复为 success，未提交则收口为 interrupted；
- 已持久化的成功章节、checkpoint 和 Agent receipt 保留；
- 用户可重新执行或从受支持 checkpoint 继续；
- 旧 runtime generation 的延迟写入全部拒绝；
- 页面刷新通过 Store + SSE 恢复当前状态。

## 8. Portable Core 迁移规则

### 8.1 迁移对象

从 Electron 任务中抽离：

- 多标段识别与选段应用逻辑；
- 目录上下文构造、解析、校验、字数控制和审校编排；
- 全局事实生成与校验；
- 正文计划、章节生成、字数调整、覆盖审校、一致性审校和配图计划；
- 用户文本切分、bid section context、文本编辑等纯函数工具；
- 任务进度、日志、暂停点和 checkpoint 结构。

J-1 开始前必须先提交迁移清单。每个模块列出：Electron 来源、portable 目标、环境依赖、输入输出 fixture、adapter 所有者和退出 Gate。迁移顺序固定为：

1. 多标段与选段；
2. 目录结构化生成；
3. 全局事实；
4. 正文逐章生成与 checkpoint；
5. 审校与修复；
6. `IllustrationPlan v1`。

图片生成、Mermaid/HTML 渲染和资产写回不得随正文大文件一并迁入 portable core。

### 8.2 保留在 adapter 的内容

- Electron IPC、dialog、app path、BrowserWindow 和 shell；
- Web HTTP、OAuth、SSE、Workspace 解析和 file ID；
- Agent sidecar transport；
- WP-L headless render；
- 运行环境特有的临时目录和进程启动。

### 8.3 兼容要求

- Electron adapter 必须改用 portable core，避免维护两套业务算法；
- Renderer bridge 方法名保持不变；
- Electron 与 Web 对相同冻结输入的结构化结果必须通过契约 fixture 对比；
- 迁移期间不得删除旧持久化字段，除非提供 migration、回滚和 fixture。

### 8.4 跨 WP 契约

| 契约 | Owner | 规范路径 | 兼容规则 | 固定证据/CI |
| --- | --- | --- | --- | --- |
| Sidecar execution envelope v1 | J-Agent Quality 基础设施 | `client/shared/contracts/agent-sidecar/` | 只能新增可选字段；安全字段变更需新版本 | protocol fixture / Agent Sidecar |
| Execution token lifecycle v1 | J-Agent Quality 基础设施 | `client/server/agent-sidecar/` | audience、绑定字段、单次使用不得放宽 | replay test / Agent Sidecar Security |
| Business Task Spec API v1 | WP-I-2/J-Agent Quality | `client/core/agent/` | operation allowlist 和事务语义不可弱化 | contract fixture / Agent Foundation |
| `IllustrationPlan v1` | WP-J | `client/shared/contracts/technical-plan/` | WP-L 只追加独立 render receipt | cross-WP fixture / Technical Plan |
| 手动知识文档引用 v1 | WP-J | `client/shared/contracts/technical-plan/` | WP-K 可增加自动匹配，不改冻结 hash 语义 | document fixture / Technical Plan |

契约升级必须新增版本与 migration fixture，保留至少一个发布版本的读取兼容窗口。Owner PR 负责更新共享类型、Web/Electron adapter、fixture 与 required CI；WP-K/WP-L 不得在消费 PR 中静默改写上游契约。

### 8.5 内容质量契约

仓库新增版本化脱敏 `client/fixtures/technical-plan-quality/v1/manifest.json` 与 `quality-report.v1` JSON Schema。每条招标要求具有稳定 requirement ID，并记录：

- requirement text hash 和脱敏证据片段 hash；
- 预期目录/章节类型；
- 实际映射的 outline/section ID；
- 事实引用与冲突状态；
- 原方案段落保留或未映射原因；
- 字数与结构检查；
- warning/error 和失败原因。

受控 Provider CI 负责稳定结构与 rubric 断言；发布前受控真实模型运行同一 fixture，并存储脱敏报告。任何未覆盖硬性要求、编造未知事实或违反 `original-only` 的结果都不能通过。

质量报告必须记录 fixture/rubric/schema、模型 snapshot 和 prompt/template version。PR CI artifact 保留 30 天，发布 Gate 的脱敏真实模型报告随 release evidence 保留至少 180 天；原始招标正文、prompt 和模型完整响应不得进入 artifact。

## 9. 实施拆分

### PR J-1：J-Core 目录纵向切片

范围：

- 冻结五个 Task DTO、Renderer 映射、错误码、run manifest 和共享类型；
- 为 Electron 任务补 characterization fixture 与迁移清单；
- 抽离多标段、选段与目录生成所需 portable core；
- 建立阶段版本、统一失效矩阵和 CAS；
- Electron adapter 切换对应 portable core；
- Web 接通多标段与一条真实目录浏览器链路；
- Sidecar 基础设施可以在独立写入范围并行开发，生产 Task Spec 不注册。

Gate：

- 真实 Chromium 完成“招标分析 -> 标段选择 -> 目录”；
- Electron 行为回归；
- Store migration 与阶段版本测试；
- portable core 不导入 Electron；
- 同输入 fixture 结果一致。

### PR J-2：J-Core 正文纵向切片

范围：

- 抽离全局事实、正文逐章生成、暂停/继续、局部重试和 checkpoint；
- 接通对应 Web Contract、SSE 与 Store 恢复；
- 完成 `run_manifest`、模型/知识/prompt 冻结与写回 CAS；
- 接通标准方案和已有方案扩写；
- 保持所有 Agent Quality 路径 fail closed 或明确不可用。

Gate：

- 单标段正文真实浏览器闭环；
- 已有方案 `original-only` 与 `ai-complement` 真实浏览器闭环；
- 暂停、继续、局部重试、刷新与重启收口；
- 固定质量 fixture 达标；
- Electron 对应行为回归。

### PR J-3：J-Agent Quality、配图计划与发布验收

范围：

- 新增独立 Agent Runner image/service、双网络和内部协议；
- Web production image 移除 OpenCode、`rg/fd/jq/prlimit` 等 Runner 专用 binary，且不能选择 in-process production runner；
- 完成 OS 隔离 Gate、一次性 token、有界输入包、生命周期和审计；
- 注册六个 WP-J 生产 Task Spec；
- 接通复杂修复、覆盖审校、一致性修复和 `IllustrationPlan v1`；
- 完成多标段、双账号、真实 OpenCode、Chromium 与 Docker 发布验收；
- 更新项目状态文档。

Gate：

- egress deny、metadata/DNS/跨 Workspace/宿主路径攻击失败；
- seccomp、`no-new-privileges`、cap drop 和资源配额生效；
- Runner 不持有账号总目录、SQLite、OAuth secret 或模型 Key；
- Web production image 不含 OpenCode 与 Runner 工具，in-process production runner 负向测试通过；
- Task Spec 的 CAS、幂等和 rollback 通过；
- 单标段、已有方案、多标段与双账号三个内部 Gate 依次通过；
- 双账号任务、文件、模型配置、SSE 和输出隔离；
- Electron、Web、Agent sidecar、Docker、OAuth 和依赖审计全绿。

合并顺序固定为 J-1 → J-2 → J-3。三个 PR 不并行修改同一 Portable Task 模块。Sidecar image、网络和协议可在 J-1 冻结契约后独立开发；生产 Task Spec 注册必须等待 J-Core 的冻结 SHA。

并行写入边界：

| Lane | 允许写入 | 禁止写入 | 依赖 |
| --- | --- | --- | --- |
| J-Core | `client/core/technical-plan/`、Store migration、technical-plan shared DTO/fixture | Sidecar transport/image/Compose | J-1 契约 |
| Sidecar Infrastructure | `client/server/agent-sidecar/`、Runner image、seccomp、独立 security tests | technical-plan Store、业务 Task Spec apply | J-1 冻结的 `SidecarProtocolV1` |
| Integration | Workspace 装配、Compose、CI、Web Contract、Renderer adapter | 未经 rebase 改写前两 Lane 核心 | J-Core 与 Sidecar 合并 SHA |

`Dockerfile`、`docker-compose.yml`、`client/package.json`、CI workflow 和 Workspace Runtime 属于共享热点，只允许 Integration Lane 在 J-3 统一收口。

## 10. 失败与安全语义

稳定错误码至少包括：

- `TASK_INVALID_INPUT`
- `TASK_CONFLICT`
- `TASK_INPUT_CHANGED`
- `TASK_ACCEPTANCE_ABORTED`
- `TASK_INTERRUPTED_BY_RESTART`
- `TASK_PAUSE_TIMEOUT`
- `AGENT_CLOSING`
- `AGENT_QUEUE_OVERLOADED`
- `AGENT_TIMEOUT`
- `AGENT_PROTOCOL_UNSUPPORTED`
- `AGENT_OUTPUT_INVALID`
- `AGENT_APPLY_FAILED`
- `AGENT_QUALITY_DISABLED`
- `AGENT_SANDBOX_UNAVAILABLE`
- `AGENT_SANDBOX_POLICY_DENIED`

所有错误响应禁止包含：

- 服务端绝对路径；
- Workspace ID；
- OAuth/session/token；
- 模型 API Key；
- 用户文档正文；
- 完整 prompt 或模型原始响应；
- sidecar 内部地址和一次性 execution token。

内部错误到 Web 的映射固定如下，并由 parity test 约束：

| 内部错误 | Web code | HTTP | retryable |
| --- | --- | --- | --- |
| `AGENT_INPUT_CHANGED` | `TASK_INPUT_CHANGED` | 409 | true |
| `AGENT_QUEUE_OVERLOADED` | 同名 | 429 | true |
| `AGENT_TIMEOUT` | 同名 | 408 | true |
| `AGENT_QUALITY_DISABLED` | 同名 | 503 | false |
| `AGENT_SANDBOX_UNAVAILABLE` | 同名 | 503 | true |
| `AGENT_OUTPUT_INVALID` | 同名 | 422 | true |
| `AGENT_APPLY_FAILED` | 同名 | 500 | true |
| `TASK_PAUSE_TIMEOUT` | 同名 | 409 | true |

每个映射同时冻结中文用户消息。未列出的内部异常只能返回脱敏 `INTERNAL_ERROR`，并生成公共诊断 run ID。

### 10.1 首版容量预算

| 对象 | 上限 |
| --- | --- |
| 单技术方案目录节点 | 1,000 |
| `RunManifestV1` JSON | 256 KiB |
| Sidecar 只读输入包 | 32 MiB |
| Agent `result.json` | 4 MiB |
| 单任务 checkpoint | 2 MiB |
| 单次 SQLite mutation transaction | 5 秒 |
| Runner 排队等待 | 10 分钟 |
| 单 Agent execution deadline | 20 分钟 |
| 单个 J-3 Docker CI job | 30 分钟 |

超过上限必须在受理或读取边界 fail closed，并返回稳定错误；不得通过截断正文、manifest、checkpoint 或 Agent 结果伪造成功。生产环境只允许把上限调低。

## 11. 完成标准

WP-J 只有同时满足以下条件才可标记完成：

1. 五个 Web Task Contract 具备严格 DTO 和真实实现；
2. 单标段、多标段和已有方案扩写均完成浏览器文本草稿成功链路；
3. 目录、全局事实、正文、暂停、继续、局部重试和配图计划真实落盘；
4. 页面刷新恢复 Store 状态，SSE 只回放当前账号事件；
5. 服务重启后活动任务收口为可重试错误；
6. 阶段 CAS 阻止旧任务覆盖新输入；
7. J-Core 不依赖生产 Agent 也可完成文本草稿主链；
8. 首批生产 Agent Task Spec 通过 sidecar OS 隔离 Gate；
9. 固定质量 fixture 证明硬性招标要求覆盖、事实无冲突、原方案模式与字数约束成立；
10. 双账号隔离、路径边界、日志脱敏和资源上限通过；
11. Electron 回归通过；
12. `npm run build`、`npm run test:web`、真实 Chromium、Agent sidecar Docker E2E、Docker business smoke、OAuth smoke 和 production audit 全绿；
13. `project.md`、`AGENTS.md` 和实施状态文档只记录“文本草稿闭环”，不得宣称图文交付完成；
14. 品牌清理继续冻结，直到 WP-K、WP-L 和架构总验收完成。

## 12. 实施前 Gate

工程复审必须确认：

1. Sidecar 是首个生产 Agent 的正式隔离拓扑；
2. WP-J 到配图计划为止，实际渲染由 WP-L 接管；
3. 三个纵向切片 PR 的拆分与固定合并顺序；
4. 阶段 revision 模型与下游失效规则；
5. Renderer 保持零设计改动；
6. 生产环境未通过 sidecar readiness 时，所有 WP-J Agent 路径 fail closed。

## 13. 开发与运维体验契约

### 13.1 10 分钟开发入口

J-1 必须补齐 `docs/runbooks/wp-j-local-dev.md`，并以 Node 22、当前锁定 Docker Compose 版本从干净 worktree 完成一次 10 分钟计时挑战：

```bash
git fetch origin
git worktree add ../Bidding-Copilot-wp-j-j1 -b codex/wp-j-j1 origin/main
cd ../Bidding-Copilot-wp-j-j1/client
npm ci
npm run wp-j:gate:j1
```

需要交互调试时，runbook 明确区分终端 A 的常驻 `npm run dev:web` 与终端 B 的 Gate；自动验收优先使用仓库根目录 `docker compose up -d --build --wait web`。文档必须说明环境文件、端口冲突、mock 登录入口、固定 fixture、预期页面、成功输出和常见失败。J-2/J-3 分别新增：

```bash
npm run wp-j:gate:j2
npm run wp-j:doctor
npm run wp-j:gate:j3
npm run wp-j:readiness
npm run wp-j:diagnose -- --run-id <safe-run-id>
```

每个聚合命令必须打印子测试、失败检查 ID、相关日志 artifact 和下一条诊断命令。总入口 `npm run test:web` 必须持续包含当前已合入工作包的非 Docker required tests；Docker/security jobs 可保持独立 required check。

### 13.2 Compose 与能力开关

开发默认只启动 J-Core：

```bash
docker compose up -d --build --wait web
```

Agent Quality 使用显式 profile：

```bash
AGENT_QUALITY_ENABLED=true docker compose --profile j-agent up -d --build --wait
```

`AGENT_QUALITY_ENABLED` 默认 `false`。关闭该开关并重启 Web 即为回滚路径：目录、全局事实和正文保持可用，所有 Agent Quality 动作返回明确的 `AGENT_QUALITY_DISABLED`。回滚不得修改数据库或删除已提交正文。

### 13.3 Readiness 与诊断

`/api/readiness` 的 HTTP 状态只表示 J-Core 是否可服务，并返回脱敏组件状态。`/api/readiness/agent-quality` 独立检查 Sidecar、网络、策略、token 与配额，失败返回 503；生产 Task Spec 注册和每次执行都校验该 readiness。响应示例：

```json
{
  "status": "ready",
  "capabilities": {
    "technical_plan_core": "ready",
    "agent_quality": "disabled"
  }
}
```

Agent Quality 状态固定为：

- `disabled`：配置关闭；
- `starting`：等待 Runner；
- `ready`：拓扑、token、策略和真实 self-check 通过；
- `blocked`：已开启但门禁失败。

Agent Quality 为 `blocked` 时 `/api/readiness` 仍可为 200，但所有 Agent 路径 fail closed。`npm run wp-j:doctor` 必须逐项输出容器用户、网络成员、公开端口、internal listener、seccomp hash、`no-new-privileges`、cap drop、PID/内存配额、挂载和真实握手，失败时给出稳定检查 ID、中文解释和下一条修复命令。禁止输出 token、内部请求内容、Workspace ID、路径或模型配置。

结构化诊断统一返回：

```json
{
  "code": "AGENT_SECCOMP_HASH_MISMATCH",
  "component": "agent-sidecar",
  "run_id": "safe-id",
  "retryable": false,
  "message": "Agent 安全策略校验失败",
  "action": "npm run wp-j:diagnose -- --component seccomp",
  "docs": "docs/runbooks/wp-j-agent-sidecar.md#seccomp"
}
```

`run_id` 只能使用随机公共诊断 ID，不能编码账号、Workspace 或 execution token。

检查 ID 注册表至少覆盖：

| 类别 | 稳定检查 |
| --- | --- |
| readiness | Web、Runner、internal listener、真实握手 |
| token | 过期、重放、绑定字段不匹配、撤销 |
| network | Runner 网络成员、公开端口、egress、metadata |
| seccomp | policy 缺失、hash 不匹配、未生效 |
| fixture | manifest、schema、rubric、模型配置、报告路径 |

每个检查 ID 必须映射到脱敏日志/artifact、修复命令和 runbook 锚点。

### 13.4 文档与证据位置

- 架构与工作包：`.planning/wp-j-technical-plan-generation/`
- 10 分钟开发入口：`docs/runbooks/wp-j-local-dev.md`
- Sidecar 拓扑与排障：`docs/runbooks/wp-j-agent-sidecar.md`
- PR Gate 与 fixture：`docs/runbooks/wp-j-gates-and-fixtures.md`
- 数据库、镜像、feature flag 与 sidecar 回滚：`docs/runbooks/wp-j-rollback.md`
- 版本化共享契约：`client/shared/contracts/`
- 脱敏质量 fixture：`client/fixtures/technical-plan-quality/v1/`
- CI trace 与失败诊断：GitHub Actions artifact，按 PR Gate 命名

J-1 数据库 migration 必须在升级前备份，并保留至少一个发布版本的旧字段读取兼容；回滚文档明确哪些旧二进制只能只读打开升级后的 Workspace。J-2 合并时记录 last-green Web commit 与 image digest。J-3 回滚顺序固定为：关闭 `AGENT_QUALITY_ENABLED`、运行 `wp-j:rollback-smoke` 验证 J-Core、停止 Runner；只有确需降级时才回到兼容当前数据库的 last-green J-2 digest。禁止通过删除 ledger、manifest 或正文数据实现降级。

## 14. 正式复审记录

| 阶段 | 双视角初始裁决 | 已收敛的关键问题 | 最终状态 |
| --- | --- | --- | --- |
| CEO | `REVISE / REVISE` | 完成口径、J-Core/Agent 分层、知识边界、配图语义、质量 Gate、纵向 PR | Clear |
| Engineering | `REQUEST CHANGES / HOLD` | Sidecar 协议、token 双能力、RunManifest 存储、CAS generation、状态投影、能力状态、容量与 CI | Clear |
| DX/Operations | `REVISE / HOLD` | 10 分钟入口、聚合命令、独立 readiness、诊断注册表、last-green 回滚、runbook | Clear as implementation contract |
| Design | Skip | 本轮零 UI 设计变化，只冻结现有文案与状态语义 | N/A |

复审没有推翻独立 Sidecar，也没有改变 WP-J/WP-K/WP-L 边界。所有正常发现已按“完整性、安全性、简单性”顺序自动写入 Spec；实施阶段不得删除这些 Gate 来缩短交付。

## 15. 已有能力、失败模式与明确延期

### 15.1 What already exists

- `technicalPlanStore`、SQLite migration、每 Workspace mutation executor；
- Portable Task Orchestrator、任务持久化与 SSE 回放；
- Web AI Runtime 的模型快照、队列、超时、响应上限和账号隔离；
- WP-I-2 Agent Coordinator、Executor、CAS、事务、幂等 ledger 和真实 OpenCode Docker E2E；
- Electron 多标段、目录、全局事实、正文和配图规划算法，作为 characterization 输入。

实施必须复用这些能力，避免重新建立第二套 Store、任务系统、AI 队列或 Agent 账本。

### 15.2 主要失败模式

| 失败模式 | 防线 | 必测证据 |
| --- | --- | --- |
| 逐章写入让任务自身 manifest 失效 | target stage generation | 多章节连续提交 |
| Sidecar 多轮请求耗尽或 token 重放 | dispatch token + proxy capability | replay/limit/revoke |
| Sidecar 故障拖垮整个 Web | Core/Agent readiness 分离 | degraded J-Core |
| queued/validating 阶段释放任务锁 | 内部全状态机 + Renderer 投影 | duplicate-start race |
| Web/Runner 单边崩溃重复写入 | receipt/ledger reconciliation | 四个 crash window |
| 目录语义变化保留旧正文 | 统一失效矩阵 | 参数化 Store fixture |
| 计划与渲染资产再次耦合 | `IllustrationPlan v1` + render receipt | cross-WP fixture |
| 回滚跨过 J-Core | last-green J-2 digest + rollback smoke | 既有正文保留 |

### 15.3 NOT in scope

- WP-K 自动知识匹配、推荐、召回、查重和废标；
- WP-L 图片/Mermaid/HTML 渲染、render receipt 消费、Word 图文导出与下载；
- 多 Agent 并发；首版 Runner 全局单任务串行；
- Redis、多实例、共享数据库、对象存储和 Kubernetes Job；
- UI 组件、布局、信息架构、深色模式；
- 品牌清理实施；
- 删除 Electron 兼容层。

## 16. Implementation Tasks

- [ ] **T1（P0，AI Coding 约 1d）— Contracts/Store — 冻结 DTO、`RunManifestV1`、状态机与 migration**
  - 来源：Engineering — 多阶段 CAS、状态投影和按 execution 存储；
  - 影响：`client/shared/contracts/technical-plan/`、SQLite、Technical Plan Store；
  - 验证：migration、canonical hash、target generation、状态转换和 rollback。
- [ ] **T2（P0，AI Coding 约 2d）— J-1 Portable Core — 接通多标段与目录纵向链**
  - 来源：CEO/Engineering — 先以可运行纵向切片降低集成风险；
  - 影响：portable technical-plan core、Electron/Web adapter、Renderer DTO；
  - 验证：`npm run wp-j:gate:j1`、Chromium 目录链、Electron fixture。
- [ ] **T3（P0，AI Coding 约 3d）— J-2 Content Core — 迁移全局事实与逐章正文**
  - 来源：Engineering — J-Core 需脱离 Agent 完成主价值；
  - 影响：portable core、AI service adapter、Technical Plan Store；
  - 验证：标准方案、`original-only`、`ai-complement`、字数与质量 fixture。
- [ ] **T4（P0，AI Coding 约 1.5d）— Task Lifecycle — 完成暂停、继续、局部重试和恢复**
  - 来源：Engineering — checkpoint、pause deadline、重启和任务锁必须闭合；
  - 影响：Task Orchestrator、Store、SSE、Renderer state adapter；
  - 验证：`npm run wp-j:gate:j2`、pause/resume/restart/race tests。
- [ ] **T5（P1，AI Coding 约 1d）— Quality Evidence — 建立脱敏 fixture 与 `quality-report.v1`**
  - 来源：CEO/DX — 流程成功还需证明内容可用于投标；
  - 影响：`client/fixtures/technical-plan-quality/v1/`、eval scripts、CI artifacts；
  - 验证：受控 Provider CI 与受控真实模型发布 Gate。
- [ ] **T6（P0，AI Coding 约 1.5d）— Sidecar Protocol — 实现 `SidecarProtocolV1` 与双 token 能力**
  - 来源：Engineering — 创建 execution 与多轮 AI Proxy 需要不同生命周期；
  - 影响：shared agent-sidecar contract、Web internal listener、Runner API；
  - 验证：schema、version、replay、revoke、reconnect、idempotent cancel。
- [ ] **T7（P0，AI Coding 约 2d）— Runner Isolation — 拆分 Web/Runner 镜像和双网络**
  - 来源：Engineering — Web production image 不得携带 Runner；
  - 影响：Docker targets、Compose profile、seccomp、cgroup/security tests；
  - 验证：egress/metadata/path attack、cap drop、quota、Web image negative。
- [ ] **T8（P0，AI Coding 约 2d）— Agent Quality — 注册六个生产 Task Spec**
  - 来源：CEO/Engineering — 复杂修复与配图计划使用受控 Agent；
  - 影响：Task Spec Registry、validator、operation、quality/illustration state；
  - 验证：真实 OpenCode、CAS、transaction、ledger、rollback、`IllustrationPlan v1`。
- [ ] **T9（P0，AI Coding 约 1d）— Web Integration — 接通 readiness、能力开关与发布状态**
  - 来源：Engineering/DX — Agent 故障不能下线 J-Core；
  - 影响：Workspace Runtime、readiness routes、Bridge error mapping、Renderer adapter；
  - 验证：Core 200 + Agent 503、Agent fail closed、双账号隔离。
- [ ] **T10（P1，AI Coding 约 1d）— DX/CI — 交付聚合 Gate、doctor、diagnose 和 runbook**
  - 来源：DX — 新 AI Coding agent 需要 10 分钟接手路径；
  - 影响：`client/package.json`、scripts、CI、README、四份 runbook；
  - 验证：全新 worktree 计时挑战、CI 唯一矩阵、稳定诊断输出。
- [ ] **T11（P0，AI Coding 约 1.5d）— Release E2E — 完成 Chromium、Sidecar 和故障窗口验收**
  - 来源：Engineering — 真实协议、崩溃、恢复与清理是发布门禁；
  - 影响：Playwright、Docker E2E、security smoke；
  - 验证：单标段、已有方案、多标段/双账号、四个 crash window。
- [ ] **T12（P1，AI Coding 约 0.5d）— Rollback/Governance — 固定 last-green 与完成口径**
  - 来源：CEO/DX — 文本草稿和可交付方案必须保持区分；
  - 影响：release evidence、project/README/AGENTS、rollback smoke；
  - 验证：关闭 Agent Quality 后 J-Core 数据完整，文档只声明真实完成范围。

## GSTACK REVIEW REPORT

- Status: APPROVED FOR IMPLEMENTATION
- Scope: WP-J 技术方案文本草稿闭环
- Product milestones: J-Core -> J-Agent Quality
- Production Agent topology: independent sidecar
- PR order: J-1 -> J-2 -> J-3
- CEO review: CLEAR, all findings folded
- Engineering review: CLEAR, all findings folded
- DX review: CLEAR as implementation contract
- Design review: SKIPPED, no UI design scope
- User Challenges: 0 unresolved
- Brand cleanup: frozen

NO UNRESOLVED DECISIONS
