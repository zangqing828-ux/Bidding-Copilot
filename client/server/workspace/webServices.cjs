// Web 端最小占位服务：为 taskService 提供所需接口形状。
// 真实 AI 请求和 Agent Runtime 留到后续 Sprint 实现。
// 占位服务的方法存在但调用时抛 WEB_CAPABILITY_PENDING，确保 taskService 能实例化但任务执行不伪造成功。

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

function createWebAgentServiceStub() {
  return {
    bindSelectedRuntime() {
      return {
        run: () => Promise.reject(new Error('Web 端 Agent Runtime 尚未实现')),
        getStatus: () => Promise.resolve({ phase: 'stopped', healthy: false, message: 'Web 端 Agent Runtime 尚未实现' }),
        listRuntimes: () => [],
        selfCheck: () => Promise.reject(new Error('Web 端 Agent Runtime 尚未实现')),
      };
    },
    close() {
      // no-op
    },
  };
}

function createWebKnowledgeBaseServiceStub({ knowledgeBaseStore }) {
  return {
    store: knowledgeBaseStore,
    // 真实方法留到后续 Sprint
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
  createWebAgentServiceStub,
  createWebKnowledgeBaseServiceStub,
  createWebDuplicateCheckServiceStub,
};
