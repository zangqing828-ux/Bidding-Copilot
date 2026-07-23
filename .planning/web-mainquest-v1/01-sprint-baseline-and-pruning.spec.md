# Sprint 01 Spec：基线冻结与产品能力删减

## 1. Sprint 结果

建立可回归的客户端基线，并从应用中完整移除资源下载、投标机会、插件管理及其入口。保留功能的构建和基础启动保持正常。

## 2. 前置条件

- 集成分支指向 `d595f58c95fca06e7fa35a5c93c097e28c5963f2` 或其后仅包含规划文档的提交。
- `client/npm ci` 和现有构建基线有记录。
- 确认 `analytics/` 保持只读。

## 3. 范围

### 3.1 删除 Renderer 入口

- `client/src/app/menuConfig.ts`
- `client/src/app/AppRouter.tsx`
- `client/src/shared/types/navigation.ts`
- 三个 feature 目录：
  - `client/src/features/resources/`
  - `client/src/features/bid-opportunity/`
  - `client/src/features/plugins/`
- 对应 CSS 文件及 `client/src/styles.css` import。

### 3.2 删除插件应用侧链路

- `client/electron/preload.cjs` 的 `plugins` bridge。
- `client/src/shared/types/ipc.ts` 的插件接口。
- `client/electron/ipc/pluginIpc.cjs`。
- `client/electron/services/pluginService.cjs`。
- `client/electron/services/pluginContext.cjs`。
- `client/electron/services/pluginConfigWindow.cjs`。
- `client/electron/ipc/index.cjs` 中的注册、服务注入和自动启用逻辑。

### 3.3 依赖检查

- 先用引用搜索确认插件类型、manifest、窗口和 service 没有保留调用方。
- `adm-zip` 仍有其他业务用途时继续保留。
- 删除页面后清理仅由这些页面使用的 import、类型和样式。

## 4. 禁改范围

- 不删除或弱化 `analytics/worker`、`analytics/dashboard` 和统计聚合。
- 不修改保留页面的布局、组件、文案和颜色。
- 不开始 Web server、OAuth 或存储改造。
- 不顺手清理其他死代码。

## 5. SDD 方案

- 模式：SDD Light。
- 开发工包：1 个 Spark worker。
- 所有权：本 Spec 3.1 至 3.3 列出的文件。
- 审查：Terra High，重点检查残留入口、跨文件引用、构建回归和 Analytics 误伤。
- 升级触发：发现插件运行时被保留业务动态依赖，立即升级为 Heavy 并回主线程重划范围。

## 6. 实施顺序

1. 记录 `npm ci`、`npm run build` 基线。
2. 删除菜单、路由和导航类型。
3. 删除三个页面及样式。
4. 删除插件 preload、IPC、service 和类型。
5. 全仓引用搜索。
6. 运行语法、TypeScript 和 Vite 构建。
7. 冻结 Sprint commit，执行只读审查。

## 7. 验收标准

- 主菜单没有资源下载、投标机会、插件管理。
- 通过旧 Section ID 无法进入对应页面。
- `window.yibiao.plugins` 不再存在。
- 应用启动时不注册、不扫描、不激活插件。
- 三个 feature 目录和对应样式已删除。
- `rg` 只允许在历史文档、Analytics 后台或依赖说明中出现相关词。
- 保留页面可进入。
- `npm run build` 退出码为 0。

## 8. 验证

```bash
cd client
npm ci
node --check electron/preload.cjs
node --check electron/ipc/index.cjs
npm run build
```

引用检查：

```bash
rg -n "bid-opportunity|plugin-manager|features/plugins|features/resources|window\\.yibiao.*plugins" client
```

手动冒烟：

- 启动 Electron。
- 逐个打开保留菜单。
- 检查控制台没有缺失模块和插件初始化错误。

## 9. 回滚

- 整个 Sprint 保持一个独立提交。
- 回滚该提交即可恢复三个能力。
- 不执行用户插件目录或业务数据删除。

## 10. Sprint 02 交接物

- 干净的应用导航面。
- 删除能力残留搜索结果。
- 基线构建记录。
- 冻结 commit SHA。
