# WP-I-2：Business Agent Execution Foundation Spec

状态：Approved for implementation after engineering review  
规划基线：`origin/main@cadbf24d79dac7ae358ac462aa8a6b15828004d3`（PR #7 / WP-I-1 已合并）  
上位 Spec：`.planning/wp-i-business-task-agent-execution/wp-i.spec.md`  
实施分支：`codex/wp-i2-agent-foundation`（正式开发时另建 worktree）  
规划分支：`codex/wp-i2-agent-foundation-spec`

## 1. 结论

I-2 交付一个只允许服务端业务层调用的 Agent 执行底座，完成真实 OpenCode 多轮 tool-call、进程级公平调度、结果安全提交、资源限制、清理和 CI 证据。

本轮不开放任何浏览器 Agent 能力，不注册正式生产业务 Agent Task Spec，也不宣称 OS 级 Agent 隔离已经完成。`agent.run/listRuntimes/selfCheck/getStatus/restart` 在 Web Contract 中继续保持 `pending`。

首个正式 Agent 业务任务仍受独立 Release Gate 约束：非 root、只读输入、独立可写目录、egress deny、`no_new_privs`、seccomp、capability 收敛与 CPU/内存/PID/磁盘配额全部通过后，生产 Task Spec 注册表才允许加入业务项。

## 2. I-1 合入后的事实基线

### 2.1 已满足的前置条件

- PR #7 已合并到 `main@cadbf24`；
- Portable Task Orchestrator、严格 Bid Analysis DTO、input revision CAS 和 Workspace mutation executor 已落地；
- `tasks.startBidAnalysis` 已成为当前唯一正式 Web 业务任务；
- Web Agent Contract 与 Renderer 入口已经收缩，浏览器 Agent 方法保持 `pending`；
- CI 已包含 Web、真实 Chromium、Electron、Docker、OAuth startup 与 production audit 门禁。

### 2.2 当前可复用实现

| 能力 | 当前文件 | I-2 处理 |
| --- | --- | --- |
| Web AI 安全请求、队列、重试、deadline、响应上限 | `client/core/aiRuntime.cjs` | 复用并增加 server-internal raw chat port |
| 进程级 AI 公平调度 | `client/core/aiFairCoordinator.cjs`、`client/server/ai/globalAiCoordinator.cjs` | 参考调度语义，不直接复用 Agent Coordinator |
| OpenCode binary、checksum 与 Docker 安装 | `client/scripts/prepare-opencode-binary.cjs`、`Dockerfile` | 保留，增加真实协议 smoke 与资源依赖 |
| Web OpenCode 启动、Proxy、权限配置和清理骨架 | `client/server/agent/webAgentService.cjs` | 拆成 runner、proxy、workspace adapter |
| Workspace 生命周期与 TTL | `client/server/workspace/workspaceRegistry.cjs`、`workspaceContext.cjs` | 纳入 Agent active/queued snapshot |
| Workspace 串行写 | `client/server/workspace/workspaceMutationExecutor.cjs` | 复用到 Agent 结果提交 |
| SQLite transaction 与 runtime migration | `client/core/sqliteDatabase.cjs` | 增加结果应用幂等账本 |

### 2.3 当前阻断

1. `createOpenAiProxy()` 调用 `scopedAi.chat()`，只返回文本并固定 `finish_reason = stop`，会丢失 `tools/tool_choice/tool_calls/usage`；
2. `webAgentService.cjs` 只维护单个 `activeTask`，没有进程级 active/queued 上限、跨 Workspace 公平性和全局 shutdown；
3. 任务由自由 payload 直接构造 prompt/files/output，缺少服务端 Task Spec 注册表与稳定版本；
4. 输出读取只用 `existsSync/readFileSync`，没有原子打开、普通文件、symlink、hard-link、inode 和未声明输出检查；
5. stdout/stderr 虽会截断字符串，仍缺少统一有界日志结构和敏感信息扫描；
6. 子进程未通过 `prlimit` 施加地址空间、文件大小、打开文件数、CPU 和进程数限制；
7. Agent 结果没有与 input revision 位于同一 transaction 的 CAS、幂等账本与 exactly-once apply；
8. Workspace activity snapshot 不统计 Agent Coordinator 中的 queued/running job；
9. server shutdown 只关闭 Workspace，缺少进程级 Agent Coordinator 的最终 drain/close；
10. 现有 Agent 测试使用 fake binary，只证明单任务骨架，没有证明真实 OpenCode tool-call 协议。

## 3. 用户结果

I-2 完成后，后续 WP-J/WP-K 可以通过一份服务端静态 Task Spec 安全调用 Agent：

```text
业务任务
  -> 读取当前 Workspace 权威状态并冻结 input revision
  -> 进入进程级公平队列
  -> 真实 OpenCode 多轮 tool-call
  -> 只在受控目录读输入、写唯一结果
  -> validator 校验完整结果
  -> CAS + transaction + idempotency 一次性写回
```

用户在本轮看不到新增菜单、页面或 Agent 操作入口。产品价值体现在后续业务任务具备可复用、可限流、可取消、可审计且不会跨账号串扰的执行底座。

## 4. 目标与非目标

### 4.1 目标

1. 增加 server-internal `chatCompletionsRaw()`，完整透传 OpenAI-compatible Chat Completions 非流式协议；
2. 冻结单次 Agent 任务的解密模型配置快照，多轮请求始终使用同一 endpoint、model 和 key；
3. 建立进程级 `AgentCoordinator`，实现跨 Workspace round-robin、Workspace 内 FIFO、有界队列、去重、取消和 shutdown；
4. 建立静态 `BusinessAgentTaskSpec` 注册表和 Executor；
5. Agent 只能读取 Task Spec 生成的输入，不能接收浏览器自由 prompt、路径或 output file；
6. validator 通过后，使用 input revision CAS、SQLite transaction 和幂等账本 exactly-once apply；
7. 加强 OpenCode permission、文件边界、输出边界、进程资源与清理；
8. 用真实 Linux OpenCode binary 和受控 AI Provider 验证完整 tool-call 链；
9. 把 Agent activity 纳入 Workspace TTL 和优雅关闭；
10. 保持 Electron 行为与现有 Web Bid Analysis 回归。

### 4.2 NOT in scope

- 浏览器直接调用任何 Agent 方法；
- 首个正式生产 Agent Task Spec；
- WP-J 技术方案目录、全局事实或正文业务；
- WP-K 知识库、查重或废标 Agent 业务；
- Redis、持久化执行队列、多实例协调或跨进程恢复；
- Agent 任务在服务重启后续跑；重启后的正式策略仍是收口为可重试中断；
- Pi Runtime 的 Web 支持；
- streaming Chat Completions，除非真实 OpenCode `v1.17.8` 实测强制要求；
- Kubernetes、独立沙箱容器、network namespace、seccomp profile 和 cgroup 配额实现；
- 品牌清理、UI 结构或配色调整；
- 真实 MainQuest OAuth 联调。

## 5. 锁定架构

