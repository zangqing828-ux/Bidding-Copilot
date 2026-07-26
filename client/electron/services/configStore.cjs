const { getConfigFilePath } = require('../utils/paths.cjs');
const {
  createConfigStore: createPortableConfigStore,
  normalizeConfig,
} = require('../../core/configStore.cjs');

function createConfigStore(app) {
  return createPortableConfigStore({ configPath: getConfigFilePath(app) });
}

module.exports = {
  createConfigStore,
  normalizeConfig,
};
