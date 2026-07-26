# WP-I：Business Task & Agent Execution Layer Spec

状态：Approved after formal engineering review
规划基线：`origin/main@1976a742b30c7d4e02b68b741b29fea65b281306`（PR #6 已合并）
规划分支：`codex/wp-i-business-task-agent-spec`
前置完成：WP-D～WP-H 基础设施与 PR #6 返修门禁
后续依赖：完整技术方案生成、知识库匹配、查重、废标真实任务链与品牌清理

## 1. 结论

WP-I 通过两个顺序合并的正式 PR 交付两项能力：

1. **PR I-1**：建立运行环境无关的业务任务编排层，并在 Web 中正式接通“招标文件解析”完整主链；
2. **PR I-2**：建立只允许服务端业务任务调用的 Agent Execution Layer，关闭真实 OpenCode tool-call 协议、资源上限、结果校验和清理门禁。

两条开发 Lane 可在契约冻结后并行，合并顺序固定为 `I-1 -> I-2`。I-2 必须基于 I-1 冻结 SHA 完成复核。

本轮继续保持：

- `agent.run` 对浏览器为 `WEB_CAPABILITY_PENDING`；
- 浏览器只能提交业务参数，不能提交 prompt、工作文件、输出路径、工具权限或运行时命令；
- Agent 只能写入任务 Spec 指定的结果文件，结果通过程序校验后才可一次性写入业务 Store；
- 第一条用户可见链路使用现有 portable `bidAnalysisTask` 与 Web AI Runtime，不为了“使用 Agent”改变已经成立的业务实现；
- Agent 层在本轮完成真实协议和安全底座，首个正式 Agent 业务任务由后续工作包在具备真实业务价值时接入。
- Agent Foundation 在 WP-I 内只提供服务端内部能力和测试装配；浏览器端 Agent 枚举、自检、状态、重启和执行入口全部保持 `pending`。
- OpenCode permission 只作为应用级权限门禁。OS 级网络隔离必须在首个正式 Agent 业务任务开放前完成并单独验收。

## 2. 背景与当前事实

### 2.1 PR #6 已完成

- Web 上传、file ID、账号 Workspace、加密配置和真实模型列表已接通；
- Web AI Runtime 已具备文本请求、重试、总 deadline、响应体上限、队列背压和账号公平调度；
- Web Agent Runtime 已具备固定 OpenCode binary、基础权限配置、任务目录、超时、进程终止和清理；
- SSE、Workspace lease、重启中断任务收口、Word 浏览器下载和 Docker CI 已建立；
- `tasks.startBidAnalysis` 与 `agent.run` 已主动恢复为 `pending`，避免把半成品能力暴露为正式产品接口。

### 2.2 What already exists：已存在且必须复用的能力

| 能力 | 当前实现 | WP-I 处理 |
| --- | --- | --- |
| 招标文件解析规则 | `client/core/bidAnalysisTask.cjs` | 直接复用 |
| 技术方案 Store | `client/core/stores/technicalPlanStore.cjs` | 直接复用 |
| Electron 任务生命周期 | `client/electron/services/taskService.cjs` | 抽取通用内核，保持 Electron 行为 |
| Web 任务服务 | `createWebTaskServiceStub()` | 替换为真实服务 |
| Web AI Runtime | `client/core/aiRuntime.cjs` | 复用文本执行；补内部协议接口 |
| Web Agent Runtime | `client/server/agent/webAgentService.cjs` | 增加受控调度和真实协议门禁 |
| SSE 事件 | `taskEventPort` + `/api/tasks/events` | 直接复用 |
| 重启恢复 | Technical Plan Store recovery | 保持并补真实任务测试 |
| `agent.run` | Contract 中为 `pending` | 继续保持 `pending` |

### 2.3 当前阻断

1. Web 任务服务仍是 stub，无法启动真实招标解析；
2. Electron `taskService.cjs` 同时包含通用生命周期、业务快照和环境装配，Web 无法安全复用；
3. Web Agent AI Proxy 只返回文本内容，未完整透传 OpenAI-compatible `tools`、`tool_choice`、`tool_calls` 和多轮工具结果；
4. Web Agent 只有单 Workspace busy 判断，没有进程级公平调度、排队上限和稳定过载错误；
5. 当前 Agent 测试主要使用 fake binary，尚未证明真实 OpenCode 可以完成一次受控工具调用并生成结果文件。

## 3. 用户结果

WP-I 验收后，用户可以：

1. 通过浏览器上传招标文件；
2. 选择关键解析、完整解析或自定义解析；
3. 启动后台解析并通过 SSE 查看每个解析项的进度；
4. 刷新页面后恢复任务状态和已完成内容；
5. 对单个失败项重试，或对全部成功项执行强制重新解析；
6. 在关键解析项全部成功后进入下一阶段；
7. 在服务重启导致任务中断时看到明确错误并重新执行。

用户不会看到：

- 任意 Agent prompt、文件路径、工具权限或运行时参数入口；
- 服务器绝对路径、Workspace ID、API Key、模型原始错误或 Agent stderr；
- “任务已成功”但关键解析项仍未完成的伪完成状态。

## 4. 目标与非目标

### 4.1 目标

1. 抽取可由 Web/Electron 共用的任务生命周期内核；
2. 接通 `tasks.startBidAnalysis` 的完整现有语义；
3. 保持任务组互斥、Store 落盘、SSE 回放和重启恢复；
4. 建立静态、版本化、服务端权威的 Business Task Spec；
5. 透传真实 OpenCode tool-call 协议，并用真实 binary 验证；
6. 建立 Agent 每 Workspace 与进程级并发、排队、取消和关闭规则；
7. 把完整验证加入 `npm run test:web` 与 Docker CI。
8. 为运行中任务建立输入版本锁、写回 CAS 和 Workspace 单一 mutation executor；
9. 将 Bid Analysis DTO 与解析项注册表收敛为可执行的共享真相源。

### 4.2 NOT in scope

- 目录生成、全局事实、正文生成的 Web 接通；
- 知识库匹配、查重分析、废标检查的真实任务执行；
- 浏览器直接调用 `ai.chat`、`ai.requestJson` 或 `agent.run`；
- Agent 使用 Bash、WebFetch、WebSearch、MCP、Skill、子任务或外部目录；
- 多实例共享队列、Redis、消息中间件、Kubernetes 或跨进程续跑；
- UI 组件、布局、交互路径或 MQDS 配色调整；
- 品牌清理、文案全量重命名或旧兼容标识迁移；
- Pi Agent 的 Web 支持；
- 在没有业务价值的场景中强行用 Agent 替换直接 AI 请求。
- 首个正式 Agent 业务任务及其浏览器入口；
- 多实例下的分布式 CAS、跨进程任务续跑与共享 mutation executor；
- 生产 Agent 的独立网络 namespace、沙箱容器或 Kubernetes egress policy；这些能力是首个正式 Agent 业务任务的前置 Release Gate。

