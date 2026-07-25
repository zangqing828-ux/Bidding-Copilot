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
const { createAiAnalyticsTracker } = require('../ai/aiAnalytics.cjs');

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

function runCloseHandlers(closeHandlers, { preserveFailures = false } = {}) {
  const errors = [];
  const failedHandlers = [];

  for (let i = closeHandlers.length - 1; i >= 0; i -= 1) {
    const handler = closeHandlers[i];
    try {
      handler();
      closeHandlers.splice(i, 1);
    } catch (error) {
      errors.push(error);
      if (preserveFailures) {
        failedHandlers.push(handler);
      }
    }
  }

  if (preserveFailures) {
    closeHandlers.length = 0;
    for (let i = failedHandlers.length - 1; i >= 0; i -= 1) {
      const failedHandler = failedHandlers[i];
      if (!closeHandlers.includes(failedHandler)) {
        closeHandlers.push(failedHandler);
      }
    }
  } else {
    closeHandlers.length = 0;
  }

  if (errors.length > 1) {
    return new AggregateError(
      errors,
      `runtime.close: 关闭处理器失败 ${errors.length} 处`,
      { cause: errors[0] },
    );
  }
  if (errors.length === 1) {
    return errors[0];
  }
  return null;
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

function createWebWorkspaceRuntime({
  workspaceId,
  userDir,
  workspaceRoot,
  paths,
  databasePath,
  configPath,
  sharedCoordinator,
  aiRuntimeOptions = {},
}) {
  const closeHandlers = [];
  let runtimeClosed = false;

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
      createWebAgentServiceStub,
      createWebTaskServiceStub,
      createWebKnowledgeBaseServiceStub,
      createWebDuplicateCheckServiceStub,
    } = require('./webServices.cjs');

    const sqliteDatabase = createSqliteDatabase({ databasePath });
    if (!sqliteDatabase || typeof sqliteDatabase.close !== 'function') {
      throw new Error('sqliteDatabase 缺少 close 方法');
    }
    pushCloseHandler(closeHandlers, createCloseHandler(sqliteDatabase), 'sqliteDatabase');

    const configStore = createEncryptedConfigStore({ configPath });
    const technicalPlanStore = createTechnicalPlanStore({ db: sqliteDatabase.db, workspaceRoot });
    const knowledgeBaseStore = createKnowledgeBaseStore({ db: sqliteDatabase.db, workspaceRoot });
    const duplicateCheckStore = createDuplicateCheckStore({ db: sqliteDatabase.db, workspaceRoot });
    const rejectionCheckStore = createRejectionCheckStore({ db: sqliteDatabase.db, workspaceRoot, technicalPlanStore });
    const templateStore = createTemplateStore({ db: sqliteDatabase.db });

    const resolvedCoordinator = sharedCoordinator || getGlobalAiCoordinator();
    const runtimeAiOptions = {
      ...aiRuntimeOptions,
      workspaceKey: workspaceId,
      sharedCoordinator: resolvedCoordinator,
      loadConfig: configStore.loadDecrypted.bind(configStore),
    };
    if (typeof runtimeAiOptions.trackRequest !== 'function') {
      runtimeAiOptions.trackRequest = createAiAnalyticsTracker({
        fetch: runtimeAiOptions.analyticsFetch,
      });
    }
    delete runtimeAiOptions.analyticsFetch;
    const aiService = createAiRuntime(runtimeAiOptions);
    pushCloseHandler(closeHandlers, createCloseHandler(aiService), 'aiService');
    const agentService = createWebAgentServiceStub();
    if (!agentService || typeof agentService.close !== 'function') {
      throw new Error('agentService 缺少 close 方法');
    }
    pushCloseHandler(closeHandlers, createCloseHandler(agentService), 'agentService');

    const knowledgeBaseService = createWebKnowledgeBaseServiceStub({ knowledgeBaseStore });
    const duplicateCheckService = createWebDuplicateCheckServiceStub({ duplicateCheckStore });
    const taskService = createWebTaskServiceStub();
    pushCloseHandler(closeHandlers, createCloseHandler(taskService), 'taskService');

    const taskEvents = createTaskEventPortAndTrack(taskService, closeHandlers);

    const runtime = {
      db: sqliteDatabase.db,
      sqliteDatabase,
      configStore,
      aiService,
      taskService,
      taskEvents,
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
        if (runtimeClosed) {
          return;
        }

        const closeError = runCloseHandlers(closeHandlers, { preserveFailures: true });
        if (closeError) {
          throw closeError;
        }

        runtimeClosed = true;
      },
    };

    assertPort('config', runtime.ports.config);
    assertPort('ai', runtime.ports.ai);
    assertPort('agent', runtime.ports.agent);
    assertPort('taskEvents', runtime.ports.taskEvents);

    return runtime;
  } catch (error) {
    const closeError = runCloseHandlers(closeHandlers, { preserveFailures: false });
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
    aiRuntimeOptions,
  });
}

module.exports = {
  createWorkspaceRuntimeFactory,
  createWebWorkspaceRuntime,
};
