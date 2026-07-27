# J-1 Migration Inventory（固定顺序）

## 审核结论

- 已按 `.planning/wp-j-technical-plan-generation/wp-j.spec.md` 的固定顺序列出迁移清单。
- 当前阶段不改 Electron 行为、不改 `client/core/stores/**`，仅产出迁移清单与确定性行为证据。
- 证据来源：`client/fixtures/technical-plan-characterization/*` + `client/scripts/test-wp-j-characterization-sections.cjs` + `client/scripts/test-wp-j-characterization-outlines.cjs`。
- 本清单用于 J-1（多标段与目录纵向切片）迁移分解，分步出清后交给后续 PR 执行。

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
| 1 | `client/electron/services/bidSectionExtractionTask.cjs`（Electron 编排层） | 计划新增 `client/core/technical-plan/sectioning/sectionExtraction.cjs`（J-1 后续实现） | `splitUserTextByContextLimit`、`workspaceStore`、`tender.md`、AI collect JSON | `client/fixtures/technical-plan-characterization/j1-multi-section-selection.fixture.json`（`sectionExtractionResponses`） | J-1 技术方案小队 + Electron Adapter Owner | 迁移前后 `bidSections` 与 `bidSectionExtractionStatus` 行为一致 |
| 1 | `client/core/stores/technicalPlanStore.cjs`（Store-owned 边界：`selectBidSection`） | `client/core/technical-plan/sectioning/sectionSelection.cjs`（J-1 后续实现，默认不越过 Store） | SQLite、`technical-plan/tender.md`、`technical-plan/tender-original.md` | `client/fixtures/technical-plan-characterization/j1-multi-section-selection.fixture.json`（`selection`） | J-1 技术方案小队 + Store Adapter Owner | `tender.md` 与 tender metadata（`selected_section_*`）可复现、selection 重做可逆 |
| 2 | `client/electron/services/outlineGenerationTask.cjs`（标准方案+既有方案分支） | 计划新增 `client/core/technical-plan/outline/standardOutline.cjs`、`client/core/technical-plan/outline/existingOutline.cjs`（J-1 后续实现） | `outlineGenerationTask` 运行时环境、bid analysis 状态、AI 服务接口、原方案文件 | `client/fixtures/technical-plan-characterization/j1-standard-outline.fixture.json`；`client/fixtures/technical-plan-characterization/j1-existing-outline.fixture.json` | J-1 技术方案小队 + Adapter Owner | `workflowKind` 下标准与 existing 两条路径产物可复现对齐；`passed` 成功路径不触发多余 Agent 回退 |
| 3 | `client/electron/services/globalFactsTask.cjs`（J-2） | `client/core/technical-plan/facts/`（J-2） | AI 接口、bid analysis 状态、SQLite tasks | J-2 证据待补 | J-2 技术方案小队 | 按 PR J-2 Gate 完成 |
| 4 | `client/electron/services/contentGenerationTask.cjs`（J-2） | `client/core/technical-plan/content/`（J-2） | AI 接口、outline、SQLite tasks、runtime checkpoints | J-2 证据待补 | J-2 技术方案小队 | 按 PR J-2 Gate 完成 |
| 5 | `client/electron/services/contentGenerationTask.cjs`（校验与修复子流） | `client/core/technical-plan/review/`（J-3） | AI 接口、outline、word-control、知识库 | J-3 证据待补 | J-3 技术方案小队 | 按 PR J-3 Gate 完成 |
| 6 | `client/electron/services/outlineGenerationTask.cjs` 的 `contentIllustrationPlan` 输出 | `client/shared/contracts/technical-plan/` 与 `client/core/technical-plan/illustration/`（J-2/3） | `contentIllustrationPlan.items[*].generation` 兼容策略、持久化与 schema | J-2/3 证据待补 | J-2/3 技术方案小队 | 与 WP-L/Sidecar 协同冻结后执行 |

## 证据边界（本 PR）

- **纯业务逻辑（portable）**：`detectBidSections`、`buildBidSectionContextHint`、多标段/目录输出归并规则（均在 core/helper 或 task 纯逻辑层）。
- **Electron-only 适配器关注点**：文件系统落盘、SQLite 持久化入口、任务启动与 task snapshot 更新路径、以及与 Electron 任务服务的适配。
- **本包输出**：不改变现有 Electron 行为，仅提供“证据脚手架 + 可复用的迁移顺序与边界清单”供 J-1 实施前后对照。
