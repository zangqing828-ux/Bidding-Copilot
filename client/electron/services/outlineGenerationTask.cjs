const path = require('node:path');
const fs = require('node:fs');
const { runOutlineGenerationTask: runCoreOutlineGenerationTask } = require('../../core/technical-plan/orchestration/outlineGenerationTask.cjs');

function readSecondReviewResult(meta, resultFileName) {
  const workspaceDir = meta?.workspace_dir;
  if (!workspaceDir) return '';
  const resultPath = path.join(workspaceDir, resultFileName);
  try {
    return fs.readFileSync(resultPath, 'utf-8');
  } catch {
    return '';
  }
}

function runOutlineGenerationTask(context = {}) {
  return runCoreOutlineGenerationTask({
    ...context,
    agentResultReader: context.agentResultReader || readSecondReviewResult,
  });
}

module.exports = { runOutlineGenerationTask };
