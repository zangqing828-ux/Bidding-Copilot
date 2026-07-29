# BidMaster Web 发布 Spec Pack

状态：`READY_FOR_IMPLEMENTATION`

基线提交：`6652dd56c3cce9d4eac101a320120acd4a6a560f`

发布目标：以最短可验证路径交付纯 Web、单租户、MainQuest Auth、Docker 单实例 ECS 版本，并完整覆盖技术标生成、图片和高保真 DOCX。

## 阅读顺序

1. [`00-master-spec.md`](./00-master-spec.md)：总目标、执行顺序、代码预算和发布 Gate。
2. [`01-current-state-and-gap-matrix.md`](./01-current-state-and-gap-matrix.md)：当前实现事实、体量解释和差距。
3. [`02-target-architecture-and-deletion-map.md`](./02-target-architecture-and-deletion-map.md)：目标架构、数据流、删除与保留边界。
4. [`03-work-packages.md`](./03-work-packages.md)：逐工作包开发任务、文件边界、预算和退出条件。
5. [`04-test-and-release-gates.md`](./04-test-and-release-gates.md)：测试矩阵、本地 RC 和发布验收。
6. [`05-mainquest-ecs-runbook.md`](./05-mainquest-ecs-runbook.md)：MainQuest 注册、镜像分发、ECS、备份和回滚。
7. [`06-traceability-and-decisions.md`](./06-traceability-and-decisions.md)：41 个 pending 的去向、决策记录和兼容 allowlist。

## Pack 使用规则

- 每次只实施一个 `WR-*` 工作包。
- 每个工作包使用独立 `codex/web-st-*` 分支和 sibling worktree。
- 只从 `codex/web-single-tenant-baseline` 创建工作包分支。
- 每包先写失败测试，再完成实现，再运行该包门禁。
- 单包业务源码净新增超过 1,000 行立即暂停；首发业务源码上限 3,000 行，测试/手写脚本
  上限 6,000 行，全部手写代码上限 9,000 行。
- 归档分支只允许逐文件取证和移植，禁止 merge、整目录复制或成套 cherry-pick。
- 本地 RC Gate 未通过前，禁止部署 ECS。
