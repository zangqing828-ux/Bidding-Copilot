const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { methods: bridgeMethods } = require('../shared/bridgeContract.cjs');
const bridgeRouter = require('../server/routes/bridge.cjs');
const { validateStartContentGenerationInput } = require('../shared/contracts/technical-plan/taskContracts.cjs');
const { createSqliteDatabase } = require('../core/sqliteDatabase.cjs');
const { createTechnicalPlanStore } = require('../core/stores/technicalPlanStore.cjs');
const { createWorkspaceMutationExecutor } = require('../server/workspace/workspaceMutationExecutor.cjs');
const { createWebBidAnalysisTaskService } = require('../server/workspace/webServices.cjs');

const RUNTIME_GENERATION = 902;

function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(message));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function contentOptions() {
  return {
    useAiImages: false,
    maxAiImages: 0,
    useMermaidImages: false,
    maxMermaidImages: 0,
    useHtmlImages: false,
    maxHtmlImages: 0,
    htmlImageTypes: '',
    tableRequirement: 'none',
    enableConsistencyAudit: false,
    consistencyRepairMode: 'normal',
    enableOriginalPlanCoverageAudit: false,
    originalPlanCoverageRepairMode: 'normal',
  };
}

function createFakeAi({ modelState = {} } = {}) {
  const activeModel = {
    provider: 'j2-test-provider',
    baseUrl: 'https://j2-model.invalid/v1',
    modelName: 'j2-test-model',
    apiKey: 'secret-never-in-manifest',
    ...modelState,
  };
  const service = {
    captureTextModelSnapshot() {
      return Object.freeze({ ...activeModel });
    },
    withQueueScope() {
      return service;
    },
    getConfig() {
      return { context_length_limit: 400000, agent_mode_scenarios: {} };
    },
    getCapabilities() {
      return {};
    },
    pauseQueueScope() {},
    resumeQueueScope() {},
    setModelSnapshot(patch) {
      Object.assign(activeModel, patch || {});
    },
  };
  return service;
}

function seedTechnicalPlan(store) {
  store.updateTechnicalPlan({
    outlineWordControlSnapshot: {
      enabled: false,
      minimumWords: 0,
      maximumWords: 0,
      sectionWords: 0,
      strictSectionWords: false,
    },
    outlineData: {
      project_name: 'J2 测试项目',
      outline: [
        {
          id: 'chapter-1',
          title: '第一章',
          description: '第一章说明',
          children: [{ id: 'node-1', title: '第一节', description: '第一节说明' }],
        },
        {
          id: 'chapter-2',
          title: '第二章',
          description: '第二章说明',
          children: [{ id: 'node-2', title: '第二节', description: '第二节说明' }],
        },
      ],
    },
    globalFacts: [{ id: 'fact-old', title: '旧事实', content: '旧事实内容' }],
    globalFactsTask: { task_id: 'facts-seed', type: 'global-facts-generation', status: 'success', progress: 100, logs: [] },
  });
}