```text
server process
  |
  +-- GlobalAgentCoordinator
  |     global active <= 4
  |     global queued <= 32
  |     round-robin by workspace
  |
  +-- Workspace A Runtime
  |     BusinessAgentExecutor
  |       -> TaskSpecRegistry
  |       -> AgentResultCommitter
  |       -> WorkspaceMutationExecutor
  |       -> WebOpenCodeRunner
  |             -> Local AI Proxy
  |             -> aiRuntime.chatCompletionsRaw()
  |             -> real OpenCode process
  |
  +-- Workspace B Runtime
        same ports, isolated state and files
```

### 5.1 组件职责

| 组件 | 生命周期 | 职责 |
| --- | --- | --- |
| `GlobalAgentCoordinator` | Web 进程 | 公平调度、全局/账号上限、去重、取消、drain、状态快照 |
| `BusinessAgentTaskRegistry` | 进程静态只读 | 注册版本化 Task Spec；生产默认空 |
| `BusinessAgentExecutor` | Workspace | build input/prompt、调用 runner、validate、提交结果 |
| `WebOpenCodeRunner` | 单次 job | 创建目录、Proxy、配置、子进程、读取输出和清理 |
| `AgentOpenAiProxy` | 单次 job | 验证 token/body，调用 raw chat port，返回完整协议 |
| `AgentResultCommitter` | Workspace | revision CAS、transaction、幂等账本、一次性 apply |
| `WebAgentService` | Workspace adapter | 向服务端业务层暴露 `execute(taskSpecId, context, options)` 和 activity |

### 5.2 依赖约束

- Browser Bridge 不得引用 Executor；
- Task Spec 不得接收浏览器自由 prompt、路径、环境变量或 output file；
- Agent Runner 不持有业务 Store；
- Agent 进程不能直接连接 SQLite；
- validator 失败时不得调用 committer；
- committer 必须在 Workspace mutation executor 中运行；
- Coordinator slot 仅在子进程退出、Proxy 关闭和任务目录清理完成后释放；
- Workspace close 只取消并等待本账号任务；进程 Coordinator 在全部 Workspace 关闭后再关闭。

## 6. 核心契约

### 6.1 Business Agent Task Spec

```js
{
  id: 'contract-fixture',
  version: 1,
  runtime: 'opencode',
  capabilities: {
    read: ['input/**'],
    glob: true,
    grep: true,
    bash: false,
    network: false
  },
  limits: {
    timeoutMs: 120000,
    maxInputBytes: 1024 * 1024,
    maxOutputBytes: 256 * 1024,
    maxModelCalls: 4,
    maxTotalTokens: 32000
  },
  async captureSnapshot(snapshotReader) {},
  buildInput(readonlySnapshot) {},
  buildPrompt(readonlySnapshot) {},
  validateOutput(content, validationMetadata) {},
  applyResult(validated, commitTransaction) {}
}
```

约束：

- `id/version/runtime/capabilities/limits` 全部来自服务端受信任静态代码，禁止动态加载；
- 输出文件全局固定为 `result.json`，不允许 Task Spec 自定义；
- Spec 只允许位于固定目录，依赖扫描禁止导入 `fs`、SQLite、Store、Workspace Runtime、mutation executor 和 Web adapter；
- Spec 严格字段校验、未知字段拒绝、递归深冻结，重复 ID 或非法 version 启动失败；
- 每项 limit 使用 `min(specLimit, serverHardCeiling)`，超出 server ceiling 的 Spec 注册失败；
- `captureSnapshot()` 在短 transaction 中一次性读取 `inputRevision + 业务快照 + 输入 hash`；
- transaction 结束后只把冻结的 `readonlySnapshot` 交给 `buildInput()/buildPrompt()`；
- `buildInput()` 返回相对路径与 Buffer/string，不返回服务器绝对路径；
- 输入总字节数在落盘前校验；
- `buildPrompt()` 只使用服务端业务上下文；
- `validateOutput()` 只接收输出和不含 Store 能力的 metadata，返回纯结构化结果；
- `applyResult()` 只接收 Committer 在 transaction 内创建的受限 `commitTransaction`；
- Task Spec 模块不得获得 Workspace Runtime、原始 Store、SQLite 连接或 mutation executor；
- 上述边界属于受信任静态代码的可审计约束，不构成恶意 Node 模块沙箱；
- `contract-fixture` 只允许 `NODE_ENV=test` 的显式测试装配注册；
- 生产注册表为空，发现测试 Spec 或测试 Provider 时 fail closed。

受限端口：

```js
SnapshotReader = {
  getInputRevision(),
  readBinding(bindingId)
}

CommitTransaction = {
  assertInputRevision(expectedRevision),
  readAppliedExecution(executionId),
  applyDeclaredOperation(operationId, validatedPayload),
  recordAppliedExecution(applicationRecord)
}
```

- Task Spec 静态声明 `inputBindings[]` 和唯一 `commitOperationId`；
- `readBinding()` 只接受已声明 binding；
- `applyDeclaredOperation()` 只接受注册时绑定的业务写入操作；
- 两个端口都拒绝未知方法和未知 ID，不暴露通用 SQL、路径或任意 Store method；
- 依赖扫描和恶意 fixture 测试证明 Spec 不能通过受支持入口取得更高能力。

### 6.2 Agent Runtime Port

```js
{
  execute(taskSpecId, executionRequest),
  getActivitySnapshot(workspaceId),
  cancelWorkspace(workspaceId, reason),
  closeWorkspace(workspaceId),
  close()
}
```

`runTask(payload)` 从正式 Web Runtime port 中移除。若为 Electron 兼容保留，只能留在 Electron adapter，不得进入浏览器 Contract 或 Web server binding。

`executionRequest` 由外层 Portable Task Orchestrator 生成：

```js
{
  executionId,
  outerTaskId,
  workspaceId,
  taskSpecVersion,
  executionEnvelope,
  taskController: {
    persistExecutionEnvelope(envelope),
    reconcileAppliedExecution(receipt),
    projectAgentStage(event)
  }
}
```

- `executionId` 由外层任务创建时生成并随外层任务持久化，重试继续使用同一值；
- 外层任务在接受时持久化 `executionId/taskSpecId/specVersion/frozenRevision/inputHash`；
- `persistExecutionEnvelope()` 在任务 accepted 前写入不可变 envelope；
- `reconcileAppliedExecution()` 在 crash recovery 命中 ledger 后把外层任务收口为成功；
- `runId` 只标识一次进程尝试，用于日志、临时目录和诊断；
- 外层 Task Controller 是持久化状态和 SSE 的唯一权威；
- Agent Executor 返回 `AgentExecutionHandle`：

```js
{
  executionId,
  runId,
  getSnapshot(),
  subscribe(listener),
  cancel(ownerCancellationToken, reason),
  result
}
```

- `result` 只在 `succeeded/failed/cancelled` 终态结算；
- 只有创建 execution 的外层 Task Controller 持有 owner cancellation token；观察者不能取消共享 execution；
- 阶段事件仅供外层 Task Controller 投影，Executor 不直接写外层任务状态。

### 6.3 Raw Chat Port

```js
chatCompletionsRaw(request, {
  queueScopeId,
  signal,
  modelSnapshot
})
```

返回上游完整 JSON：

