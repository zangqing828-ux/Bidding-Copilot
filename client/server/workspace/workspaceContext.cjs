const path = require('node:path');
const fs = require('node:fs');
const { resolveWorkspacePaths } = require('../../core/workspacePaths.cjs');
const { createWorkspaceRuntimeFactory } = require('./workspaceRuntimeFactory.cjs');

function getCloseCandidate(target, label) {
  if (!target || typeof target !== 'object') {
    return { label, closeFn: null, cause: null };
  }

  try {
    if (typeof target.close !== 'function') {
      return { label, closeFn: null, cause: new Error(`${label} 缺少 close 方法`) };
    }

    return { label, closeFn: target.close };
  } catch (error) {
    return { label, closeFn: null, cause: error };
  }
}

function collectFallbackCloseCandidates(runtime) {
  return [
    getCloseCandidate(runtime.taskEvents, 'runtime.taskEvents'),
    getCloseCandidate(runtime.taskService, 'runtime.taskService'),
    getCloseCandidate((runtime.ports && runtime.ports.agent) || runtime.agent, 'runtime.ports.agent/runtime.agent'),
    getCloseCandidate(runtime.sqliteDatabase, 'runtime.sqliteDatabase'),
  ];
}

function runCloseCandidates(targets) {
  const errors = [];
  const seen = new Set();

  for (const target of targets) {
    if (!target) {
      continue;
    }

    if (target.cause) {
      errors.push(target.cause);
      continue;
    }

    const closeFn = target.closeFn;
    if (typeof closeFn !== 'function' || seen.has(closeFn)) {
      continue;
    }

    seen.add(closeFn);
    try {
      closeFn();
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

    runtimeCloseCandidate.closeFn.call(runtime);
    closed = true;
  };

  return {
    workspaceId,
    workspaceRoot,
    paths,
    db: runtime.db,
    sqliteDatabase: runtime.sqliteDatabase,
    configStore: runtime.configStore,
    stores: runtime.stores,
    taskService: runtime.taskService,
    taskEvents: runtime.taskEvents,
    close,
  };
}

module.exports = { createWorkspaceContext };