function createRunnerSet({ pauseGate, raceGate, restartGate, afterFirstChapter } = {}) {
  const runnerState = {
    contentRuns: [],
    globalRuns: 0,
  };
  const globalFacts = async ({ workspaceStore, updateTask }) => {
    runnerState.globalRuns += 1;
    const state = workspaceStore.loadTechnicalPlan();
    updateTask({ status: 'running', progress: 35 }, state);
    workspaceStore.updateTechnicalPlan({
      globalFacts: [{ id: 'fact-j2', title: '统一事实', content: 'J2 统一事实内容' }],
      globalFactsTask: { ...(state.globalFactsTask || {}), status: 'success', progress: 100 },
    });
    updateTask({ status: 'success', progress: 100 }, workspaceStore.loadTechnicalPlan());
  };

  const content = async ({ workspaceStore, updateTask, taskControl, payload, signal }) => {
    const action = payload.action
      || (payload.resume ? 'resume' : payload.retryContentCorrection ? 'retry-correction' : payload.rerunIllustrations ? 'rerun-illustration-plan' : payload.regenerate ? 'regenerate-all' : payload.targetItemId ? 'regenerate-section' : 'start');
    runnerState.contentRuns.push(action);
    const state = workspaceStore.loadTechnicalPlan();
    let ids = ['node-1', 'node-2'];
    if (action === 'regenerate-section') ids = [payload.target_item_id || payload.targetItemId];
    if (action === 'resume') {
      ids = ids.filter((id) => state.contentGenerationSections?.[id]?.status !== 'success');
    }
    if (action === 'retry-correction' || action === 'rerun-illustration-plan') {
      ids = [];
    }

    for (const nodeId of ids) {
      if (pauseGate && action === 'start' && nodeId === 'node-2') await pauseGate.promise;
      if (raceGate && action === 'start' && nodeId === 'node-1') await raceGate.promise;
      if (restartGate && action === 'start') {
        await Promise.race([
          restartGate.promise,
          new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })),
        ]);
      }
      if (taskControl.isPauseRequested()) {
        const current = workspaceStore.loadTechnicalPlan();
        const pausedTask = { ...(current.contentGenerationTask || {}), status: 'paused', pause_requested: true };
        workspaceStore.updateTechnicalPlan({ contentGenerationTask: pausedTask });
        updateTask(pausedTask, workspaceStore.loadTechnicalPlan());
        return;
      }
      const previous = workspaceStore.loadTechnicalPlan();
      workspaceStore.saveContentGenerationItem({
        nodeId,
        section: {
          id: nodeId,
          title: nodeId,
          status: 'success',
          content: `正文 ${nodeId} ${action}`,
          updated_at: new Date().toISOString(),
        },
        runtime: {
          completed_item_ids: [...Object.keys(previous.contentGenerationSections || {}), nodeId],
          pending_item_ids: ids.filter((itemId) => itemId !== nodeId),
        },
      });
      if (nodeId === 'node-1' && typeof afterFirstChapter === 'function') {
        await afterFirstChapter({ workspaceStore, signal });
      }
      updateTask({ status: 'running', progress: nodeId === 'node-1' ? 50 : 90 }, workspaceStore.loadTechnicalPlan());
    }

    const completed = workspaceStore.loadTechnicalPlan();
    workspaceStore.updateTechnicalPlan({
      contentGenerationTask: { ...(completed.contentGenerationTask || {}), status: 'success', progress: 100 },
      contentGenerationRuntime: { completed_item_ids: Object.keys(completed.contentGenerationSections || {}) },
    });
    updateTask({ status: 'success', progress: 100 }, workspaceStore.loadTechnicalPlan());
  };

  return { globalFacts, content, runnerState };
}

function createContext({
  root,
  runners,
  runtimeGeneration = RUNTIME_GENERATION,
  seed = true,
  aiService,
  knowledgeBaseService,
}) {
  const database = createSqliteDatabase({ workspaceRoot: root });
  const store = createTechnicalPlanStore({
    db: database.db,
    workspaceRoot: root,
    workspaceRuntimeGeneration: runtimeGeneration,
  });
  if (seed) seedTechnicalPlan(store);
  const mutationExecutor = createWorkspaceMutationExecutor();
  const service = createWebBidAnalysisTaskService({
    aiService: aiService || createFakeAi(),
    knowledgeBaseService,
    technicalPlanStore: store,
    mutationExecutor,
    workspaceRuntimeGeneration: runtimeGeneration,
    taskRunners: runners,
  });
  return { database, store, mutationExecutor, service };
}

function createFakeKnowledgeBase(knowledgeState) {
  return {
    store: {
      getDocument(documentId) {
        if (documentId !== 'knowledge-1') return null;
        return {
          document_id: documentId,
          file_name: '知识样例.md',
          updated_at: '2026-07-27T00:00:00.000Z',
          status: 'success',
        };
      },
      readMarkdown(documentId) {
        if (documentId !== 'knowledge-1') return '';
        return knowledgeState.markdown;
      },
    },
  };
}