```js
{
  id,
  object,
  created,
  model,
  choices: [{
    index,
    message: {
      role,
      content,
      tool_calls
    },
    finish_reason
  }],
  usage
}
```

规则：

- `captureTextModelSnapshot()` 显式返回当前解密文本模型的不可变快照；
- raw request 允许字段从 `CHAT_BODY_FIELDS` 派生，但删除 `model`；
- 请求携带 `model/base_url/api_key/provider` 时返回 `AGENT_PROXY_BAD_REQUEST`；
- 上游请求的 model 强制使用 `modelSnapshot.modelName`；
- `modelSnapshot` 由当前 Workspace `aiRuntime` 在任务接受时生成；
- endpoint policy、manual redirect、重试、整体 deadline、响应体上限、取消和脱敏继续生效；
- raw port 与 `chat()/requestJson()` 共用底层请求函数；
- `chat()` 仍要求文本内容，现有调用和测试保持不变；
- raw port 不写入 Browser Bridge manifest。

### 6.4 模型快照

快照只存在内存：

```js
{
  provider,
  baseUrl,
  modelName,
  apiKey,
  capturedAt
}
```

- 任务进入 accepted 状态时冻结；
- queued 期间修改配置不影响已接受任务；
- 多轮请求使用同一快照；
- 任务结束后释放引用；
- 不落 SQLite、文件、普通日志和错误响应；
- 测试只能断言 hash/identity，不能打印 Key。

### 6.5 Agent 结果提交

幂等主键：

```text
workspaceId + executionId
```

`taskSpecId/specVersion/inputRevision/inputHash` 是该 execution 的不可变校验字段。使用相同 execution ID 提交不同 envelope 时返回 `AGENT_EXECUTION_CONFLICT`。

`AgentApplicationReceipt` 为有界返回凭据：

```js
{
  executionId,
  outputSha256,
  appliedAt,
  resultLocator
}
```

`resultLocator` 只保存业务状态定位信息，不保存 Agent 输出正文。

提交顺序固定：

```text
mutationExecutor.execute
  -> BEGIN IMMEDIATE
  -> 按 executionId 查询 agent_result_applications
  -> 已存在：校验 immutable envelope，返回 receipt，不重复 apply
  -> envelope 不一致：ROLLBACK / AGENT_EXECUTION_CONFLICT
  -> 再次读取 input revision
  -> revision 不一致：ROLLBACK / AGENT_INPUT_CHANGED
  -> taskSpec.applyResult()
  -> 写入 agent_result_applications
  -> COMMIT
  -> 返回 bounded receipt
  -> 外层 Task Controller 发布成功事件
```

`agent_result_applications` 至少包含：

- `idempotency_key` 主键；
- `execution_id`；
- `run_id`；
- `task_spec_id`；
- `task_spec_version`；
- `input_revision`；
- `input_sha256`；
- `output_sha256`；
- `result_locator_json`；
- `applied_at`。

`result_locator_json` 与业务结果、账本在同一 transaction 写入，上限 2 KiB，只允许稳定业务实体 ID、Store key 和版本号，不允许服务器绝对路径、正文或任意用户输入。`execution_id` 在当前 Workspace 数据库内唯一。重试和恢复必须先按 execution ID 查询账本，并从账本完整重建 `AgentApplicationReceipt`，再决定是否启动新 run。严禁把完整 Agent 输出写入幂等账本。

事务使用 better-sqlite3 immediate transaction。独立 crash test 在 COMMIT 后、外层状态确认前终止子进程，重新打开 SQLite 后执行 reconciliation，确认业务结果只应用一次。

## 7. 调度与状态机

### 7.1 固定上限

| 范围 | active | queued |
| --- | ---: | ---: |
| 每 Workspace | 1 | 2 |
| Web 进程 | 4 | 32 |

环境变量只能调低：

- `WEB_AGENT_GLOBAL_ACTIVE_LIMIT`
- `WEB_AGENT_GLOBAL_QUEUE_LIMIT`
- `WEB_AGENT_WORKSPACE_QUEUE_LIMIT`

提高默认值需要独立容量验证。

### 7.2 状态

```text
reserved -> admitting -> queued -> running -> validating -> applying -> cleanup -> succeeded
    |          |           |         |           |            |          |
    |          |           |         |           |            |          +-> cleanup_failed
    |          |           |         |           |            +-> apply_failed
    |          |           |         |           +-> output_invalid
    |          |           |         +-> timeout / cancelled / runtime_failed
    |          |           +-> queue_overloaded / cancelled
    +-> queue_overloaded
```

稳定规则：

- Workspace 间 round-robin；
- Workspace 内 FIFO；
- Coordinator 只按 `workspaceId + executionId` 去重；
- 相同 execution 的 `taskSpecId/specVersion/inputRevision/inputHash` 必须完全一致，否则返回 `AGENT_EXECUTION_CONFLICT`；
- 不同 execution 即使输入相同也创建独立 job；外层业务任务决定是否复用 execution；
- 成功或失败终态不做进程内永久缓存；
- queued 取消立即移除；
- running 取消发送 `SIGTERM`，2 秒后 `SIGKILL`，等待进程退出与清理；
- cleanup 失败返回 `AGENT_CLEANUP_FAILED` 并保留可重试关闭状态；
- queue 满返回 `AGENT_QUEUE_OVERLOADED`、`retryable=true`、`retryAfterSeconds=5`；
- 单个 waiter 取消不能取消共享 execution；只有外层 Task Controller、Workspace close 或 process shutdown 可以取消 execution；
- `deadlineAt` 从首次 `execute()` 开始，覆盖 reservation、admission、排队、运行、验证、提交与清理；
- Coordinator reservation、队列和 active 统一有界。

### 7.3 接受点

任务只有完成以下步骤后才算 accepted：

1. 校验 execution request 与 Task Spec；
2. 在 reservation、模型快照和 OpenCode 启动前，先按 `workspaceId + executionId` 查询 ledger；
3. 命中相同 envelope 的成功 receipt 时，调用 `reconcileAppliedExecution()` 并返回 completed handle；
4. Coordinator 按 `workspaceId + executionId` 预留有界 reservation；
5. 在短 transaction 中冻结 `input revision + readonly snapshot + input hash`；
6. 调用 `persistExecutionEnvelope()` 持久化不可变 envelope；
7. 使用冻结快照完成 buildInput/buildPrompt；
8. 输入大小和路径全部通过；
9. 模型快照已冻结；
10. reservation 转为 queued/running job。

接受点前失败不能留下 running/queued 状态、临时目录或幂等账本。

如果业务输入在快照 transaction 结束后、Coordinator 登记前发生变化，任务可以进入队列，但 apply 前 CAS 必须以冻结 revision 拒绝旧结果。不得重新读取新 revision 后继续使用旧快照。

### 7.4 取消与提交线性化

- `queued/running/validating` 阶段取消必须阻止进入 commit transaction；
- `applying` 以 transaction 开始作为线性化点；
- transaction 开始前已观察到取消：返回 `AGENT_CANCELLED`，零业务写入；
- transaction 已开始：Workspace close/server shutdown 等待原子提交完成，不再把该 execution 标记为 cancelled；
- transaction 成功后，外层 Task Controller 必须记录 succeeded；进程在外层确认前异常时，恢复/重试使用同一 `executionId` 查询幂等账本；
- transaction 失败后返回 `AGENT_APPLY_FAILED`，外层任务进入可重试错误；
- `validating -> applying`、`workspace close -> applying`、`server shutdown -> applying` 必须有确定性竞争测试。

