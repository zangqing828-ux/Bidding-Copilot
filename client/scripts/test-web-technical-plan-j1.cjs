const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSqliteDatabase } = require('../core/sqliteDatabase.cjs');
const { createTechnicalPlanStore } = require('../core/stores/technicalPlanStore.cjs');
const { createWorkspaceMutationExecutor } = require('../server/workspace/workspaceMutationExecutor.cjs');
const { createWebBidAnalysisTaskService } = require('../server/workspace/webServices.cjs');

const WORKSPACE_RUNTIME_GENERATION = 701;
const REQUIRED_BID_TASKS = ['projectOverview', 'techRequirements', 'projectInfo', 'partAInfo', 'deliveryAndServiceRequirements'];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function waitFor(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(message));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function createFakeAi({
  sectionTitle = '一标段',
  finalReviewMode = 'pass',
  failAlignedChildren = false,
  failRequirementGroups = false,
  oversizedAlignedChildren = false,
} = {}) {
  const sectionGate = deferred();
  const outlineGate = deferred();
  let holdSection = true;
  let holdOutline = true;
  let modelName = 'j1-model-frozen-a';
  let contextLengthLimit = 400000;
  let capabilities = {};
  const scopedSnapshots = [];
  const collectLabels = [];

  const service = {
    async chat({ messages = [] }) {
      return `J-1 招标解析结果：${String(messages.at(-1)?.content || '').slice(0, 32)}`;
    },
    async collectJsonResponse(options = {}) {
      const label = String(options.progressLabel || options.logTitle || options.failureMessage || '');
      collectLabels.push(label);
      if (label.includes('多标段识别') && holdSection) await sectionGate.promise;
      if (!label.includes('多标段识别') && holdOutline) await outlineGate.promise;
      if (label.includes('技术评分大类') && failRequirementGroups) {
        throw new Error('模型返回的技术评分大类格式无效');
      }
      if (label.includes('最终目录审核') && finalReviewMode === 'invalid') {
        throw new Error('模型返回的最终目录审核结果格式无效');
      }

      let result;
      if (label.includes('多标段识别')) {
        result = {
          sections: [
            { id: 'section-1', index: 1, unit: '标段', title: sectionTitle, headLine: `${sectionTitle}：云平台建设`, description: '平台建设与系统集成。', includeRanges: [{ startLine: 3, endLine: 4, reason: '一标段正文' }], evidence: [`${sectionTitle}：云平台建设`] },
            { id: 'section-2', index: 2, unit: '标段', title: '二标段', headLine: '二标段：运维保障', description: '运维监控与交付培训。', includeRanges: [{ startLine: 6, endLine: 7, reason: '二标段正文' }], evidence: ['二标段：运维保障'] },
          ],
        };
      } else if (label.includes('技术评分大类')) {
        result = { groups: [{ requirement_id: 'REQ-J1-01', title: '技术能力', description: '架构、实施和验收能力。', detail_points: ['架构能力'] }] };
      } else if (label.includes('最终目录审核')) {
        result = { passed: finalReviewMode !== 'fail', suggestions: finalReviewMode === 'fail' ? ['目录需要修复'] : [] };
      } else {
        result = oversizedAlignedChildren
          ? { children: Array.from({ length: 1001 }, (_, index) => ({
            id: `1.${index + 1}`,
            title: `超限目录 ${index + 1}`,
            description: `超限目录 ${index + 1} 描述`,
          })) }
          : failAlignedChildren
          ? { children: [] }
          : { children: [{ id: '1.1', title: '总体架构与技术路线', description: '说明实施技术路线。', children: [{ id: '1.1.1', title: '平台架构说明', description: '说明平台模块与接口。' }] }] };
      }
      if (typeof options.normalizer === 'function') result = options.normalizer(result);
      if (typeof options.validator === 'function') options.validator(result);
      return result;
    },
    requestJson(options) { return service.collectJsonResponse(options); },
    captureTextModelSnapshot() {
      return Object.freeze({ provider: 'j1-fake-provider', baseUrl: 'https://j1-model.invalid/v1', modelName, apiKey: 'j1-test-key', capturedAt: '2026-07-27T00:00:00.000Z' });
    },
    withQueueScope(_scope, { modelSnapshot } = {}) {
      scopedSnapshots.push(modelSnapshot);
      return service;
    },
    getConfig: () => ({ context_length_limit: contextLengthLimit }),
    getCapabilities: () => capabilities,
    resumeQueueScope() {},
    pauseQueueScope() {},
    setModelName(value) { modelName = value; },
    setContextLengthLimit(value) { contextLengthLimit = value; },
    setCapabilities(value) { capabilities = { ...(value || {}) }; },
    releaseSection() { holdSection = false; sectionGate.resolve(); },
    releaseOutline() { holdOutline = false; outlineGate.resolve(); },
    scopedSnapshots,
    collectLabels,
  };
  return service;
}