function buildManifest(store, { executionId = 'size-execution', taskId = 'size-task', refs = [] } = {}) {
  return {
    manifest_version: 1,
    execution_id: executionId,
    task_id: taskId,
    task_type: 'global-facts-generation',
    workspace_runtime_generation: RUNTIME_GENERATION,
    stage_revision_vector: store.currentStageRevisions(),
    normalized_input_hash: '0'.repeat(64),
    source_hashes: {
      tender_document_hash: null,
      original_plan_hash: null,
      reference_documents: refs,
    },
    selected_bid_section: null,
    upstream_result_hashes: {
      bid_analysis_hash: '0'.repeat(64),
      outline_hash: '0'.repeat(64),
      global_facts_hash: null,
      content_hash: null,
    },
    generation_config_hash: '0'.repeat(64),
    prompt_template_version: 'j2-test.v1',
    model_snapshot_ref: 'j2-test-model',
    output_schema_version: 'global-facts.v1',
  };
}

async function testContractAndBindings() {
  for (const method of ['startGlobalFactsGeneration', 'startContentGeneration', 'pauseContentGeneration']) {
    assert.equal(bridgeMethods.tasks[method].status, 'implemented', `${method} 必须 implemented`);
    assert.equal(bridgeMethods.tasks[method].workPackage, 'WP-J2', `${method} 必须归属 WP-J2`);
    assert.equal(bridgeRouter.__contractBindingMetadata.tasks[method].type, 'direct', `${method} 必须有 direct binding`);
  }
  assert.throws(
    () => validateStartContentGenerationInput({ action: 'start', generation_options: contentOptions(), queueScopeId: 'foreign' }),
    (error) => error.code === 'TASK_INVALID_INPUT',
    'canonical content DTO 禁止混入非契约字段',
  );
}

async function testStartPauseResumeRetry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-j2-lifecycle-'));
  const pauseGate = deferred();
  const runners = createRunnerSet({ pauseGate });
  const { database, store, service } = createContext({ root, runners });
  try {
    const globalTask = await service.startGlobalFactsGeneration({});
    await waitFor(() => store.getTechnicalPlanRunRecord(globalTask.execution_id)?.status === 'succeeded', `global facts runner 未成功: ${JSON.stringify(store.loadTechnicalPlan().globalFactsTask)} / ${JSON.stringify(store.getTechnicalPlanRunRecord(globalTask.execution_id))}`);
    assert.equal(store.getTechnicalPlanRunRecord(globalTask.execution_id)?.status, 'succeeded', 'global facts run record 必须成功');

    const contentStart = service.startContentGeneration({ action: 'start', generation_options: contentOptions() });
    await waitFor(() => store.loadTechnicalPlan().contentGenerationSections?.['node-1']?.status === 'success', '第一章节未完成');
    const pausePromise = service.pauseContentGeneration({});
    await waitFor(() => store.loadTechnicalPlan().contentGenerationTask?.status === 'pausing', '暂停请求未进入 pausing');
    pauseGate.resolve();
    const pausedTask = await pausePromise;
    await contentStart;
    assert.equal(pausedTask.status, 'paused', '暂停必须返回 paused');
    assert.equal(store.loadTechnicalPlan().contentGenerationSections['node-1'].status, 'success', '暂停前完成章节必须保留');
    assert.deepEqual(store.loadTechnicalPlan().contentGenerationSections['node-2'], undefined, '暂停时未完成章节不得伪造成功');
    const pausedRecord = store.getTechnicalPlanRunRecord(pausedTask.execution_id);
    assert.equal(pausedRecord.status, 'paused', '暂停必须持久化 run record 状态');
    assert.ok(pausedRecord.checkpoint.pending_item_ids.includes('node-2'), 'checkpoint 必须保留待处理章节');

    const resumedTask = await service.startContentGeneration({ action: 'resume' });
    await waitFor(() => store.getTechnicalPlanRunRecord(resumedTask.execution_id)?.status === 'succeeded', `正文恢复未成功: ${JSON.stringify(store.loadTechnicalPlan().contentGenerationTask)} / ${JSON.stringify(store.getTechnicalPlanRunRecord(resumedTask.execution_id))}`);
    assert.equal(resumedTask.execution_id, pausedTask.execution_id, 'resume 必须复用同一 execution');
    assert.equal(store.loadTechnicalPlan().contentGenerationSections['node-2'].status, 'success', 'resume 必须完成剩余章节');
    assert.equal(store.getTechnicalPlanRunRecord(resumedTask.execution_id).status, 'succeeded', 'resume 最终必须成功写回');

    const oldNode2 = store.loadTechnicalPlan().contentGenerationSections['node-2'].content;
    const retryTask = await service.startContentGeneration({
      action: 'regenerate-section',
      target_item_id: 'node-1',
      requirement: '增加验收说明',
      generation_options: contentOptions(),
    });
    await waitFor(() => store.getTechnicalPlanRunRecord(retryTask.execution_id)?.status === 'succeeded', '局部重试未成功');
    assert.equal(store.loadTechnicalPlan().contentGenerationSections['node-1'].content, '正文 node-1 regenerate-section', '局部重试必须写回目标章节');
    assert.equal(store.loadTechnicalPlan().contentGenerationSections['node-2'].content, oldNode2, '局部重试不得改写其他章节');
    assert.equal(store.getTechnicalPlanRunRecord(retryTask.execution_id).status, 'succeeded', '局部重试 run record 必须成功');
  } finally {
    await service.close();
    database.close();
  }
}

