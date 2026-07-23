# Sprint 02 Spec：Web 运行时与浏览器 Bridge

## 1. Sprint 结果

浏览器可以启动现有 React 应用，Node 服务可以提供静态页面、健康检查和统一 API 入口，Renderer 在浏览器中通过 Web Bridge 使用与 `window.yibiao` 一致的调用门面。

## 2. 前置条件

- Sprint 01 为 `PASS`。
- 部署拓扑确认采用单实例服务和持久卷。
- gbrain policy 已确认。

## 3. 技术决策

- 服务端使用 Node + Express，保持现有 CommonJS 服务风格。
- 前端继续使用 Vite + React。
- Web Bridge 使用 `fetch` 和 SSE。
- 浏览器缺少 Electron preload 时安装 Web Bridge；Electron 环境继续使用 preload bridge。
- 未迁移的业务接口返回明确的 `501 WEB_CAPABILITY_PENDING`，不得返回伪造成功结果。
- `/api/health` 和 `/api/runtime-config` 无需登录；其余业务 API 从 Sprint 03 开始统一保护。

## 4. 计划文件

建议新增：

```text
client/server/index.cjs
client/server/app.cjs
client/server/config.cjs
client/server/routes/health.cjs
client/server/routes/runtimeConfig.cjs
client/server/routes/bridge.cjs
client/src/shared/api/webBridge.ts
client/src/shared/api/httpClient.ts
client/src/shared/runtime/installRuntimeBridge.ts
```

建议修改：

```text
client/package.json
client/vite.config.ts
client/src/main.tsx
client/src/shared/types/ipc.ts
```

最终文件名可以贴合仓库风格微调，职责边界保持不变。

## 5. SDD 方案

- 模式：SDD Heavy。
- 开发工包 A：服务端启动、静态文件、健康检查、运行时配置。
- 开发工包 B：Web Bridge、HTTP client、浏览器启动选择。
- 工包 A 不修改 Renderer；工包 B 不修改 Electron services。
- 两个工包可以并行，`package.json` 和 `vite.config.ts` 由主线程集中集成，避免冲突。
- 审查：Terra High + Sol Medium 并行。
- Terra 重点：Electron 回归、错误处理、静态资源、接口边界。
- Sol 重点：Bridge 兼容策略、增量迁移是否足够简单。

## 6. 实施顺序

1. 建立 Web server 和配置加载。
2. 增加 `/api/health`、`/api/runtime-config`。
3. 增加生产静态文件托管和 SPA fallback。
4. 增加 HTTP client 和 Web Bridge。
5. 在 React 启动前安装正确的 runtime bridge。
6. 增加 `dev:web`、`build:web`、`start:web`。
7. 同时验证 Web 与 Electron 构建。

## 7. 验收标准

- `npm run dev:web` 可在浏览器打开应用 Shell。
- 浏览器刷新任意前端路由后仍能回到 SPA。
- `/api/health` 返回版本、状态和进程存活信息，不包含密钥和路径。
- `/api/runtime-config` 只返回浏览器需要的公开配置。
- Electron 启动继续使用 preload bridge。
- 浏览器环境不会引用 `ipcRenderer`、`fs` 或 Electron 模块。
- 未迁移动作向用户显示可解释错误。
- Web 和 Electron 的 TypeScript/Vite 构建均通过。

## 8. 验证

```bash
cd client
npm run build
npm run build:web
npm run start:web
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS http://127.0.0.1:3000/api/runtime-config
```

手动验证：

- 浏览器打开应用。
- 刷新首页和一个二级页面。
- Electron 启动并打开同一页面。
- 触发一个尚未迁移动作，确认错误码和 Toast 可理解。

## 9. 安全与失败路径

- 服务端不向客户端返回本地绝对路径。
- 统一限制 JSON body 大小。
- 统一错误响应不带 stack。
- 生产模式关闭详细调试输出。
- `trust proxy` 配置在 Sprint 03 随 OAuth 一起落地。

## 10. 回滚

- Web 启动入口为增量能力。
- 回滚 Sprint 提交后 Electron 路径继续可用。
- 不迁移业务数据。

## 11. Sprint 03 交接物

- 可访问的 Web Shell。
- Web Bridge 接口清单和待迁移矩阵。
- 服务端配置入口。
- 冻结 commit SHA 与双审查结论。
