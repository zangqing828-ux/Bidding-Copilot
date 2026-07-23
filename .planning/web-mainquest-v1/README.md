# Bidding Copilot Web · MainQuest v1 规划索引

## 当前结论

本项目采用 7 个顺序 Sprint 完成 Web 化。首版保留现有 React 页面、组件、布局与交互，只对保留页面执行 MainQuest MQDS v4.1 浅色配色替换。深色模式、组件重做、信息架构重排均不进入 v1。

## 承接位置

- 集成分支：`feature/web-mainquest-v1`
- 集成 worktree：`/Users/dingcheng/Coding-Project/02-key-project/Bidding-Copilot-web-mainquest`
- 基线提交：`d595f58c95fca06e7fa35a5c93c097e28c5963f2`
- 规划日期：`2026-07-23`

## 文档导航

1. [SDD 总控方案](./00-sdd-master-plan.md)
2. [Sprint 01：基线冻结与产品能力删减](./01-sprint-baseline-and-pruning.spec.md)
3. [Sprint 02：Web 运行时与浏览器 Bridge](./02-sprint-web-runtime-and-bridge.spec.md)
4. [Sprint 03：MainQuest OAuth 与 Web 会话](./03-sprint-mainquest-oauth.spec.md)
5. [Sprint 04：账号工作区与浏览器文件流](./04-sprint-account-workspace-and-files.spec.md)
6. [Sprint 05：后台任务、Linux Runtime 与导出](./05-sprint-tasks-linux-and-export.spec.md)
7. [Sprint 06：MQDS 浅色配色替换](./06-sprint-mqds-light-colors.spec.md)
8. [Sprint 07：容器部署与整体验收](./07-sprint-deployment-and-acceptance.spec.md)

## v1 产品边界

### 保留

- 技术方案生成与已有方案扩写
- 知识库
- 标书查重
- 废标项检查
- 模板与导出格式
- AI、Agent 与开发配置中仍服务于保留业务的能力
- 现有埋点、模型使用统计和 Analytics 服务

### 删除

- 资源下载
- 投标机会
- 插件管理
- 上述三项对应的菜单、路由、页面、样式和应用侧服务入口

### 前端约束

- 只做浅色配色替换。
- 保持现有组件树、页面结构、布局、间距、字号、圆角、阴影参数和交互流程。
- 保持现有产品名称与图标结构；品牌结构调整留到后续版本。
- 不增加主题开关、`data-theme`、深色 Token 或深色资源。

## 需要老板在实施前确认的产品假设

规划先按以下默认值编写，进入对应 Sprint 前仍保留一次确认门：

1. Web v1 采用每个 MainQuest 账号独立 SQLite 与文件目录。
2. Web 端使用 MainQuest 产品访问权限，桌面端机器授权逻辑不接入 Web。
3. 用户继续自带模型配置，API Key 在服务端加密保存，浏览器只显示脱敏结果。
4. v1 使用单实例容器和持久卷，暂不支持横向扩容。
5. 正式域名、OAuth Client、回调地址和生产密钥由部署阶段注入，不写入仓库。