### 7.5 Shutdown 顺序与预算

1. HTTP/SSE `beginDraining()`；
2. `agentCoordinator.beginClosing()` 同步拒绝新 reservation；
3. 主 HTTP server 停止接收并关闭 SSE；
4. Workspace 分别取消 queued/running，并等待 validating/applying/cleanup；
5. `agentCoordinator.close()` 等待所有 reservation、slot 和 cleanup 清零；
6. 进程退出。

默认总预算 30 秒，其中 `SIGTERM -> SIGKILL` grace 2 秒，单 job cleanup deadline 5 秒。重复 SIGTERM/SIGINT 复用同一 shutdown Promise。

`beginClosing()` 与 `closeWorkspace(workspaceId)` 的原子语义：

- 拒绝对应范围的新 reservation；
- 取消现存 reserved/admitting/queued；
- 向 running/validating 发送取消信号；
- 已越过 apply linearization point 的任务允许完成；
- 等待 apply 与 cleanup 收敛；
- 调用后禁止任何 reserved/admitting job 转入 queued；
- admission 回调晚到时只执行资源释放，不继续任务。

## 8. OpenCode 与文件安全

### 8.1 任务目录

```text
workspace/.agent-tasks/<runId>/
  work/                  # OpenCode --dir，只含工具可见内容
    input/               # 生成后 chmod 0555/0444
    result.json          # 唯一声明输出
    AGENT_INSTRUCTIONS.md
  runtime/               # config/home/cache/tmp，位于工作目录外
```

- `runId` 仅服务端 UUID；
- 创建根目录后校验 realpath 位于当前 Workspace；
- OpenCode `--dir` 固定为 `work/`，config/home/cache/tmp 全部位于其外部；
- 输入路径必须是规范化 POSIX 相对路径，且只能位于 `input/`；
- 拒绝绝对路径、空路径、`.`、`..`、保留配置名、重复路径和大小写冲突；
- 输入写完后再切换为只读 mode；
- 不复制兄弟 Workspace 文件，不接受 file ID 或绝对路径作为 Runner 参数；
- finally 中清理整个 run 目录，失败时记录稳定结果码和脱敏统计。

