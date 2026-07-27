const { createTemplateStore } = require('../../core/templateStore.cjs');
const { createEncryptedConfigStore } = require('../config/encryptedConfigStore.cjs');
const { createTechnicalPlanStore } = require('../../core/stores/technicalPlanStore.cjs');
const { createKnowledgeBaseStore } = require('../../core/stores/knowledgeBaseStore.cjs');
const { createDuplicateCheckStore } = require('../../core/stores/duplicateCheckStore.cjs');
const { createRejectionCheckStore } = require('../../core/stores/rejectionCheckStore.cjs');
const { createTaskEventPort } = require('../../core/taskEventPort.cjs');
const { assertPort } = require('../../core/ports.cjs');
const { createAiRuntime } = require('../../core/aiRuntime.cjs');
const { getGlobalAiCoordinator } = require('../ai/globalAiCoordinator.cjs');
const { getGlobalAgentCoordinator } = require('../agent/globalAgentCoordinator.cjs');
const { createAiAnalyticsTracker } = require('../ai/aiAnalytics.cjs');
const { createWebEndpointPolicy } = require('../ai/webEndpointPolicy.cjs');
const { createWorkspaceStoreExecutor } = require('./storeBridgeExecutor.cjs');
const { createWorkspaceMutationExecutor } = require('./workspaceMutationExecutor.cjs');
const { createUploadRegistry } = require('./uploadRegistry.cjs');
const { createWebFileService } = require('./webFileService.cjs');

function createCloseHandler(target) {
  if (!target || typeof target.close !== 'function') {
    return null;
  }
  return target.close.bind(target);
}

function pushCloseHandler(closeHandlers, closeHandler, label) {
  if (typeof closeHandler === 'function') {
    closeHandlers.push(closeHandler);
    return;
  }
  if (label) {
    throw new Error(`${label} 缺少 close 方法`);
  }
}

function isPromiseLike(value) {
  return value && typeof value.then === 'function';
}

function restoreFailedHandlers(closeHandlers, failedHandlers) {
  closeHandlers.length = 0;
  for (let i = failedHandlers.length - 1; i >= 0; i -= 1) {
    const failedHandler = failedHandlers[i];
    if (!closeHandlers.includes(failedHandler)) {
      closeHandlers.push(failedHandler);
    }
  }
}

function buildCloseError(errors) {
  if (errors.length > 1) {
    return new AggregateError(
      errors,
      `runtime.close: 关闭处理器失败 ${errors.length} 处`,
      { cause: errors[0] },
    );
  }
  return errors[0] || null;
}

async function runCloseHandlers(closeHandlers, { preserveFailures = false } = {}) {
  const errors = [];
  const failedHandlers = [];

  for (let i = closeHandlers.length - 1; i >= 0; i -= 1) {
    const handler = closeHandlers[i];
    try {
      await handler();
      closeHandlers.splice(i, 1);
    } catch (error) {
      errors.push(error);
      if (preserveFailures) {
        failedHandlers.push(handler);
      }
    }
  }

  if (preserveFailures) {
    restoreFailedHandlers(closeHandlers, failedHandlers);
  } else {
    closeHandlers.length = 0;
  }

  return buildCloseError(errors);
}

function runCloseHandlersSync(closeHandlers) {
  const errors = [];

  for (let i = closeHandlers.length - 1; i >= 0; i -= 1) {
    const handler = closeHandlers[i];
    try {
      const result = handler();
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch((error) => {
          console.warn('[workspace] 初始化失败后的异步资源清理失败', error?.message || String(error));
        });
      }
      closeHandlers.splice(i, 1);
    } catch (error) {
      errors.push(error);
    }
  }

  closeHandlers.length = 0;
  return buildCloseError(errors);
}

function wrapSetupError(error, closeError) {
  if (!closeError) {
    return error;
  }
  return new AggregateError(
    [error, ...Array.isArray(closeError.errors) ? closeError.errors : [closeError]],
    'runtime 初始化失败且清理失败',
    { cause: error },
  );
}

