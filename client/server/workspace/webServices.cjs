const crypto = require('node:crypto');
const { createTaskOrchestrator } = require('../../core/taskOrchestrator.cjs');
const { runBidAnalysisTask } = require('../../core/bidAnalysisTask.cjs');
const { validateStartBidAnalysisInput } = require('../../shared/bidAnalysisContract.cjs');

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

function createTask(payload) {
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
  };
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
  const orchestrator = createTaskOrchestrator({
    definitions,
    createTask,
    getScopeId: () => '',
    stateAdapter,
    createRunnerContext({ payload, queueScopeId, updateTask, emitTask }) {
      const inputRevision = payload.input_revision;
      const workspaceStore = {
        readTenderMarkdown: () => technicalPlanStore.readTenderMarkdown(),
        loadTechnicalPlan: () => technicalPlanStore.loadTechnicalPlan(),
        updateTechnicalPlan: (partial) => mutationExecutor.execute(() => technicalPlanStore.updateTechnicalPlan(partial)),
        updateTechnicalPlanForInputRevision: (revision, partial) => mutationExecutor.execute(() => technicalPlanStore.updateTechnicalPlanForInputRevision(revision, partial)),
      };
      return {
        aiService: typeof aiService.withQueueScope === 'function' ? aiService.withQueueScope(queueScopeId) : aiService,
        workspaceStore,
        updateTask,
        emitTask,
        payload: { ...payload, input_revision: inputRevision },
        queueScopeId,
      };
    },
    releaseRunnerContext({ queueScopeId }) {
      if (typeof aiService.resumeQueueScope === 'function') aiService.resumeQueueScope(queueScopeId);
    },
  });

  return {
    close() {
      // runtime close 由 mutation executor 排空，任务只需停止向外订阅。
    },
    getActiveTasks: orchestrator.getActiveTasks,
    subscribeCallback: orchestrator.subscribe,
    unsubscribeCallback: orchestrator.unsubscribe,
    startBidAnalysis(payload) {
      const input = validateStartBidAnalysisInput(payload);
      const activeTask = orchestrator.activeTasks.get('bid-analysis');
      if (activeTask?.status === 'running' || activeTask?.status === 'pausing') {
        return activeTask;
      }
      return mutationExecutor.execute(() => technicalPlanStore.prepareBidAnalysisRun({
        selectedTaskIds: input.selected_task_ids,
        taskIds: input.task_ids,
        forceRerun: input.force_rerun,
      })).then(({ inputVersion }) => orchestrator.start({
        type: 'bid-analysis',
        payload: { ...input, input_revision: inputVersion.inputRevision },
        runner: runBidAnalysisTask,
      }));
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
