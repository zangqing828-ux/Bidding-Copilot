// Web 端 task/agent 最小占位服务：为后续业务包保留接口形状。
// AI 真实运行时由 core/aiRuntime.cjs 装配；这里的 AI stub 仅保留兼容导出，不能用于 live wiring。
// 占位服务的方法存在但调用时抛 WEB_CAPABILITY_PENDING，确保任务执行不会伪造成功。

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

// WP-E 仅接通一条最小业务闭环：项目概述生成。其他任务继续保持 pending，避免伪造完成状态。
function createWebTaskService({ technicalPlanStore, agentService }) {
  const callbacks = new Set();
  const activeTasks = new Map();

  function emit(task, patch) {
    callbacks.forEach((callback) => {
      try { callback({ task, technicalPlanPatch: patch }); } catch {}
    });
  }

  function now() {
    return new Date().toISOString();
  }

  function getActiveTasks() {
    return Array.from(activeTasks.values());
  }

  function startBidAnalysis() {
    if (activeTasks.has('bid-analysis')) {
      return activeTasks.get('bid-analysis');
    }
    const tenderMarkdown = technicalPlanStore.readTenderMarkdown();
    if (!String(tenderMarkdown || '').trim()) {
      const error = new Error('请先导入招标文件再执行项目概述分析');
      error.code = 'INVALID_BRIDGE_ARGUMENTS';
      throw error;
    }
    const task = {
      task_id: `bid-analysis-${Date.now()}`,
      type: 'bid-analysis',
      status: 'running',
      progress: 10,
      logs: ['正在启动 OpenCode 项目概述分析'],
      started_at: now(),
      updated_at: now(),
    };
    activeTasks.set('bid-analysis', task);
    technicalPlanStore.updateTechnicalPlanWithoutReload({ bidAnalysisTask: task });
    emit(task, { bidAnalysisTask: task });
    void agentService.runTask({
      task_id: task.task_id,
      title: '项目概述分析',
      task: '请基于 input/tender.md 提取项目名称、背景目的、规模预算、时间安排、实施内容和技术特点，生成准确的项目概述。',
      output_file: 'result.md',
      files: [{ path: 'input/tender.md', content: tenderMarkdown }],
    }).then((result) => {
      const state = technicalPlanStore.loadTechnicalPlan();
      const completed = { ...task, status: 'success', progress: 100, logs: ['项目概述分析完成'], updated_at: now() };
      const bidAnalysisTasks = {
        ...(state.bidAnalysisTasks || {}),
        projectOverview: { id: 'projectOverview', label: '项目概述', status: 'success', content: result.output_content },
      };
      technicalPlanStore.updateTechnicalPlanWithoutReload({ bidAnalysisTask: completed, bidAnalysisTasks });
      activeTasks.delete('bid-analysis');
      emit(completed, { bidAnalysisTask: completed, bidAnalysisTasks });
    }).catch((error) => {
      const failed = { ...task, status: 'error', progress: 100, logs: ['项目概述分析失败'], error: error?.message || 'Agent 执行失败', updated_at: now() };
      technicalPlanStore.updateTechnicalPlanWithoutReload({ bidAnalysisTask: failed });
      activeTasks.delete('bid-analysis');
      emit(failed, { bidAnalysisTask: failed });
    });
    return task;
  }

  return {
    getActiveTasks,
    subscribeCallback(callback) { callbacks.add(callback); return () => callbacks.delete(callback); },
    unsubscribeCallback(callback) { callbacks.delete(callback); },
    close() { callbacks.clear(); activeTasks.clear(); },
    startBidAnalysis,
    subscribe() { throw new Error('该能力在 Web 端尚未提供'); },
    startBidSectionExtraction() { return Promise.reject(new Error('该能力在 Web 端尚未提供')); },
    startOutlineGeneration() { return Promise.reject(new Error('该能力在 Web 端尚未提供')); },
    startGlobalFactsGeneration() { return Promise.reject(new Error('该能力在 Web 端尚未提供')); },
    startContentGeneration() { return Promise.reject(new Error('该能力在 Web 端尚未提供')); },
    startRejectionItemsExtraction() { return Promise.reject(new Error('该能力在 Web 端尚未提供')); },
    startRejectionCheck() { return Promise.reject(new Error('该能力在 Web 端尚未提供')); },
    startDuplicateAnalysis() { return Promise.reject(new Error('该能力在 Web 端尚未提供')); },
    pauseContentGeneration() { return Promise.reject(new Error('该能力在 Web 端尚未提供')); },
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
    uploadDocuments(folderId, fileIds) {
      return fileService.uploadKnowledgeBaseDocuments({ folderId, fileIds, knowledgeBaseStore });
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
  createWebTaskService,
  createWebAiServiceStub,
  createWebKnowledgeBaseService,
  createWebDuplicateCheckServiceStub,
};