## 5. 架构

```text
Browser BidAnalysisPage
        |
        | business payload only
        v
Web Bridge Contract
        |
        v
Web Task Service
        |
        v
Portable Task Orchestrator
        |
        v
Workspace Mutation Executor
        |
        +-----------------------+
        |                       |
        v                       v
Bid Analysis Runner       Future Agent-backed Runner
        |                       |
        v                       v
Scoped AI Runtime         Business Agent Executor
        |                       |
        |                  Static Task Spec
        |                       |
        |                  Process Agent Coordinator
        |                       |
        |                  OpenCode Runtime
        |                       |
        |                  Result Validator
        +-----------+-----------+
                    |
                    v
          Technical Plan Store
                    |
                    v
             Task Event Port
                    |
                    v
               Account SSE
```

### 5.1 分层职责

#### Renderer

- 保存解析模式与选择项；
- 启动业务任务；
- 先读取 Store，再订阅 SSE，再读取 active tasks；
- 展示任务、解析项、进度和可重试错误；
- 不拥有任务生命周期和结果权威状态。

#### Web Bridge

- 校验业务 DTO；
- 解析当前认证 Workspace；
- 调用当前 Workspace 的 Task Service；
- 将稳定错误码映射为 HTTP 状态；
- Request Signal 只覆盖 DTO 校验、任务落盘和入队；
- `running` 持久化成功且 Task Controller 完成注册后才返回 `accepted`；
- 返回 `accepted` 后后台任务只受显式取消、Workspace 关闭或服务 shutdown 控制。

#### Portable Task Orchestrator

- 任务创建、任务组互斥、重复启动幂等；
- active task、queue scope、状态更新和订阅；
- 通过注入的 `TaskDefinition`、`StateAdapter` 和 `SnapshotProjector` 完成业务装配；
- runner 生命周期和异常收口；
- 不导入 Electron、Express、HTTP、SSE 或具体业务 runner。

#### Workspace Mutation Executor

- 每个 Workspace 只有一个 mutation executor；
- Bridge 写操作、Task Runner 状态写入、Agent `applyResult()` 全部经由该 executor；
- 读取可直接并发，所有会改变业务权威状态的操作严格串行；
- mutation 成功落盘后才生成 SSE snapshot；
- Workspace close 先停止接收新 mutation，再等待已接受 mutation 收口。

#### Business Runner

- 读取业务 Store；
- 校验业务前置条件；
- 启动时冻结输入版本并在每次状态写入前执行 CAS；
- 使用注入的 scoped AI/Agent；
- 持续写入业务项状态；
- 完成后写入真实成功或部分失败结果。

#### Business Agent Executor

- 只接受注册表中的 `taskSpecId` 和服务端构造的 context；
- 根据 Spec 生成任务文件、固定 prompt 和输出约束；
- 交给 Agent Coordinator 调度；
- 校验输出后调用 `applyResult()`；
- `applyResult()` 通过 mutation executor 在单个事务中执行 CAS、幂等键检查和结果写入；
- Agent 失败时不修改业务权威结果。

## 6. 核心契约

### 6.1 Web Bid Analysis DTO

浏览器只允许提交：

```ts
interface StartBidAnalysisInput {
  mode: 'key' | 'full' | 'custom';
  selected_task_ids: string[];
  task_ids?: string[];
  force_rerun?: boolean;
}
```

DTO 使用 `client/shared/bidAnalysisContract.cjs` 中的严格 schema 作为唯一运行时真相源。该模块同时导出字段白名单、解析模式、错误码和 normalize/validate 函数；Web Bridge、Electron adapter、core runner 和 contract negative tests 必须直接复用。TypeScript 声明通过 parity test 与 schema 保持一致。

约束：

- `selected_task_ids` 只接受注册的解析项 ID；
- 关键解析项始终包含在有效选择中；
- `task_ids` 只能是本次有效选择的子集；
- `force_rerun` 只接受布尔值；
- DTO 不接受 prompt、模型、file path、file ID、output file、runtime ID 或 Workspace ID；
- 招标文件从当前 Workspace Store 读取。
- 未知字段、缺失字段、错误类型和重复 ID 均返回 `TASK_INVALID_INPUT`。

Bid Analysis 解析项定义收敛到共享静态注册表 `client/shared/bidAnalysisDefinitions.json`。Renderer 与 core 共同消费该注册表，`required/full/custom` 集合不得各自维护副本。

返回现有 `BackgroundTaskState`：

```ts
interface StartTaskResult {
  task_id: string;
  type: 'bid-analysis';
  group: 'technical-plan';
  status: 'running';
  progress: number;
  started_at: string;
  updated_at: string;
}
```

#### 任务接受点

`startBidAnalysis()` 只有完成以下动作后才返回：

```text
strict DTO validated
-> input revision captured
-> Task Controller registered
-> outer task persisted as running
-> runner promise attached
-> return accepted task
```

在 `running` 落盘前 HTTP 断开，Request Signal 取消本次受理且不得留下任务记录；完成接受点后 HTTP 断开不再影响 Task Controller。

#### 输入版本锁

每个 Bid Analysis 任务冻结：

```js
{
  tenderHash,
  selectedSectionId,
  bidAnalysisSelectionHash,
  workflowKind,
  inputRevision
}
```

- `inputRevision` 在招标文件重新导入、标段切换、解析配置变化时递增；
- runner 每次写入解析项与最终状态前执行 CAS；
- CAS 失败时以 `TASK_INPUT_CHANGED` 收口，旧任务不得覆盖新输入；
- 运行中修改输入的 Bridge 写操作可以成功，但必须使旧任务后续写回失败并触发 Task Controller 取消；
- 单项重试沿用当前输入版本，并原子清空目录、全局事实、正文、图片计划及相关任务状态；其他已成功解析项继续保留。

### 6.2 Portable Task Definition

任务定义为静态代码，不进入数据库：

```js
{
  type: 'bid-analysis',
  label: '招标文件解析',
  group: 'technical-plan',
  step: 2,
  lockPolicy: 'group-exclusive',
  stateKey: 'technicalPlan',
  taskField: 'bidAnalysisTask',
  runner: runBidAnalysisTask,
  recoveryPolicy: recoverBidAnalysisTask
}
```

任务定义不得携带 Workspace 可变状态，不得由浏览器注册或覆盖。

Portable 内核只识别生命周期接口，不解释各任务的恢复语义。八类 Electron 任务分别提供 recovery policy，并通过“状态—快照—恢复—关闭—queue scope”行为矩阵验收。

### 6.3 Business Agent Task Spec

