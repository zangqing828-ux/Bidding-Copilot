const { getWorkspaceDir } = require('../utils/paths.cjs');
const coreStore = require('../../core/stores/duplicateCheckStore.cjs');

function createDuplicateCheckStore(options = {}) {
  const { app, ...coreOptions } = options;
  const workspaceRoot = coreOptions.workspaceRoot || getWorkspaceDir(app);
  return coreStore.createDuplicateCheckStore({ ...coreOptions, workspaceRoot });
}

module.exports = {
  ...coreStore,
  createDuplicateCheckStore,
};
