const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { createTaskOrchestrator } = require('../../core/taskOrchestrator.cjs');
const { runBidAnalysisTask } = require('../../core/bidAnalysisTask.cjs');
const { runBidSectionExtractionTask } = require('../../core/technical-plan/orchestration/bidSectionExtractionTask.cjs');
const { runOutlineGenerationTask } = require('../../core/technical-plan/orchestration/outlineGenerationTask.cjs');
const { bidAnalysisDefinitions, normalizeBidAnalysisSelection, validateStartBidAnalysisInput } = require('../../shared/bidAnalysisContract.cjs');
const {
  validateStartBidSectionExtractionInput,
  validateStartOutlineGenerationInput,
  validateStartGlobalFactsGenerationInput,
  validateStartContentGenerationInput,
  validatePauseContentGenerationInput,
} = require('../../shared/contracts/technical-plan/taskContracts.cjs');
const { computeRunManifestV1Hash } = require('../../shared/contracts/technical-plan/runManifest.cjs');

const TECHNICAL_PLAN_TASK_DEFINITIONS = Object.freeze({
  'bid-section-extraction': Object.freeze({
    label: '多标段识别',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 2,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'bidSectionExtractionTask',
  }),
  'bid-analysis': Object.freeze({
    label: '招标文件解析',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 2,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'bidAnalysisTask',
  }),
  'outline-generation': Object.freeze({
    label: '目录生成',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 3,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'outlineGenerationTask',
  }),
  'global-facts-generation': Object.freeze({
    label: '全局事实设定',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 4,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'globalFactsTask',
  }),
  'content-generation': Object.freeze({
    label: '正文生成',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 5,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'contentGenerationTask',
  }),
});

const portableRuntimeRequire = createRequire(__filename);

function resolvePortableTaskRunner(type, injectedRunner) {
  if (typeof injectedRunner === 'function') return injectedRunner;
  const modulePath = type === 'global-facts-generation'
    ? '../../core/technical-plan/content/globalFactsTask.cjs'
    : type === 'content-generation'
      ? '../../core/technical-plan/content/contentGenerationTask.cjs'
      : null;
  const exportName = type === 'global-facts-generation' ? 'runGlobalFactsTask' : 'runContentGenerationTask';
  if (!modulePath) return null;
  try {
    const loaded = portableRuntimeRequire(modulePath);
    return typeof loaded?.[exportName] === 'function' ? loaded[exportName] : null;
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND' && String(error.message || '').includes(modulePath)) return null;
    throw error;
  }
}

function stableHash(value) {
  const normalized = typeof value === 'string' ? value : JSON.stringify(value);
  return crypto.createHash('sha256').update(normalized || '', 'utf8').digest('hex');
}

function hashNullableText(value) {
  const text = String(value || '').trim();
  return text ? stableHash(text) : null;
}

function projectOutlineStructure(items) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    id: String(item?.id || ''),
    title: String(item?.title || ''),
    description: String(item?.description || ''),
    ...(Array.isArray(item?.children) && item.children.length
      ? { children: projectOutlineStructure(item.children) }
      : {}),
  }));
}

function copyPatchFields(target, source, fields) {
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source || {}, field)) {
      target[field] = source[field];
    }
  }
}

function createTaskItemNotFoundError(message) {
  const error = new Error(message);
  error.code = 'TASK_ITEM_NOT_FOUND';
  error.retryable = false;
  return error;
}

function createTaskInputChangedError(message = '任务输入已变化，请重新执行') {
  const error = new Error(message);
  error.code = 'TASK_INPUT_CHANGED';
  error.retryable = true;
  return error;
}

function createReferenceDocumentManifest(knowledgeBaseService, documentIds) {
  const store = knowledgeBaseService?.store;
  return (documentIds || []).map((documentId) => {
    let document;
    try {
      document = store?.getDocument?.(documentId);
    } catch {
      document = null;
    }
    if (!document || document.status !== 'success') {
      throw createTaskItemNotFoundError(`参考知识文档 ${documentId} 不存在或尚未解析完成`);
    }
    const markdown = store.readMarkdown(documentId);
    const parseVersion = String(document.updated_at || document.created_at || 'knowledge-v1');
    return {
      document_id: documentId,
      content_hash: stableHash(String(markdown || '')),
      parse_version: parseVersion,
      source_record_hash: stableHash({
        document_id: documentId,
        file_name: document.file_name || '',
        updated_at: document.updated_at || '',
        status: document.status,
      }),
    };
  });
}

function createModelSnapshotReference(modelSnapshot) {
  const publicSnapshot = {
    provider: String(modelSnapshot?.provider || ''),
    base_url: String(modelSnapshot?.baseUrl || ''),
    model_name: String(modelSnapshot?.modelName || ''),
  };
  return {
    publicSnapshot,
    reference: `text-model:${stableHash(publicSnapshot)}`,
  };
}

