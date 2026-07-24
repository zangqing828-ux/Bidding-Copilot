const { getWorkspaceDir } = require('../utils/paths.cjs');
const coreStore = require('../../core/stores/rejectionCheckStore.cjs');

function createRejectionCheckStore(options = {}) {
  const { app, ...coreOptions } = options;
  const workspaceRoot = coreOptions.workspaceRoot || getWorkspaceDir(app);
  return coreStore.createRejectionCheckStore({ ...coreOptions, workspaceRoot });
}

module.exports = {
  ...coreStore,
  createRejectionCheckStore,
};