OpenCode 官方权限规则中，`glob` 按 pattern、`grep` 按 regex 匹配，`external_directory` 只处理工作目录外路径。I-2 依靠独立 `work/` 缩小工具可见面，不能把 `read: input/**` 单独当作 glob/grep 隔离证据。参考：[OpenCode Permissions](https://opencode.ai/docs/permissions)。

### 8.2 OpenCode permission

默认：

```js
{
  '*': 'deny',
  read: {
    '*': 'deny',
    'input/**': 'allow',
    'AGENT_INSTRUCTIONS.md': 'allow'
  },
  glob: 'allow',
  grep: 'allow',
  edit: {
    '*': 'deny',
    'result.json': 'allow'
  },
  bash: 'deny',
  webfetch: 'deny',
  websearch: 'deny',
  task: 'deny',
  skill: 'deny',
  lsp: 'deny',
  question: 'deny',
  external_directory: 'deny'
}
```

测试必须读取真实生成配置，并用真实 OpenCode 请求中的 tool schema 驱动受控 Provider，不能硬编码 OpenCode 内部工具名。

### 8.3 输出读取

固定流程：

1. `lstat`；
2. 必须为普通文件、`nlink === 1`；
3. `realpath` 必须等于声明输出路径且位于任务根；
4. 使用 `O_RDONLY | O_NOFOLLOW` 打开；
5. 第一次 `fstat` 比较 `dev/ino/nlink/size/mtime/ctime`；
6. 流式读取并执行字节上限；
7. 第二次 `fstat`，确认读取期间元数据未变化；
8. 再次 `lstat` 声明路径并核对 inode；
9. 计算 SHA-256；
10. 关闭 fd 后进入 validator。

进入读取前必须确认整个 OpenCode 进程组已退出。读取后扫描 `work/`，只允许固定清单 `input/`、`AGENT_INSTRUCTIONS.md`、`result.json`；发现额外文件返回 `AGENT_OUTPUT_UNDECLARED`。

以下情况全部拒绝：

- symlink；
- hard-link；
- FIFO/socket/device；
- 输出超限；
- 输出在读取前后被替换；
- 未声明的业务输出文件；
- 空输出；
- validator 不通过。

### 8.4 子进程资源

Docker 显式安装并验证 `prlimit`。I-2 默认值与 Server hard ceiling 固定如下，Task Spec 只能继续调低。真实 OpenCode smoke 若无法通过，必须先修订本 Spec 和风险说明，再调整数值：

| 资源 | 建议上限 |
| --- | ---: |
| address space | 1536 MiB |
| output file size | 4 MiB |
| open files | 256 |
| processes | 128 |
| CPU time | 630 秒 |
| wall clock | 600 秒 |
| stdout ring buffer | 2 MiB |
| stderr ring buffer | 64 KiB |
| model calls | 8 |
| total tokens | 64000 |

实现要求：

- Linux Web Runtime 通过 `prlimit -- ...opencode` 启动；
- `prlimit` 缺失时 readiness/self-check 失败；
- 上限只能由服务端配置调低；
- wall clock 到期后终止整个进程组；
- slot 在子进程组确认退出后释放；
- 当前同 UID `RLIMIT_NPROC` 的局限写入文档，不能描述为 cgroup/PID namespace 隔离。
- 每轮模型调用前递增 call count；usage 存在时累计 token，超过上限取消任务；
- usage 缺失时仍由 `maxModelCalls` 阻断无限循环。

## 9. AI Proxy 协议

### 9.1 请求

- 只监听 `127.0.0.1` 随机端口；
- 每 job 生成随机 bearer token；
- 只接受 `POST /v1/chat/completions`；
- 请求体上限 2 MiB；
- JSON 无效、token 错误、路径错误和重复关闭返回稳定错误；
- 仅转发白名单采样字段、messages、tools、tool_choice 和 parallel_tool_calls；
- 不接受客户端指定真实 model/key/base URL。

### 9.2 响应

- 返回 raw Chat Completions JSON；
- 保留 `message.tool_calls`、`finish_reason` 和 `usage`；
- 上游错误转换为兼容 error object，正文与 URL 脱敏；
- 本轮优先支持非流式；
- 未实现 streaming 时，收到 `stream=true` 固定返回 `AGENT_PROTOCOL_UNSUPPORTED`；
- 如果真实 OpenCode 强制发送 `stream=true`，先记录实测协议，再实施有界 SSE 透传和断线取消；不得删除 stream 字段后伪造成功。

### 9.3 受控 Provider

测试 Provider：

1. 读取真实 OpenCode 首轮请求中的 `tools`；
2. 选择允许写入 `result.json` 的工具与实际 schema；
3. 返回确定性 tool call；
4. 接收 OpenCode 第二轮工具结果；
5. 返回最终 assistant completion；
6. 记录轮次数、tool_call ID 和字段存在性，不记录输入正文和 Key。

只允许 `NODE_ENV=test` 显式注入；生产装配发现测试 Provider 立即失败。

## 10. 错误契约

| Code | 场景 | retryable |
| --- | --- | --- |
| `AGENT_TASK_SPEC_NOT_FOUND` | 未注册 Task Spec | false |
| `AGENT_TASK_SPEC_INVALID` | Spec/version/capability 非法 | false |
| `AGENT_EXECUTION_CONFLICT` | 相同 execution 的冻结 envelope 不一致 | false |
| `AGENT_INPUT_INVALID` | 输入路径、类型或内容非法 | false |
| `AGENT_INPUT_TOO_LARGE` | 输入总量超限 | false |
| `AGENT_INPUT_CHANGED` | apply 前 revision 变化 | true |
| `AGENT_QUEUE_OVERLOADED` | Workspace 或全局队列满 | true |
| `AGENT_CANCELLED` | admitting/queued/running 被取消 | true |
| `AGENT_TIMEOUT` | wall clock 超时 | true |
| `AGENT_RUNTIME_UNAVAILABLE` | binary/prlimit 不可用 | true |
| `AGENT_RUNTIME_FAILED` | OpenCode 非零退出 | true |
| `AGENT_PROXY_BAD_REQUEST` | Proxy 请求非法 | false |
| `AGENT_PROXY_UPSTREAM_FAILED` | AI 上游失败 | true |
| `AGENT_PROTOCOL_UNSUPPORTED` | OpenCode 请求需要尚未实现的协议模式 | false |
| `AGENT_MODEL_CALL_LIMIT` | 模型调用次数或 token 上限 | false |
| `AGENT_OUTPUT_MISSING` | 未生成声明输出 | true |
| `AGENT_OUTPUT_INVALID` | validator 不通过 | true |
| `AGENT_OUTPUT_TOO_LARGE` | 输出超过 Spec 上限 | false |
| `AGENT_OUTPUT_UNSAFE` | symlink/hard-link/非普通文件/替换竞争 | false |
| `AGENT_OUTPUT_UNDECLARED` | 工作目录出现未声明输出 | false |
| `AGENT_APPLY_FAILED` | transaction 写回失败 | true |
| `AGENT_CLEANUP_FAILED` | 子进程、Proxy 或目录清理失败 | true |
| `AGENT_CLOSING` | Workspace/进程正在关闭 | true |
| `AGENT_SHUTDOWN_TIMEOUT` | shutdown 超出总预算 | true |

错误响应和日志不得包含：

- API Key、Authorization、Proxy token；
- Base URL 完整值；
- Prompt、tool arguments、文件正文和完整模型响应；
- server absolute path；
- email、MainQuest subject 或 Workspace ID 原值。

Executor 边界统一取消语义：Runner、AbortSignal 和历史实现产生的 `AGENT_ABORTED` 全部转换为 `AGENT_CANCELLED`。`AGENT_ABORTED` 不得暴露给 `AgentExecutionHandle`、外层 Task Controller、SSE 或调用方。

## 11. 数据与恢复

### 11.1 持久化

I-2 只新增 `agent_result_applications` 幂等账本。queued/running job 仍为进程内状态，因为生产 Task Spec 注册表为空，本轮没有用户可触发的正式 Agent 任务。`executionId/taskSpecId/specVersion/frozenRevision/inputHash` 由未来外层 Portable Task Orchestrator 作为 execution envelope 持久化；test-only fixture 使用持久化测试外层任务记录验证 crash window。

### 11.2 重启

- 进程重启后不恢复 Agent job；
- 测试 Fixture 不留下业务 running 状态；
- 后续正式业务 Task Spec 必须由其外层 Portable Task Orchestrator 负责把中断收口为可重试错误；
- 幂等账本保留，防止同一 execution 在新 run 中重复应用；
- 重试和恢复先按 `executionId` 查账本；找到成功账本时直接 reconciliation 外层状态，不重新执行 OpenCode；
- 必须覆盖“业务结果与账本已提交、外层任务尚未确认即重启”的窗口，恢复后以同一 `executionId` 查询到已应用结果并收口成功。

### 11.3 Workspace TTL

activity snapshot 新增：

```js
{
  agentReservedCount,
  agentAdmittingCount,
  agentActiveCount,
  agentQueuedCount,
  agentCleanupCount
}
```

任一值大于 0 时，Workspace 不得被 TTL sweep 回收。无法读取 Coordinator 状态时按 active 处理。

统一活跃条件覆盖 `reserved/admitting/queued/running/validating/applying/cleanup`。reservation/admission/overload 失败时必须释放模型快照和所有临时引用。

## 12. 实施工作包

### I2-A：契约与失败测试先行

写入范围：

- `client/core/aiRuntime.cjs`
- `client/server/agent/`
- `client/scripts/test-web-agent-*.cjs`
- `client/shared/bridgeContract.cjs`

动作：

- 冻结 Task Spec、Raw Chat、Coordinator、错误码和 activity DTO；
- 建立当前 `scopedAi.chat()` 丢 tool calls 的失败测试；
- 建立浏览器 Agent 全部 pending 的严格守卫；
- 建立生产注册表为空和测试装配 fail-closed 测试。

Gate：

- 测试能够先证明当前实现缺口；
- 不修改 Renderer UI；
- Contract 中无 Agent implemented 方法。

### I2-B：Raw Chat Port 与模型快照

写入范围：

- `client/core/aiRuntime.cjs`
- `client/scripts/test-web-ai-runtime.cjs`
- `client/server/agent/agentOpenAiProxy.cjs`

动作：

- 抽取底层 raw request；
- 增加 `chatCompletionsRaw()`；
- 增加模型配置快照；
- Proxy 完整转发 tool-call；
- 保持 `chat()/requestJson()` 行为。

Gate：

- 原 AI tests 全绿；
- tool calls、finish reason、usage 和多轮 messages 不丢失；
- queued 后配置变化不影响当前 Agent job；
- cancel/deadline/response size/endpoint policy 全部继续生效。

### I2-C：进程级 Agent Coordinator

写入范围：

- `client/server/agent/agentCoordinator.cjs`
- `client/server/agent/globalAgentCoordinator.cjs`
- `client/server/workspace/workspaceContext.cjs`
- `client/server/workspace/workspaceRegistry.cjs`
- `client/server/index.cjs`

动作：

- 实现 round-robin/FIFO、有界队列和去重；
- 实现 queued/running cancel；
- 实现 workspace close 与 process close；
- 注入 Workspace Agent Service；
- 纳入 TTL snapshot 和 server shutdown。

Gate：

- 每 Workspace active=1/queued=2；
- global active=4/queued=32；
- 单账号不能长期占满全局 slot；
- close race、queue cancel、shutdown 和 slot 释放测试通过。

### I2-D：Task Registry、Executor 与安全提交

写入范围：

- `client/server/agent/businessAgentTaskRegistry.cjs`
- `client/server/agent/businessAgentExecutor.cjs`
- `client/server/agent/agentResultCommitter.cjs`
- `client/core/sqliteDatabase.cjs`
- `sql/workspace_schema.sql`
- `client/server/workspace/workspaceRuntimeFactory.cjs`

动作：

- 建立静态、冻结、版本化注册表；
- 生产默认空；
- 建立 buildInput/buildPrompt/validate/apply 流程；
- 增加 `agent_result_applications`；
- CAS + transaction + idempotency；
- Store write failure 可靠 rollback。
- 增加 runtime schema 与 `sql/workspace_schema.sql` 的版本、表、索引、唯一约束 parity gate。

Gate：

- validator 失败零业务写入；
- revision 变化返回 `AGENT_INPUT_CHANGED`；
- 同一幂等键 apply 一次；
- 同一 `executionId` 以新 `runId` 重试仍只 apply 一次；
- commit 成功、外层状态确认前模拟崩溃，恢复后不重复 apply；
- transaction 失败无部分结果和成功事件。

### I2-E：OpenCode Runner 与资源门禁

写入范围：

- `client/server/agent/webOpenCodeRunner.cjs`
- `client/server/agent/openCodeTaskWorkspace.cjs`
- `client/server/agent/webAgentService.cjs`
- `Dockerfile`
- readiness/self-check 相关文件

动作：

- 从现有 Service 抽取 Proxy、Runner 和 Workspace 文件逻辑；
- 收紧 permission；
- 输入只读 mode；
- 安全输出读取；
- `prlimit`；
- 有界 ring buffer；
- 进程组终止与清理；
- readiness 检查 binary、prlimit 和配置。

Gate：

- fake binary 边界测试全绿；
- symlink/hard-link/FIFO/替换竞争/超限全部拒绝；
- timeout/cancel/shutdown 后无子进程、Proxy 和目录泄漏；
- 应用级权限与 OS 级隔离口径分开。

### I2-F：真实 OpenCode E2E、CI 与文档

写入范围：

- `client/scripts/test-web-agent-protocol.cjs`
- `client/scripts/test-web-agent-coordinator.cjs`
- `client/scripts/test-web-agent-executor.cjs`
- `client/package.json`
- `.github/workflows/ci.yml`
- `Dockerfile`
- `project.md`
- `README.md`
- `AGENTS.md`
- `client/开发说明.md`
- `docs/web-v1-incomplete-items.md`

动作：

- test-only `contract-fixture`；
- 受控 AI Provider；
- 建立独立 Docker `agent-e2e` target，包含 fixture/provider/harness；
- 最终 runtime target 不复制 fixture/provider/harness；
- 真实 OpenCode tool-call 两轮 E2E；
- 敏感信息扫描；
- 完整 CI；
- 同步事实口径。

Gate：

- 真实 binary 执行允许工具并生成唯一结果；
- validator、CAS、transaction、exactly-once apply 全链通过；
- 双 Workspace 并发、过载、取消、close 和 shutdown 通过；
- 浏览器 Agent 入口仍 pending；
- 文档明确生产注册表为空、OS 隔离待后续 Release Gate。
- Agent Foundation 独立 CI job 纳入最终 `quality_gate`。

## 13. 开发顺序与并行边界

正式实施顺序：

```text
I2-A
  -> I2-B
  -> I2-C
  -> I2-D
  -> I2-E
  -> I2-F
```

允许的有限并行：

- I2-B 契约冻结后，I2-C 可与 I2-D 并行；
- I2-C 只写 Coordinator/生命周期；
- I2-D 只写 Registry/Executor/Committer/SQLite；
- `workspaceRuntimeFactory.cjs`、`package.json`、CI、Dockerfile 由集成主线程统一修改；
- I2-E 依赖 I2-B 的 Proxy 契约与 I2-C 的取消/slot 契约；
- I2-F 最后串行集成。

每个 worker 使用独立 worktree，Subagent 不 commit/push。主线程检查 diff 后提交。

## 14. 测试路径图

```text
Raw Chat
  ├─ text response -> existing chat contract
  ├─ tool_call -> raw response preserved
  ├─ second round -> tool result preserved
  ├─ config changed -> frozen snapshot unchanged
  └─ timeout/abort/oversize/SSRF -> existing safety errors

Coordinator
  ├─ reservation -> admission bounded
  ├─ one workspace -> FIFO / active 1
  ├─ two workspaces -> round-robin
  ├─ same execution/same envelope -> same job
  ├─ same execution/different envelope -> conflict
  ├─ different execution/same input -> separate jobs
  ├─ per-workspace queue full -> overload
  ├─ global queue full -> overload
  ├─ queued cancel -> immediate remove
  ├─ running cancel -> process tree exit then slot release
  └─ shutdown -> reject new / drain all

Executor
  ├─ unknown spec -> reject
  ├─ invalid input -> no accepted job
  ├─ output invalid -> no apply
  ├─ input revision changed -> CAS reject
  ├─ snapshot/accept race -> old snapshot cannot commit
  ├─ Store failure -> rollback
  ├─ same execution/new run -> exactly once
  ├─ commit/crash/outer retry -> ledger closes success
  └─ success -> ledger + business result in one transaction

OpenCode
  ├─ real binary -> real tool schema
  ├─ controlled provider -> deterministic tool call
  ├─ unique result -> validator pass
  ├─ extra output -> reject
  ├─ symlink/hard-link/non-regular -> reject
  ├─ output too large -> reject and cleanup
  ├─ timeout/cancel -> kill process group
  └─ logs/errors -> no secret/path/content leakage

Capability Surface
  ├─ Web contract -> all agent methods pending
  ├─ Web dispatchers -> no agent binding
  ├─ production registry -> empty
  └─ test fixture/provider -> NODE_ENV=test only
```

## 15. 具体测试清单

### 15.1 单元与集成

- raw chat 保留 `tools/tool_choice/parallel_tool_calls/tool_calls/finish_reason/usage`；
- `chat()` 对纯文本响应保持原返回；
- raw chat 不允许覆盖真实 Key/URL；
- raw chat 请求中的 model 被拒绝，上游 model 只来自冻结快照；
- 模型快照在 queued、running 和多轮期间稳定；
- 所有终态释放模型快照引用；
- 一致性 snapshot 后输入变化，旧结果不能写入新 revision；
- Coordinator round-robin、FIFO、去重和固定上限；
- reservation/admission 也受 Workspace/global 上限与整体 deadline 约束；
- 同 execution 新 run、不同 execution 相同输入、单 waiter 取消；
- reservation 阻塞期间 TTL 不回收 Workspace；
- shutdown 发生在 admission 阻塞期间；
- Workspace close 发生在 reserved 阶段；
- beginClosing 后 admission 回调返回时 job 不能进入 queued；
- queue cancel 与 workspace close 并发；
- workspace close 不影响兄弟账号；
- process close 等待所有 cleanup；
- TTL 不回收 queued/running Agent Workspace；
- Task Spec 注册、冻结、版本冲突和生产空注册表；
- 输入路径、重复、大小写冲突、总大小和保留名；
- validator error；
- CAS conflict；
- transaction rollback；
- idempotency duplicate；
- stable execution ID 跨 run 重试；
- commit 后、外层状态确认前的 crash window；
- crash recovery 命中 receipt 后不再次调用模型、不再次 apply，并调用外层 reconcile；
- 重新打开 SQLite 后可从账本重建完整 receipt，`resultLocator` 与业务结果一致；
- validating/applying/cancel、workspace close/applying 与 shutdown/applying 竞争；
- validator 与 build 阶段无法取得 Store/mutation/SQLite 能力；
- output missing/empty/oversize；
- symlink、hard-link、FIFO、socket/device；
- inode 替换竞争；
- 同 inode 并发写、路径读取后替换、残留孙进程和额外输出；
- stdout/stderr ring buffer；
- prlimit 缺失与超限；
- Proxy token、body、JSON 和路径错误；
- 日志与错误敏感信息扫描。
- queued cancel、running cancel、Workspace close 和 process shutdown 均只暴露 `AGENT_CANCELLED`；
- Task Spec 未知字段、server ceiling、依赖扫描和恶意 fixture；
- schema version/table/index/unique parity；
- Coordinator 随机化调度、1000 job 完成后句柄/Map/队列泄漏；

### 15.2 真实 Docker E2E

```text
build agent-e2e target
  -> verify OpenCode checksum
  -> NODE_ENV=test 启动内部 test harness
  -> 注册 contract-fixture
  -> 启动 controlled AI provider
  -> real OpenCode 首轮请求 tools
  -> provider 返回实际 schema tool_call
  -> OpenCode 写 result.json
  -> real second round completion
  -> validator PASS
  -> CAS + transaction apply
  -> 第二次同幂等键不重复 apply
  -> task dir / proxy / child process 全部清理
  -> inspect final runtime target: fixture/provider/harness absent
```

必须同时运行负向 Docker case：

- invalid checksum build fail closed；
- production 模式注册 fixture/provider fail closed；
- output too large；
- timeout；
- sibling Workspace input attempt；
- symlink/hard-link；
- queue overload；
- shutdown during running job。
- model call/token limit；
- glob/grep 尝试读取 runtime 目录；
- input 写入、额外输出、bash/web/task/skill；
- 同 inode TOCTOU 与残留孙进程；
- 独立子进程 COMMIT crash/reopen reconciliation；
- shutdown/apply 竞争和敏感 canary 扫描；
- Linux x64 与 arm64 binary/checksum 构建门禁。

### 15.3 回归门禁

```bash
cd client
npm run build
npm run test:web-agent-protocol
npm run test:web-agent-coordinator
npm run test:web-agent-executor
npm run test:web
npm run test:web-browser
npm run smoke:electron-native
npm run audit:production
```

仓库根：

```bash
docker build -t bidding-copilot-web:i2 .
git diff --check origin/main...HEAD
```

## 16. 失败模式与救援

| 失败模式 | 用户/系统表现 | 检测 | 救援 |
| --- | --- | --- | --- |
| OpenCode 改为强制 stream | 真实协议 E2E 失败 | 记录真实请求 `stream` 字段 | 增加有界 SSE 透传后再合入 |
| `prlimit` 参数导致 OpenCode 无法启动 | self-check/runtime failed | 真实 Docker smoke | 校准默认上限，不允许绕过资源门禁 |
| Coordinator slot 提前释放 | 全局 active 超限、僵尸进程 | cancel/timeout race test | slot 绑定 cleanup Promise |
| Workspace TTL 回收运行任务 | Agent 中断或 Store 关闭 | activity/TTL race test | 未知状态按 active，补 snapshot |
| 配置变化污染多轮任务 | 同一 job 跨模型/Key | snapshot identity test | accepted 时冻结，结束后释放 |
| validator 后写入部分成功 | 数据不一致 | transaction fault injection | apply 与 ledger 同 transaction |
| 重复请求重复写业务结果 | 重复内容或覆盖 | stable execution ID/idempotency test | 唯一主键 + 事务内查询 |
| commit 后外层未确认即崩溃 | 重试生成新 run 后重复 apply | crash-window test | 外层持久化 execution ID + 幂等账本 |
| 快照与 revision 错配 | 旧输入结果污染新状态 | snapshot/accept race test | 短事务冻结 revision、快照和 hash |
| close 与 apply 竞争 | 数据已提交但外层显示取消 | linearization race tests | transaction 开始作为取消线性化点 |
| 输出文件被替换 | 读取越界或非预期内容 | inode race fixture | `O_NOFOLLOW + lstat/fstat` |
| 测试 Fixture 进入生产 | 暴露内部执行面 | production startup negative | 生产 registry 强制为空 |
| 错误泄露正文/Key/路径 | 安全与隐私事故 | sensitive scan | 稳定错误码与脱敏日志 |

## 17. 可观测性

仅记录：

- `runId` 的不可逆短 hash；
- Task Spec ID/version；
- Workspace ID 的不可逆短 hash；
- queued/running/validating/applying/cleanup 阶段；
- 等待时间、执行时间、输出字节数、清理字节数；
- 结果码、重试属性；
- active/queued 聚合数。

禁止记录 Prompt、tool arguments、模型完整响应、文件正文、API Key、Proxy token、Base URL、服务器绝对路径和用户身份原值。

## 18. 回滚

- Raw Chat Port 为新增 server-internal 方法，可独立回滚，原 `chat()/requestJson()` 保持；
- Coordinator 与 Executor 只有内部测试 Fixture 使用，回滚不会影响当前 Web Bid Analysis；
- schema migration 只新增幂等表，不删除旧字段；
- 若真实 OpenCode 协议门禁失败，PR 保持未合并状态，不通过恢复自由 `agent.run` 降级；
- 回滚后浏览器 Agent 仍为 pending；
- 不删除 I-1 已合入的 Task Orchestrator、CAS 和 Bid Analysis。

## 19. 完成 Gate

以下条件全部满足，I-2 才能标记完成：

1. PR 基于 `main@cadbf24` 或其后续 fast-forward 基线；
2. raw Chat Port 完整保留真实 OpenCode 所需 tool-call 协议；
3. 多轮任务使用冻结模型快照；
4. Coordinator 公平性、上限、去重、取消、close 和 shutdown 通过；
5. Workspace TTL 识别 reserved/admitting/queued/running/validating/applying/cleanup；
6. Task Spec 注册表静态、版本化、生产为空；
7. validator 前无业务写，CAS/transaction/idempotency exactly-once apply；
8. 稳定 `executionId` 跨 run 重试和 commit crash window 通过；
9. 取消与 applying 的线性化竞争测试通过；
10. 输出普通文件、symlink/hard-link、inode、大小和未声明输出门禁通过；
11. `prlimit` 与有界 stdout/stderr 生效；
12. 模型调用次数和 token server ceiling 生效；
13. 真实 OpenCode + 受控 Provider + contract fixture 完成两轮 tool-call；
14. 独立 `agent-e2e` image 包含测试 harness，最终 runtime image 明确不包含；
15. 子进程、Proxy、任务目录和队列在成功、失败、取消、超时、关闭后全部清理；
16. 双 Workspace 隔离、公平性、随机压力和 1000 job 泄漏测试通过；
17. runtime migration 与设计 SQL schema parity 通过；
18. Web 所有 Agent 方法继续 `pending`，Web dispatchers 无 Agent binding；
19. production 模式无法注册 test fixture/provider；
20. Linux x64/arm64 binary checksum 与 Docker 门禁通过；
21. 完整 Web、Chromium、Electron、Docker、OAuth startup 和 audit 门禁全绿；
22. 项目文档只声明 Agent Foundation 完成，并保留 OS 级隔离 Release Gate；
23. 品牌清理继续冻结。

## 20. 实施任务

- [ ] **T1 / P1 — Raw Chat Contract**：补失败测试并实现完整 Chat Completions raw port。
- [ ] **T2 / P1 — Model Snapshot**：accepted 时冻结解密模型配置，多轮一致。
- [ ] **T3 / P1 — Agent Coordinator**：round-robin、FIFO、上限、去重、取消和 shutdown。
- [ ] **T4 / P1 — Workspace Lifecycle**：Agent activity、TTL、closeWorkspace 与进程 close 顺序。
- [ ] **T5 / P1 — Task Spec Registry**：静态版本化注册表、能力受限 hook 参数，生产空、测试显式注入。
- [ ] **T6 / P1 — Business Agent Executor**：build、run、validate、apply 生命周期。
- [ ] **T7 / P1 — Result Committer**：稳定 execution ID、revision CAS、SQLite transaction、幂等账本和 crash window。
- [ ] **T8 / P1 — OpenCode Workspace**：只读输入、唯一输出、permission 和路径边界。
- [ ] **T9 / P1 — Safe Output Reader**：普通文件、link、inode、流式上限和 hash。
- [ ] **T10 / P1 — Process Limits**：prlimit、ring buffer、进程组终止和 cleanup。
- [ ] **T11 / P1 — Real Protocol E2E**：controlled provider + real OpenCode + contract fixture。
- [ ] **T12 / P1 — Security Negative Tests**：跨账号、输出攻击、测试装配生产拒绝和敏感扫描。
- [ ] **T13 / P1 — CI Integration**：Web、Docker、Electron、OAuth、audit 完整门禁。
- [ ] **T14 / P2 — Documentation**：同步项目事实、未完成项和 OS 隔离边界。
- [ ] **T15 / P1 — Formal Review**：工程复审关闭全部阻断后再提正式 PR。

## 21. 已继承且不重新讨论的决策

1. I-2 在 I-1 合并后实施，当前前置已满足；
2. Agent Coordinator 为进程级单例，Workspace 只持有本账号 lease/取消/状态；
3. Single Node v1 使用内存有界队列；
4. raw Chat Port 只供服务端 Agent Executor；
5. 模型配置在任务接受时冻结；
6. Agent 结果使用 CAS、transaction 和幂等键；
7. test-only `contract-fixture` 验证完整链；
8. 生产 Task Spec 注册表本轮为空；
9. 浏览器 Agent 全部保持 pending；
10. OS 级 Agent 隔离是首个正式业务 Task Spec 的独立前置 Gate；
11. 后续工程决策默认采用推荐方案，重大产品范围或安全边界变化需单独确认。

## 22. 规划审查待办

- [x] 对照 `main@cadbf24` 做正式 Scope Review；
- [x] 独立工程 reviewer 检查 Coordinator、CAS、文件 TOCTOU 和 shutdown；
- [x] 独立安全 reviewer 检查 permission 与 OS 隔离口径；
- [x] 将审查结论写入本文件；
- [x] 生成独立测试计划；
- [x] 规划文档达到可提交状态。

## 23. 工程复审结论

### 23.1 范围复审

- P0：0；
- 初审 P1：4，全部关闭；
- P2：0；
- 结论：I-2 保持 Foundation 范围，无需拆 PR；
- 浏览器 Agent 继续 pending；
- 生产 Task Spec 注册表继续为空；
- OS 级隔离继续作为首个正式 Agent 业务任务的独立 Release Gate。

关闭项：

1. 一致性快照先于 buildInput/buildPrompt；
2. stable execution ID 取代随机 run ID 作为幂等身份；
3. 冻结 `AgentExecutionHandle` 与取消/apply 线性化；
4. Task Spec 各阶段使用能力受限端口。

### 23.2 工程与安全复审

- P0：0；
- 初审 P1：9，全部关闭；
- 初审 P2：3，全部关闭；
- 第一轮定向复审剩余 P1：3、P2：1，全部关闭；
- 第二轮定向复审剩余 P1：1，已通过同事务持久化 `result_locator_json` 关闭；
- 最终定向复审：`PASS`。

关键返修：

1. raw chat 请求不能覆盖冻结模型；
2. Coordinator 先 reservation，再 admission，完整 deadline 覆盖全部阶段；
3. `workspaceId + executionId` 唯一，ledger 查询先于 revision CAS；
4. receipt 可从 SQLite 账本完整重建；
5. reserved/admitting 纳入 TTL 与 close；
6. `beginClosing()` 原子取消未进入 apply 的任务；
7. Task Spec 静态可信、依赖扫描、字段深冻结、server ceiling；
8. OpenCode `work/` 与 runtime 目录分离；
9. 输出读取前后双 fstat、路径复核和额外文件扫描；
10. `prlimit`、模型调用次数、token 和日志 ring buffer 上限；
11. 独立 Agent E2E Docker target，最终 runtime image 不携带测试 harness；
12. schema parity、随机压力、1000 job 和 ARM64 门禁。

## 24. Decision Audit Trail

| # | 决策 | 分类 | 结论 |
| --- | --- | --- | --- |
| D1 | I-2 是否扩大为用户可用 Agent | Scope | 不扩大，浏览器能力全部 pending |
| D2 | 是否注册首个生产 Task Spec | Security | 不注册，生产注册表为空 |
| D3 | 幂等身份 | Architecture | 使用稳定 execution ID，run ID 仅追踪尝试 |
| D4 | crash recovery | Data | ledger 查询前置，receipt 同事务持久化 |
| D5 | admission 顺序 | Performance | reservation 先于 snapshot/build/model |
| D6 | Task Spec 权限 | Security | 静态可信代码 + 精确端口 + 依赖扫描 |
| D7 | OpenCode 工作目录 | Security | work 与 runtime 分离 |
| D8 | 输出读取 | Security | 进程组退出后进行双 fstat 与路径复核 |
| D9 | shutdown | Lifecycle | beginClosing、Workspace cancel/wait、Coordinator close |
| D10 | 资源限制 | Reliability | prlimit + model calls/tokens + ring buffer |
| D11 | E2E 装配 | CI | 独立 agent-e2e target，生产镜像排除 harness |
| D12 | OS 级隔离 | Release Gate | 保持后续前置，不在 I-2 宣称完成 |

## GSTACK REVIEW REPORT

- Scope Review：CLEAR；
- Engineering Review：CLEAR；
- Security Boundary Review：CLEAR；
- Test Coverage Review：CLEAR；
- UI Review：N/A，本轮无用户界面变更；
- unresolved：0；
- critical gaps：0；
- implementation base：`main@cadbf24`；
- next step：按 I2-A → I2-F 实施。

**VERDICT:** ENG CLEARED — WP-I-2 规划达到实施标准。

NO UNRESOLVED DECISIONS
