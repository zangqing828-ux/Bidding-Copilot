const coreContentGenerationTask = require('../../core/technical-plan/content/contentGenerationTask.cjs');
const electronIllustrationPorts = require('./contentIllustrationGeneration.cjs');

function runContentGenerationTask(options = {}) {
  return coreContentGenerationTask.runContentGenerationTask({
    ...options,
    illustrationPorts: electronIllustrationPorts,
  });
}

module.exports = {
  ...coreContentGenerationTask,
  runContentGenerationTask,
};