async function testResumeRejectsChangedFrozenInputs() {
  const modelRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-j2-resume-model-change-'));
  const modelState = {};
  const modelAi = createFakeAi({ modelState });
  const modelPauseGate = deferred();
  const modelContext = createContext({
    root: modelRoot,
    runners: createRunnerSet({ pauseGate: modelPauseGate }),
    aiService: modelAi,
  });
  try {
    const taskPromise = modelContext.service.startContentGeneration({ action: 'start', generation_options: contentOptions() });
    await waitFor(() => modelContext.store.loadTechnicalPlan().contentGenerationSections?.['node-1']?.status === 'success', '模型冻结测试第一章节未完成');
    const pausePromise = modelContext.service.pauseContentGeneration({});
    modelPauseGate.resolve();
    const pausedTask = await pausePromise;
    await taskPromise;
    assert.equal(JSON.stringify(modelContext.store.getTechnicalPlanRunRecord(pausedTask.execution_id)).includes('secret-never-in-manifest'), false, 'run record 不得持久化明文模型 Key');

    modelAi.setModelSnapshot({ modelName: 'j2-test-model-changed' });
    await assert.rejects(
      modelContext.service.startContentGeneration({ action: 'resume' }),
      (error) => error?.code === 'TASK_INPUT_CHANGED',
      '模型快照变化时 resume 必须 fail closed',
    );
    assert.equal(modelContext.store.loadTechnicalPlan().contentGenerationSections['node-2'], undefined, '模型变化的 resume 不得新增旧结果');
    assert.equal(modelContext.store.getTechnicalPlanRunRecord(pausedTask.execution_id).status, 'paused', 'resume 校验失败不得先把 run record 改为 accepted');

    modelAi.setModelSnapshot({ modelName: 'j2-test-model' });
    const resumed = await modelContext.service.startContentGeneration({ action: 'resume' });
    await waitFor(() => modelContext.store.getTechnicalPlanRunRecord(resumed.execution_id)?.status === 'succeeded', '模型快照恢复未成功');
    assert.equal(modelContext.store.loadTechnicalPlan().contentGenerationSections['node-2'].status, 'success', '模型快照一致后 resume 应完成剩余章节');
  } finally {
    await modelContext.service.close();
    modelContext.database.close();
  }

  const knowledgeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-j2-resume-knowledge-change-'));
  const knowledgeState = { markdown: '知识内容 v1' };
  const knowledgePauseGate = deferred();
  const knowledgeContext = createContext({
    root: knowledgeRoot,
    runners: createRunnerSet({ pauseGate: knowledgePauseGate }),
    knowledgeBaseService: createFakeKnowledgeBase(knowledgeState),
  });
  try {
    knowledgeContext.store.updateTechnicalPlan({ referenceKnowledgeDocumentIds: ['knowledge-1'] });
    const taskPromise = knowledgeContext.service.startContentGeneration({ action: 'start', generation_options: contentOptions() });
    await waitFor(() => knowledgeContext.store.loadTechnicalPlan().contentGenerationSections?.['node-1']?.status === 'success', '知识冻结测试第一章节未完成');
    const pausePromise = knowledgeContext.service.pauseContentGeneration({});
    knowledgePauseGate.resolve();
    const pausedTask = await pausePromise;
    await taskPromise;
    assert.equal(JSON.stringify(knowledgeContext.store.getTechnicalPlanRunRecord(pausedTask.execution_id)).includes('secret-never-in-manifest'), false, '知识冻结 run record 不得持久化明文模型 Key');

    knowledgeState.markdown = '知识内容 v2';
    await assert.rejects(
      knowledgeContext.service.startContentGeneration({ action: 'resume' }),
      (error) => error?.code === 'TASK_INPUT_CHANGED',
      '知识内容变化时 resume 必须 fail closed',
    );
    assert.equal(knowledgeContext.store.loadTechnicalPlan().contentGenerationSections['node-2'], undefined, '知识变化的 resume 不得新增旧结果');
    assert.equal(knowledgeContext.store.getTechnicalPlanRunRecord(pausedTask.execution_id).status, 'paused', '知识校验失败不得先把 run record 改为 accepted');

    knowledgeState.markdown = '知识内容 v1';
    const resumed = await knowledgeContext.service.startContentGeneration({ action: 'resume' });
    await waitFor(() => knowledgeContext.store.getTechnicalPlanRunRecord(resumed.execution_id)?.status === 'succeeded', '知识快照恢复未成功');
    assert.equal(knowledgeContext.store.loadTechnicalPlan().contentGenerationSections['node-2'].status, 'success', '知识快照一致后 resume 应完成剩余章节');
  } finally {
    await knowledgeContext.service.close();
    knowledgeContext.database.close();
  }
}