```js
{
  id: 'technical-plan.outline-repair',
  version: 1,
  runtime: 'opencode',
  outputFile: 'result.json',
  capabilities: {
    read: ['input/**'],
    write: ['result.json'],
    glob: true,
    grep: true,
    bash: false,
    network: false
  },
  limits: {
    timeoutMs: 600000,
    maxInputBytes: 8 * 1024 * 1024,
    maxOutputBytes: 2 * 1024 * 1024
  },
  buildInput(context) {},
  buildPrompt(context) {},
  validateOutput(content, context) {},
  applyResult(validated, context) {}
}
```

约束：

- `id/version/runtime/outputFile/capabilities/limits` 为服务端静态值；
- `buildInput()` 只从当前 Workspace 的业务 Store 读取数据；
- `buildPrompt()` 不接收浏览器自由文本；
- `validateOutput()` 必须返回结构化结果或抛稳定错误；
- `applyResult()` 只在完整验证通过后执行，并使用 `runId + taskSpecId + version + inputRevision` 作为幂等键；
- `applyResult()` 与输入版本 CAS 必须位于同一个 Store transaction；
- Agent 不直接持有 Store，不直接修改业务数据库；
- 本轮增加仅测试装配可注册的 `contract-fixture` Task Spec，完整验证 `buildInput -> buildPrompt -> real OpenCode -> validateOutput -> applyResult`；
- 生产注册表不包含 `contract-fixture`，本轮不开放首个正式 Agent 业务任务。

### 6.4 Agent Runtime Port

Portable 业务层只依赖：

```js
{
  execute(taskSpecId, context, options),
  getStatus(),
  close()
}
```

底层 `runTask(payload)` 保持 Web adapter 内部实现细节，不进入 Browser Bridge。

### 6.5 Server-internal Raw Chat Port

Agent Proxy 使用：

```js
chatCompletionsRaw(request, {
  queueScopeId,
  signal,
  modelSnapshot
})
```

约束：

- 仅服务端 Agent Executor 可调用，不进入 Browser Bridge contract；
- 原有 `chat()` 和 `requestJson()` 返回契约保持不变；
- 完整保留 `messages/tools/tool_choice/parallel_tool_calls/tool_calls/finish_reason/usage`；
- 继续复用 endpoint policy、队列背压、重试、整体 deadline、响应体上限、连接取消和脱敏审计；
- Agent 启动时冻结解密后的模型配置快照，多轮 tool-call 始终使用同一 endpoint、model 和 key；
- 配置变更只影响新 Agent 任务；
- OpenCode 版本兼容门禁覆盖实际 endpoint、headers、流式模式和工具 schema。

## 7. 状态机

### 7.1 业务任务

```text
                 +----------------------+
                 |                      |
                 v                      |
idle -> running -> success          retry selected
          |  |        |                 |
          |  |        +-> force rerun --+
          |  |
          |  +-> error -> retry
          |
          +-> process restart
                    |
                    v
         error + retryable=true
         TASK_INTERRUPTED_BY_RESTART
```

规则：

- 启动成功后立即落盘 `running`；
- 每个解析项单独记录 `idle/running/success/error`；
- 所有已选解析项成功时，外层任务为 `success`；
- 任一已选解析项失败时，外层任务为 `error + retryable=true`，失败项与已成功结果全部保留；
- 工作流是否可进入下一阶段只依据 5 个关键项，附加项失败不锁死下一步；
- 重启后遗留 `running/pausing` 统一转为可重试错误；
- 重复启动同一任务时返回当前 active task，不创建第二个执行器；
- 同一 Workspace 的 `technical-plan` 任务组保持互斥。
- 输入版本变化时进入 `error + TASK_INPUT_CHANGED`，旧 Runner 后续 mutation 全部拒绝。

### 7.2 Agent 调度

```text
accepted -> queued -> running -> validating -> succeeded
               |         |           |
               |         |           +-> output_invalid
               |         +-> timeout / cancelled / runtime_failed
               +-> queue_overloaded
```

推荐固定上限：

- 每 Workspace active Agent：`1`
- 每 Workspace queued Agent：`2`
- 进程级 active Agent：`4`
- 进程级 queued Agent：`32`

部署环境只允许把上限调低；提高默认上限需要独立容量验证。

Agent Coordinator 为 Web 进程级单例，通过依赖注入提供给每个 Workspace Agent Service。Workspace 只持有本账号的 job lease、取消句柄和状态投影。

公平与关闭规则：

- Workspace 之间采用 round-robin；
- 同一 Workspace 内按 FIFO；
- 同一 `workspaceId + taskSpecId + inputRevision` 重复提交返回现有 queued/running job；
- queued job 取消后立即从队列移除并 reject；
- running job 只有在子进程退出、proxy 关闭和临时目录清理完成后才释放 slot；
- Workspace close 取消本账号 queued/running job，不影响其他账号；
- server shutdown 先进入 draining，再关闭 Workspace，最后关闭进程级 Coordinator；
- queue 满固定返回 `Retry-After: 5`；
- Coordinator 提供按 Workspace 统计的 active/queued snapshot，纳入 TTL 回收判断。

## 8. OpenCode tool-call 协议

Web Agent AI Proxy 必须：

1. 接收 OpenCode 发出的完整 OpenAI-compatible Chat Completions 请求；
2. 保留 `messages`、`tools`、`tool_choice`、`parallel_tool_calls` 和允许的采样字段；
3. 用当前 Workspace 的解密模型配置替换真实模型名和 Key；
4. 将上游响应中的 `message.tool_calls`、`finish_reason`、usage 和后续工具结果轮次完整返回 OpenCode；
5. 对上游 3xx、私网地址、超时、超限、429 和 5xx 继续复用 Web AI Runtime 的安全策略；
6. 不在普通日志中记录 tool arguments、Prompt、文件正文或模型完整响应；
7. 本轮可先支持非流式完整协议；若真实 OpenCode 强制流式，则必须实现 SSE chunk 透传并补同等级测试，不能伪造非流式成功。

真实协议门禁：

```text
Controlled AI Provider
        |
        | first response: deterministic tool_call
        v
Real OpenCode Linux binary
        |
        | executes allowed output edit
        v
result file
        |
        | second model round
        v
final assistant response
        |
        v
validator PASS
```

测试提供方应从 OpenCode 实际请求的 `tools` 中识别可写工具及 schema，再生成符合 schema 的 tool call，避免把 OpenCode 内部工具名称硬编码到测试。

受控 AI Provider 只允许通过测试装配注入。生产 Workspace 必须继续使用现有 endpoint policy，不能为了 Docker smoke 放宽生产私网、HTTP 或 DNS 回绑限制。

### 8.1 Agent 执行安全边界

WP-I 必须清楚区分两层门禁：

