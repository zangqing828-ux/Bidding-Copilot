const crypto = require('node:crypto');
const { createTaskOrchestrator } = require('../../core/taskOrchestrator.cjs');
const { runBidAnalysisTask } = require('../../core/bidAnalysisTask.cjs');
const { bidAnalysisDefinitions, normalizeBidAnalysisSelection, validateStartBidAnalysisInput } = require('../../shared/bidAnalysisContract.cjs');

// 其他 Web 任务仍保留 pending，投标解析在 WP-I 中接入真实运行时。

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

function createTask(_type, payload) {
  const timestamp = new Date().toISOString();
  return {
    task_id: crypto.randomUUID(),
    type: 'bid-analysis',
    group: 'technical-plan',
    step: 2,
    lock_policy: 'group-exclusive',
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

function createWebBidAnalysisTaskService({ aiService, technicalPlanStore, mutationExecutor }) {
  if (!aiService || !technicalPlanStore || !mutationExecutor) {
    throw new Error('Web 招标解析任务服务缺少运行时依赖');
  }

  const definitions = {
    'bid-analysis': {
      label: '招标文件解析',
      group: 'technical-plan',
      groupLabel: '技术方案',
      step: 2,
      lockPolicy: 'group-exclusive',
      stateKey: 'technicalPlan',
      field: 'bidAnalysisTask',
    },
  };
  const stateAdapter = {
    load: () => technicalPlanStore.loadTechnicalPlan(),
    persist(_definition, partial) {
      const inputRevision = partial?.bidAnalysisTask?.input_revision;
      if (Number.isInteger(inputRevision)) {
        return mutationExecutor.execute(() => technicalPlanStore.updateTechnicalPlanForInputRevision(inputRevision, partial));
      }
      return mutationExecutor.execute(() => technicalPlanStore.updateTechnicalPlan(partial));
    },
    snapshot(_definition, state, task, eventPatch = {}) {
      const patch = {
        bidAnalysisTask: state?.bidAnalysisTask || task,
        bidAnalysisMode: state?.bidAnalysisMode,
        bidAnalysisSelectedTaskIds: state?.bidAnalysisSelectedTaskIds,
        bidAnalysisProgress: state?.bidAnalysisProgress,
        projectOverview: state?.projectOverview,
        techRequirements: state?.techRequirements,
        bidAnalysisTasks: state?.bidAnalysisTasks,
        ...eventPatch.technicalPlanPatch,
      };
      return {
        technicalPlanPatch: patch,
        ...(eventPatch.bidItem ? { bidItem: eventPatch.bidItem } : {}),
      };
    },
  };
  let closed = false;
  let closePromise = null;
  const orchestrator = createTaskOrchestrator({
    definitions,
    createTask,
    getScopeId: () => '',
    getPayloadSignature: (_type, payload) => payload?.payload_signature,
    stateAdapter,
    createRunnerContext({ payload, queueScopeId, updateTask, emitTask, taskControl, signal }) {
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
        aiService: typeof aiService.withQueueScope === 'function' ? aiService.withQueueScope(queueScopeId) : aiService,
        workspaceStore,
        updateTask,
        emitTask,
        taskControl,
        signal,
        payload: { ...payload, input_revision: inputRevision },
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
      const payloadSignature = createPayloadSignature(input);
      const activeTask = orchestrator.activeTasks.get('bid-analysis');
      if (activeTask?.status === 'running' || activeTask?.status === 'pausing') {
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
        runner: runBidAnalysisTask,
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
