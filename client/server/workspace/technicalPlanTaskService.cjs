// Web 技术方案任务编排服务：只注册四种首发任务（招标解析、目录、全局事实、正文）。
// 复用 bid-analysis 的 CAS、mutation executor、SSE 快照与 close 语义；
// generation 任务的 runner 直接同步访问 Store（better-sqlite3 事务原子），
// 写路径带 input revision 守卫：目录或输入变化后旧任务无法回写。
const crypto = require('node:crypto');
const { createTaskOrchestrator } = require('../../core/taskOrchestrator.cjs');
const { runBidAnalysisTask } = require('../../core/bidAnalysisTask.cjs');
const { runOutlineGenerationTask } = require('../../core/technical-plan/outline/outlineGenerationTask.cjs');
const { runGlobalFactsTask } = require('../../core/technical-plan/content/globalFactsTask.cjs');
const { runContentGenerationTask } = require('../../core/technical-plan/content/contentGenerationTask.cjs');
const { bidAnalysisDefinitions, normalizeBidAnalysisSelection, validateStartBidAnalysisInput } = require('../../shared/bidAnalysisContract.cjs');
const {
  TASK_ERROR_CODES,
  canonicalizeRendererStartContentGenerationInput,
  canonicalizeStartContentGenerationInput,
  validateStartOutlineGenerationInput,
  validateStartGlobalFactsGenerationInput,
  validatePauseContentGenerationInput,
} = require('../../shared/contracts/technical-plan/taskContracts.cjs');

const taskDefinitions = Object.freeze({
  'bid-analysis': {
    label: '招标文件解析',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 2,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'bidAnalysisTask',
  },
  'outline-generation': {
    label: '目录生成',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 3,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'outlineGenerationTask',
  },
  'global-facts-generation': {
    label: '全局事实设定',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 4,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'globalFactsTask',
  },
  'content-generation': {
    label: '正文生成',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 5,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'contentGenerationTask',
  },
});

function hasOwn(target, key) {
  return Object.prototype.hasOwnProperty.call(target || {}, key);
}

function copyPatchFields(patch, state, fields) {
  for (const field of fields) {
    patch[field] = state?.[field];
  }
}

function isActiveTaskStatus(status) {
  return status === 'running' || status === 'pausing';
}

function createTask(type, payload) {
  const definition = taskDefinitions[type];
  const timestamp = new Date().toISOString();
  return {
    task_id: crypto.randomUUID(),
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
    payload_signature: payload.payload_signature,
  };
}

function createTaskConflictError() {
  const error = new Error('当前技术方案任务仍在执行，请等待完成后再提交新的解析请求');
  error.code = TASK_ERROR_CODES.CONFLICT;
  error.retryable = true;
  return error;
}

function createTaskInterruptedError() {
  const error = new Error('服务正在关闭，技术方案任务已中断，请重新执行');
  error.code = TASK_ERROR_CODES.INTERRUPTED_BY_RESTART;
  error.retryable = true;
  return error;
}

function createAcceptanceAbortError() {
  const error = new Error('请求在任务受理前已断开');
  error.code = TASK_ERROR_CODES.ACCEPTANCE_ABORTED;
  error.retryable = true;
  return error;
}

function createInputChangedError() {
  const error = new Error('技术方案输入已更新，旧任务结果不再回写，请重新开始');
  error.code = TASK_ERROR_CODES.INPUT_CHANGED;
  error.retryable = true;
  return error;
}