1. **应用级门禁（WP-I 完成）**
   - OpenCode permission 默认拒绝；
   - Bash、WebFetch、WebSearch、MCP、Skill、子任务、外部目录关闭；
   - 输入目录只读语义、唯一输出文件、realpath 与 symlink/hard-link 拒绝；
   - Agent 浏览器能力全部 `pending`；
   - 仅服务端测试装配可以注册 `contract-fixture`。
2. **OS 级隔离（首个正式 Agent 业务任务前完成）**
   - 独立非 root UID；
   - 只读输入挂载与独立可写 runtime 目录；
   - 网络 namespace 或等价 egress deny；
   - `no_new_privs`、seccomp 与最小 capability；
   - CPU、内存、PID、文件大小和 inode 配额。

WP-I 不得把 permission 测试描述为 OS 级安全隔离已经完成。生产注册表为空，因此该限制不会形成用户可调用的 Agent 执行面。

本轮仍需加入可在当前容器内实施的资源硬限制：

- 使用 Linux `prlimit` 或等价机制限制单文件大小、地址空间和进程数；
- `result.json` 超限返回 `AGENT_OUTPUT_TOO_LARGE`；
- stdout/stderr 使用有界 ring buffer；
- 临时目录清理前统计总大小并记录脱敏结果码；
- 读取结果前使用 `lstat + realpath` 拒绝 symlink、hard-link 和非普通文件。

## 9. 错误契约

| Code | HTTP | 用户结果 |
| --- | --- | --- |
| `TASK_INVALID_INPUT` | 400 | 提示解析配置无效 |
| `TASK_INPUT_MISSING` | 400 | 提示先上传招标文件或选择标段 |
| `TASK_CONFLICT` | 409 | 提示当前技术方案任务仍在执行 |
| `TASK_ITEM_NOT_FOUND` | 400 | 提示选择项已失效 |
| `TASK_INPUT_CHANGED` | Store/SSE | 提示任务输入已变化，请重新执行 |
| `TASK_INTERRUPTED_BY_RESTART` | Store/SSE | 提示服务重启导致中断，可重试 |
| `AI_QUEUE_OVERLOADED` | 429 | 提示稍后重试，返回 `Retry-After` |
| `AGENT_QUEUE_OVERLOADED` | 429 | 提示 Agent 繁忙，返回 `Retry-After` |
| `AGENT_RUNTIME_UNAVAILABLE` | 503 | 提示运行时暂不可用 |
| `AGENT_PROTOCOL_UNSUPPORTED` | 503 | 提示当前模型不支持 Agent 协议 |
| `AGENT_OUTPUT_INVALID` | 422 | 提示智能处理结果未通过校验 |
| `AGENT_OUTPUT_TOO_LARGE` | 422 | 提示输出超过安全上限 |
| `AGENT_TIMEOUT` | 504 | 提示任务超时，可重试 |

错误响应不得包含 API Key、Base URL、服务端路径、Workspace ID、Prompt、正文、tool arguments、stderr 或 stack。

每个 Bid Analysis item 持久化：

```js
{
  status,
  error,
  error_code,
  retryable
}
```

Renderer 使用 `error_code/retryable` 决定重试与提示，中文 `error` 只用于展示。

## 10. 数据与恢复

- 本轮不新增通用任务表；
- 招标解析任务继续保存到 `technical_plan_tasks`；
- 单项结果继续保存到 `technical_plan_bid_items`；
- active task 与队列保留在当前 Workspace Runtime 内存中；
- `technical_plan_meta` 增加单调递增的 `input_revision`；解析任务表保存启动时 revision；
- 所有 Bid Analysis item 保存 `error_code/retryable`；
- Agent Task Spec 保存在代码注册表中；
- Agent 临时目录位于当前 Workspace 的 `.agent-tasks/`，成功、失败、取消和关闭后均删除；
- Agent 只返回已验证结果，临时输出不作为业务恢复点；
- Single Node v1 不承诺服务重启后继续执行 Agent；重启后业务任务进入可重试错误。
- Agent result commit 使用独立幂等记录或目标 Store 唯一键，进程退出结果不确定时不得重复应用。

输入变化与下游失效矩阵：

| 变化 | 当前 Bid items | 目录 | 全局事实 | 正文/图片计划 | 运行中任务 |
| --- | --- | --- | --- | --- | --- |
| 重新上传招标文件 | 全部清空 | 清空 | 清空 | 清空 | `TASK_INPUT_CHANGED` |
| 切换标段 | 全部清空 | 清空 | 清空 | 清空 | `TASK_INPUT_CHANGED` |
| 修改解析选择 | 保留未重跑的成功项 | 清空 | 清空 | 清空 | `TASK_INPUT_CHANGED` |
| 单项重试 | 保留其他成功项 | 清空 | 清空 | 清空 | 新 revision 下执行 |
| 强制重跑 | 选中项清空 | 清空 | 清空 | 清空 | 新 revision 下执行 |

失效与 revision 递增必须位于同一个 SQLite transaction。

## 11. 工作包与实施顺序

### PR I-1：Task Orchestrator + Web Bid Analysis

### WP-I-A：契约冻结与失败测试

范围：

- 冻结 `StartBidAnalysisInput`、任务返回值和错误码；
- 建立严格 DTO schema 与共享 Bid Analysis 解析项注册表；
- 冻结 input revision、CAS、mutation executor 与接受点契约；
- 为关键/完整/自定义、单项重试和强制重跑补失败测试；
- 固定 `agent.run = pending`；
- 固定 Browser Bridge 不接受 prompt/files/output/runtime。

验收：

- 测试先证明当前 `501` 缺口；
- Contract 不允许未知字段和未知 task ID；
- Contract manifest、Web 类型和 Electron 类型通过 parity test 保持一致。

### WP-I-B：Portable Task Orchestrator

范围：

- 先建立八类 Electron 任务行为矩阵和 characterization tests；
- 从 Electron Task Service 抽取任务生命周期、锁、active task、订阅和 runner 调度；
- `TaskDefinition`、`StateAdapter`、`SnapshotProjector` 和 recovery policy 通过注册表注入；
- 建立 Workspace 单一 mutation executor；
- Electron wrapper 使用新内核，保持所有现有任务行为；
- 删除抽取后产生的重复生命周期逻辑。

验收：

- Portable core require 图不进入 `electron/`；
- 八类 Electron characterization tests、native smoke 与现有任务测试通过；
- 技术方案任务组互斥、重复启动、订阅回放和关闭行为不变；
- refactor 前后 Electron Bridge 对外契约不变。

### WP-I-C：Web Bid Analysis 垂直闭环

范围：

- 创建真实 Web Task Service；
- 注册 `bid-analysis` definition 与现有 `runBidAnalysisTask`；
- 建立 input revision、写回 CAS、item 级稳定错误和下游原子失效；
- 从当前 Workspace Store 读取招标 Markdown；
- 注入 scoped Web AI Runtime；
- 接通 Bridge、SSE、active task 和重启恢复；
- 将 `tasks.startBidAnalysis` 更新为 `implemented`。