function createTaskEventPortAndTrack(taskService, closeHandlers) {
  const taskEvents = createTaskEventPort(taskService);
  pushCloseHandler(closeHandlers, taskEvents.close, 'taskEvents');
  return taskEvents;
}

function createBidAnalysisTestAiService() {
  const service = {
    chat: async ({ messages = [] } = {}) => `浏览器测试解析结果：${String(messages.at(-1)?.content || '').slice(0, 24)}`,
    collectJsonResponse: async (options = {}) => {
      const label = String(options.progressLabel || options.logTitle || options.failureMessage || '');
      let value;
      if (label.includes('多标段识别')) {
        value = {
          sections: [
            {
              id: 'section-1',
              index: 1,
              unit: '标段',
              title: '一标段',
              headLine: '一标段：云平台建设',
              description: '平台基础设施建设、系统集成',
              includeRanges: [{ startLine: 4, endLine: 5, reason: '一标段正文' }],
              evidence: ['一标段：云平台建设'],
            },
            {
              id: 'section-2',
              index: 2,
              unit: '标段',
              title: '二标段',
              headLine: '二标段：运维与保障',
              description: '运维监控、SLA 与交付培训',
              includeRanges: [{ startLine: 7, endLine: 8, reason: '二标段正文' }],
              evidence: ['二标段：运维与保障'],
            },
          ],
        };
      } else if (label.includes('技术评分大类')) {
        value = {
          groups: [{
            requirement_id: 'REQ-BROWSER-01',
            title: '技术实现能力',
            description: '围绕系统架构、实施方式和验收能力展开。',
            detail_points: ['平台架构稳定性', '实施与交付能力'],
          }],
        };
      } else if (label.includes('最终目录审核')) {
        value = { passed: true, suggestions: [] };
      } else if (label.includes('章节')) {
        value = {
          children: [{
            id: '1.1',
            title: '总体架构与技术路线',
            description: '输出可落地的架构实施路线与职责分工。',
            children: [{
              id: '1.1.1',
              title: '平台架构说明',
              description: '说明平台架构、模块边界和接口契约。',
            }],
          }],
        };
      } else {
        value = {};
      }
      if (typeof options.normalizer === 'function') value = options.normalizer(value);
      if (typeof options.validator === 'function') options.validator(value);
      return value;
    },
    requestJson(options) {
      return service.collectJsonResponse(options);
    },
    captureTextModelSnapshot: () => Object.freeze({
      provider: 'browser-test',
      baseUrl: 'https://browser-test.invalid/v1',
      modelName: 'browser-test-model',
      apiKey: 'browser-test-key',
      capturedAt: new Date().toISOString(),
    }),
    close() {},
    getConfig: () => ({ context_length_limit: 400000 }),
    getCapabilities: () => ({}),
    getImageQueueStatus: () => ({ active: 0, queued: 0 }),
    getTextQueueStatus: () => ({ active: 0, queued: 0 }),
    pauseQueueScope() {},
    resumeQueueScope() {},
    withQueueScope() { return service; },
  };
  return service;
}

