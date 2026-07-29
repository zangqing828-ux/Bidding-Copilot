const { parentPort } = require('node:worker_threads');

const { createTemplateStore } = require('../../core/templateStore.cjs');
const { createSqliteDatabase } = require('../../core/sqliteDatabase.cjs');
const { createTechnicalPlanStore } = require('../../core/stores/technicalPlanStore.cjs');
const { createEncryptedConfigStore } = require('../config/encryptedConfigStore.cjs');

if (!parentPort) {
  throw new Error('storeBridgeWorker 必须运行在 Worker Thread 中');
}

const workspaceContexts = new Map();

function serializeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    code: typeof error?.code === 'string' ? error.code : undefined,
    retryable: typeof error?.retryable === 'boolean' ? error.retryable : undefined,
    status: Number.isFinite(Number(error?.status)) ? Number(error.status) : undefined,
  };
}

function createWorkerContext(payload) {
  const {
    workspaceId,
    workspaceRoot,
    databasePath,
    configPath,
  } = payload || {};

  if (!workspaceId || !workspaceRoot || !databasePath || !configPath) {
    throw new Error('Store Worker 缺少 workspace 初始化参数');
  }

  const sqliteDatabase = createSqliteDatabase({ databasePath });
  try {
    const technicalPlanStore = createTechnicalPlanStore({
      db: sqliteDatabase.db,
      workspaceRoot,
    });

    return {
      sqliteDatabase,
      chain: Promise.resolve(),
      closing: false,
      targets: {
        configStore: createEncryptedConfigStore({ configPath }),
        technicalPlanStore,
        templateStore: createTemplateStore({ db: sqliteDatabase.db }),
      },
    };
  } catch (error) {
    sqliteDatabase.close();
    throw error;
  }
}

function getWorkerContext(payload) {
  const workspaceId = String(payload?.workspaceId || '');
  let context = workspaceContexts.get(workspaceId);
  if (!context) {
    context = createWorkerContext(payload);
    workspaceContexts.set(workspaceId, context);
  }
  if (context.closing) {
    const error = new Error('Store Worker workspace 正在关闭');
    error.code = 'WORKSPACE_UNAVAILABLE';
    error.retryable = true;
    throw error;
  }
  return context;
}

async function executeStoreMethod(payload) {
  const context = getWorkerContext(payload);
  const operation = context.chain.then(async () => {
    const target = context.targets[payload.targetName];
    const method = target?.[payload.method];
    if (typeof method !== 'function') {
      throw new Error(`Store Worker 方法不存在：${payload.targetName}.${payload.method}`);
    }
    return method.apply(target, Array.isArray(payload.args) ? payload.args : []);
  });
  context.chain = operation.then(() => undefined, () => undefined);
  return operation;
}

async function closeWorkspace(payload) {
  const workspaceId = String(payload?.workspaceId || '');
  const context = workspaceContexts.get(workspaceId);
  if (!context) {
    return { closed: false };
  }

  context.closing = true;
  await context.chain;
  context.sqliteDatabase.close();
  workspaceContexts.delete(workspaceId);
  return { closed: true };
}

async function handleMessage(message) {
  if (message?.type === 'execute') {
    return executeStoreMethod(message.payload);
  }
  if (message?.type === 'close-workspace') {
    return closeWorkspace(message.payload);
  }
  throw new Error(`未知 Store Worker 消息：${message?.type || 'empty'}`);
}

parentPort.on('message', (message) => {
  Promise.resolve()
    .then(() => handleMessage(message))
    .then(
      (data) => parentPort.postMessage({ id: message.id, ok: true, data }),
      (error) => parentPort.postMessage({
        id: message.id,
        ok: false,
        error: serializeError(error),
      }),
    );
});