验收：

- 所有已选项成功后外层任务才成功；
- 附加项失败时外层任务显示可重试错误，关键 5 项齐全时仍允许进入下一步；
- 完整/自定义选择准确；
- 单项重试只重跑目标项；
- 强制重跑清理旧结果及后续失效状态；
- 页面刷新后可恢复；
- 两账号任务、事件、模型配置和 Store 不串扰。

PR I-1 必须先合并。I-2 以 I-1 合并 SHA 重新 rebase 并运行完整门禁。

### PR I-2：Business Agent Execution Foundation

### WP-I-D：Business Agent Execution Foundation

范围：

- 建立 Business Agent Task Spec 注册表与 executor；
- 建立进程级单例、公平且有界的 Agent Coordinator；
- 增加 raw Chat Completions/tool-call 协议端口；
- 冻结多轮 Agent 模型配置快照；
- 建立 Agent result CAS、事务提交与幂等键；
- 增加 `prlimit`、普通文件检查、symlink/hard-link 拒绝和有界日志；
- Web Agent Service 只接受 executor 生成的任务；
- 关闭成功、失败、取消、超时和 shutdown 清理；
- Web 的 `agent.run/listRuntimes/selfCheck/getStatus/restart` 全部保持 `pending`。

验收：

- fake binary 单元测试覆盖权限配置和边界；
- 真实 OpenCode Docker E2E 使用 test-only `contract-fixture` 完成 tool call、validator 与一次性 `applyResult()`；
- permission、普通文件、外部目录、兄弟 Workspace、symlink/hard-link 和未声明输出测试通过；
- 文档明确网络权限测试只代表应用级门禁；
- round-robin/FIFO、去重、取消、slot 释放、TTL snapshot 和队列满行为通过；
- 关闭时等待子进程退出并清理 proxy、目录和队列。

### WP-I-E：CI、文档与发布门禁

范围：

- 将真实 Web Bid Analysis E2E 加入完整 Web gate；
- 将真实 OpenCode tool-call smoke 加入 Docker gate；
- 增加双账号、输入变化竞争、重启恢复、过载、取消、Store 写失败和敏感信息扫描；
- 更新 `project.md`、`README.md`、`AGENTS.md` 和 `client/开发说明.md` 的 PR #6/WP-I 事实口径；
- 更新 `docs/web-v1-incomplete-items.md`，只关闭有证据完成的项目。

验收：

- 本地与远端 CI 全绿；
- PR 描述明确“Bid Analysis 已接通，其他业务任务仍 pending”；
- 不把 Agent Foundation 描述为浏览器 Agent 产品能力或 OS 级隔离完成；
- 品牌清理继续保持冻结。

## 12. Worktree 并行开发策略

| Lane | 工作包 | 主要模块 | 依赖 |
| --- | --- | --- | --- |
| A / PR I-1 | I-A → I-B → I-C | `shared/contract`、`core/task`、`electron/task adapter`、`server/workspace` | 串行 |
| B / PR I-2 | I-D | `core/ai protocol`、`server/agent`、Agent tests | I-A 契约冻结；最终基于 I-1 SHA |
| C | I-E 文档草稿 | `.planning/`、项目文档 | I-A，可并行起草 |
| Integration | I-E CI 与验收 | `scripts/`、`.github/workflows/`、Docker | 每个 PR 分别集成 |

执行顺序：

1. 主线程完成 I-A 并冻结接口；
2. Lane A 与 Lane B 使用独立 worktree 并行开发；
3. 文档 worker 只维护文档，不修改代码；
4. Lane A 完成后提交并合并 PR I-1；
5. Lane B rebase 到 I-1 合并 SHA，重新运行全部测试后提交 PR I-2；
6. 每个 PR 独立修改并验证自己的 package scripts、CI 和 Docker gate。

冲突控制：

- `workspaceRuntimeFactory.cjs` 只由 Lane A 修改；
- `aiRuntime.cjs`、`webAgentService.cjs` 与进程级 Agent Coordinator 只由 Lane B 修改；
- shared contract 冻结后，Lane B 不自行修改；确需变化时先回到主线程更新契约；
- `package.json`、CI workflow、Dockerfile 由对应 PR 主线程集成；
- Subagent 不执行 commit、push 或 PR 操作，主线程统一提交。

冲突提示：两条 Lane 都会触及 Workspace 生命周期契约。Lane B 只在 I-1 合并后接入 `workspaceRuntimeFactory.cjs`，避免两个 worktree 同时修改该模块。

## 13. 测试计划

### 13.1 Portable Task Orchestrator

- 八类 Electron 任务在抽取前后使用同一组 characterization fixtures；
- 每类任务覆盖状态、快照、恢复、关闭、锁和 queue scope；
- 创建任务并立即落盘；
- 同类型重复启动返回同一任务；
- 同任务组冲突返回 `TASK_CONFLICT`；
- 不同 Workspace 不冲突；
- runner 成功、抛错、同步抛错和 close；
- queue scope 创建、恢复和释放；
- subscribe 时回放 active tasks；
- unsubscribe/close 幂等；
- Store 写失败不伪造 SSE 成功；
- mutation executor 保证 Bridge 与 Runner 写操作串行；
- 重启恢复把 running item 和外层任务转为可重试错误。

### 13.2 Bid Analysis

- key 模式执行 5 个关键项；
- full 模式执行全部注册项；
- custom 模式自动包含关键项；
- 单项 retry 只执行指定项；
- `force_rerun` 重置全部选中项和后续失效状态；
- 项目概述先执行，缓存预热后并发剩余项；
- 分段解析与结果合并；
- 空招标文件、失效标段、未知任务 ID；
- 必填项空结果、单项 429/5xx/timeout、部分失败；
- 附加项失败时外层 `error + retryable`，关键项齐全时 workflow gate 可继续；
- 关键项失败时外层 error 且 workflow gate 阻断；
- item 级 `error_code/retryable` 持久化并经 SSE 返回；
- 解析中重新上传、切换标段、修改配置时旧任务以 `TASK_INPUT_CHANGED` 收口；
- 单项 retry 原子失效目录、全局事实、正文和图片计划，其他成功解析项不重跑；
- CAS 失败和 Store mutation 失败不产生成功 SSE；
- 页面刷新后 Store + SSE + active tasks 恢复；
- 两账号并行执行无事件、配置和结果串扰；
- HTTP 请求断开后已接受的后台任务继续执行。
- HTTP 在接受点前断开不留下 running 记录；
- Workspace TTL sweep 不回收 queued/running 任务。

### 13.3 Agent Foundation