async function testCheckpointRejectsChangedInputAfterFirstChapter() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-j2-checkpoint-frozen-input-'));
  const ai = createFakeAi();
  const context = createContext({
    root,
    aiService: ai,
    runners: createRunnerSet({
      afterFirstChapter: () => {
        ai.setModelSnapshot({ modelName: 'j2-test-model-after-node-1' });
      },
    }),
  });
  try {
    const taskPromise = context.service.startContentGeneration({ action: 'start', generation_options: contentOptions() });
    const acceptedTask = await taskPromise;
    await waitFor(() => context.store.getTechnicalPlanRunRecord(acceptedTask.execution_id)?.status === 'error', '第一章节后输入变化未收口');
    const state = context.store.loadTechnicalPlan();
    assert.equal(state.contentGenerationSections['node-1']?.status, 'success', '变化前已提交的第一章节应保留');
    assert.equal(state.contentGenerationSections['node-2'], undefined, '第一章节后输入变化不得新增旧结果');
    assert.equal(state.contentGenerationTask.error_code, 'TASK_INPUT_CHANGED', 'checkpoint 输入变化必须返回 TASK_INPUT_CHANGED');
  } finally {
    await context.service.close();
    context.database.close();
  }
}

async function testRestartRecovery() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-j2-restart-'));
  const restartGate = deferred();
  const runners = createRunnerSet({ restartGate });
  const first = createContext({ root, runners });
  let task;
  try {
    task = await first.service.startContentGeneration({ action: 'start', generation_options: contentOptions() });
    await waitFor(() => first.store.loadTechnicalPlan().contentGenerationTask?.status === 'running', 'restart 场景任务未启动');
    first.store.recoverInterruptedTasks();
    assert.equal(first.store.loadTechnicalPlan().contentGenerationTask.error_code, 'TASK_INTERRUPTED_BY_RESTART', '重启恢复必须收口运行任务');
    await first.service.close();
    assert.equal(first.service.getActiveTasks().length, 0, 'Runtime close 后不应保留 Agent task');
  } finally {
    restartGate.resolve();
    await first.service.close();
    first.database.close();
  }

  const resumedRunners = createRunnerSet();
  const second = createContext({ root, runners: resumedRunners, seed: false });
  try {
    const current = second.store.loadTechnicalPlan();
    assert.equal(current.contentGenerationTask.error_code, 'TASK_INTERRUPTED_BY_RESTART', '新 Runtime 必须读取可重试的中断任务');
    const resumed = await second.service.startContentGeneration({ action: 'resume' });
    await waitFor(() => second.store.getTechnicalPlanRunRecord(resumed.execution_id)?.status === 'succeeded', '重启后恢复任务未成功');
    assert.equal(resumed.execution_id, task.execution_id, '重启后 resume 必须复用原 execution');
  } finally {
    await second.service.close();
    second.database.close();
  }
}

