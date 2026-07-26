const { getWorkspaceDir } = require('../utils/paths.cjs');
const coreStore = require('../../core/stores/knowledgeBaseStore.cjs');

function createKnowledgeBaseStore(options = {}) {
  const { app, ...coreOptions } = options;
  const workspaceRoot = coreOptions.workspaceRoot || getWorkspaceDir(app);
  return coreStore.createKnowledgeBaseStore({ ...coreOptions, workspaceRoot });
}

module.exports = {
  ...coreStore,
  createKnowledgeBaseStore,
};
