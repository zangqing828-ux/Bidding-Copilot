const path = require('node:path');
const fs = require('node:fs');
const { resolveWorkspacePaths } = require('../../core/workspacePaths.cjs');
const { createWorkspaceRuntimeFactory } = require('./workspaceRuntimeFactory.cjs');

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
  if (typeof runtime.close !== 'function') {
    let cleanupError;
    try {
      runtime.close?.();
    } catch (error) {
      cleanupError = error;
    }

    if (runtime?.sqliteDatabase?.close && typeof runtime.sqliteDatabase.close === 'function') {
      try {
        runtime.sqliteDatabase.close();
      } catch (closeError) {
        if (cleanupError) {
          cleanupError = new AggregateError(
            [cleanupError, closeError],
            'runtimeFactory 返回的运行时缺少 close 方法',
          );
        } else {
          cleanupError = closeError;
        }
      }
    }
    if (cleanupError) {
      const assembledError = new Error('runtimeFactory 返回的运行时缺少 close 方法');
      assembledError.cleanupErrors = cleanupError;
      throw assembledError;
    }
    throw new Error('runtimeFactory 返回的运行时缺少 close 方法');
  }

  let closed = false;
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    runtime.close();
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
