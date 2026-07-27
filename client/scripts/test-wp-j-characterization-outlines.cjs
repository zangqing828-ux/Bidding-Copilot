const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runOutlineGenerationTask } = require('../electron/services/outlineGenerationTask.cjs');

function readFixture(fileName) {
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'technical-plan-characterization', fileName);
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createWorkspaceStore(storedPlan, originalPlanMarkdown = '') {
  let state = { ...storedPlan };
  return {
    loadTechnicalPlan: () => state,
    updateTechnicalPlan: (partial) => {
      state = {
        ...state,
        ...(partial || {}),
      };
      return state;
    },
    readOriginalPlanMarkdown: () => originalPlanMarkdown,
    readOriginalOutlineRuntime: () => null,
    saveOriginalOutlineRuntime: () => {},
    clearOriginalOutlineRuntime: () => {},
  };
}

function createAiService(fixture, pathType) {
  const queue = (fixture.input.aiCallPlan || [])
    .map(clone)
    .filter((step) => {
      if (pathType !== 'existing') return true;
      return !['extractOriginalOutline', 'extractOriginalOutlineAdditions'].includes(step.name);
    });
  let index = 0;
  return {
    getConfig: () => fixture.input.aiConfig || { context_length_limit: 400000 },
    collectJsonResponse: (options = {}) => {
      const step = queue[index];
      if (!step) {
        throw new Error(`AI mock 调用不足：第 ${index + 1} 次`);
      }
      index += 1;
      const actual = String(options.progressLabel || options.failureMessage || '').trim();
      if (step.label && !actual.includes(step.label)) {
        throw new Error(`AI 调用顺序偏离：期望标签 ${step.label}, 实际 ${actual}`);
      }
      let value = clone(step.response);
      if (options.normalizer) {
        value = options.normalizer(value);
      }
      if (options.validator) {
        options.validator(value);
      }
      return value;
    },
    requestJson: function (options) {
      return this.collectJsonResponse(options);
    },
    isDeveloperMode: () => false,
  };
}

async function runFixtureFixture(fixture, pathType) {
  const fixtureInput = fixture.input;
  const initialState = {
    workflowKind: fixtureInput.workflowKind || 'technical-plan',
    bidAnalysisTasks: fixtureInput.bidAnalysisTasks,
    projectOverview: fixtureInput.projectOverview,
    techRequirements: fixtureInput.techRequirements,
    originalPlanFile: fixtureInput.originalPlanMarkdown ? 'original-plan.md' : undefined,
    outlineExpansionMode: fixtureInput.payload?.outline_expansion_mode === 'original-only' ? 'original-only' : 'ai-complement',
  };

  const workspaceStore = createWorkspaceStore(initialState, fixtureInput.originalPlanMarkdown || '');
  const originalTask = {
    status: 'idle',
    progress: 0,
    logs: [],
    stats: {},
  };
  const updateTask = (task) => task;
  const aiService = createAiService(fixture, pathType);
  const originalPlanMarkdown = fixtureInput.originalPlanMarkdown || '';
  const originalOutlineExtracted = {
    outline: [
      {
        id: '1',
        title: '既有方案实施框架',
        description: '既有方案的一级目录。',
        children: [],
      },
    ],
  };
  const agentService = {
    runTask: async (taskContext) => {
      if (taskContext?.title === '原方案旧目录智能提取' && pathType === 'existing') {
        return { output_content: JSON.stringify(originalOutlineExtracted) };
      }
      if (taskContext?.title === '原方案旧目录智能补漏' && pathType === 'existing') {
        return { output_content: JSON.stringify(originalOutlineExtracted) };
      }
      throw new Error(`AI 回退不应进入本次表征：${taskContext?.title || 'unknown'} / ${pathType}`);
    },
  };
  const knowledgeBaseService = null;

  await runOutlineGenerationTask({
    aiService,
    agentService,
    workspaceStore,
    knowledgeBaseService,
    updateTask,
    payload: fixtureInput.payload || {},
  });

  const actualState = workspaceStore.loadTechnicalPlan();
  const actualOutline = actualState.outlineData;
  const expected = fixture.expected;

  assert.equal(actualState.outlineGenerationTask.status, expected.outlineGenerationTask.status, `${pathType} final task status`);
  assert.equal(actualState.outlineGenerationTask.progress, expected.outlineGenerationTask.progress, `${pathType} final task progress`);
  assert.equal(actualState.outlineMode, expected.outlineMode, `${pathType} outline mode`);
  assert.equal(actualState.workflowKind || 'technical-plan', fixtureInput.workflowKind, `${pathType} workflowKind`);
  assert.equal(actualState.outlineExpansionMode, expected.outlineExpansionMode, `${pathType} expansion mode`);
  assert.deepEqual(actualOutline, expected.outline, `${pathType} outline content`);
  assert.equal(actualState.outlineGenerationTask.stats.outline.current_leaf_count, expected.leafCount, `${pathType} leaf count`);
}

async function main() {
  const standardFixture = readFixture('j1-standard-outline.fixture.json');
  const existingFixture = readFixture('j1-existing-outline.fixture.json');

  await runFixtureFixture(standardFixture, 'standard');
  await runFixtureFixture(existingFixture, 'existing');
  console.log('WP-J J-1 标准与既有方案目录路径 fixture 验证通过');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
