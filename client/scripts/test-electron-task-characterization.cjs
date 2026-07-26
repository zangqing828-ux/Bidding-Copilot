const assert = require('node:assert/strict');
const { createTaskService, taskDefinitions } = require('../electron/services/taskService.cjs');

const TASK_MATRIX = Object.freeze([
  ['bid-section-extraction', 'technicalPlan', 'bidSectionExtractionTask', 'technical-plan'],
  ['bid-analysis', 'technicalPlan', 'bidAnalysisTask', 'technical-plan'],
  ['outline-generation', 'technicalPlan', 'outlineGenerationTask', 'technical-plan'],
  ['global-facts-generation', 'technicalPlan', 'globalFactsTask', 'technical-plan'],
  ['content-generation', 'technicalPlan', 'contentGenerationTask', 'technical-plan'],
  ['rejection-items-extraction', 'rejectionCheck', 'extractionTask', 'rejection-check'],
  ['rejection-check-run', 'rejectionCheck', 'checkTask', 'rejection-check'],
  ['duplicate-analysis', 'duplicateCheck', 'analysisTask', 'duplicate-check'],
]);

function createStateStore(initial = {}, loadName, updateName) {
  let state = { ...initial };
  return {
    [loadName]() { return state; },
    [updateName](partial) { state = { ...state, ...partial }; return state; },
    get state() { return state; },
  };
}

function createHarness(initial = {}) {
  const technicalPlanStore = createStateStore({ outlineWordControlSnapshot: {}, ...(initial.technicalPlan || {}) }, 'loadTechnicalPlan', 'updateTechnicalPlan');
  technicalPlanStore.updateTechnicalPlanWithoutReload = technicalPlanStore.updateTechnicalPlan;
  const rejectionCheckStore = createStateStore(initial.rejectionCheck, 'loadRejectionCheck', 'updateRejectionCheck');
  const duplicateCheckStore = createStateStore(initial.duplicateCheck, 'loadDuplicateCheck', 'updateDuplicateCheck');
  const releases = new Map();
  const taskRunners = Object.fromEntries(TASK_MATRIX.map(([type]) => [type, () => new Promise((resolve) => releases.set(type, resolve))]));
  const events = [];
  const service = createTaskService({
    aiService: { withQueueScope: () => ({}), resumeQueueScope: () => {} },
    agentService: { bindSelectedRuntime: () => ({}) },
    technicalPlanStore,
    rejectionCheckStore,
    duplicateCheckStore,
    duplicateCheckService: { runAnalysisTask: taskRunners['duplicate-analysis'] },
    taskRunners,
  });
  const unsubscribe = service.subscribeCallback((event) => events.push(event));
  return { service, technicalPlanStore, rejectionCheckStore, duplicateCheckStore, releases, events, unsubscribe };
}

function start(service, type) {
  switch (type) {
    case 'bid-section-extraction': return service.startBidSectionExtraction({});
    case 'bid-analysis': return service.startBidAnalysis({ mode: 'key' });
    case 'outline-generation': return service.startOutlineGeneration({});
    case 'global-facts-generation': return service.startGlobalFactsGeneration({});
    case 'content-generation': return service.startContentGeneration({});
    case 'rejection-items-extraction': return service.startRejectionItemsExtraction({});
    case 'rejection-check-run': return service.startRejectionCheck({});
    case 'duplicate-analysis': return service.startDuplicateAnalysis({ tenderFile: { file_path: 'tender.md', size: 1, modified_at: '1' } });
    default: throw new Error(`unknown task ${type}`);
  }
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function main() {
  assert.equal(TASK_MATRIX.length, 8, '行为矩阵覆盖八类 Electron 任务');
  for (const [type, stateKey, field, group] of TASK_MATRIX) {
    const definition = taskDefinitions[type];
    assert.ok(definition, `${type} 已注册`);
    assert.equal(definition.stateKey, stateKey, `${type} 状态存储不变`);
    assert.equal(definition.field, field, `${type} 任务字段不变`);
    assert.equal(definition.group, group, `${type} 任务组不变`);

    const harness = createHarness();
    const task = start(harness.service, type);
    assert.equal(task.type, type, `${type} 启动类型正确`);
    assert.equal(task.status, 'running', `${type} 启动即 running`);
    assert.equal(task.group, group, `${type} 保留任务组`);
    assert.strictEqual(start(harness.service, type), task, `${type} 重复启动返回当前任务`);
    assert.equal(harness.service.getActiveTasks().length, 1, `${type} active task 可回放`);
    assert.ok(harness.events.some((event) => event.task.task_id === task.task_id), `${type} 启动后产生订阅事件`);
    harness.releases.get(type)();
    await flush();
    assert.equal(harness.service.getActiveTasks().length, 0, `${type} runner 收口后释放 active task`);
    harness.unsubscribe();
  }

  const conflictHarness = createHarness();
  conflictHarness.service.startBidAnalysis({ mode: 'key' });
  assert.throws(() => conflictHarness.service.startOutlineGeneration({}), /技术方案正在执行/, '同一任务组保持互斥');
  conflictHarness.releases.get('bid-analysis')();
  await flush();

  const recoveryHarness = createHarness({
    technicalPlan: {
      bidSectionExtractionTask: { status: 'running', logs: [] },
      bidAnalysisTask: { status: 'running', logs: [] },
      bidAnalysisTasks: { projectOverview: { status: 'running', content: '' } },
      outlineGenerationTask: { status: 'running', logs: [] },
      globalFactsTask: { status: 'running', logs: [] },
      contentGenerationTask: { status: 'running', logs: [], stats: {} },
      contentGenerationSections: {},
    },
    rejectionCheck: {
      extractionTask: { status: 'running' },
      checkTask: { status: 'running' },
    },
    duplicateCheck: { analysisTask: { status: 'running' } },
  });
  recoveryHarness.service.getActiveTasks();
  assert.equal(recoveryHarness.technicalPlanStore.state.bidSectionExtractionTask.status, 'error', '多标段识别重启后可重试');
  assert.equal(recoveryHarness.technicalPlanStore.state.bidAnalysisTask.status, 'error', '招标解析重启后可重试');
  assert.equal(recoveryHarness.technicalPlanStore.state.outlineGenerationTask.status, 'error', '目录生成重启后可重试');
  assert.equal(recoveryHarness.technicalPlanStore.state.globalFactsTask.status, 'error', '全局事实重启后可重试');
  assert.equal(recoveryHarness.technicalPlanStore.state.contentGenerationTask.status, 'paused', '正文生成重启后保持暂停恢复语义');
  assert.equal(recoveryHarness.rejectionCheckStore.state.extractionTask.status, 'error', '废标项提取重启后可重试');
  assert.equal(recoveryHarness.rejectionCheckStore.state.checkTask.status, 'error', '废标检查重启后可重试');
  assert.equal(recoveryHarness.duplicateCheckStore.state.analysisTask.status, 'error', '查重重启后可重试');

  console.log('Electron 八类任务行为矩阵测试通过');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
