# WP-I-2 Test Plan

状态：Approved with WP-I-2 Spec
基线：`main@cadbf24`
对应 Spec：`wp-i2.spec.md`

## 1. Gate 原则

- 每个 P1 契约先有失败测试，再实现；
- fake binary 用于边界和竞态，不能替代真实 OpenCode；
- 真实协议测试运行在独立 Docker `agent-e2e` target；
- 最终 runtime image 必须证明不含 fixture、controlled provider 和 test harness；
- Web Agent Contract 始终保持 pending；
- 任一安全负向测试失败时不得合并。

## 2. 测试套件

| Suite | 目标 | 类型 |
| --- | --- | --- |
| `test:web-agent-protocol` | raw chat、tool calls、模型快照、Proxy | Node integration |
| `test:web-agent-coordinator` | reservation、公平、上限、取消、close | deterministic + stress |
| `test:web-agent-executor` | Task Spec、CAS、transaction、receipt、crash | SQLite integration |
| `test:web-agent-runtime` | 文件、permission、prlimit、cleanup | fake binary |
| `test:web-agent-docker` | real OpenCode 两轮 tool-call | Docker E2E |
| `test:web-contract` | 浏览器 Agent pending | contract negative |
| `test:workspace-lifecycle` | TTL、Workspace close、process shutdown | lifecycle integration |

## 3. Raw Chat 与 Proxy

- [ ] 纯文本响应保持现有 `chat()` 返回；
- [ ] raw response 保留 `message.tool_calls`；
- [ ] 保留 `finish_reason`、`usage`、tool call ID；
- [ ] 第二轮 messages 保留 assistant tool call 和 tool result；
- [ ] 请求携带 `model` 被拒绝；
- [ ] 请求携带 key/base URL/provider 被拒绝；
- [ ] 上游 model 只来自冻结快照；
- [ ] queued 后修改配置，当前 execution 不变化；
- [ ] 新 execution 使用新配置；
- [ ] success/error/cancel/timeout/overload 全部释放快照；
- [ ] `stream=true` 在未实现时返回 `AGENT_PROTOCOL_UNSUPPORTED`；
- [ ] Proxy token 错误返回 401；
- [ ] body 超过 2 MiB；
- [ ] 非法 JSON；
- [ ] 非 POST 或错误路径；
- [ ] endpoint policy、manual redirect、deadline、response size 和 abort 回归。

## 4. Coordinator

- [ ] 每 Workspace active 不超过 1；
- [ ] 每 Workspace queued 不超过 2；
- [ ] global active 不超过 4；
- [ ] global queued 不超过 32；
- [ ] reservation/admission 计入上限；
- [ ] Workspace 内 FIFO；
- [ ] Workspace 间 round-robin；
- [ ] 同 execution + 同 envelope 返回同一 job；
- [ ] 同 execution + 不同 envelope 返回 `AGENT_EXECUTION_CONFLICT`；
- [ ] 不同 execution + 相同输入创建独立 job；
- [ ] 单个 observer 不能取消共享 execution；
- [ ] owner cancel 取消 queued；
- [ ] owner cancel 取消 running；
- [ ] queue overload 返回 retryAfterSeconds=5；
- [ ] deadline 覆盖 admission、queue、run、validate、apply、cleanup；
- [ ] admission 失败释放 reservation 和快照；
- [ ] beginClosing 后拒绝新 reservation；
- [ ] beginClosing 取消 reserved/admitting/queued；
- [ ] admission 回调晚到不能转 queued；
- [ ] applying 线性化后允许 transaction 完成；
- [ ] cleanup 完成后才释放 slot；
- [ ] 随机状态机压力测试；
- [ ] 1000 job 后 Map、队列、监听器、句柄无增长。

## 5. Task Spec 与 Executor

- [ ] 未注册 Spec；
- [ ] 重复 ID；
- [ ] 非法 version；
- [ ] 未知字段；
- [ ] 非法 capability；
- [ ] 超过 server ceiling；
- [ ] 对象递归深冻结；
- [ ] production registry 为空；
- [ ] production 注册 fixture fail closed；
- [ ] production 注入 controlled provider fail closed；
- [ ] Task Spec 依赖扫描拒绝 fs/SQLite/Store/runtime；
- [ ] SnapshotReader 拒绝未声明 binding；
- [ ] CommitTransaction 拒绝未声明 operation；
- [ ] validator 无 Store/SQLite/mutation 能力；
- [ ] validator 失败零业务写入；
- [ ] apply 只能在 Committer transaction 内执行。

## 6. Snapshot、CAS、Ledger 与 Crash

- [ ] 短 transaction 同时冻结 revision、snapshot、input hash；
- [ ] snapshot 后输入变化，apply 返回 `AGENT_INPUT_CHANGED`；
- [ ] execution envelope 在 accepted 前持久化；
- [ ] ledger 主键为 Workspace 内 execution ID；
- [ ] immutable envelope 不一致返回 conflict；
- [ ] ledger 查询先于 revision CAS；
- [ ] receipt 包含 executionId/outputSha256/appliedAt/resultLocator；
- [ ] resultLocator JSON 不超过 2 KiB；
- [ ] resultLocator 不含绝对路径、正文或用户输入；
- [ ] 业务结果、ledger、resultLocator 同 transaction；
- [ ] Store fault injection 完整 rollback；
- [ ] 同 execution 新 run 不再次 apply；
- [ ] COMMIT 后、外层确认前由独立子进程退出；
- [ ] 重新打开 SQLite 后完整重建 receipt；
- [ ] recovery 不再次调用模型；
- [ ] recovery 不再次 apply；
- [ ] recovery 调用 reconcileAppliedExecution 并把外层任务收口成功；
- [ ] runtime schema 与设计 SQL 的 version/table/index/unique parity。

