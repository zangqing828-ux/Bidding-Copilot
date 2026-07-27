# J-1 Migration Inventory（固定顺序）

## 审核结论

- 已按 `.planning/wp-j-technical-plan-generation/wp-j.spec.md` 的固定顺序列出迁移清单。
- J-1 已将多标段、选段和目录编排迁入 portable core，并通过 Web adapter 接入正式业务入口。
- Store 已升级到 schema v24，加入 stage revision、RunManifest/CAS、任务执行记录，以及 `IllustrationPlan` 与 render receipt 的幂等拆分迁移。
- Electron 继续使用相同 core Store，并由 Electron adapter 重组旧版 `generation` 兼容视图。
- 证据来源：`client/fixtures/technical-plan-characterization/*` + `client/scripts/test-wp-j-characterization-sections.cjs` + `client/scripts/test-wp-j-characterization-outlines.cjs`。
- 本清单记录 J-1 已实施边界，并继续约束 J-2/J-3 的迁移顺序。

## 固定迁移顺序

1. 多标段与选段
2. 目录结构化生成
3. 全局事实
4. 正文逐章生成与 checkpoint
5. 审校与修复
6. `IllustrationPlan v1`

## 模块级迁移清单

| 顺序 | 来源位置（Core/Electron） | portable 目标 | 环境依赖 | 输入/输出 fixture | Adapter Owner | Exit Gate |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `client/core/bidSectionDetector.cjs`（已在 core 的可迁移目标） | 保持在 `client/core/bidSectionDetector.cjs`（Portable baseline） | 无副作用，纯文本输入 | `client/fixtures/technical-plan-characterization/j1-multi-section-selection.fixture.json`（`detection`） | J-1 技术方案小队 | 对照 `detectBidSections` 与 `buildBidSectionContextHint` 生成同一结果 |
| 1 | `client/electron/services/bidSectionExtractionTask.cjs`（Electron 编排层） | `client/core/technical-plan/orchestration/bidSectionExtractionTask.cjs` | `splitUserTextByContextLimit`、workspace Store、AI collect JSON | `client/fixtures/technical-plan-characterization/j1-multi-section-selection.fixture.json`（`sectionExtractionResponses`） | Portable Core + Web/Electron Adapter Owner | 迁移前后 `bidSections` 与任务终态一致；Web J-Core 不调用自由 Agent |
| 1 | `client/core/stores/technicalPlanStore.cjs`（Store-owned 边界：`selectBidSection`） | Store 事务内选段、working copy 重建、stage revision/CAS | SQLite、`technical-plan/tender.md`、`technical-plan/tender-original.md` | `client/fixtures/technical-plan-characterization/j1-multi-section-selection.fixture.json`（`selection`） | Store Adapter Owner | `tender.md` 与 selected-section metadata 可复现；重复识别先恢复 original working copy |
| 2 | `client/electron/services/outlineGenerationTask.cjs`（标准方案+已有方案分支） | `client/core/technical-plan/orchestration/outlineGenerationTask.cjs` + `client/core/technical-plan/outline/` | portable AI port、bid analysis 状态、原方案只读输入 | `client/fixtures/technical-plan-characterization/j1-standard-outline.fixture.json`；`client/fixtures/technical-plan-characterization/j1-existing-outline.fixture.json` | Portable Core + Web/Electron Adapter Owner | 标准与 existing 两条路径产物可复现；目录总节点不超过 1000；J-Core 不调用自由 Agent |
| 3 | `client/electron/services/globalFactsTask.cjs`（J-2） | `client/core/technical-plan/facts/`（J-2） | AI 接口、bid analysis 状态、SQLite tasks | J-2 证据待补 | J-2 技术方案小队 | 按 PR J-2 Gate 完成 |
| 4 | `client/electron/services/contentGenerationTask.cjs`（J-2） | `client/core/technical-plan/content/`（J-2） | AI 接口、outline、SQLite tasks、runtime checkpoints | J-2 证据待补 | J-2 技术方案小队 | 按 PR J-2 Gate 完成 |
| 5 | `client/electron/services/contentGenerationTask.cjs`（校验与修复子流） | `client/core/technical-plan/review/`（J-3） | AI 接口、outline、word-control、知识库 | J-3 证据待补 | J-3 技术方案小队 | 按 PR J-3 Gate 完成 |
| 6 | `client/electron/services/outlineGenerationTask.cjs` 的 `contentIllustrationPlan` 输出 | v24 已拆分纯 `IllustrationPlan` 与 `technical_plan_illustration_render_receipts`；具体生成编排留在 J-2/3 | SQLite migration、Electron 兼容重组 adapter | `client/scripts/test-wp-j-store-cas.cjs` | J-1 Store Owner；J-2/3 业务 Owner | v23 旧数据幂等迁移，Web 不返回内嵌 generation，Electron 兼容视图保持 |

## J-1 证据边界

- **纯业务逻辑（portable）**：`detectBidSections`、多标段提取编排、目录结构归一化、1000 节点上限和标准/已有方案目录 runner。
- **Store-owned 边界**：schema v24、stage revision、RunManifest/CAS、working copy、任务终态与业务结果原子提交。
- **Adapter 关注点**：Web Bridge DTO 映射一次；Electron 只保留环境装配与旧配图 generation 兼容视图。
- **真实业务证据**：`npm run wp-j:gate:j1` 与 `npm run test:web-technical-plan-browser`。本地执行说明见 `docs/runbooks/wp-j-local-dev.md`。