async function testRaceAndSizeLimits() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-j2-race-'));
  const raceGate = deferred();
  const runners = createRunnerSet({ raceGate });
  const { database, store, service } = createContext({ root, runners });
  try {
    const task = await service.startContentGeneration({ action: 'start', generation_options: contentOptions() });
    await waitFor(() => store.loadTechnicalPlan().contentGenerationTask?.status === 'running', 'race 场景任务未启动');
    store.saveGlobalFacts([{ id: 'fact-race', title: '竞态事实', content: '输入已经变化' }]);
    raceGate.resolve();
    await waitFor(() => store.loadTechnicalPlan().contentGenerationTask?.status === 'error', '输入竞态未收口');
    assert.equal(store.loadTechnicalPlan().contentGenerationTask.error_code, 'TASK_INPUT_CHANGED', '阶段版本变化必须返回 TASK_INPUT_CHANGED');
    assert.equal(store.loadTechnicalPlan().contentGenerationSections['node-1'], undefined, '竞态写回不得落入旧章节结果');
    assert.equal(store.getTechnicalPlanRunRecord(task.execution_id).status, 'error', '竞态 run record 必须失败');

    const refs = Array.from({ length: 4000 }, (_, index) => ({
      document_id: `reference-${index}`,
      content_hash: '0'.repeat(64),
      parse_version: 'v1',
      source_record_hash: '0'.repeat(64),
    }));
    assert.throws(
      () => store.acceptTechnicalPlanTaskRun(buildManifest(store, { refs }), { initialCheckpoint: {} }),
      (error) => error.code === 'TASK_INVALID_INPUT',
      'manifest 超过 256KiB 必须 fail closed',
    );
  } finally {
    await service.close();
    database.close();
  }

  const checkpointRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-j2-checkpoint-'));
  const checkpointDb = createSqliteDatabase({ workspaceRoot: checkpointRoot });
  const checkpointStore = createTechnicalPlanStore({
    db: checkpointDb.db,
    workspaceRoot: checkpointRoot,
    workspaceRuntimeGeneration: RUNTIME_GENERATION,
  });
  try {
    const accepted = checkpointStore.acceptTechnicalPlanTaskRun(buildManifest(checkpointStore), { initialCheckpoint: {} });
    assert.throws(
      () => checkpointStore.writebackTechnicalPlanTaskCheckpoint({
        executionId: accepted.executionId,
        manifestHash: accepted.manifestHash,
        targetStageGeneration: accepted.targetStageGeneration,
        checkpoint: { payload: 'x'.repeat(2 * 1024 * 1024) },
        nodeId: 'missing-node',
        section: { id: 'missing-node', status: 'success', content: 'should not write' },
      }),
      (error) => error.code === 'TASK_INVALID_INPUT',
      'checkpoint 超过 2MiB 必须 fail closed',
    );
  } finally {
    checkpointDb.close();
  }
}

async function main() {
  await testContractAndBindings();
  await testStartPauseResumeRetry();
  await testResumeRejectsChangedFrozenInputs();
  await testCheckpointRejectsChangedInputAfterFirstChapter();
  await testRestartRecovery();
  await testRaceAndSizeLimits();
  console.log('WP-J J2 lifecycle tests passed.');
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
