# Sprint 04 Spec：账号工作区与浏览器文件流

## 1. Sprint 结果

每个 MainQuest 账号拥有独立配置、SQLite 和业务文件目录；浏览器可以通过上传与下载完成原 Electron 文件选择流程，并且无法跨账号读取数据。

## 2. 前置条件

- Sprint 03 为 `PASS`。
- `request.workspaceId` 稳定可用。
- 老板确认用户自带模型配置，并允许服务端加密保存。
- 部署环境可提供固定 `CONFIG_ENCRYPTION_KEY` 和持久卷。

## 3. 数据隔离设计

- MainQuest subject 先映射到本地随机 workspace UUID。
- 文件路径只使用本地 workspace UUID。
- 每次请求从会话解析 workspace，不接受浏览器提交 workspace 路径。
- SQLite connection、Store、临时文件和日志均从 request context 获取账号根目录。
- 业务表继续沿用现有 schema v18 及后续 migration。
- 所有 Store factory 按 workspace 创建或缓存，缓存键为本地 workspace UUID。

## 4. 配置与密钥

- 现有用户配置迁移为账号级服务端配置。
- API Key 使用服务端主密钥加密后落盘。
- 推荐 AES-256-GCM，每条记录使用独立 nonce。
- 浏览器读取时只返回是否已配置、末尾少量字符和非敏感字段。
- 更新 Key 时浏览器提交新值，服务端不回显明文。
- 日志与错误响应禁止输出 Key、Token、Base URL 中的凭据参数。

## 5. 浏览器文件交互

Electron dialog 对应 Web 处理：

| 桌面动作 | Web 动作 |
| --- | --- |
| 打开招标文件 | multipart upload |
| 导入知识库文档 | multipart upload |
| 导入查重/废标文件 | multipart upload |
| 选择已有方案 | multipart upload |
| 保存导出文件 | 服务端生成后返回下载 |

上传规则：

- 在 Web 边界检查登录态、大小、扩展名、MIME 和文件数量。
- 文件名只用于展示，服务端使用生成 ID 落盘。
- 解析服务只接收服务端生成的绝对路径。
- 上传失败和解析失败清理临时文件。
- 下载使用一次性业务 ID，不接受任意路径参数。

## 6. 计划模块

建议新增：

```text
client/server/workspace/workspaceContext.cjs
client/server/workspace/workspaceRegistry.cjs
client/server/config/encryptedConfigStore.cjs
client/server/routes/uploads.cjs
client/server/routes/downloads.cjs
client/server/middleware/uploadLimits.cjs
```

建议抽取：

- `client/electron/utils/paths.cjs` 中与 Electron `app` 无关的路径规则。
- `sqliteDatabase.cjs` 和各 Store 的 workspace root 注入。
- 文件解析服务中 dialog 选择与实际解析两个阶段。

## 7. SDD 方案

- 模式：SDD Heavy。
- 开发工包 A：workspace registry、路径、SQLite/Store 多账号实例。
- 开发工包 B：加密配置和账号级配置 API。
- 开发工包 C：上传、临时文件、下载 ID 和浏览器文件适配。
- A 先冻结 workspace context 接口；B、C 再并行。
- 每个工包拥有独立模块，现有 service 的共享修改由主线程集中集成。
- 审查：Terra High + Sol Medium。
- Terra 重点：路径穿越、跨账号缓存、临时文件、密钥和 migration。
- Sol 重点：账号隔离模型、BYOK 体验和最小迁移方案。

## 8. 验收标准

- 两个测试账号拥有不同 SQLite 和目录。
- 账号 A 无法通过 ID、文件名、URL 或任务引用访问账号 B 数据。
- 同一账号重新登录后能看到原数据。
- 容器进程重启后数据仍在。
- 配置 API 不回显 Key 明文。
- 招标文件、已有方案、知识库、查重和废标检查所需文件可从浏览器上传。
- 取消上传、超限、错误格式和解析失败有清晰提示。
- 临时文件按成功、失败和过期策略清理。
- Electron 文件选择路径继续工作。

## 9. 验证

自动化必须覆盖：

- workspace path 生成。
- 两账号 Store 隔离。
- SQLite migration。
- Key 加密、解密、错误主密钥。
- 上传大小、类型、数量和路径穿越。
- 下载 ID 的账号归属。

命令：

```bash
cd client
node --check electron/services/sqliteDatabase.cjs
npm run build
npm run test:web-workspace
npm run test:web-files
```

手动验证：

- 账号 A 上传一份测试文件并生成业务记录。
- 账号 B 登录后确认不可见。
- 切回账号 A，确认数据仍在。
- 重启服务，重复确认。

## 10. 回滚

- 新账号目录不自动删除。
- migration 必须向前兼容；涉及 schema 时同时更新 `sql/workspace_schema.sql`。
- 回滚代码前先验证旧版本能打开当前 schema。

## 11. Sprint 05 交接物

- request-scoped workspace context。
- 多账号 Store factory。
- 浏览器上传和受控下载。
- 加密配置能力。
- 隔离测试证据与冻结 commit SHA。
