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
  assert.equal(retryPrepared.inputVersion.inputRevision, 2, '单项重试创建新输入版本');
  const retryState = store.loadTechnicalPlan();
  assert.equal(retryState.bidAnalysisTasks.projectOverview, undefined, '单项重试仅清空目标项');
  assert.equal(retryState.bidAnalysisTasks.techRequirements.content, '保留结果', '单项重试保留其他成功项');
  assert.equal(retryState.bidAnalysisTasks.projectInfo.error_code, 'AI_TIMEOUT', 'item 错误码持久化');
  assert.equal(retryState.bidAnalysisTasks.projectInfo.retryable, true, 'item retryable 持久化');
  assert.deepEqual(retryState.globalFacts, [], '单项重试原子清空全局事实');
  assert.equal(retryState.contentGenerationOptions, undefined, '单项重试原子清空正文配置');
  assert.equal(retryState.contentIllustrationPlan, undefined, '单项重试原子清空图片计划');

  store.clearTechnicalPlan();
  assert.equal(store.getBidAnalysisInputVersion().inputRevision, 3, '清空工作区仍保持版本单调递增');
  console.log('Bid analysis input CAS tests passed.');
} finally {
  database?.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