function createBidAnalysisPayloadSignature(input) {
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

// canonical action -> core runner 期望的 payload 字段。
function buildContentRunnerPayload(canonical) {
  switch (canonical.action) {
    case 'resume':
      return { resume: true };
    case 'retry-correction':
      return { retry_content_correction: true };
    case 'rerun-illustration-plan':
      return { rerun_illustrations: true };
    case 'regenerate-all':
      return { regenerate: true, generation_options: canonical.generation_options };
    case 'regenerate-section':
      return {
        regenerate: true,
        targetItemId: canonical.target_item_id,
        requirement: canonical.requirement,
        generation_options: canonical.generation_options,
      };
    default:
      return { generation_options: canonical.generation_options };
  }
}

function createTechnicalPlanTaskService({ aiService, technicalPlanStore, knowledgeBaseService, mutationExecutor, taskRunners = {} }) {
  if (!aiService || !technicalPlanStore || !mutationExecutor) {
    throw new Error('Web 技术方案任务服务缺少运行时依赖');
  }

  let closed = false;
  let closePromise = null;

  function currentInputRevision() {
    return technicalPlanStore.getBidAnalysisInputVersion().inputRevision;
  }

  const stateAdapter = {
    load: () => technicalPlanStore.loadTechnicalPlan(),
    persist(definition, partial) {
      const task = partial?.[definition.field];
      const inputRevision = task?.input_revision;
      if (definition.field === 'bidAnalysisTask') {
        if (Number.isInteger(inputRevision)) {
          return mutationExecutor.execute(() => technicalPlanStore.updateTechnicalPlanForInputRevision(inputRevision, partial));
        }
        return mutationExecutor.execute(() => technicalPlanStore.updateTechnicalPlan(partial));
      }
      // generation 任务的 runner 同步消费 persist 返回的状态，必须同步 CAS 落盘。
      if (Number.isInteger(inputRevision)) {
        return technicalPlanStore.updateTechnicalPlanForInputRevision(inputRevision, partial);
      }
      return technicalPlanStore.updateTechnicalPlan(partial);
    },
    snapshot(definition, state, task, eventPatch = {}) {
      const patch = { ...(eventPatch.technicalPlanPatch || {}) };
      if (definition.field) {
        patch[definition.field] = state?.[definition.field] || task;
      }

      if (task.type === 'bid-analysis') {
        copyPatchFields(patch, state, ['bidAnalysisMode', 'bidAnalysisSelectedTaskIds', 'bidAnalysisProgress', 'projectOverview', 'techRequirements', 'bidAnalysisTasks']);
        if (state?.outlineData === null) {
          copyPatchFields(patch, state, [
            'outlineData',
            'outlineWordControlSnapshot',
            'outlineGenerationTask',
            'globalFactsTask',
            'globalFacts',
            'contentGenerationTask',
            'contentGenerationOptions',
            'contentGenerationSections',
            'contentGenerationPlans',
            'contentIllustrationPlan',
            'contentGenerationRuntime',
          ]);
        }
      }

      if (task.type === 'outline-generation') {
        copyPatchFields(patch, state, [
          'outlineMode',
          'outlineExpansionMode',
          'outlineWordControlOptions',
          'outlineWordControlSnapshot',
          'referenceKnowledgeDocumentIds',
        ]);
        if (task.status === 'success' || state?.outlineData === null || hasOwn(eventPatch, 'outlineData')) {
          copyPatchFields(patch, state, [
            'outlineData',
            'globalFactsTask',
            'globalFacts',
            'contentGenerationTask',
            'contentGenerationSections',
            'contentGenerationPlans',
            'contentIllustrationPlan',
            'contentGenerationRuntime',
          ]);
        }
      }

      if (task.type === 'global-facts-generation') {
        copyPatchFields(patch, state, ['globalFacts']);
        if (!isActiveTaskStatus(task.status)) {
          copyPatchFields(patch, state, [
            'contentGenerationTask',
            'contentGenerationSections',
            'contentGenerationPlans',
            'contentIllustrationPlan',
            'contentGenerationRuntime',
          ]);
        }
      }

      if (task.type === 'content-generation') {
        copyPatchFields(patch, state, ['outlineWordControlSnapshot', 'contentIllustrationPlan', 'contentGenerationRuntime']);
        if (!isActiveTaskStatus(task.status)) {
          copyPatchFields(patch, state, [
            'outlineData',
            'contentGenerationSections',
            'contentGenerationPlans',
            'contentIllustrationPlan',
            'contentGenerationRuntime',
          ]);
        }
      }

      if (hasOwn(eventPatch, 'outlineData')) patch.outlineData = eventPatch.outlineData;
      if (hasOwn(eventPatch, 'contentRuntime')) patch.contentGenerationRuntime = eventPatch.contentRuntime;

      const event = { technicalPlanPatch: patch };
      if (hasOwn(eventPatch, 'bidItem')) event.bidItem = eventPatch.bidItem;
      if (hasOwn(eventPatch, 'outlineData')) event.outlineData = eventPatch.outlineData;
      if (hasOwn(eventPatch, 'contentSection')) event.contentSection = eventPatch.contentSection;
      if (hasOwn(eventPatch, 'contentPlan')) event.contentPlan = eventPatch.contentPlan;
      if (hasOwn(eventPatch, 'contentRuntime')) event.contentRuntime = eventPatch.contentRuntime;
      return event;
    },
  };

  // generation runner 的 Store 视图：读同步透传，写同步执行且校验任务绑定的 input revision。
  function createGuardedWorkspaceStore(taskRevision) {
    function assertRevision() {
      if (Number.isInteger(taskRevision) && currentInputRevision() !== taskRevision) {
        throw createInputChangedError();
      }
    }
    function guard(method) {
      return (...args) => {
        assertRevision();
        return technicalPlanStore[method](...args);
      };
    }
    return {
      loadTechnicalPlan: () => technicalPlanStore.loadTechnicalPlan(),
      readTenderMarkdown: () => technicalPlanStore.readTenderMarkdown(),
      readOriginalPlanMarkdown: () => technicalPlanStore.readOriginalPlanMarkdown(),
      readOriginalOutlineRuntime: () => technicalPlanStore.readOriginalOutlineRuntime(),
      readIllustrationHtml: (relativePath) => technicalPlanStore.readIllustrationHtml(relativePath),
      findIllustrationHtml: (query) => technicalPlanStore.findIllustrationHtml(query),
      updateTechnicalPlan: guard('updateTechnicalPlan'),
      updateTechnicalPlanWithoutReload: guard('updateTechnicalPlanWithoutReload'),
      saveContentGenerationItem: guard('saveContentGenerationItem'),
      commitOutlineGenerationResult: guard('commitOutlineGenerationResult'),
      saveOriginalOutlineRuntime: guard('saveOriginalOutlineRuntime'),
      clearOriginalOutlineRuntime: guard('clearOriginalOutlineRuntime'),
      clearMermaidCache: guard('clearMermaidCache'),
      clearIllustrationFiles: guard('clearIllustrationFiles'),
      saveIllustrationHtml: guard('saveIllustrationHtml'),
      saveIllustrationPng: guard('saveIllustrationPng'),
    };
  }

  const orchestrator = createTaskOrchestrator({
    definitions: taskDefinitions,
    createTask,
    getScopeId: () => '',
    getPayloadSignature: (_type, payload) => payload?.payload_signature,
    stateAdapter,
    createRunnerContext({ definition, payload, queueScopeId, updateTask, emitTask, taskControl, signal, previousState }) {
      const scopedAiService = typeof aiService.withQueueScope === 'function' ? aiService.withQueueScope(queueScopeId) : aiService;
      if (definition.field === 'bidAnalysisTask') {
        const inputRevision = payload.input_revision;
        const workspaceStore = {
          readTenderMarkdown: () => technicalPlanStore.readTenderMarkdown(),
          loadTechnicalPlan: () => technicalPlanStore.loadTechnicalPlan(),
          updateTechnicalPlan: (partial) => mutationExecutor.execute(() => technicalPlanStore.updateTechnicalPlan(partial)),
          updateTechnicalPlanForInputRevision: (revision, partial) => mutationExecutor.execute(() => technicalPlanStore.updateTechnicalPlanForInputRevision(revision, partial)),
          commitBidAnalysisMutation: (revision, build) => mutationExecutor.execute(() => {
            const previous = technicalPlanStore.loadTechnicalPlan() || {};
            const result = build(previous) || {};
            const state = technicalPlanStore.updateTechnicalPlanForInputRevision(revision, result.partial || {});
            return { ...result, state };
          }),
        };
        return {
          aiService: scopedAiService,
          workspaceStore,
          updateTask,
          emitTask,
          taskControl,
          signal,
          payload: { ...payload, input_revision: inputRevision },
          queueScopeId,
        };
      }
      return {
        aiService: scopedAiService,
        workspaceStore: createGuardedWorkspaceStore(payload.input_revision),
        knowledgeBaseService,
        updateTask,
        emitTask,
        taskControl,
        signal,
        payload,
        previousState,
        queueScopeId,
      };
    },
    releaseRunnerContext({ queueScopeId }) {
      if (!closed && typeof aiService.resumeQueueScope === 'function') aiService.resumeQueueScope(queueScopeId);
    },
  });

  let startingBidAnalysis = null;

  function clearStartingBidAnalysis(starting) {
    if (startingBidAnalysis === starting) {
      startingBidAnalysis = null;
    }
  }

  function getTaskRunner(type, fallback) {
    return typeof taskRunners[type] === 'function' ? taskRunners[type] : fallback;
  }

  // 受理阶段统一走 mutation executor：读取前置状态和当前 revision 后同步启动。
  function startGenerationTask({ type, runner, runnerPayload, payloadSignature, initialPartial = {}, precheck }) {
    if (closed) return Promise.reject(createTaskInterruptedError());
    const activeTask = orchestrator.activeTasks.get(type);
    if (isActiveTaskStatus(activeTask?.status)) {
      if (activeTask.payload_signature && payloadSignature && activeTask.payload_signature !== payloadSignature) {
        return Promise.reject(createTaskConflictError());
      }
      return Promise.resolve(orchestrator.start({ type, payload: { payload_signature: activeTask.payload_signature }, runner }));
    }
    // 同组不同类型的互斥冲突统一返回 TASK_CONFLICT，与 bridge 契约一致。
    for (const otherTask of orchestrator.getActiveTasks()) {
      if (!isActiveTaskStatus(otherTask.status) || otherTask.type === type) continue;
      if (taskDefinitions[otherTask.type]?.group === taskDefinitions[type].group) {
        return Promise.reject(createTaskConflictError());
      }
    }
    return mutationExecutor.execute(() => {
      const state = technicalPlanStore.loadTechnicalPlan() || {};
      if (typeof precheck === 'function') precheck(state);
      const inputRevision = currentInputRevision();
      return orchestrator.start({
        type,
        payload: { ...runnerPayload, input_revision: inputRevision, payload_signature: payloadSignature },
        runner,
        initialPartial,
      });
    });
  }

  return {
    close() {
      if (closePromise) return closePromise;
      closed = true;
      const interrupted = createTaskInterruptedError();
      startingBidAnalysis?.controller.abort(interrupted);
      closePromise = Promise.resolve(startingBidAnalysis?.promise)
        .catch(() => undefined)
        .then(() => orchestrator.close({ reason: interrupted }));
      return closePromise;
    },
    getActiveTasks: orchestrator.getActiveTasks,
    subscribeCallback: orchestrator.subscribe,
    unsubscribeCallback: orchestrator.unsubscribe,
    startBidAnalysis(payload, { signal } = {}) {
      if (closed) return Promise.reject(createTaskInterruptedError());
      const input = validateStartBidAnalysisInput(payload);
      const payloadSignature = createBidAnalysisPayloadSignature(input);
      const activeTask = orchestrator.activeTasks.get('bid-analysis');
      if (isActiveTaskStatus(activeTask?.status)) {
        if (activeTask.payload_signature !== payloadSignature) {
          return Promise.reject(createTaskConflictError());
        }
        return activeTask;
      }
      if (startingBidAnalysis) {
        if (startingBidAnalysis.payloadSignature !== payloadSignature) {
          return Promise.reject(createTaskConflictError());
        }
        return startingBidAnalysis.promise;
      }
      const controller = new AbortController();
      const abortAcceptance = () => controller.abort(createAcceptanceAbortError());
      if (signal?.aborted) abortAcceptance();
      else signal?.addEventListener?.('abort', abortAcceptance, { once: true });
      const startPromise = mutationExecutor.execute(() => technicalPlanStore.prepareBidAnalysisRun({
        mode: input.mode,
        selectedTaskIds: input.selected_task_ids,
        taskIds: input.task_ids,
        forceRerun: input.force_rerun,
      }), { signal: controller.signal }).then(({ inputVersion }) => {
        if (controller.signal.aborted) throw controller.signal.reason || createAcceptanceAbortError();
        return orchestrator.start({
          type: 'bid-analysis',
          payload: { ...input, input_revision: inputVersion.inputRevision, payload_signature: payloadSignature },
          runner: getTaskRunner('bid-analysis', runBidAnalysisTask),
        });
      });
      const starting = { payloadSignature, controller, promise: startPromise };
      startingBidAnalysis = starting;
      void startPromise.then(
        () => clearStartingBidAnalysis(starting),
        () => clearStartingBidAnalysis(starting),
      ).finally(() => {
        signal?.removeEventListener?.('abort', abortAcceptance);
      });
      return startPromise;
    },
    startOutlineGeneration(payload) {
      const input = validateStartOutlineGenerationInput(payload);
      return startGenerationTask({
        type: 'outline-generation',
        runner: getTaskRunner('outline-generation', runOutlineGenerationTask),
        runnerPayload: input,
        payloadSignature: JSON.stringify(input),
        initialPartial: {
          outlineMode: 'aligned',
          outlineExpansionMode: input.outline_expansion_mode,
          outlineWordControlOptions: input.word_control_options,
          referenceKnowledgeDocumentIds: input.reference_knowledge_document_ids,
        },
        precheck(state) {
          if (!state.tenderFile) {
            throw createStartPrecheckError('请先上传并解析招标文件，再生成目录');
          }
        },
      });
    },
    startGlobalFactsGeneration(payload) {
      validateStartGlobalFactsGenerationInput(payload);
      return startGenerationTask({
        type: 'global-facts-generation',
        runner: getTaskRunner('global-facts-generation', runGlobalFactsTask),
        runnerPayload: {},
        payloadSignature: JSON.stringify({}),
        initialPartial: {
          globalFacts: [],
          contentGenerationTask: undefined,
          contentGenerationSections: {},
          contentGenerationPlans: {},
          contentIllustrationPlan: undefined,
          contentGenerationRuntime: undefined,
        },
        precheck(state) {
          if (!state.outlineData?.outline?.length) {
            throw createStartPrecheckError('请先生成目录，再生成全局事实');
          }
        },
      });
    },
    startContentGeneration(payload) {
      const canonical = hasOwn(payload || {}, 'action')
        ? canonicalizeStartContentGenerationInput(payload)
        : canonicalizeRendererStartContentGenerationInput(payload);
      return startGenerationTask({
        type: 'content-generation',
        runner: getTaskRunner('content-generation', runContentGenerationTask),
        runnerPayload: buildContentRunnerPayload(canonical),
        payloadSignature: JSON.stringify(canonical),
        precheck(state) {
          if (!state.outlineData?.outline?.length) {
            throw createStartPrecheckError('请先生成目录，再生成正文');
          }
          if (!state.outlineWordControlSnapshot) {
            throw createStartPrecheckError('当前目录没有字数控制生效快照，请重新生成目录');
          }
        },
      });
    },
    pauseContentGeneration(payload = {}) {
      validatePauseContentGenerationInput(payload);
      const task = orchestrator.activeTasks.get('content-generation');
      const control = orchestrator.activeTaskControls.get('content-generation');
      if (task && isActiveTaskStatus(task.status) && control?.requestPause) {
        if (control.queueScopeId && typeof aiService.pauseQueueScope === 'function') {
          aiService.pauseQueueScope(control.queueScopeId);
        }
        return control.requestPause();
      }
      const technicalPlan = technicalPlanStore.loadTechnicalPlan() || {};
      const contentTask = technicalPlan.contentGenerationTask;
      if (contentTask?.status === 'paused' || contentTask?.status === 'pausing') {
        return contentTask;
      }
      throw createStartPrecheckError('当前没有正在生成的正文任务。');
    },
  };
}

function createStartPrecheckError(message) {
  const error = new Error(message);
  error.code = TASK_ERROR_CODES.INVALID_INPUT;
  return error;
}

module.exports = {
  createTechnicalPlanTaskService,
  technicalPlanTaskDefinitions: taskDefinitions,
};
