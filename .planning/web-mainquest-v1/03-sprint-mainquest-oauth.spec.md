# Sprint 03 Spec：MainQuest OAuth 与 Web 会话

## 1. Sprint 结果

用户通过 MainQuest OAuth 登录 Web 端，服务端安全完成授权码交换，浏览器持有 HttpOnly 会话，所有业务 API 都能识别当前账号。

## 2. 前置条件

- Sprint 02 为 `PASS`。
- 老板确认 Web 授权使用 MainQuest 产品访问权限。
- 老板确认每账号独立数据模型。
- 已获得测试环境 OAuth Client ID、Client Secret、Product ID 和精确回调地址。

## 3. OAuth 协议

当前对接点：

- `GET /oauth/authorize`
- `POST /oauth/token`
- `GET /oauth/me`

Web 端流程：

1. `GET /api/auth/login` 生成随机 state，写入短期服务端状态并跳转 MainQuest Auth。
2. MainQuest Auth 完成登录和产品访问检查。
3. 回调 `GET /api/auth/callback`。
4. 服务端校验 state。
5. 服务端使用 Client Secret 交换授权码。
6. 服务端调用 `/oauth/me` 获取用户身份。
7. 写入或更新本地账号映射。
8. 创建本地会话，写入 HttpOnly、Secure、SameSite=Lax Cookie。
9. 跳转 Web 首页。

Client Secret 只存在于服务端环境变量。

## 4. 计划模块

建议新增：

```text
client/server/auth/oauthClient.cjs
client/server/auth/sessionStore.cjs
client/server/auth/accountStore.cjs
client/server/middleware/requireAuth.cjs
client/server/routes/auth.cjs
client/server/database/systemDatabase.cjs
```

建议 API：

```text
GET  /api/auth/login
GET  /api/auth/callback
GET  /api/auth/me
POST /api/auth/logout
```

## 5. 会话模型

- 浏览器只持有随机 session ID。
- session 数据存于服务端 SQLite。
- 会话保存本地账号 ID、MainQuest subject、显示信息、创建时间和过期时间。
- Cookie 不保存 access token、用户资料或产品权限详情。
- OAuth access token 只在服务端短期使用；如无持续调用需要，完成 `/oauth/me` 后不长期保存。
- 会话过期策略在实施前固定，默认 7 天绝对过期。

## 6. SDD 方案

- 模式：SDD Heavy。
- 开发工包 A：OAuth client、state、callback、MainQuest 用户映射。
- 开发工包 B：本地 session、Cookie、`requireAuth`、前端登录态。
- 工包 A 不修改业务 Store；工包 B 不修改 OAuth token 交换。
- 两工包依赖系统库 schema，由主线程先冻结 schema 后再并行。
- 审查：Terra High + Sol Medium。
- Terra 重点：state、会话固定、Cookie、secret、回调错误、开放路由。
- Sol 重点：授权边界、会话模型、产品权限假设和操作后果。

## 7. 接口保护

公开接口仅包括：

- `/api/health`
- `/api/runtime-config`
- `/api/auth/login`
- `/api/auth/callback`

`/api/auth/me` 可返回 401。其他 `/api/*` 必须经过 `requireAuth`。

## 8. 验收标准

- 未登录访问业务 API 返回 401。
- 登录按钮跳转到 MainQuest Auth。
- 正常回调建立本地会话并返回 Web 首页。
- state 缺失、错误、过期或重复使用时登录失败。
- OAuth code 交换失败时不建立会话。
- Client Secret 不进入前端 bundle、响应或日志。
- `/api/auth/me` 返回最小用户展示信息。
- 退出后当前 session 失效。
- 被撤销产品访问的处理策略明确；v1 至少在重新登录时阻断。
- 反向代理下 Secure Cookie 和回调协议正确。

## 9. 验证

自动化覆盖：

- 未登录业务接口。
- state 成功、错误、过期、重复。
- token endpoint 错误。
- `/oauth/me` 错误。
- session 创建、过期、退出。
- Cookie 属性。

命令：

```bash
cd client
npm run build
npm run test:web-auth
```

手动验证：

- 测试账号成功登录和退出。
- 无产品权限账号被 MainQuest Auth 拦截。
- 浏览器开发者工具中无 Client Secret。
- 反向代理测试环境完成一次完整回调。

## 10. 配置

环境变量至少包含：

```text
MAINQUEST_AUTH_BASE_URL
MAINQUEST_OAUTH_CLIENT_ID
MAINQUEST_OAUTH_CLIENT_SECRET
MAINQUEST_PRODUCT_ID
MAINQUEST_OAUTH_REDIRECT_URI
SESSION_SECRET
PUBLIC_BASE_URL
```

启动时校验必需配置，错误信息只列配置名。

## 11. 回滚

- 系统身份库独立于业务工作区。
- 回滚代码前先使新会话失效。
- 不删除账号映射和审计记录。

## 12. Sprint 04 交接物

- 可靠的 `request.account` / `request.workspaceId`。
- 系统身份与会话 schema。
- OAuth 测试证据。
- 冻结 commit SHA 与双审查结论。
