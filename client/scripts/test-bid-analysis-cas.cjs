const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSqliteDatabase } = require('../core/sqliteDatabase.cjs');
const { createTechnicalPlanStore } = require('../core/stores/technicalPlanStore.cjs');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bid-analysis-cas-'));
let database;
try {
  database = createSqliteDatabase({ workspaceRoot: tempRoot });
  const store = createTechnicalPlanStore({ db: database.db, workspaceRoot: tempRoot });
  const initial = store.getBidAnalysisInputVersion();
  assert.equal(initial.inputRevision, 0, '初始输入版本为零');

  store.saveBidAnalysisConfig({ mode: 'full', selectedTaskIds: ['projectOverview', 'techRequirements'] });
  const changed = store.getBidAnalysisInputVersion();
  assert.equal(changed.inputRevision, 1, '解析配置变更递增输入版本');
  assert.notEqual(changed.selectionHash, initial.selectionHash, '解析配置变更刷新选择哈希');

  assert.throws(
    () => store.updateTechnicalPlanForInputRevision(initial.inputRevision, {
      bidAnalysisTasks: {
        projectOverview: { id: 'projectOverview', label: '项目概况', status: 'success', content: '过期结果' },
      },
    }),
    (error) => error?.code === 'TASK_INPUT_CHANGED' && error?.retryable === true,
    '过期任务不能覆盖新版输入',
  );

  store.updateTechnicalPlanForInputRevision(changed.inputRevision, {
    bidAnalysisTasks: {
      projectOverview: { id: 'projectOverview', label: '项目概况', status: 'success', content: '当前结果' },
    },
  });
  const saved = store.loadTechnicalPlan();
  assert.equal(saved.bidAnalysisTasks.projectOverview.content, '当前结果', '当前版本允许落盘');

  const customSelection = ['projectOverview', 'techRequirements', 'projectInfo', 'partAInfo', 'deliveryAndServiceRequirements', 'procurementList'];
  store.updateTechnicalPlan({
    bidSectionMode: 'multiple',
    bidSections: [
      { id: 'section-a', title: '标段 A', startLine: 1, endLine: 10 },
      { id: 'section-b', title: '标段 B', startLine: 11, endLine: 20 },
    ],
    bidSectionExtractionStatus: 'success',
  });
  database.db.prepare(`
    UPDATE technical_plan_meta
    SET selected_section_id = 'section-a', selected_section_title = '标段 A'
    WHERE id = 1
  `).run();
  store.saveBidAnalysisConfig({ mode: 'custom', selectedTaskIds: customSelection, bidSectionMode: 'multiple' });
  const afterConfigSave = store.loadTechnicalPlan();
  const selectedSection = database.db.prepare(`
    SELECT selected_section_id AS id, selected_section_title AS title
    FROM technical_plan_meta WHERE id = 1
  `).get();
  assert.equal(afterConfigSave.bidSectionExtractionStatus, 'success', '仅切换解析项不清空已完成的多标段识别');
  assert.equal(afterConfigSave.bidSections.length, 2, '仅切换解析项保留已识别标段');
  assert.deepEqual(selectedSection, { id: 'section-a', title: '标段 A' }, '仅切换解析项保留已选标段');

  const ordinaryStart = store.prepareBidAnalysisRun({ mode: 'key', selectedTaskIds: ['projectOverview', 'techRequirements', 'projectInfo', 'partAInfo', 'deliveryAndServiceRequirements'] });
  assert.equal(ordinaryStart.inputVersion.inputRevision, 3, '普通启动配置变化也冻结新输入版本');
  assert.notEqual(ordinaryStart.inputVersion.selectionHash, changed.selectionHash, '普通启动配置变化刷新选择哈希');
  assert.throws(
    () => store.updateTechnicalPlanForInputRevision(changed.inputRevision, { projectOverview: '旧任务结果' }),
    (error) => error?.code === 'TASK_INPUT_CHANGED',
    '普通启动前的旧任务无法通过 CAS',
  );

  store.updateTechnicalPlan({
    bidAnalysisTasks: {
      projectOverview: { id: 'projectOverview', label: '项目概况', status: 'success', content: '待重跑结果' },
      techRequirements: { id: 'techRequirements', label: '技术要求', status: 'success', content: '保留结果' },
      projectInfo: { id: 'projectInfo', label: '项目信息', status: 'error', content: '', error: '模型超时', error_code: 'AI_TIMEOUT', retryable: true },
    },
    globalFacts: [{ id: 'fact-1', title: '事实', content: '待失效' }],
    contentGenerationOptions: { enabled: true },
    contentIllustrationPlan: { version: 1 },
  });
  const retryPrepared = store.prepareBidAnalysisRun({ taskIds: ['projectOverview'] });
  assert.equal(retryPrepared.inputVersion.inputRevision, 4, '单项重试创建新输入版本');
  const retryState = store.loadTechnicalPlan();
  assert.equal(retryState.bidAnalysisTasks.projectOverview, undefined, '单项重试仅清空目标项');
  assert.equal(retryState.bidAnalysisTasks.techRequirements.content, '保留结果', '单项重试保留其他成功项');
  assert.equal(retryState.bidAnalysisTasks.projectInfo.error_code, 'AI_TIMEOUT', 'item 错误码持久化');
  assert.equal(retryState.bidAnalysisTasks.projectInfo.retryable, true, 'item retryable 持久化');
  assert.deepEqual(retryState.globalFacts, [], '单项重试原子清空全局事实');
  assert.equal(retryState.contentGenerationOptions, undefined, '单项重试原子清空正文配置');
  assert.equal(retryState.contentIllustrationPlan, undefined, '单项重试原子清空图片计划');

  store.clearTechnicalPlan();
  assert.equal(store.getBidAnalysisInputVersion().inputRevision, 5, '清空工作区仍保持版本单调递增');
  console.log('Bid analysis input CAS tests passed.');
} finally {
  database?.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
