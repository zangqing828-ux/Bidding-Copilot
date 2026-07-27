const { getWorkspaceDir } = require('../utils/paths.cjs');
const coreStore = require('../../core/stores/technicalPlanStore.cjs');

function createTechnicalPlanStore(options = {}) {
  const { app, ...coreOptions } = options;
  const workspaceRoot = coreOptions.workspaceRoot || getWorkspaceDir(app);
  return coreStore.createTechnicalPlanStore({ ...coreOptions, workspaceRoot, composeLegacyIllustrationReceipts: true });
}

module.exports = {
  ...coreStore,
  createTechnicalPlanStore,
};