## 7. 文件与 OpenCode Permission

- [ ] OpenCode `--dir` 指向 work；
- [ ] config/home/cache/tmp 位于 work 外；
- [ ] 输入只能写入 `work/input/`；
- [ ] 输入生成后 mode 为 0555/0444；
- [ ] 绝对路径、`..`、空路径、保留名；
- [ ] 重复路径和大小写冲突；
- [ ] 输入总大小上限；
- [ ] Bash、WebFetch、WebSearch、Task、Skill、LSP、Question 全部 deny；
- [ ] external_directory deny；
- [ ] glob/grep 无法读取 runtime；
- [ ] 无法读取兄弟 Workspace；
- [ ] 无法修改 input；
- [ ] 只能生成 `result.json`；
- [ ] 额外文件返回 `AGENT_OUTPUT_UNDECLARED`；
- [ ] symlink；
- [ ] hard-link；
- [ ] FIFO/socket/device；
- [ ] 输出空或缺失；
- [ ] 输出超限；
- [ ] 同 inode 并发写；
- [ ] 读取前路径替换；
- [ ] 读取后路径替换；
- [ ] 残留孙进程写入；
- [ ] 双 fstat/lstat 元数据变化拒绝。

## 8. 资源与清理

- [ ] prlimit 缺失 readiness/self-check fail；
- [ ] address space 上限；
- [ ] file size 上限；
- [ ] open files 上限；
- [ ] process 上限；
- [ ] CPU time 上限；
- [ ] wall clock timeout；
- [ ] maxModelCalls；
- [ ] maxTotalTokens；
- [ ] usage 缺失仍受 maxModelCalls 限制；
- [ ] stdout ring buffer 2 MiB；
- [ ] stderr ring buffer 64 KiB；
- [ ] SIGTERM 后 2 秒 SIGKILL；
- [ ] 成功后进程组退出；
- [ ] 失败后进程组退出；
- [ ] cancel 后进程组退出；
- [ ] timeout 后进程组退出；
- [ ] Proxy 关闭；
- [ ] task directory 删除；
- [ ] cleanup 失败返回稳定错误并可重试关闭。

## 9. Workspace 与 Shutdown

- [ ] reserved 阶段阻止 TTL；
- [ ] admitting 阶段阻止 TTL；
- [ ] queued/running/validating/applying/cleanup 阻止 TTL；
- [ ] activity snapshot 失败时保守 active；
- [ ] Workspace close 只取消本账号；
- [ ] 兄弟 Workspace 继续运行；
- [ ] shutdown 期间拒绝新 HTTP 与 reservation；
- [ ] shutdown 发生在 admission 阻塞期间；
- [ ] Workspace close 发生在 reserved 阶段；
- [ ] shutdown 发生在 validating；
- [ ] shutdown 发生在 applying；
- [ ] 卡死子进程最终 SIGKILL；
- [ ] cleanup deadline；
- [ ] 重复 SIGTERM/SIGINT 复用同一 Promise；
- [ ] 总预算 30 秒；
- [ ] 内部 `AGENT_ABORTED` 统一映射为 `AGENT_CANCELLED`。

## 10. Docker 与供应链

- [ ] Linux x64 OpenCode checksum；
- [ ] Linux arm64 OpenCode checksum；
- [ ] invalid checksum build fail；
- [ ] agent-e2e target 包含 fixture/provider/harness；
- [ ] runtime target 不包含 fixture/provider/harness；
- [ ] runtime 使用非 root；
- [ ] prlimit 可用；
- [ ] real OpenCode 首轮发送真实 tools；
- [ ] controlled provider 根据真实 schema 返回 tool call；
- [ ] OpenCode 写唯一 result；
- [ ] 第二轮 completion；
- [ ] validator/CAS/transaction/receipt；
- [ ] 敏感 canary 不出现在日志、API 和构建产物。

## 11. 完整回归

- [ ] `npm run build`；
- [ ] `npm run test:web-agent-protocol`；
- [ ] `npm run test:web-agent-coordinator`；
- [ ] `npm run test:web-agent-executor`；
- [ ] `npm run test:web`；
- [ ] `npm run test:web-browser`；
- [ ] `npm run smoke:electron-native`；
- [ ] Docker Agent Foundation job；
- [ ] Docker Web business smoke；
- [ ] Docker production OAuth smoke；
- [ ] `npm run audit:production`；
- [ ] `git diff --check origin/main...HEAD`；
- [ ] GitHub Quality Gate 全绿。

## 12. 合并裁决

任何 P1 测试失败：`REQUEST_CHANGES`。
全部 Gate 通过，且浏览器 Agent 仍 pending、生产注册表为空、OS 级隔离边界未夸大：`APPROVE`。
