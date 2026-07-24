const { getWorkspaceDatabasePath } = require('../utils/paths.cjs');
const { resolveWorkspacePaths } = require('../../core/workspacePaths.cjs');
const {
  createSqliteDatabase: createPortableSqliteDatabase,
  schemaVersion,
} = require('../../core/sqliteDatabase.cjs');

function resolveDatabasePath(app, options = {}) {
  if (options.databasePath) {
    return options.databasePath;
  }
  if (options.workspaceRoot) {
    return resolveWorkspacePaths(options.workspaceRoot).databasePath;
  }
  if (!app) {
    throw new Error('createSqliteDatabase: 缺少 databasePath 或 workspaceRoot；App 不可为空');
  }
  return getWorkspaceDatabasePath(app);
}

function createSqliteDatabase(app, options = {}) {
  const databasePath = resolveDatabasePath(app, options);
  const db = createPortableSqliteDatabase({
    ...options,
    databasePath,
    workspaceRoot: undefined,
  });

  if (app && typeof app.once === 'function') {
    app.once('before-quit', () => {
      db.close();
    });
  }

  return db;
}

module.exports = {
  createSqliteDatabase,
  schemaVersion,
};
