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
  createWebAiServiceStub,
  createWebKnowledgeBaseService,
  createWebDuplicateCheckServiceStub,
};