- Task Spec 未注册、版本不匹配和输出文件越界；
- 输入大小、输出大小和 timeout；
- 每 Workspace/global active 与 queue 上限；
- round-robin/FIFO 公平调度，单账号不能长期占满全局 slot；
- 同 Workspace 去重、取消后的 slot 释放时点、固定 `Retry-After: 5`；
- 取消 queued/running；
- queue cancel 与 Workspace close 并发；
- shutdown 等待子进程退出；
- proxy token 错误、请求体超限和非法 JSON；
- tool-call request/response 多轮透传；
- 模型不返回 tool call；
- tool arguments 无效；
- Agent 多轮期间修改模型配置，当前任务继续使用冻结快照；
- 真实 OpenCode 写入唯一允许输出；
- test-only `contract-fixture` 完成 validator、CAS 和 exactly-once apply；
- applyResult 前 Store 写失败不产生部分业务结果；
- Bash、Web 工具、外部目录、额外文件、symlink/hard-link 和跨 Workspace 拒绝；
- 超大输出触发 `AGENT_OUTPUT_TOO_LARGE`，子进程和目录被清理；
- 日志和 API 响应敏感信息扫描。

### 13.4 用户 E2E

```text
真实 Chromium
  -> mock MainQuest 登录
  -> 上传测试招标文件
  -> 保存可控模型配置
  -> 点击“开始解析”
  -> 观察 running 与 SSE 进度
  -> 刷新页面
  -> 等待关键 5 项成功
  -> 验证可进入下一阶段
  -> 单项重试
  -> 验证其余成功项未重跑
  -> 附加项失败时看到错误且仍可进入下一阶段
  -> 关键项失败时看到错误且下一步保持禁用
```

### 13.5 CI 命令

计划新增：

```bash
cd client
npm run test:task-orchestrator
npm run test:electron-task-characterization
npm run test:web-bid-analysis
npm run test:web-agent-protocol
npm run test:web
npm run test:web-browser
npm run smoke:electron-native
```

Docker gate：

```text
build image
-> verify OpenCode checksum
-> start controlled AI provider
-> run real OpenCode tool-call smoke
-> run Web bid-analysis business smoke
-> health/readiness
-> production OAuth startup smoke
```

### 13.6 生产失败模式

| 场景 | 程序处理 | 自动化证据 | 用户结果 |
| --- | --- | --- | --- |
| AI 429/5xx/timeout | 现有 retry 与总 deadline | Web Bid Analysis integration | 当前项失败，可单项重试 |
| 某个关键项返回空内容 | 标记该项 error，外层任务 error | Required item empty case | 明确显示失败项 |
| 附加项失败 | 外层 error，关键项 gate 独立判断 | Chromium partial failure E2E | 显示失败且可继续 |
| 运行中输入变化 | CAS 拒绝旧任务写回 | Input revision race tests | 提示输入变化并重新执行 |
| Bridge 与 Runner 同时写 Store | mutation executor 串行提交 | Mutation ordering test | 保留最新有效状态 |
| 页面刷新或 SSE 断线 | Store 恢复 + SSE 重连 + active task 回放 | Browser refresh E2E | 继续看到真实进度 |
| 服务重启 | running 转 retryable error | Runtime recreate test | 提示重新执行 |
| 两个账号同时解析 | Workspace 隔离的 Store/queue/SSE | Two-account integration | 只看到自己的任务 |
| Agent queue 满 | 拒绝入队，返回 429 | Coordinator limit test | 提示稍后重试 |
| Agent 进程超时 | 终止进程组并等待退出 | Real process timeout test | 显示超时，可重试 |
| Agent 输出不合规 | validator 拒绝，不写业务 Store | Invalid output test | 显示结果校验失败 |
| Agent 输出超大或伪装链接 | OS 文件限制与普通文件校验拒绝 | Resource/symlink tests | 任务失败，业务数据不变 |
| Agent 尝试禁用工具或越界 | OpenCode 应用级权限拒绝 | Real config + attack tests | 任务失败，业务数据不变 |
| Agent 多轮期间模型配置变化 | 使用任务启动时配置快照 | Model snapshot test | 当前任务稳定完成 |
| validator 后 Store 写失败 | 事务回滚，幂等键不提交 | Apply failure test | 显示可重试错误 |
| Workspace 关闭 | 取消 queued，终止 running，关闭 proxy | Workspace close test | 无僵尸任务和临时目录 |
| 模型不支持 tool call | 结束并返回稳定协议错误 | Controlled provider negative test | 提示更换支持 Agent 的模型 |

任何失败场景都必须同时满足：有自动化测试、有明确错误处理、用户可恢复。静默失败视为 P1。

### 13.7 覆盖路径图

```text
CODE PATHS                                      USER FLOWS
[+] Portable Task Orchestrator                  [+] Web Bid Analysis
 ├── create -> persist -> accepted               ├── [E2E] 登录、上传、启动
 ├── duplicate -> return active                  ├── [E2E] SSE 进度、刷新恢复
 ├── conflict -> TASK_CONFLICT                   ├── [E2E] 单项重试
 ├── runner success/error/cancel                 ├── [E2E] 附加项失败仍可继续
 ├── input CAS -> TASK_INPUT_CHANGED             └── [E2E] 关键项失败阻断
 └── Electron 8-task characterization

[+] Workspace Mutation                          [+] 多租户与竞争
 ├── Bridge mutation -> serialized               ├── 两账号隔离
 ├── Runner mutation -> serialized               ├── 请求断开前/后接受点
 ├── commit -> snapshot -> SSE                   ├── 运行中上传/切标段/改配置
 └── Store error -> rollback                     └── TTL sweep / close race

[+] Agent Foundation                            [+] Agent 内部安全链
 ├── registry -> coordinator                     ├── real OpenCode tool-call
 ├── raw chat -> frozen model snapshot           ├── contract-fixture apply once
 ├── validate -> CAS -> transaction              ├── 禁用工具/越界/链接拒绝
 ├── output limit -> stable error                └── timeout/cancel/close cleanup
 └── round-robin/FIFO/overload
```

实现时应在以下复杂模块保留简短 ASCII 注释：

- Portable Task Orchestrator：接受点、Task Controller 与清理顺序；
- Workspace Mutation Executor：mutation、commit、snapshot、SSE 顺序；
- Agent Coordinator：round-robin/FIFO、取消和 slot 释放；
- Business Agent Executor：validate、CAS、事务与幂等提交顺序。

## 14. 性能与资源边界

