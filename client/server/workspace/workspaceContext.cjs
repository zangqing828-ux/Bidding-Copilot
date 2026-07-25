const path = require('node:path');
const fs = require('node:fs');
const { resolveWorkspacePaths } = require('../../core/workspacePaths.cjs');
const { createWorkspaceRuntimeFactory } = require('./workspaceRuntimeFactory.cjs');

function getCloseCandidate(target, label) {
  if (!target || typeof target !== 'object') {
    return { label, owner: null, resource: null, closeFn: null, cause: null };
  }

  try {
    const closeFn = target.close;
    if (typeof closeFn !== 'function') {
      return {
        label,
        owner: target,
        resource: target,
        closeFn: null,
        cause: new Error(`${label} 缺少 close 方法`),
      };
    }

    return {
      label,
      owner: target,
      resource: target,
      closeFn,
      cause: null,
    };
  } catch (error) {
    return {
      label,
      owner: target,
      resource: target,
      closeFn: null,
      cause: error,
    };
  }
}

function collectFallbackCloseCandidates(runtime) {
  return [
    getCloseCandidate(runtime.taskEvents, 'runtime.taskEvents'),
    getCloseCandidate(runtime.taskService, 'runtime.taskService'),
    getCloseCandidate(runtime.aiService || (runtime.ports && runtime.ports.ai), 'runtime.aiService/runtime.ports.ai'),
    getCloseCandidate((runtime.ports && runtime.ports.agent) || runtime.agent, 'runtime.ports.agent/runtime.agent'),
    getCloseCandidate(runtime.sqliteDatabase, 'runtime.sqliteDatabase'),
  ];
}

function runCloseCandidates(targets) {
  const errors = [];
  const seen = new Set();

  for (const target of targets) {
    if (!target || !target.resource || seen.has(target.resource)) {
      continue;
    }

    seen.add(target.resource);

    if (target.cause) {
      errors.push(target.cause);
      continue;
    }

    const closeFn = target.closeFn;
    if (typeof closeFn !== 'function') {
      continue;
    }

    try {
      closeFn.call(target.owner);
    } catch (error) {
      errors.push(error);
    }
  }

  return errors;
}

function buildCloseError(errors) {
  if (!errors.length) {
    return null;
  }
  if (errors.length === 1) {
    return errors[0];
  }
  const first = errors[0];
  return new AggregateError(
    errors,
    `context.close: 关闭失败 (${errors.length} 项)`,
    { cause: first },
  );
}

function countActiveTasks(value) {
  if (Array.isArray(value)) {
    return value.length;
  }
  if (Number.isFinite(Number(value))) {
    return Math.max(0, Number(value));
  }
  if (value && typeof value === 'object') {
    return Object.keys(value).length;
  }
  return 0;
}

function createActivitySnapshot(runtime) {
  function readTaskCount() {
    if (!runtime.taskService || typeof runtime.taskService.getActiveTasks !== 'function') {
      return 0;
    }
    return countActiveTasks(runtime.taskService.getActiveTasks());
  }

  function readQueueStatus(methodName) {
    if (!runtime.aiService || typeof runtime.aiService[methodName] !== 'function') {
      return { active: 0, queued: 0 };
    }
    const status = runtime.aiService[methodName]();
    return {
      active: Math.max(0, Number(status?.active) || 0),
      queued: Math.max(0, Number(status?.queued) || 0),
    };
  }

  try {
    const activeTaskCount = readTaskCount();
    const text = readQueueStatus('getTextQueueStatus');
    const image = readQueueStatus('getImageQueueStatus');
    const aiActiveCount = text.active + image.active;
    const aiQueuedCount = text.queued + image.queued;
    return {
      activeTaskCount,
      aiActiveCount,
      aiQueuedCount,
      active: activeTaskCount > 0 || aiActiveCount > 0 || aiQueuedCount > 0,
      unknown: false,
    };
  } catch {
    // 无法确认资源状态时保守地阻止 TTL 回收，等待下一次检查。
    return {
      activeTaskCount: 0,
      aiActiveCount: 0,
      aiQueuedCount: 0,
      active: true,
      unknown: true,
    };
  }
}

function createWorkspaceContext({
  workspaceId,
  dataDir,
  runtimeFactory = createWorkspaceRuntimeFactory,
}) {
  const workspaceRoot = path.join(dataDir, 'users', workspaceId, 'workspace');
  const userDir = path.join(dataDir, 'users', workspaceId);
  const paths = resolveWorkspacePaths(workspaceRoot);

  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(paths.uploadsDir, { recursive: true });

  const runtime = runtimeFactory({
    workspaceId,
    userDir,
    workspaceRoot,
    paths,
    databasePath: paths.databasePath,
    configPath: path.join(userDir, 'config.enc.json'),
    dataDir,
  });

  if (!runtime || typeof runtime !== 'object') {
    throw new Error('runtimeFactory 必须返回对象');
  }

  const runtimeCloseCandidate = getCloseCandidate(runtime, 'runtime.close');
  if (runtimeCloseCandidate.cause || !runtimeCloseCandidate.closeFn) {
    const closeErrors = runCloseCandidates(collectFallbackCloseCandidates(runtime));
    if (runtimeCloseCandidate.cause) {
      closeErrors.unshift(runtimeCloseCandidate.cause);
    } else {
      closeErrors.push(new Error('runtime 缺少 close 方法'));
    }

    const closeError = buildCloseError(closeErrors);
    throw closeError || new Error('runtime 关闭能力无效');
  }

  let closed = false;
  const close = () => {
    if (closed) {
      return;
    }

    runtimeCloseCandidate.closeFn.call(runtimeCloseCandidate.owner);
    closed = true;
  };

  return {
    workspaceId,
    workspaceRoot,
    paths,
    db: runtime.db,
    sqliteDatabase: runtime.sqliteDatabase,
    configStore: runtime.configStore,
    aiService: runtime.aiService || (runtime.ports && runtime.ports.ai),
    stores: runtime.stores,
    taskService: runtime.taskService,
    taskEvents: runtime.taskEvents,
    getActivitySnapshot() {
      return createActivitySnapshot(runtime);
    },
    close,
  };
}

module.exports = { createWorkspaceContext };