function createWebWorkspaceRuntime({
  workspaceId,
  userDir,
  workspaceRoot,
  paths,
  databasePath,
  configPath,
  sharedCoordinator,
  sharedAgentCoordinator,
  aiRuntimeOptions = {},
  aiServiceOverride,
}) {
  const closeHandlers = [];
  let closePromise = null;

  if (!workspaceId || typeof workspaceId !== 'string') {
    throw new Error('workspaceId 必须为非空字符串');
  }
  if (!userDir || typeof userDir !== 'string') {
    throw new Error('userDir 必须为字符串');
  }
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    throw new Error('workspaceRoot 必须为字符串');
  }
  if (!paths || typeof paths !== 'object') {
    throw new Error('paths 必须为路径对象');
  }

  if (!databasePath || typeof databasePath !== 'string') {
    throw new Error('databasePath 必须为字符串');
  }
  if (!configPath || typeof configPath !== 'string') {
    throw new Error('configPath 必须为字符串');
  }

  try {
    const { createSqliteDatabase } = require('../../core/sqliteDatabase.cjs');
    const {
      createWebBidAnalysisTaskService,
      createWebKnowledgeBaseService,
      createWebDuplicateCheckServiceStub,
    } = require('./webServices.cjs');
    const { createWebAgentService } = require('../agent/webAgentService.cjs');
    const { createWebExportService } = require('../export/webExportService.cjs');

    const sqliteDatabase = createSqliteDatabase({ databasePath });
    if (!sqliteDatabase || typeof sqliteDatabase.close !== 'function') {
      throw new Error('sqliteDatabase 缺少 close 方法');
    }
    pushCloseHandler(closeHandlers, createCloseHandler(sqliteDatabase), 'sqliteDatabase');

    const agentCoordinator = sharedAgentCoordinator || getGlobalAgentCoordinator();
    const agentWorkspaceLease = typeof agentCoordinator.registerWorkspace === 'function'
      ? agentCoordinator.registerWorkspace(workspaceId)
      : null;
    if (!agentWorkspaceLease?.generation) {
      throw new Error('Agent Coordinator 缺少 Workspace 运行时代号');
    }
    pushCloseHandler(closeHandlers, createCloseHandler(agentWorkspaceLease), 'agentWorkspaceLease');

    const configStore = createEncryptedConfigStore({ configPath });
    const uploadRegistry = createUploadRegistry({ db: sqliteDatabase.db, uploadsDir: paths.uploadsDir });
    const fileService = createWebFileService({ uploadRegistry, configStore });
    const technicalPlanStore = createTechnicalPlanStore({
      db: sqliteDatabase.db,
      workspaceRoot,
      fileService,
      workspaceRuntimeGeneration: agentWorkspaceLease.generation,
    });
    technicalPlanStore.recoverInterruptedTasks();
    const knowledgeBaseStore = createKnowledgeBaseStore({ db: sqliteDatabase.db, workspaceRoot });
    const duplicateCheckStore = createDuplicateCheckStore({ db: sqliteDatabase.db, workspaceRoot });
    sqliteDatabase.db.prepare(`
      UPDATE duplicate_check_files
      SET file_path = 'upload:' || file_id
      WHERE file_path NOT LIKE 'upload:%'
    `).run();
    sqliteDatabase.db.prepare(`
      UPDATE duplicate_check_content_files
      SET content_path = NULL
      WHERE content_path IS NOT NULL
    `).run();
    const rejectionCheckStore = createRejectionCheckStore({ db: sqliteDatabase.db, workspaceRoot, technicalPlanStore, fileService });
    const templateStore = createTemplateStore({ db: sqliteDatabase.db });
    const storeExecutor = createWorkspaceStoreExecutor({
      workspaceId,
      workspaceRoot,
      databasePath,
      configPath,
    });
    pushCloseHandler(closeHandlers, createCloseHandler(storeExecutor), 'storeExecutor');
    const mutationExecutor = createWorkspaceMutationExecutor();
    pushCloseHandler(closeHandlers, createCloseHandler(mutationExecutor), 'mutationExecutor');

    const resolvedCoordinator = sharedCoordinator || getGlobalAiCoordinator();
    const runtimeAiOptions = {
      ...aiRuntimeOptions,
      workspaceKey: workspaceId,
      sharedCoordinator: resolvedCoordinator,
      loadConfig: configStore.loadDecrypted.bind(configStore),
    };
    const isProductionRuntime = process.env.NODE_ENV === 'production';
    const hasInjectedEndpointPolicy = typeof runtimeAiOptions.endpointPolicy === 'function'
      || (runtimeAiOptions.endpointPolicy && typeof runtimeAiOptions.endpointPolicy === 'object');
    if (isProductionRuntime || !hasInjectedEndpointPolicy) {
      runtimeAiOptions.endpointPolicy = createWebEndpointPolicy();
    }
    if (typeof runtimeAiOptions.trackRequest !== 'function') {
      runtimeAiOptions.trackRequest = createAiAnalyticsTracker({
        fetch: runtimeAiOptions.analyticsFetch,
      });
    }
    delete runtimeAiOptions.analyticsFetch;
    const useBidAnalysisTestAi = process.env.WEB_BID_ANALYSIS_TEST_MODE === '1';
    if ((aiServiceOverride || useBidAnalysisTestAi) && isProductionRuntime) {
      throw new Error('生产环境禁止使用测试 AI 装配');
    }
    if (useBidAnalysisTestAi && process.env.NODE_ENV !== 'test') {
      throw new Error('测试 AI 只允许由 NODE_ENV=test 的测试装配启用');
    }
    const aiService = aiServiceOverride || (useBidAnalysisTestAi ? createBidAnalysisTestAiService() : createAiRuntime(runtimeAiOptions));
    pushCloseHandler(closeHandlers, createCloseHandler(aiService), 'aiService');
    const agentService = createWebAgentService({
      workspaceId,
      workspaceRoot,
      aiService,
      agentCoordinator,
      agentWorkspaceLease,
    });
    if (!agentService || typeof agentService.close !== 'function') {
      throw new Error('agentService 缺少 close 方法');
    }
    pushCloseHandler(closeHandlers, createCloseHandler(agentService), 'agentService');
    const exportService = createWebExportService({ workspaceId, workspaceRoot });
    pushCloseHandler(closeHandlers, createCloseHandler(exportService), 'exportService');

    const knowledgeBaseService = createWebKnowledgeBaseService({ knowledgeBaseStore, fileService });
    const duplicateCheckService = createWebDuplicateCheckServiceStub({ duplicateCheckStore });
    const taskService = createWebBidAnalysisTaskService({
      aiService,
      agentService,
      knowledgeBaseService,
      technicalPlanStore,
      mutationExecutor,
      workspaceRuntimeGeneration: agentWorkspaceLease.generation,
    });
    pushCloseHandler(closeHandlers, createCloseHandler(taskService), 'taskService');

    const taskEvents = createTaskEventPortAndTrack(taskService, closeHandlers);

    const runtime = {
      db: sqliteDatabase.db,
      sqliteDatabase,
      configStore,
      uploadRegistry,
      fileService,
      storeExecutor,
      mutationExecutor,
      aiService,
      agentService,
      exportService,
      taskService,
      taskEvents,
      knowledgeBaseService,
      stores: {
        technicalPlanStore,
        knowledgeBaseStore,
        duplicateCheckStore,
        rejectionCheckStore,
        templateStore,
      },
      ports: {
        config: {
          load: configStore.load.bind(configStore),
          save: configStore.save.bind(configStore),
        },
        ai: aiService,
        agent: agentService,
        taskEvents,
      },
      close() {
        if (closePromise) {
          return closePromise;
        }

        const attempt = (async () => {
          const closeError = await runCloseHandlers(closeHandlers, { preserveFailures: true });
          if (closeError) {
            throw closeError;
          }
        })();

        closePromise = attempt;
        void attempt.catch(() => {
          if (closePromise === attempt) {
            closePromise = null;
          }
        });
        return attempt;
      },
    };

    assertPort('config', runtime.ports.config);
    assertPort('ai', runtime.ports.ai);
    assertPort('agent', runtime.ports.agent);
    assertPort('taskEvents', runtime.ports.taskEvents);

    return runtime;
  } catch (error) {
    const closeError = runCloseHandlersSync(closeHandlers);
    if (closeError) {
      throw wrapSetupError(error, closeError);
    }
    throw error;
  }
}

function createWorkspaceRuntimeFactory(runtimeOptions = {}) {
  const {
    workspaceId,
    userDir,
    workspaceRoot,
    paths = {},
    databasePath,
    configPath,
    adapter = 'web',
    sharedCoordinator,
    sharedAgentCoordinator,
    aiRuntimeOptions,
  } = runtimeOptions;

  if (adapter !== 'web') {
    throw new Error(`不支持的 adapter: ${adapter}`);
  }

  return createWebWorkspaceRuntime({
    workspaceId,
    userDir,
    workspaceRoot,
    paths,
    databasePath,
    configPath,
    sharedCoordinator,
    sharedAgentCoordinator,
    aiRuntimeOptions,
    aiServiceOverride: runtimeOptions.aiServiceOverride,
  });
}

module.exports = {
  createWorkspaceRuntimeFactory,
  createWebWorkspaceRuntime,
};