- Bid Analysis 继续使用现有文本队列与进程级公平 coordinator；
- 项目概述先执行，剩余解析项并发交给 AI 队列控制；
- 不在业务层新增第二套 AI 并发限制；
- Agent Coordinator 独立于 AI Queue，但 Agent 的模型请求仍进入当前 Workspace AI queue；
- Agent active slot 可以等待 AI queue，但总 deadline 同时覆盖 Agent 排队、OpenCode 执行和多轮模型请求；
- Agent queue 只保存小型任务元数据，不保留重复文档副本；
- Agent 文件在获得执行 slot 后才写入临时目录；
- 单次 Agent 输入默认上限 8 MiB，输出上限 2 MiB，超时上限 10 分钟；
- Workspace idle 回收必须把 active/queued Agent 计入 activity snapshot；
- 所有定时器 `unref()`，所有流、HTTP server、child process 和临时目录有显式 owner。
- Bid Analysis 的 `Promise.all` 只覆盖静态注册表中的有限解析项；模型实际并发继续受 AI Coordinator 限制；
- mutation executor 只串行写操作，不阻塞只读 Store 查询；
- 可观测性记录 queue wait、mutation wait 与 total deadline，容量验证以 p95 等待时间和峰值 RSS 为准。

## 15. 可观测性

记录：

- task type、内部 task ID、阶段、进度、耗时和结果码；
- Agent taskSpec ID/version、排队耗时、执行耗时、validator 结果；
- AI/Agent queue active/queued 数量；
- timeout、cancel、restart recovery 和 overload 计数。

禁止记录：

- email、MainQuest token、API Key、Base URL；
- Prompt、用户文档正文、tool arguments；
- Agent 完整 stdout/stderr；
- 服务端绝对路径和 Workspace ID 明文。

普通用户只看到可操作的中文提示；开发者诊断日志继续遵循现有本地 JSONL 与脱敏规则。

## 16. 回滚

- I-B 为行为保持重构，可独立回滚到 Electron 原 Task Service；
- I-C 回滚时将 `tasks.startBidAnalysis` 恢复为 `pending`，保留已有 Store 数据；
- PR I-1 可独立回滚；PR I-2 不得在 I-1 回滚后单独保留；
- I-D 回滚时停止注册 Business Agent Executor，所有 Web Agent capability 始终保持 `pending`；
- 回滚不删除账号 SQLite、上传文件或已完成解析结果；
- Agent 临时目录不参与业务恢复，可安全清理；
- 每个工作包独立提交，主线程保留冻结 SHA。

## 17. 完成 Gate

以下条件全部满足，WP-I 才能标记完成：

1. `tasks.startBidAnalysis` 在真实 Web Bridge 中为 `implemented`；
2. key/full/custom、retry、force rerun 全部按现有 UI 语义执行；
3. 外层任务与关键项 workflow gate 的部分失败语义通过真实 Chromium 验证；
4. input revision、CAS、下游失效和 mutation executor 竞争测试通过；
5. 浏览器刷新、SSE 重连和服务重启恢复通过；
6. 双账号隔离通过；
7. 八类 Electron 任务 characterization tests 与 native smoke 通过；
8. 真实 OpenCode binary 使用 test-only `contract-fixture` 完成受控 tool-call、validator 和 exactly-once apply；
9. Agent 应用级权限、普通文件检查、资源上限与清理门禁通过；
10. Agent round-robin/FIFO、Workspace/全局队列上限、取消和 shutdown 通过；
11. Web 的 `agent.run/listRuntimes/selfCheck/getStatus/restart` 均保持 `pending`；
12. 完整 Web、浏览器、Docker、OAuth startup 和 dependency audit 全绿；
13. PR I-1 先合并，PR I-2 基于 I-1 合并 SHA 完成全量复核；
14. 项目文档只声明已被自动化证据证明的能力，并明确 OS 级 Agent 隔离仍是后续 Release Gate。

## 18. 实施任务

- [ ] **T1（P1，人工约 4h / AI Coding 约 45min）— Shared Contract — 建立严格 Bid Analysis DTO 与共享解析项注册表**
  - 来源：Architecture / Outside Voice — `payload: unknown` 与 Renderer/core 双份定义；
  - 影响模块：`client/shared/`、`client/core/`、`client/src/features/technical-plan/`；
  - 验证：Contract negative tests、required/full/custom parity tests。
- [ ] **T2（P1，人工约 1d / AI Coding 约 2h）— Electron Tasks — 建立八类任务行为矩阵与 characterization tests**
  - 来源：Test Review D8 / Outside Voice — 910 行 Electron Task Service 的行为保持证据；
  - 影响模块：`client/electron/services/`、`client/scripts/`；
  - 验证：`npm run test:electron-task-characterization`。
- [ ] **T3（P1，人工约 1d / AI Coding 约 2h）— Portable Core — 抽取最小 Task Orchestrator**
  - 来源：Architecture D4 — 只抽取生命周期，注入 Definition、StateAdapter、SnapshotProjector；
  - 影响模块：`client/core/`、`client/electron/services/`；
  - 验证：`npm run test:task-orchestrator && npm run smoke:electron-native`。
- [ ] **T4（P1，人工约 1d / AI Coding 约 2h）— Workspace State — 建立 mutation executor、input revision 与写回 CAS**
  - 来源：Outside Voice 1/2/13 — 防止旧任务覆盖新招标文件、标段和配置；
  - 影响模块：`client/core/stores/`、`client/server/workspace/`、`client/server/routes/`；
  - 验证：mutation ordering、input changed、接受点断连与 TTL race tests。
- [ ] **T5（P1，人工约 1d / AI Coding 约 2h）— Web Bid Analysis — 接通完整业务 Runner**
  - 来源：WP-I 主目标 / Architecture D3/D6 — 完整模式、重试、强制重跑、部分失败和独立 Task Controller；
  - 影响模块：`client/core/`、`client/server/workspace/`、`client/shared/bridgeContract.cjs`；
  - 验证：`npm run test:web-bid-analysis`。
- [ ] **T6（P1，人工约 4h / AI Coding 约 45min）— Store Contract — 增加 item 错误码与原子下游失效**
  - 来源：Outside Voice 3/4 — 单项重试必须失效下游且错误可机器判断；
  - 影响模块：`client/core/stores/`、SQLite migration、共享类型；
  - 验证：retry invalidation、error code persistence、restart recovery tests。
- [ ] **T7（P1，人工约 4h / AI Coding 约 45min）— Browser E2E — 验证真实 Bid Analysis 用户链路**
  - 来源：Test Review D9 — 外层错误与 workflow gate 由不同前端逻辑控制；
  - 影响模块：`client/e2e/`、`client/src/features/technical-plan/`；
  - 验证：`npm run test:web-browser`。
- [ ] **T8（P1，人工约 1d / AI Coding 约 2h）— Agent Protocol — 增加 raw Chat Port 与冻结模型快照**
  - 来源：Architecture D5 / Outside Voice 8 — 多轮 tool-call 不得丢协议或跨配置；
  - 影响模块：`client/core/aiRuntime.cjs`、`client/server/agent/`；
  - 验证：raw protocol、model snapshot、stream compatibility tests。