function booleanConfigProjection(value) {
  return Object.fromEntries(
    Object.entries(value && typeof value === 'object' ? value : {})
      .filter(([, item]) => typeof item === 'boolean')
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function captureTechnicalPlanGenerationConfig(aiService) {
  let config = {};
  let capabilities = {};
  try {
    config = typeof aiService?.getConfig === 'function' ? aiService.getConfig() || {} : {};
  } catch {
    config = {};
  }
  try {
    capabilities = typeof aiService?.getCapabilities === 'function'
      ? aiService.getCapabilities() || {}
      : aiService?.capabilities || {};
  } catch {
    capabilities = {};
  }
  const contextLengthLimit = Number(config.context_length_limit);
  const disabledAgentScenarios = Object.fromEntries(
    Object.keys(booleanConfigProjection(config.agent_mode_scenarios)).map((key) => [key, false]),
  );
  return Object.freeze({
    context_length_limit: Number.isFinite(contextLengthLimit) && contextLengthLimit > 0
      ? Math.floor(contextLengthLimit)
      : null,
    agent_mode_scenarios: Object.freeze({
      ...disabledAgentScenarios,
      existing_plan_expansion_original_outline_extraction: false,
    }),
    capabilities: Object.freeze(booleanConfigProjection(capabilities)),
  });
}

function createTechnicalPlanRunManifest({
  type,
  input,
  taskId,
  executionId,
  workspaceRuntimeGeneration,
  technicalPlanStore,
  knowledgeBaseService,
  modelSnapshot,
  generationConfigSnapshot,
  stageRevisionVector,
  referenceDocumentIds,
}) {
  const state = technicalPlanStore.loadTechnicalPlan() || {};
  const selectedReferenceDocumentIds = type === 'outline-generation'
    ? (referenceDocumentIds || input.reference_knowledge_document_ids)
    : (['global-facts-generation', 'content-generation'].includes(type)
      ? (referenceDocumentIds || state.referenceKnowledgeDocumentIds || [])
      : []);
  const referenceDocuments = createReferenceDocumentManifest(knowledgeBaseService, selectedReferenceDocumentIds);
  const tenderMarkdown = type === 'bid-section-extraction'
    ? technicalPlanStore.readOriginalTenderMarkdown?.() || technicalPlanStore.readTenderMarkdown?.() || ''
    : technicalPlanStore.readTenderMarkdown?.() || '';
  const originalPlanMarkdown = technicalPlanStore.readOriginalPlanMarkdown?.() || '';
  const selectedSectionId = String(state.tenderFile?.selectedSectionId || state.selectedSectionId || '').trim();
  const { publicSnapshot, reference: modelSnapshotRef } = createModelSnapshotReference(modelSnapshot);
  const bidAnalysisHash = hashNullableText(JSON.stringify({
    bidAnalysisTasks: state.bidAnalysisTasks || {},
    projectOverview: state.projectOverview || '',
    techRequirements: state.techRequirements || '',
  }));
  const outlineHash = hashNullableText(JSON.stringify({
    project_name: state.outlineData?.project_name || '',
    project_overview: state.outlineData?.project_overview || '',
    outline: projectOutlineStructure(state.outlineData?.outline || []),
  }));
  const globalFactsHash = hashNullableText(JSON.stringify(state.globalFacts || []));
  const contentHash = hashNullableText(JSON.stringify({
    contentGenerationSections: state.contentGenerationSections || {},
    contentGenerationPlans: state.contentGenerationPlans || {},
  }));
  const promptVersion = {
    'bid-section-extraction': 'technical-plan.bid-section-extraction.v1',
    'outline-generation': 'technical-plan.outline-generation.v1',
    'global-facts-generation': 'technical-plan.global-facts-generation.v1',
    'content-generation': 'technical-plan.content-generation.v1',
  }[type] || 'technical-plan.unknown.v1';

  return {
    manifest_version: 1,
    task_id: taskId,
    execution_id: executionId,
    task_type: type,
    workspace_runtime_generation: workspaceRuntimeGeneration,
    stage_revision_vector: stageRevisionVector || technicalPlanStore.currentStageRevisions(),
    normalized_input_hash: stableHash(input),
    source_hashes: {
      tender_document_hash: hashNullableText(tenderMarkdown),
      original_plan_hash: hashNullableText(originalPlanMarkdown),
      reference_documents: referenceDocuments,
    },
    selected_bid_section: type !== 'bid-section-extraction' && selectedSectionId ? {
      section_id: selectedSectionId,
      content_hash: stableHash(tenderMarkdown),
    } : null,
    upstream_result_hashes: {
      bid_analysis_hash: ['outline-generation', 'global-facts-generation', 'content-generation'].includes(type) ? bidAnalysisHash : null,
      outline_hash: ['global-facts-generation', 'content-generation'].includes(type) ? outlineHash : null,
      global_facts_hash: type === 'content-generation' ? globalFactsHash : null,
      content_hash: null,
    },
    generation_config_hash: stableHash({
      input,
      model: publicSnapshot,
      api_key_hash: stableHash(String(modelSnapshot?.apiKey || '')),
      runtime: generationConfigSnapshot || {},
    }),
    prompt_template_version: promptVersion,
    model_snapshot_ref: modelSnapshotRef,
    output_schema_version: {
      'bid-section-extraction': 'bid-sections.v1',
      'outline-generation': 'outline-data.v1',
      'global-facts-generation': 'global-facts.v1',
      'content-generation': 'content-generation.v1',
    }[type] || 'technical-plan.unknown.v1',
  };
}

function createWebTaskServiceStub() {
  const callbacks = new Set();

  function createPendingError() {
    return new Error('该能力在 Web 端尚未提供');
  }

  function subscribeCallback(callback) {
    callbacks.add(callback);
    return () => callbacks.delete(callback);
  }

  function unsubscribeCallback(callback) {
    callbacks.delete(callback);
  }

  function close() {
    callbacks.clear();
  }

  return {
    getActiveTasks() {
      return [];
    },
    subscribeCallback,
    unsubscribeCallback,
    close,
    subscribe() {
      throw createPendingError();
    },
    startBidSectionExtraction() {
      return Promise.reject(createPendingError());
    },
    startBidAnalysis() {
      return Promise.reject(createPendingError());
    },
    startOutlineGeneration() {
      return Promise.reject(createPendingError());
    },
    startGlobalFactsGeneration() {
      return Promise.reject(createPendingError());
    },
    startContentGeneration() {
      return Promise.reject(createPendingError());
    },
    startRejectionItemsExtraction() {
      return Promise.reject(createPendingError());
    },
    startRejectionCheck() {
      return Promise.reject(createPendingError());
    },
    startDuplicateAnalysis() {
      return Promise.reject(createPendingError());
    },
    pauseContentGeneration() {
      return Promise.reject(createPendingError());
    },
  };
}

function createTask(type, payload, taskMetadata = {}) {
  const definition = TECHNICAL_PLAN_TASK_DEFINITIONS[type] || {};
  const timestamp = new Date().toISOString();
  return {
    task_id: taskMetadata.taskId || crypto.randomUUID(),
    execution_id: taskMetadata.executionId,
    manifest_hash: taskMetadata.runRecord?.manifestHash,
    type,
    group: definition.group,
    step: definition.step,
    lock_policy: definition.lockPolicy,
    status: 'running',
    progress: 0,
    logs: [],
    started_at: timestamp,
    updated_at: timestamp,
    input_revision: payload.input_revision,
    payload_signature: taskMetadata.payloadSignature,
  };
}

function collectLeafNodeIds(items, result = []) {
  for (const item of Array.isArray(items) ? items : []) {
    if (Array.isArray(item?.children) && item.children.length) {
      collectLeafNodeIds(item.children, result);
    } else if (item?.id) {
      result.push(String(item.id));
    }
  }
  return result;
}

function createTechnicalPlanCheckpoint({ type, input, state, runRecord, status, error } = {}) {
  const sections = state?.contentGenerationSections && typeof state.contentGenerationSections === 'object'
    ? state.contentGenerationSections
    : {};
  const leafIds = collectLeafNodeIds(state?.outlineData?.outline || []);
  const completedItemIds = Object.entries(sections)
    .filter(([, section]) => section?.status === 'success')
    .map(([itemId]) => String(itemId));
  const pendingItemIds = leafIds.filter((itemId) => !completedItemIds.includes(itemId));
  return {
    schema_version: 1,
    task_type: type,
    execution_id: runRecord?.executionId,
    manifest_hash: runRecord?.manifestHash,
    target_stage_generation: runRecord?.targetStageGeneration,
    input: input || {},
    action: input?.action,
    status,
    completed_item_ids: completedItemIds,
    pending_item_ids: pendingItemIds,
    global_fact_group_ids: Array.isArray(state?.globalFacts) ? state.globalFacts.map((item) => String(item.id || '')).filter(Boolean) : [],
    content_generation_runtime: state?.contentGenerationRuntime || null,
    ...(error ? {
      error_code: error.code || 'TASK_EXECUTION_FAILED',
      message: error.message || String(error),
      retryable: error.retryable === true,
    } : {}),
    updated_at: new Date().toISOString(),
  };
}

function toPortableContentRunnerPayload(input = {}) {
  switch (input.action) {
    case 'resume':
      return { resume: true };
    case 'retry-correction':
      return { retryContentCorrection: true };
    case 'rerun-illustration-plan':
      return { rerunIllustrations: true };
    case 'regenerate-all':
      return { regenerate: true, generationOptions: input.generation_options };
    case 'regenerate-section':
      return {
        targetItemId: input.target_item_id,
        requirement: input.requirement,
        generationOptions: input.generation_options,
      };
    case 'start':
    default:
      return { generationOptions: input.generation_options };
  }
}

function createTaskConflictError() {
  const error = new Error('当前技术方案任务仍在执行，请等待完成后再提交新的解析请求');
  error.code = 'TASK_CONFLICT';
  error.retryable = true;
  return error;
}

function createTaskInterruptedError() {
  const error = new Error('服务正在关闭，招标文件解析已中断，请重新执行');
  error.code = 'TASK_INTERRUPTED_BY_RESTART';
  error.retryable = true;
  return error;
}

function createAcceptanceAbortError() {
  const error = new Error('请求在任务受理前已断开');
  error.code = 'TASK_ACCEPTANCE_ABORTED';
  error.retryable = true;
  return error;
}

function createPauseTimeoutError() {
  const error = new Error('任务暂停未能在期限内收敛，请稍后重试');
  error.code = 'TASK_PAUSE_TIMEOUT';
  error.retryable = true;
  return error;
}

function createTaskRunnerUnavailableError(type) {
  const error = new Error(`${type} portable runner 尚未装配`);
  error.code = 'TASK_RUNTIME_UNAVAILABLE';
  error.retryable = true;
  return error;
}

function createPayloadSignature(input) {
  const selection = normalizeBidAnalysisSelection(input.mode, input.selected_task_ids);
  const requested = new Set(Array.isArray(input.task_ids) ? input.task_ids : []);
  const taskIds = bidAnalysisDefinitions
    .map((definition) => definition.id)
    .filter((taskId) => requested.has(taskId));
  return JSON.stringify({
    mode: selection.mode,
    selected_task_ids: selection.taskIds,
    task_ids: taskIds,
    force_rerun: input.force_rerun === true,
  });
}

function createWebBidAnalysisTaskService({
  aiService,
  agentService,
  knowledgeBaseService,
  technicalPlanStore,
  mutationExecutor,
  workspaceRuntimeGeneration,
  taskRunners = {},
}) {
  if (!aiService || !technicalPlanStore || !mutationExecutor) {
    throw new Error('Web 招标解析任务服务缺少运行时依赖');
  }
  // WP-J J-1 固定走 J-Core；生产 Agent 修复链在 J-3 Sidecar Gate 前保持关闭。
  const boundAgentService = null;
  const globalFactsRunner = resolvePortableTaskRunner('global-facts-generation', taskRunners.globalFacts);
  const contentRunner = resolvePortableTaskRunner('content-generation', taskRunners.content);

  const definitions = TECHNICAL_PLAN_TASK_DEFINITIONS;
  const acceptedStartLeases = new Set();
  const stateAdapter = {
    load: () => technicalPlanStore.loadTechnicalPlan(),
    persist(_definition, partial) {
      const task = partial?.[_definition.field];
      if (task?.execution_id && task?.manifest_hash && typeof technicalPlanStore.updateTechnicalPlanTaskRunStatus === 'function') {
        const status = task.status;
        if (status && status !== 'running' && status !== 'success') {
          return mutationExecutor.execute(() => {
            technicalPlanStore.updateTechnicalPlanTaskRunStatus({
              executionId: task.execution_id,
              manifestHash: task.manifest_hash,
              status,
              checkpoint: task.checkpoint,
              task,
            });
            return technicalPlanStore.loadTechnicalPlan();
          });
        }
      }
      const inputRevision = partial?.bidAnalysisTask?.input_revision;
      if (Number.isInteger(inputRevision)) {
        return mutationExecutor.execute(() => technicalPlanStore.updateTechnicalPlanForInputRevision(inputRevision, partial));
      }
      return mutationExecutor.execute(() => technicalPlanStore.updateTechnicalPlan(partial));
    },
    persistFailure(definition, failedTask, error) {
      return mutationExecutor.execute(() => {
        if (failedTask.execution_id && failedTask.manifest_hash) {
          technicalPlanStore.failTechnicalPlanTaskRun({
            executionId: failedTask.execution_id,
            manifestHash: failedTask.manifest_hash,
            errorCode: error?.code,
            message: error?.message,
            retryable: error?.retryable === true,
            task: failedTask,
          });
          return technicalPlanStore.loadTechnicalPlan();
        }
        return technicalPlanStore.updateTechnicalPlan({ [definition.field]: failedTask });
      });
    },
    assertCanStart(type, payload) {
      if (acceptedStartLeases.has(type)) return;
      const state = technicalPlanStore.loadTechnicalPlan() || {};
      const resumeContent = type === 'content-generation' && payload?.action === 'resume';
      for (const [field, taskType] of Object.entries({
        bidSectionExtractionTask: 'bid-section-extraction',
        bidAnalysisTask: 'bid-analysis',
        outlineGenerationTask: 'outline-generation',
        globalFactsTask: 'global-facts-generation',
        contentGenerationTask: 'content-generation',
      })) {
        const task = state[field];
        if (!task || ['success', 'error', 'cancelled', 'interrupted'].includes(task.status)) continue;
        if (resumeContent && taskType === 'content-generation' && ['paused', 'pausing'].includes(task.status)) continue;
        throw createTaskConflictError();
      }
    },
    snapshot(definition, state, task, eventPatch = {}) {
      const patch = { ...(eventPatch.technicalPlanPatch || {}) };
      if (definition.field) {
        patch[definition.field] = state?.[definition.field] || task;
      }
      if (task.type === 'bid-analysis') {
        copyPatchFields(patch, state, [
          'bidAnalysisMode',
          'bidAnalysisSelectedTaskIds',
          'bidAnalysisProgress',
          'projectOverview',
          'techRequirements',
          'bidAnalysisTasks',
          'outlineData',
          'outlineWordControlSnapshot',
          'outlineGenerationTask',
          'globalFactsTask',
          'globalFacts',
          'contentGenerationTask',
          'contentGenerationSections',
          'contentGenerationPlans',
          'contentIllustrationPlan',
          'contentGenerationRuntime',
        ]);
      } else if (task.type === 'bid-section-extraction') {
        copyPatchFields(patch, state, [
          'bidSectionMode',
          'bidSections',
          'bidSectionExtractionStatus',
          'bidSectionExtractionError',
          'tenderFile',
          'bidAnalysisTask',
          'bidAnalysisTasks',
          'bidAnalysisProgress',
          'projectOverview',
          'techRequirements',
          'outlineData',
          'outlineWordControlSnapshot',
          'outlineGenerationTask',
          'referenceKnowledgeDocumentIds',
          'globalFactsTask',
          'globalFacts',
          'contentGenerationTask',
          'contentGenerationOptions',
          'contentGenerationSections',
          'contentGenerationPlans',
          'contentIllustrationPlan',
          'contentGenerationRuntime',
        ]);
      } else if (task.type === 'outline-generation') {
        copyPatchFields(patch, state, [
          'outlineMode',
          'outlineExpansionMode',
          'outlineWordControlOptions',
          'outlineWordControlSnapshot',
          'referenceKnowledgeDocumentIds',
          'outlineData',
          'globalFactsTask',
          'globalFacts',
          'contentGenerationTask',
          'contentGenerationSections',
          'contentGenerationPlans',
          'contentIllustrationPlan',
          'contentGenerationRuntime',
        ]);
      } else if (task.type === 'global-facts-generation') {
        copyPatchFields(patch, state, [
          'globalFacts',
          'globalFactsTask',
          'contentGenerationTask',
          'contentGenerationSections',
          'contentGenerationPlans',
          'contentIllustrationPlan',
          'contentGenerationRuntime',
          'outlineData',
          'outlineWordControlSnapshot',
          'referenceKnowledgeDocumentIds',
        ]);
      } else if (task.type === 'content-generation') {
        copyPatchFields(patch, state, [
          'outlineData',
          'outlineWordControlSnapshot',
          'globalFacts',
          'globalFactsTask',
          'contentGenerationTask',
          'contentGenerationSections',
          'contentGenerationPlans',
          'contentIllustrationPlan',
          'contentGenerationRuntime',
        ]);
      }
      return {
        technicalPlanPatch: patch,
        ...(eventPatch.bidItem ? { bidItem: eventPatch.bidItem } : {}),
      };
    },
  };
  let closed = false;
  let closePromise = null;
  const payloadSignatures = new WeakMap();
  const orchestrator = createTaskOrchestrator({
    definitions,
    createTask,
    getScopeId: () => '',
    getPayloadSignature: (_type, payload) => payloadSignatures.get(payload),
    stateAdapter,
    createRunnerContext({ type, payload, queueScopeId, updateTask, emitTask, taskControl, signal, previousState, taskMetadata = {} }) {
      const inputRevision = payload.input_revision;
      const runRecord = taskMetadata.runRecord;
      const manifestInput = taskMetadata.manifestInput || payload;
      let volatileState = technicalPlanStore.loadTechnicalPlan() || {};
      let volatileOriginalOutlineRuntime = technicalPlanStore.readOriginalOutlineRuntime?.() || null;
      const updateVolatileState = (partial) => {
        volatileState = { ...volatileState, ...(partial || {}) };
        return volatileState;
      };
      const commitAcceptedResult = (partial, finalTaskPatch, checkpoint) => mutationExecutor.execute(() => {
        let currentModelSnapshot;
        try {
          currentModelSnapshot = captureModelSnapshot();
        } catch {
          throw createTaskInputChangedError('模型配置已变化，请重新执行任务');
        }
        const currentGenerationConfig = captureTechnicalPlanGenerationConfig(aiService);
        const currentState = technicalPlanStore.loadTechnicalPlan() || {};
        const currentManifest = createTechnicalPlanRunManifest({
          type,
          input: manifestInput,
          taskId: runRecord.taskId,
          executionId: runRecord.executionId,
          workspaceRuntimeGeneration,
          technicalPlanStore,
          knowledgeBaseService,
          modelSnapshot: currentModelSnapshot,
          generationConfigSnapshot: currentGenerationConfig,
          stageRevisionVector: runRecord.manifest.stage_revision_vector,
          referenceDocumentIds: ['outline-generation', 'global-facts-generation', 'content-generation'].includes(type)
            ? currentState.referenceKnowledgeDocumentIds || []
            : [],
        });
        if (computeRunManifestV1Hash(currentManifest) !== runRecord.manifestHash) {
          throw createTaskInputChangedError();
        }
        const activeTask = orchestrator.activeTasks.get(type);
        const finalTask = finalTaskPatch ? {
          ...(activeTask || {}),
          ...finalTaskPatch,
          updated_at: new Date().toISOString(),
        } : null;
        const committedPartial = finalTask
          ? { ...partial, [definitions[type].field]: finalTask }
          : partial;
        const writeback = technicalPlanStore.writebackTechnicalPlanTaskRun({
          executionId: runRecord.executionId,
          manifestHash: runRecord.manifestHash,
          targetStageGeneration: runRecord.targetStageGeneration,
          checkpoint: checkpoint || createTechnicalPlanCheckpoint({
            type,
            input: manifestInput,
            state: currentState,
            runRecord,
            status: finalTaskPatch?.status || 'success',
          }),
          apply: () => technicalPlanStore.updateTechnicalPlan(committedPartial),
        });
        return writeback.payload;
      }, { signal });
      const workspaceStore = {
        ...technicalPlanStore,
        readTenderMarkdown: () => technicalPlanStore.readTenderMarkdown(),
        loadTechnicalPlan: () => runRecord ? volatileState : technicalPlanStore.loadTechnicalPlan(),
        updateTechnicalPlan: (partial) => runRecord
          ? updateVolatileState(partial)
          : technicalPlanStore.updateTechnicalPlan(partial),
        updateTechnicalPlanWithoutReload: (partial) => runRecord
          ? updateVolatileState(partial)
          : technicalPlanStore.updateTechnicalPlanWithoutReload(partial),
        updateTechnicalPlanForInputRevision: (revision, partial) => mutationExecutor.execute(() => technicalPlanStore.updateTechnicalPlanForInputRevision(revision, partial)),
        commitBidAnalysisMutation: (revision, build) => mutationExecutor.execute(() => {
          const previous = technicalPlanStore.loadTechnicalPlan() || {};
          const result = build(previous) || {};
          const state = technicalPlanStore.updateTechnicalPlanForInputRevision(revision, result.partial || {});
          return { ...result, state };
        }),
        prepareBidSectionExtraction: runRecord ? () => volatileState : technicalPlanStore.prepareBidSectionExtraction,
        readOriginalOutlineRuntime: runRecord ? () => volatileOriginalOutlineRuntime : technicalPlanStore.readOriginalOutlineRuntime,
        saveOriginalOutlineRuntime: runRecord ? (value) => {
          volatileOriginalOutlineRuntime = value;
        } : technicalPlanStore.saveOriginalOutlineRuntime,
        clearOriginalOutlineRuntime: runRecord ? () => {
          volatileOriginalOutlineRuntime = null;
        } : technicalPlanStore.clearOriginalOutlineRuntime,
        commitBidSectionExtractionResult: type === 'bid-section-extraction' && runRecord ? commitAcceptedResult : undefined,
        commitOutlineGenerationResult: type === 'outline-generation' && runRecord ? commitAcceptedResult : undefined,
        commitTechnicalPlanResult: runRecord ? commitAcceptedResult : undefined,
        saveContentGenerationItem: type === 'content-generation' && runRecord
          ? (partial = {}) => {
            const nextCheckpointState = {
              ...volatileState,
              contentGenerationRuntime: partial.runtime !== undefined
                ? partial.runtime
                : volatileState.contentGenerationRuntime,
            };
            const itemId = String(partial.nodeId || partial.section?.id || partial.storedPlan?.node_id || '').trim();
            if (partial.section && itemId) {
              nextCheckpointState.contentGenerationSections = {
                ...(volatileState.contentGenerationSections || {}),
                [itemId]: { ...partial.section, id: itemId },
              };
            }
            if (partial.storedPlan && itemId) {
              nextCheckpointState.contentGenerationPlans = {
                ...(volatileState.contentGenerationPlans || {}),
                [itemId]: partial.storedPlan,
              };
            }
            const checkpoint = createTechnicalPlanCheckpoint({
              type,
              input: manifestInput,
              state: nextCheckpointState,
              runRecord,
              status: 'running',
            });
            const currentTask = orchestrator.activeTasks.get(type) || volatileState.contentGenerationTask;
            technicalPlanStore.writebackTechnicalPlanTaskCheckpoint({
              executionId: runRecord.executionId,
              manifestHash: runRecord.manifestHash,
              targetStageGeneration: runRecord.targetStageGeneration,
              checkpoint,
              status: 'running',
              task: currentTask,
              ...partial,
            });
            volatileState = technicalPlanStore.loadTechnicalPlan() || nextCheckpointState;
            return volatileState;
          }
          : technicalPlanStore.saveContentGenerationItem,
      };
      const scopedBaseAiService = typeof aiService.withQueueScope === 'function'
        ? aiService.withQueueScope(queueScopeId, taskMetadata.modelSnapshot ? { modelSnapshot: taskMetadata.modelSnapshot } : {})
        : aiService;
      const scopedAiService = taskMetadata.generationConfigSnapshot ? {
        ...scopedBaseAiService,
        getConfig: () => ({
          context_length_limit: taskMetadata.generationConfigSnapshot.context_length_limit,
          agent_mode_scenarios: { ...taskMetadata.generationConfigSnapshot.agent_mode_scenarios },
        }),
        getCapabilities: () => ({ ...taskMetadata.generationConfigSnapshot.capabilities }),
      } : scopedBaseAiService;
      return {
        aiService: scopedAiService,
        agentService: boundAgentService,
        knowledgeBaseService,
        workspaceStore,
        updateTask,
        emitTask,
        taskControl,
        signal,
        previousState,
        taskMetadata,
        commitTechnicalPlanResult: runRecord ? commitAcceptedResult : undefined,
        payload: Number.isInteger(inputRevision) ? { ...payload, input_revision: inputRevision } : payload,
        queueScopeId,
      };
    },
    releaseRunnerContext({ queueScopeId }) {
      if (!closed && typeof aiService.resumeQueueScope === 'function') aiService.resumeQueueScope(queueScopeId);
    },
  });
  const startingTasks = new Map();

  async function runPortableTechnicalPlanTask(type, runner, context) {
    if (typeof runner !== 'function') throw createTaskRunnerUnavailableError(type);
    const runnerContext = type === 'content-generation'
      ? { ...context, payload: toPortableContentRunnerPayload(context.payload) }
      : context;
    try {
      await runner(runnerContext);
    } catch (error) {
      if (context.signal.aborted && !context.taskControl.isPauseRequested()) {
        throw context.signal.reason || createTaskInterruptedError();
      }
      throw error;
    }
    if (context.signal.aborted && !context.taskControl.isPauseRequested()) {
      throw context.signal.reason || createTaskInterruptedError();
    }
    const state = context.workspaceStore.loadTechnicalPlan() || {};
    const definition = definitions[type];
    const task = state[definition.field] || {};
    const checkpoint = createTechnicalPlanCheckpoint({
      type,
      input: context.taskMetadata?.manifestInput || context.payload,
      state,
      runRecord: context.taskMetadata?.runRecord,
      status: task.status || 'success',
    });

    if (task.status === 'paused' || task.status === 'pausing' || context.taskControl.isPauseRequested()) {
      await mutationExecutor.execute(() => technicalPlanStore.updateTechnicalPlanTaskRunStatus({
        executionId: context.taskMetadata.runRecord.executionId,
        manifestHash: context.taskMetadata.runRecord.manifestHash,
        targetStageGeneration: context.taskMetadata.runRecord.targetStageGeneration,
        status: 'paused',
        checkpoint,
        task: { ...task, status: 'paused', pause_requested: true },
      }));
      return state;
    }

    if (task.status === 'error') {
      const error = new Error(task.error || `${type} 执行失败`);
      error.code = task.error_code || 'TASK_EXECUTION_FAILED';
      error.retryable = task.retryable === true;
      throw error;
    }

    const partial = type === 'global-facts-generation'
      ? {
        globalFacts: state.globalFacts || [],
        globalFactsTask: task,
        contentGenerationTask: undefined,
        contentGenerationSections: {},
        contentGenerationPlans: {},
        contentIllustrationPlan: undefined,
        contentGenerationRuntime: undefined,
      }
      : {
        outlineData: state.outlineData || null,
        contentGenerationSections: state.contentGenerationSections || {},
        contentGenerationPlans: state.contentGenerationPlans || {},
        contentIllustrationPlan: state.contentIllustrationPlan,
        contentGenerationRuntime: state.contentGenerationRuntime,
        contentGenerationTask: task,
      };
    await context.commitTechnicalPlanResult(
      partial,
      { ...task, status: 'success', progress: 100, pause_requested: false },
      { ...checkpoint, status: 'success' },
    );
    return state;
  }

  function isActiveTask(task) {
    return task?.status === 'running' || task?.status === 'pausing';
  }

  function assertNoConflictingTask(type, payloadSignature) {
    for (const [activeType, activeTask] of orchestrator.activeTasks.entries()) {
      if (!isActiveTask(activeTask)) continue;
      if (activeType === type && activeTask.payload_signature === payloadSignature) {
        return activeTask;
      }
      throw createTaskConflictError();
    }
    for (const [startingType, starting] of startingTasks.entries()) {
      if (startingType === type && starting.payloadSignature === payloadSignature) {
        return starting.promise;
      }
      throw createTaskConflictError();
    }
    return null;
  }

  function startManagedTask({
    type,
    input,
    payloadSignature,
    runner,
    initialPartial,
    prepare,
    signal,
  }) {
    if (closed) return Promise.reject(createTaskInterruptedError());
    try {
      const existing = assertNoConflictingTask(type, payloadSignature);
      if (existing) return existing;
      stateAdapter.assertCanStart(type, input);
    } catch (error) {
      return Promise.reject(error);
    }

    const controller = new AbortController();
    const abortAcceptance = () => controller.abort(createAcceptanceAbortError());
    if (signal?.aborted) abortAcceptance();
    else signal?.addEventListener?.('abort', abortAcceptance, { once: true });

    let acceptedRunRecord = null;
    let acceptedTask = null;
    const startPromise = Promise.resolve()
      .then(() => prepare(controller.signal))
      .then((prepared = {}) => {
        acceptedRunRecord = prepared.runRecord || null;
        acceptedTask = prepared.acceptedTask || null;
        if (controller.signal.aborted) throw controller.signal.reason || createAcceptanceAbortError();
        const preparedPayload = prepared.payloadPatch ? { ...input, ...prepared.payloadPatch } : { ...input };
        payloadSignatures.set(preparedPayload, payloadSignature);
        acceptedStartLeases.add(type);
        let started;
        try {
          started = orchestrator.start({
            type,
            payload: preparedPayload,
            runner,
            initialPartial: prepared.initialPartial || initialPartial,
            taskMetadata: {
              ...prepared,
              payloadPatch: undefined,
              payloadSignature,
            },
          });
        } catch (error) {
          acceptedStartLeases.delete(type);
          throw error;
        }
        if (started && typeof started.then === 'function') {
          return started.finally(() => acceptedStartLeases.delete(type));
        }
        acceptedStartLeases.delete(type);
        return started;
      })
      .catch(async (error) => {
        if (acceptedRunRecord) {
          await mutationExecutor.execute(() => technicalPlanStore.failTechnicalPlanTaskRun({
            executionId: acceptedRunRecord.executionId,
            manifestHash: acceptedRunRecord.manifestHash,
            errorCode: error?.code || 'TASK_ACCEPTANCE_FAILED',
            message: error?.message || '任务受理失败',
            retryable: error?.retryable === true,
            task: acceptedTask ? {
              ...acceptedTask,
              status: 'error',
              error: error?.message || '任务受理失败',
              error_code: error?.code || 'TASK_ACCEPTANCE_FAILED',
              retryable: error?.retryable === true,
              updated_at: new Date().toISOString(),
            } : undefined,
          }));
        }
        throw error;
      });
    const starting = { payloadSignature, controller, promise: startPromise };
    startingTasks.set(type, starting);
    void startPromise.finally(() => {
      if (startingTasks.get(type) === starting) {
        startingTasks.delete(type);
      }
      signal?.removeEventListener?.('abort', abortAcceptance);
    }).catch(() => undefined);
    return startPromise;
  }

  function captureModelSnapshot() {
    if (typeof aiService.captureTextModelSnapshot === 'function') {
      return aiService.captureTextModelSnapshot();
    }
    const error = new Error('当前 AI Runtime 无法冻结模型配置');
    error.code = 'AI_CONFIG_INVALID';
    error.retryable = false;
    throw error;
  }

  function prepareTechnicalPlanRun(type, input, initialPartial, payloadSignature, signal, { initialCheckpoint } = {}) {
    if (!Number.isInteger(workspaceRuntimeGeneration) || workspaceRuntimeGeneration <= 0) {
      return Promise.reject(createTaskConflictError());
    }
    const taskId = crypto.randomUUID();
    const executionId = crypto.randomUUID();
    return mutationExecutor.execute(() => {
      const modelSnapshot = captureModelSnapshot();
      const generationConfigSnapshot = captureTechnicalPlanGenerationConfig(aiService);
      const manifest = createTechnicalPlanRunManifest({
        type,
        input,
        taskId,
        executionId,
        workspaceRuntimeGeneration,
        technicalPlanStore,
        knowledgeBaseService,
        modelSnapshot,
        generationConfigSnapshot,
      });
      const acceptedTask = createTask(type, input, {
        taskId,
        executionId,
        payloadSignature,
      });
      const runRecord = technicalPlanStore.acceptTechnicalPlanTaskRun(manifest, {
        initialPartial: {
          ...(initialPartial || {}),
          [definitions[type].field]: acceptedTask,
        },
        initialCheckpoint,
      });
      return {
        taskId,
        executionId,
        modelSnapshot,
        generationConfigSnapshot,
        acceptedTask,
        runRecord,
      };
    }, { signal });
  }

  function prepareContentResumeRun(input, payloadSignature, signal) {
    return mutationExecutor.execute(() => {
      const state = technicalPlanStore.loadTechnicalPlan() || {};
      const task = state.contentGenerationTask;
      const record = task?.execution_id
        ? technicalPlanStore.getTechnicalPlanRunRecord(task.execution_id)
        : technicalPlanStore.getTechnicalPlanRunRecordByTaskId?.(task?.task_id);
      if (!task || !record || !record.manifest || record.taskType !== 'content-generation') {
        throw createTaskConflictError();
      }
      const manifestInput = record.checkpoint?.input;
      if (!manifestInput || manifestInput.action === 'resume') {
        throw createTaskConflictError();
      }
      const resumedRecord = technicalPlanStore.resumeTechnicalPlanTaskRun({
        executionId: record.executionId,
        manifestHash: record.manifestHash,
        targetStageGeneration: record.targetStageGeneration,
      });
      const modelSnapshot = captureModelSnapshot();
      const generationConfigSnapshot = captureTechnicalPlanGenerationConfig(aiService);
      const acceptedTask = createTask('content-generation', input, {
        taskId: record.taskId,
        executionId: record.executionId,
        payloadSignature,
        runRecord: resumedRecord,
      });
      return {
        taskId: record.taskId,
        executionId: record.executionId,
        modelSnapshot,
        generationConfigSnapshot,
        acceptedTask,
        runRecord: resumedRecord,
        manifestInput,
        initialPartial: { contentGenerationTask: acceptedTask },
      };
    }, { signal });
  }

  return {
    close() {
      if (closePromise) return closePromise;
      closed = true;
      const interrupted = createTaskInterruptedError();
      const starting = Array.from(startingTasks.values());
      starting.forEach((item) => item.controller.abort(interrupted));
      closePromise = Promise.allSettled(starting.map((item) => item.promise))
        .then(() => orchestrator.close({ reason: interrupted }));
      return closePromise;
    },
    getActiveTasks: orchestrator.getActiveTasks,
    subscribeCallback: orchestrator.subscribe,
    unsubscribeCallback: orchestrator.unsubscribe,
    startBidSectionExtraction(payload, { signal } = {}) {
      const input = validateStartBidSectionExtractionInput(payload);
      const payloadSignature = stableHash(input);
      const initialPartial = {
        bidSectionMode: 'multiple',
        bidSections: [],
        bidSectionExtractionStatus: 'running',
        bidSectionExtractionError: undefined,
        bidAnalysisTask: undefined,
        bidAnalysisTasks: {},
        bidAnalysisProgress: 0,
        projectOverview: '',
        techRequirements: '',
        outlineData: null,
        outlineWordControlSnapshot: undefined,
        outlineGenerationTask: undefined,
        referenceKnowledgeDocumentIds: [],
        globalFactsTask: undefined,
        globalFacts: [],
        contentGenerationTask: undefined,
        contentGenerationOptions: undefined,
        contentGenerationSections: {},
        contentGenerationPlans: {},
        contentIllustrationPlan: undefined,
        contentGenerationRuntime: undefined,
      };
      return startManagedTask({
        type: 'bid-section-extraction',
        input,
        payloadSignature,
        runner: runBidSectionExtractionTask,
        initialPartial,
        prepare: (acceptanceSignal) => prepareTechnicalPlanRun(
          'bid-section-extraction',
          input,
          initialPartial,
          payloadSignature,
          acceptanceSignal,
        ),
        signal,
      });
    },
    startBidAnalysis(payload, { signal } = {}) {
      const input = validateStartBidAnalysisInput(payload);
      const payloadSignature = createPayloadSignature(input);
      return startManagedTask({
        type: 'bid-analysis',
        input,
        payloadSignature,
        runner: runBidAnalysisTask,
        prepare: (acceptanceSignal) => mutationExecutor.execute(() => technicalPlanStore.prepareBidAnalysisRun({
          mode: input.mode,
          selectedTaskIds: input.selected_task_ids,
          taskIds: input.task_ids,
          forceRerun: input.force_rerun,
        }), { signal: acceptanceSignal }).then(({ inputVersion }) => ({
          payloadPatch: { input_revision: inputVersion.inputRevision },
        })),
        signal,
      });
    },
    startOutlineGeneration(payload, { signal } = {}) {
      const input = validateStartOutlineGenerationInput(payload);
      const payloadSignature = stableHash(input);
      const initialPartial = {
        outlineMode: 'aligned',
        outlineExpansionMode: input.outline_expansion_mode,
        outlineWordControlOptions: input.word_control_options,
        outlineWordControlSnapshot: undefined,
        referenceKnowledgeDocumentIds: input.reference_knowledge_document_ids,
        outlineData: null,
        globalFactsTask: undefined,
        globalFacts: [],
        contentGenerationTask: undefined,
        contentGenerationSections: {},
        contentGenerationPlans: {},
        contentIllustrationPlan: undefined,
        contentGenerationRuntime: undefined,
      };
      return startManagedTask({
        type: 'outline-generation',
        input,
        payloadSignature,
        runner: runOutlineGenerationTask,
        initialPartial,
        prepare: (acceptanceSignal) => prepareTechnicalPlanRun(
          'outline-generation',
          input,
          initialPartial,
          payloadSignature,
          acceptanceSignal,
        ),
        signal,
      });
    },
    startGlobalFactsGeneration(payload, { signal } = {}) {
      const input = validateStartGlobalFactsGenerationInput(payload);
      const payloadSignature = stableHash(input);
      const initialPartial = {
        globalFacts: [],
        globalFactsTask: undefined,
        contentGenerationTask: undefined,
        contentGenerationSections: {},
        contentGenerationPlans: {},
        contentIllustrationPlan: undefined,
        contentGenerationRuntime: undefined,
      };
      return startManagedTask({
        type: 'global-facts-generation',
        input,
        payloadSignature,
        runner: (context) => runPortableTechnicalPlanTask('global-facts-generation', globalFactsRunner, context),
        initialPartial,
        prepare: (acceptanceSignal) => prepareTechnicalPlanRun(
          'global-facts-generation',
          input,
          initialPartial,
          payloadSignature,
          acceptanceSignal,
          { initialCheckpoint: { input, status: 'accepted' } },
        ),
        signal,
      });
    },
    startContentGeneration(payload, { signal } = {}) {
      const input = validateStartContentGenerationInput(payload);
      const payloadSignature = stableHash(input);
      if (input.action === 'resume') {
        return startManagedTask({
          type: 'content-generation',
          input,
          payloadSignature,
          runner: (context) => runPortableTechnicalPlanTask('content-generation', contentRunner, context),
          prepare: (acceptanceSignal) => prepareContentResumeRun(input, payloadSignature, acceptanceSignal),
          signal,
        });
      }
      const initialPartial = {
        ...(input.generation_options ? { contentGenerationOptions: input.generation_options } : {}),
        ...(input.action === 'start' || input.action === 'regenerate-all' ? {
          contentGenerationSections: {},
          contentGenerationPlans: {},
          contentIllustrationPlan: undefined,
          contentGenerationRuntime: undefined,
        } : {}),
      };
      return startManagedTask({
        type: 'content-generation',
        input,
        payloadSignature,
        runner: (context) => runPortableTechnicalPlanTask('content-generation', contentRunner, context),
        initialPartial,
        prepare: (acceptanceSignal) => prepareTechnicalPlanRun(
          'content-generation',
          input,
          initialPartial,
          payloadSignature,
          acceptanceSignal,
          { initialCheckpoint: { input, status: 'accepted' } },
        ),
        signal,
      });
    },
    pauseContentGeneration(payload, { signal } = {}) {
      validatePauseContentGenerationInput(payload || {});
      if (signal?.aborted) return Promise.reject(signal.reason || createAcceptanceAbortError());
      const control = orchestrator.activeTaskControls.get('content-generation');
      const activeTask = orchestrator.activeTasks.get('content-generation');
      if (!control || !activeTask) {
        const persisted = technicalPlanStore.loadTechnicalPlan()?.contentGenerationTask;
        if (persisted?.status === 'paused') return Promise.resolve(persisted);
        return Promise.reject(createTaskConflictError());
      }
      if (activeTask.status === 'paused') return Promise.resolve(activeTask);
      const pausingTask = control.requestPause();
      const timeoutMs = Math.max(1000, Number(process.env.WEB_TASK_PAUSE_DRAIN_TIMEOUT_MS) || 60000);
      const timeout = new Promise((_, reject) => {
        const timer = setTimeout(() => reject(createPauseTimeoutError()), timeoutMs);
        timer.unref?.();
      });
      const settled = Promise.resolve(control.runnerPromise).then(() => {
        const task = technicalPlanStore.loadTechnicalPlan()?.contentGenerationTask;
        return task?.status === 'paused' ? task : { ...pausingTask, status: 'paused', pause_requested: true };
      });
      return Promise.race([settled, timeout]).catch(async (error) => {
        if (error?.code !== 'TASK_PAUSE_TIMEOUT') throw error;
        control.cancel(error);
        const task = orchestrator.activeTasks.get('content-generation') || pausingTask;
        if (task.execution_id && task.manifest_hash) {
          await mutationExecutor.execute(() => technicalPlanStore.updateTechnicalPlanTaskRunStatus({
            executionId: task.execution_id,
            manifestHash: task.manifest_hash,
            status: 'error',
            checkpoint: createTechnicalPlanCheckpoint({
              type: 'content-generation',
              input: task.payload || {},
              state: technicalPlanStore.loadTechnicalPlan(),
              runRecord: technicalPlanStore.getTechnicalPlanRunRecord(task.execution_id),
              status: 'error',
              error,
            }),
            task: {
              ...task,
              status: 'error',
              error: error.message,
              error_code: error.code,
              retryable: true,
              pause_requested: false,
            },
          }));
        }
        throw error;
      });
    },
  };
}

function createWebAiServiceStub() {
  const stubScope = {
    chat: () => Promise.reject(new Error('Web 端 AI 请求尚未实现')),
    requestJson: () => Promise.reject(new Error('Web 端 AI 请求尚未实现')),
    collectJsonResponse: () => Promise.reject(new Error('Web 端 AI 请求尚未实现')),
    generateImage: () => Promise.reject(new Error('Web 端 AI 生图尚未实现')),
  };

  return {
    withQueueScope(_scopeId) {
      return stubScope;
    },
    pauseQueueScope(_scopeId) {
      // no-op：占位服务无真实队列
    },
    resumeQueueScope(_scopeId) {
      // no-op
    },
    chat: stubScope.chat,
    requestJson: stubScope.requestJson,
    collectJsonResponse: stubScope.collectJsonResponse,
    generateImage: stubScope.generateImage,
  };
}

function createWebKnowledgeBaseService({ knowledgeBaseStore, fileService }) {
  return {
    store: knowledgeBaseStore,
    list() {
      return knowledgeBaseStore.list();
    },
    createFolder(name) {
      return knowledgeBaseStore.createFolder(name);
    },
    getOutlineReferences(documentIds) {
      return knowledgeBaseStore.getOutlineReferences(documentIds);
    },
    getDocument(documentId) {
      return knowledgeBaseStore.getDocument(documentId);
    },
    readMarkdown(documentId) {
      return knowledgeBaseStore.readMarkdown(documentId);
    },
    uploadDocuments(folderId, fileIds, options = {}) {
      return fileService.uploadKnowledgeBaseDocuments({ folderId, fileIds, knowledgeBaseStore, signal: options.signal });
    },
  };
}

function createWebDuplicateCheckServiceStub({ duplicateCheckStore }) {
  return {
    store: duplicateCheckStore,
    runAnalysisTask: async () => {
      throw new Error('Web 端查重分析任务尚未实现');
    },
  };
}

module.exports = {
  createWebTaskServiceStub,
  createWebBidAnalysisTaskService,
  createWebAiServiceStub,
  createWebKnowledgeBaseService,
  createWebDuplicateCheckServiceStub,
};