let fakeAgentBindCalls = 0;

function createFakeAgent() {
  return {
    bindSelectedRuntime() {
      fakeAgentBindCalls += 1;
      return { async runTask() { return { output: '{}' }; } };
    },
  };
}

async function seedTender(store) {
  const markdown = ['# J-1 双标段招标文件', '项目概况：本项目建设统一平台。', '一标段：云平台建设', '包含平台架构、系统集成与上线。', '通用服务要求：提供项目管理。', '二标段：运维保障', '包含运维监控、培训与 SLA 服务。', '交付要求：完成验收资料。'].join('\n');
  const result = await store.importTenderDocument(['j1-tender']);
  assert.equal(result.success, true, '真实 technicalPlanStore 必须完成测试招标文件导入');
  assert.equal(result.markdown, markdown, '导入后必须保留完整双标段 Markdown');
}

async function main() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'web-technical-plan-j1-'));
  let database;
  let mutationExecutor;
  try {
    database = createSqliteDatabase({ workspaceRoot });
    const tenderMarkdown = ['# J-1 双标段招标文件', '项目概况：本项目建设统一平台。', '一标段：云平台建设', '包含平台架构、系统集成与上线。', '通用服务要求：提供项目管理。', '二标段：运维保障', '包含运维监控、培训与 SLA 服务。', '交付要求：完成验收资料。'].join('\n');
    const store = createTechnicalPlanStore({
      db: database.db,
      workspaceRoot,
      workspaceRuntimeGeneration: WORKSPACE_RUNTIME_GENERATION,
      fileService: {
        async importDocument() {
          return { success: true, file_content: tenderMarkdown, file_name: 'j1-two-sections.md', parser_label: 'J1 fake importer', message: 'J1 导入成功' };
        },
      },
    });
    await seedTender(store);
    mutationExecutor = createWorkspaceMutationExecutor();
    const fakeAi = createFakeAi();
    const service = createWebBidAnalysisTaskService({
      aiService: fakeAi,
      agentService: createFakeAgent(),
      technicalPlanStore: store,
      mutationExecutor,
      workspaceRuntimeGeneration: WORKSPACE_RUNTIME_GENERATION,
    });

    const firstBidSection = service.startBidSectionExtraction({});
    const duplicateBidSection = service.startBidSectionExtraction({});
    await assert.rejects(
      () => service.startOutlineGeneration({ reference_knowledge_document_ids: [], outline_expansion_mode: 'ai-complement', word_control_options: { enabled: false, minimumWords: 0, maximumWords: 0, sectionWords: 0, strictSectionWords: false } }),
      (error) => error?.code === 'TASK_CONFLICT',
      'bid-section 受理期间，outline 的不同请求必须冲突',
    );
    const [bidSectionTask, duplicateTask] = await Promise.all([firstBidSection, duplicateBidSection]);
    assert.equal(duplicateTask.task_id, bidSectionTask.task_id, 'bid-section 相同请求必须 single-flight 复用');
    assert.ok(store.readOriginalTenderMarkdown().includes('一标段'), '任务受理后原始招标文件必须仍可读取');
    fakeAi.releaseSection();
    await waitFor(() => ['success', 'error'].includes(store.loadTechnicalPlan().bidSectionExtractionTask?.status), 'bid-section 真实 runner 未完成');
    assert.equal(store.loadTechnicalPlan().bidSectionExtractionTask?.status, 'success', `bid-section 真实 runner 失败：${store.loadTechnicalPlan().bidSectionExtractionTask?.error || ''}`);
    await waitFor(() => service.getActiveTasks().length === 0, 'bid-section 完成后仍保留活动任务');

    const bidSectionRecord = store.getTechnicalPlanRunRecord(bidSectionTask.execution_id);
    assert.equal(bidSectionRecord?.status, 'succeeded', 'bid-section 最终结果必须通过 run record 标记为 succeeded');
    assert.equal(store.loadTechnicalPlan().bidSections.length, 2, 'bid-section 结果必须经 CAS 落盘');
    assert.equal(bidSectionRecord.workspaceRuntimeGeneration, WORKSPACE_RUNTIME_GENERATION, 'run record 必须固定 workspace runtime generation');
    assert.equal(fakeAi.scopedSnapshots[0]?.modelName, 'j1-model-frozen-a', 'execution 内模型快照必须在受理时冻结');
    assert.ok(!JSON.stringify(bidSectionRecord.manifest).includes('j1-test-key'), 'run manifest 不得保存模型密钥');

    store.selectBidSection(store.loadTechnicalPlan().bidSections[1]);
    assert.ok(!store.readTenderMarkdown().includes('一标段：云平台建设'), '选择第二标段后 working copy 不应包含第一标段正文');
    const rerunSectionAi = createFakeAi();
    const rerunSectionService = createWebBidAnalysisTaskService({
      aiService: rerunSectionAi,
      agentService: createFakeAgent(),
      technicalPlanStore: store,
      mutationExecutor,
      workspaceRuntimeGeneration: WORKSPACE_RUNTIME_GENERATION,
    });
    await rerunSectionService.startBidSectionExtraction({});
    const rerunAcceptedState = store.loadTechnicalPlan();
    assert.equal(rerunAcceptedState.bidSections.length, 0, '重新识别标段受理时必须清除旧选择和旧识别结果');
    assert.ok(store.readTenderMarkdown().includes('一标段：云平台建设'), '重新识别标段必须先恢复 original working copy');
    rerunSectionAi.releaseSection();
    await waitFor(() => ['success', 'error'].includes(store.loadTechnicalPlan().bidSectionExtractionTask?.status), '重新识别标段未完成');
    assert.equal(store.loadTechnicalPlan().bidSectionExtractionTask?.status, 'success', '恢复 original 后重新识别应成功');
    await waitFor(() => rerunSectionService.getActiveTasks().length === 0, '重新识别完成后仍保留活动任务');

    const modelRaceAi = createFakeAi({ sectionTitle: '模型竞态标段' });
    const modelRaceService = createWebBidAnalysisTaskService({
      aiService: modelRaceAi,
      agentService: createFakeAgent(),
      technicalPlanStore: store,
      mutationExecutor,
      workspaceRuntimeGeneration: WORKSPACE_RUNTIME_GENERATION,
    });
    const modelRaceTask = await modelRaceService.startBidSectionExtraction({});
    modelRaceAi.setModelName('j1-model-mutated-after-acceptance');
    modelRaceAi.releaseSection();
    await waitFor(() => ['success', 'error'].includes(store.loadTechnicalPlan().bidSectionExtractionTask?.status), '模型变更竞态未结束');
    const modelRaceState = store.loadTechnicalPlan();
    const modelRaceRecord = store.getTechnicalPlanRunRecord(modelRaceTask.execution_id);
    assert.equal(modelRaceAi.scopedSnapshots[0]?.modelName, 'j1-model-frozen-a', '模型竞态也必须使用受理时冻结的模型快照');
    assert.equal(modelRaceState.bidSectionExtractionTask?.status, 'error', '受理后模型变化必须使任务进入 error');
    assert.equal(modelRaceState.bidSectionExtractionTask?.error_code, 'TASK_INPUT_CHANGED', '受理后模型变化必须返回 TASK_INPUT_CHANGED');
    assert.equal(modelRaceRecord?.status, 'error', '受理后模型变化必须把 run record 收口为 error');
    assert.ok(!modelRaceState.bidSections.some((section) => section.title === '模型竞态标段'), '模型变化后的业务结果不得写回');
    await waitFor(() => modelRaceService.getActiveTasks().length === 0, '模型变更竞态结束后仍保留活动任务');

    store.saveBidAnalysisConfig({ mode: 'key', selectedTaskIds: REQUIRED_BID_TASKS, bidSectionMode: 'single' });
    await assert.rejects(
      () => mutationExecutor.execute(() => store.writebackTechnicalPlanTaskRun({
        executionId: bidSectionRecord.executionId,
        manifestHash: bidSectionRecord.manifestHash,
        targetStageGeneration: bidSectionRecord.targetStageGeneration,
        apply: () => ({ bidSectionExtractionStatus: 'success' }),
      })),
      (error) => error?.code === 'TASK_INPUT_CHANGED',
      '旧 revision 的 run record 写回必须被 mutation executor / CAS 拒绝',
    );

    await service.startBidAnalysis({ mode: 'key', selected_task_ids: REQUIRED_BID_TASKS, force_rerun: true });
    await waitFor(() => ['success', 'error'].includes(store.loadTechnicalPlan().bidAnalysisTask?.status), '目录前置的招标分析未完成');
    assert.equal(store.loadTechnicalPlan().bidAnalysisTask?.status, 'success', `目录前置的招标分析失败：${store.loadTechnicalPlan().bidAnalysisTask?.error || ''}`);
    await waitFor(() => service.getActiveTasks().length === 0, '招标分析完成后仍保留活动任务');

    const outlineInput = { reference_knowledge_document_ids: [], outline_expansion_mode: 'ai-complement', word_control_options: { enabled: false, minimumWords: 0, maximumWords: 0, sectionWords: 0, strictSectionWords: false } };
    for (const scenario of [
      { name: '最终审核拒绝', options: { finalReviewMode: 'fail' }, expectedCode: 'TASK_OUTPUT_INVALID' },
      { name: '最终审核 JSON 无效', options: { finalReviewMode: 'invalid' }, expectedCode: 'TASK_OUTPUT_INVALID' },
      { name: '评分项对齐目录无效', options: { failAlignedChildren: true }, expectedCode: 'TASK_OUTPUT_INVALID' },
      { name: '技术评分大类无效', options: { failRequirementGroups: true }, expectedCode: 'TASK_OUTPUT_INVALID' },
      { name: '模型返回 1001 个目录节点', options: { oversizedAlignedChildren: true }, expectedCode: 'TASK_INVALID_INPUT' },
      {
        name: '字数控制需要 Agent 调整',
        options: {},
        expectedCode: 'TASK_OUTPUT_INVALID',
        wordControlOptions: {
          enabled: true,
          minimumWords: 6000,
          maximumWords: 9000,
          sectionWords: 3000,
          strictSectionWords: false,
        },
      },
    ]) {
      const coreOnlyAi = createFakeAi(scenario.options);
      const coreOnlyService = createWebBidAnalysisTaskService({
        aiService: coreOnlyAi,
        agentService: createFakeAgent(),
        technicalPlanStore: store,
        mutationExecutor,
        workspaceRuntimeGeneration: WORKSPACE_RUNTIME_GENERATION,
      });
      const task = await coreOnlyService.startOutlineGeneration({
        ...outlineInput,
        word_control_options: scenario.wordControlOptions || outlineInput.word_control_options,
      });
      coreOnlyAi.releaseOutline();
      await waitFor(() => ['success', 'error'].includes(store.loadTechnicalPlan().outlineGenerationTask?.status), `${scenario.name} 未结束`);
      assert.equal(store.loadTechnicalPlan().outlineGenerationTask?.error_code, scenario.expectedCode, `${scenario.name} 应返回稳定 ${scenario.expectedCode}`);
      assert.equal(store.getTechnicalPlanRunRecord(task.execution_id)?.status, 'error', `${scenario.name} 应收口 run record`);
      if (scenario.options.oversizedAlignedChildren) {
        assert.equal(
          coreOnlyAi.collectLabels.includes('最终目录审核'),
          false,
          '1001 节点应在 runner 归一化阶段终止，不能继续请求最终审核',
        );
      }
      await waitFor(() => coreOnlyService.getActiveTasks().length === 0, `${scenario.name} 结束后仍保留活动任务`);
    }
    assert.equal(fakeAgentBindCalls, 0, 'J-Core 异常路径不得调用自由 Agent fallback');

    const configRaceAi = createFakeAi();
    const configRaceService = createWebBidAnalysisTaskService({
      aiService: configRaceAi,
      agentService: createFakeAgent(),
      technicalPlanStore: store,
      mutationExecutor,
      workspaceRuntimeGeneration: WORKSPACE_RUNTIME_GENERATION,
    });
    const configRaceTask = await configRaceService.startOutlineGeneration(outlineInput);
    configRaceAi.setContextLengthLimit(200000);
    configRaceAi.setCapabilities({ structured_output: true });
    configRaceAi.releaseOutline();
    await waitFor(() => ['success', 'error'].includes(store.loadTechnicalPlan().outlineGenerationTask?.status), '运行配置变更竞态未结束');
    assert.equal(store.loadTechnicalPlan().outlineGenerationTask?.error_code, 'TASK_INPUT_CHANGED', '运行配置变化必须拒绝旧目录结果');
    assert.equal(store.getTechnicalPlanRunRecord(configRaceTask.execution_id)?.status, 'error', '运行配置变化必须收口 run record');
    assert.equal(store.loadTechnicalPlan().outlineData, null, '运行配置变化后的目录结果不得写回');
    await waitFor(() => configRaceService.getActiveTasks().length === 0, '运行配置变更竞态结束后仍保留活动任务');

    const knowledgeRaceAi = createFakeAi();
    const knowledgeBaseService = {
      store: {
        getDocument(documentId) {
          return {
            document_id: documentId,
            file_name: '竞态知识.md',
            status: 'success',
            created_at: '2026-07-27T00:00:00.000Z',
            updated_at: '2026-07-27T00:00:00.000Z',
          };
        },
        readMarkdown() {
          return '# 竞态知识\n运行期间加入的知识内容。';
        },
      },
    };
    const knowledgeRaceService = createWebBidAnalysisTaskService({
      aiService: knowledgeRaceAi,
      agentService: createFakeAgent(),
      knowledgeBaseService,
      technicalPlanStore: store,
      mutationExecutor,
      workspaceRuntimeGeneration: WORKSPACE_RUNTIME_GENERATION,
    });
    const knowledgeRaceTask = await knowledgeRaceService.startOutlineGeneration(outlineInput);
    store.saveOutlineConfig({
      referenceKnowledgeDocumentIds: ['knowledge-mutated-after-acceptance'],
      outlineExpansionMode: 'ai-complement',
      wordControlOptions: outlineInput.word_control_options,
    });
    knowledgeRaceAi.releaseOutline();
    await waitFor(() => ['success', 'error'].includes(store.loadTechnicalPlan().outlineGenerationTask?.status), '知识选择变更竞态未结束');
    assert.equal(store.loadTechnicalPlan().outlineGenerationTask?.error_code, 'TASK_INPUT_CHANGED', '知识选择变化必须拒绝旧目录结果');
    assert.equal(store.getTechnicalPlanRunRecord(knowledgeRaceTask.execution_id)?.status, 'error', '知识选择变化必须收口 run record');
    assert.deepEqual(
      store.loadTechnicalPlan().referenceKnowledgeDocumentIds,
      ['knowledge-mutated-after-acceptance'],
      '旧目录结果不得覆盖运行期间的新知识选择',
    );
    await waitFor(() => knowledgeRaceService.getActiveTasks().length === 0, '知识选择变更竞态结束后仍保留活动任务');
    store.saveOutlineConfig({
      referenceKnowledgeDocumentIds: [],
      outlineExpansionMode: 'ai-complement',
      wordControlOptions: outlineInput.word_control_options,
    });

    const firstOutline = service.startOutlineGeneration(outlineInput);
    const duplicateOutline = service.startOutlineGeneration(outlineInput);
    await assert.rejects(
      () => service.startBidSectionExtraction({}),
      (error) => error?.code === 'TASK_CONFLICT',
      'outline 受理期间，bid-section 的不同请求必须冲突',
    );
    const [outlineTask, duplicateOutlineTask] = await Promise.all([firstOutline, duplicateOutline]);
    assert.equal(duplicateOutlineTask.task_id, outlineTask.task_id, 'outline 相同请求必须 single-flight 复用');
    fakeAi.releaseOutline();
    await waitFor(() => store.loadTechnicalPlan().outlineGenerationTask?.status === 'success', 'outline 真实 runner 未完成');
    await waitFor(() => service.getActiveTasks().length === 0, 'outline 完成后仍保留活动任务');
    const outlineRecord = store.getTechnicalPlanRunRecord(outlineTask.execution_id);
    assert.equal(outlineRecord?.status, 'succeeded', 'outline 最终结果必须通过 run record 标记为 succeeded');
    assert.ok(store.loadTechnicalPlan().outlineData?.outline?.length, 'outline 最终结果必须经 CAS 落盘');
    assert.equal(store.loadTechnicalPlan().outlineGenerationTask?.status, 'success', '目录业务结果与 task success 必须在同一最终状态出现');
    assert.equal(fakeAgentBindCalls, 0, 'Web J-Core 不得调用自由 Agent fallback');

    const preOrchestratorAbort = new AbortController();
    let preOrchestratorRecord = null;
    const abortingStore = {
      ...store,
      acceptTechnicalPlanTaskRun(manifest) {
        const record = store.acceptTechnicalPlanTaskRun(manifest);
        preOrchestratorRecord = record;
        preOrchestratorAbort.abort(Object.assign(new Error('J-1 受理后立即关闭 workspace'), { code: 'TASK_ACCEPTANCE_ABORTED', retryable: true }));
        return record;
      },
    };
    const preOrchestratorService = createWebBidAnalysisTaskService({
      aiService: createFakeAi(),
      agentService: createFakeAgent(),
      technicalPlanStore: abortingStore,
      mutationExecutor,
      workspaceRuntimeGeneration: WORKSPACE_RUNTIME_GENERATION,
    });
    await assert.rejects(
      () => preOrchestratorService.startBidSectionExtraction({}, { signal: preOrchestratorAbort.signal }),
      (error) => error?.code === 'TASK_ACCEPTANCE_ABORTED',
      'run record 受理后、orchestrator 启动前的 abort 必须拒绝启动',
    );
    const settledPreOrchestratorRecord = store.getTechnicalPlanRunRecord(preOrchestratorRecord?.executionId);
    assert.equal(settledPreOrchestratorRecord?.status, 'error', 'orchestrator 未启动即 close/abort 时 run record 必须收口为 error');
    assert.notEqual(settledPreOrchestratorRecord?.status, 'accepted', 'orchestrator 未启动即 close/abort 时不得残留 accepted run record');
    assert.equal(preOrchestratorService.getActiveTasks().length, 0, 'orchestrator 未启动即 close/abort 时不得登记活动任务');
    await preOrchestratorService.close();

    const closingAi = createFakeAi();
    const closingService = createWebBidAnalysisTaskService({ aiService: closingAi, agentService: createFakeAgent(), technicalPlanStore: store, mutationExecutor, workspaceRuntimeGeneration: WORKSPACE_RUNTIME_GENERATION });
    await closingService.startBidSectionExtraction({});
    await closingService.close();
    assert.equal(closingService.getActiveTasks().length, 0, 'close 后不得遗留活动任务');
    assert.equal(store.loadTechnicalPlan().bidSectionExtractionTask?.error_code, 'TASK_INTERRUPTED_BY_RESTART', 'close 必须持久化稳定中断码');
    await mutationExecutor.close();
    console.log('WP-J J-1 Web technical-plan focused tests passed.');
  } finally {
    database?.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