- [ ] **T9（P1，人工约 1d / AI Coding 约 2h）— Agent Coordinator — 建立进程级公平有界调度**
  - 来源：Architecture D2 / Outside Voice 12 — round-robin、FIFO、去重、取消和 activity 必须确定；
  - 影响模块：`client/server/agent/`、`client/server/workspace/`；
  - 验证：fairness、limits、cancel/close race、TTL activity tests。
- [ ] **T10（P1，人工约 1d / AI Coding 约 2h）— Agent Executor — 建立 CAS、事务与幂等提交**
  - 来源：Code Quality D7 / Outside Voice 7 — 验证通过后的结果只能提交一次；
  - 影响模块：`client/core/`、`client/server/agent/`、测试 Fixture Store；
  - 验证：real OpenCode `contract-fixture`、Store failure rollback、duplicate apply tests。
- [ ] **T11（P1，人工约 1d / AI Coding 约 2h）— Agent Runtime — 增加文件与进程资源限制**
  - 来源：Outside Voice 5/6 — permission 配置无法限制磁盘和进程资源；
  - 影响模块：`client/server/agent/`、Dockerfile、Docker smoke；
  - 验证：output too large、symlink/hard-link、non-regular file、timeout cleanup tests。
- [ ] **T12（P1，人工约 4h / AI Coding 约 45min）— Capability Surface — 关闭全部浏览器 Agent 入口**
  - 来源：Outside Voice 14 — Foundation 测试必须走内部装配；
  - 影响模块：`client/shared/bridgeContract.cjs`、Web bindings、Renderer 设置入口；
  - 验证：Web contract strict guard 与 Browser capability scan。
- [ ] **T13（P1，人工约 1d / AI Coding 约 2h）— CI — 建立 I-1 与 I-2 独立门禁**
  - 来源：Scope D1 — 两个正式 PR 顺序合并；
  - 影响模块：`client/package.json`、`.github/workflows/`、Docker；
  - 验证：完整 Web、Playwright、Electron、Docker、OAuth startup、audit。
- [ ] **T14（P2，人工约 3h / AI Coding 约 30min）— Documentation — 更新项目事实与发布边界**
  - 来源：工程治理 — 只声明已被自动化证明的能力；
  - 影响模块：`project.md`、`README.md`、`AGENTS.md`、`client/开发说明.md`、incomplete items；
  - 验证：品牌清理仍冻结，Agent OS 隔离明确标记为后续 Release Gate。
- [ ] **T15（P1，人工约 4h / AI Coding 约 45min）— Review — 分别完成 I-1 与 I-2 正式复审**
  - 来源：Scope D1 — I-2 依赖 I-1 合并 SHA；
  - 影响模块：两个 PR 的最终 diff；
  - 验证：I-1 合并后 I-2 rebase，全量 CI 与 `git diff --check` 通过。

## 19. 后续工作包

- WP-J：技术方案多标段、目录、全局事实与正文生成；
- WP-K：知识库匹配、废标检查与查重真实任务；
- WP-L：Headless 图片/Mermaid 高保真导出与 Web v1 Release Candidate；
- 首个正式 Agent 业务任务前置 Gate：完成 OS 级非 root、只读挂载、egress deny、`no_new_privs`、seccomp 和资源配额；未完成时生产 Agent 注册表必须为空；
- 架构 Release Gate 全部通过后，再解冻品牌清理实施。

## 20. 已批准的规划决策

1. WP-I 首个用户可见闭环采用“完整招标文件解析”；
2. WP-I 拆为两个正式 PR，顺序固定为 `I-1 -> I-2`；
3. `agent.run` 及全部 Web Agent 管理能力在 WP-I 继续保持 pending；
4. Agent Foundation 本轮完成真实协议、应用级权限和资源门禁，首个正式 Agent 业务任务延后；
5. Single Node v1 使用内存有界队列，暂不引入 Redis 或持久化执行队列；
6. Agent Coordinator 由进程持有，Workspace 只管理本账号任务；
7. Portable Task Orchestrator 使用最小内核和注入式业务适配；
8. HTTP Request Signal 与后台 Task Controller 分离；
9. 任一已选解析项失败时外层任务为可重试错误，workflow gate 单独依据 5 个关键项；
10. Agent 使用 server-internal raw Chat Port，原有 AI 业务接口保持不变；
11. 运行中任务使用 input revision、CAS 和单一 mutation executor；
12. Agent 结果使用模型快照、CAS、事务和幂等键；
13. test-only `contract-fixture` 验证完整 Agent Executor，生产注册表不开放业务任务；
14. 首个正式 Agent 业务任务开放前必须完成 OS 级隔离 Release Gate；
15. 后续工程复审决策默认采用推荐方案，重大产品范围或安全边界变化仍需单独确认。

## 21. 正式工程复审结论

- Step 0 Scope Challenge：整体 WP-I 范围保留，交付拆为两个正式 PR；
- Architecture Review：5 项问题，全部采用推荐方案；
- Code Quality Review：1 项问题，增加 test-only Agent contract fixture；
- Test Review：完成覆盖路径图，2 个缺口全部闭合；
- Performance Review：0 项新增问题；
- Outside Voice：Codex 独立复核发现 15 项挑战，合并为 8 组工程约束并全部写入本 Spec；
- NOT in scope：已写明；
- What already exists：已写明且明确复用；
- TODO：首个正式 Agent 业务任务前的 OS 级隔离 Gate 已记录到后续工作包；
- Failure modes：17 类生产失败路径均有预期处理与自动化证据要求，0 个静默关键缺口；
- Parallelization：3 条开发 Lane 可在契约冻结后并行，正式合并顺序固定为 I-1、I-2；
- Lake Score：9/9 次交互决策采用完整推荐方案；
- Retrospective：PR #5/#6 的评审历史反复暴露“基础设施已存在、能力暴露超过证据”的问题，本 Spec 继续以 capability pending 和真实成功链路 Gate 控制发布口径。

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
| --- | --- | --- | ---: | --- | --- |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | 当前工程范围沿用已批准产品方向 |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | 未运行 diff review |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 8 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | 本轮不改组件、布局和视觉设计 |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | 当前无需独立 DX review |

**CODEX:** Outside Voice 已运行，15 项挑战全部审阅，8 组有效约束已写回 Spec。

**CROSS-MODEL:** 两轮复审一致认为 WP-I 可以实施；输入版本 CAS、单一 mutation executor 和 Agent OS 隔离口径由 Outside Voice 进一步补强。

**VERDICT:** ENG CLEARED — WP-I 规划已达到实施标准，按 PR I-1、PR I-2 顺序执行。

NO UNRESOLVED DECISIONS
