const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DEBUG = process.env.OUTLINE_TEST_DEBUG === '1';

const { runOutlineGenerationTask } = require('../core/technical-plan/orchestration/outlineGenerationTask.cjs');

function readFixture(fileName) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', fileName), 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createWorkspaceStore(storedPlan, originalPlanMarkdown = '') {
  let state = { ...storedPlan };
  return {
    loadTechnicalPlan: () => state,
    updateTechnicalPlan: (partial) => {
      state = { ...state, ...(partial || {}) };
      return state;
    },
    readOriginalPlanMarkdown: () => originalPlanMarkdown,
    readOriginalOutlineRuntime: () => null,
    saveOriginalOutlineRuntime: () => {},
    clearOriginalOutlineRuntime: () => {},
  };
}

function createAiService(fixture, options = {}) {
  const plan = clone(fixture.input.aiCallPlan || []);
  const hangAtCall = Number.isFinite(options.hangAtCall) ? Number(options.hangAtCall) : null;
  const hangMessage = String(options.hangMessage || 'mock hang');
  const defaultDelayMs = Number.isFinite(options.delayMs) ? Number(options.delayMs) : 0;
  const fallbackByLabel = {
    旧方案目录提取: {
      outline: [],
    },
    旧方案目录缺漏: {
      additions: [],
    },
    原方案旧目录补漏: {
      additions: [],
    },
    原方案一级目录补充计划: {
      groups: [],
    },
    技术评分大类: {
      groups: [],
    },
    章节: {
      children: [],
    },
    最终目录审核: {
      passed: true,
      suggestions: [],
    },
  };
  const getFallbackResponse = (labelText, failureText) => {
    const keyText = String(labelText || failureText || '').trim();
    return Object.entries(fallbackByLabel).reduce((acc, [keyword, response]) => {
      if (acc) {
        return acc;
      }
      return keyText.includes(keyword) ? response : null;
    }, null);
  };

  let index = 0;
  const resolveWithDelay = (value) => {
    if (defaultDelayMs <= 0) {
      return value;
    }
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(value);
      }, defaultDelayMs);
    });
  };

  return {
    getConfig: () => fixture.input.aiConfig || { context_length_limit: 400000 },
    collectJsonResponse: (optionsArg = {}) => {
      if (options.abortAtCall != null && index === options.abortAtCall) {
        const error = new Error('任务已取消');
        error.code = 'TASK_ACCEPTANCE_ABORTED';
        throw error;
      }
      if (options.failAtCall != null && index === options.failAtCall) {
        const error = new Error('AI 服务异常');
        if (options.failCode) {
          error.code = options.failCode;
        }
        throw error;
      }
      if (hangAtCall != null && index === hangAtCall) {
        index += 1;
        if (DEBUG) {
          console.log(`[AI mock hang] index=${index - 1} message="${hangMessage}"`);
        }
        return new Promise(() => {});
      }
      const step = plan[index];
      if (DEBUG) {
        const actual = String(optionsArg?.progressLabel || optionsArg?.failureMessage || '').trim();
        console.log(`[AI mock ${optionsArg?.failureMessage ? 'retry' : 'call'}] index=${index} actualLabel="${actual}" step="${step?.label || 'unknown'}"`);
      }
      if (!step) {
        const fallback = getFallbackResponse(optionsArg?.progressLabel, optionsArg?.failureMessage);
        index += 1;
        if (fallback) {
          return resolveWithDelay(clone(fallback));
        }
        throw new Error(`AI mock 调用不足：第 ${index} 次`);
      }
      const isFinalReview = String(optionsArg?.progressLabel || optionsArg?.failureMessage || '').includes('最终目录审核');
      index += 1;
      if (isFinalReview) {
        return resolveWithDelay(clone(fallbackByLabel.最终目录审核));
      }
      let value = clone(step.response);
      if (options.invalidAiAtCall != null && index === options.invalidAiAtCall) {
        if (DEBUG) {
          console.log(`[AI mock invalid] index=${index}`);
        }
        value = 'not-json';
      }
      if (optionsArg?.normalizer) {
        value = optionsArg.normalizer(value);
      }
      if (optionsArg?.validator) {
        optionsArg.validator(value);
      }
      return resolveWithDelay(value);
    },
    requestJson: function (optionsArg) {
      return this.collectJsonResponse(optionsArg);
    },
    isDeveloperMode: () => false,
  };
}

function createAgentService(isExistingMode) {
  const originalOutline = {
    outline: [
      {
        id: '1',
        title: '既有方案实施框架',
        description: '既有方案的一级目录。',
        children: [],
      },
    ],
  };
  return {
    runTask: async (taskContext) => {
      if (isExistingMode && taskContext?.title === '原方案旧目录智能提取') {
        return { output_content: JSON.stringify(originalOutline) };
      }
      if (isExistingMode && taskContext?.title === '原方案旧目录智能补漏') {
        return { output_content: JSON.stringify(originalOutline) };
      }
      throw new Error(`不应进入 agent 分支：${taskContext?.title || 'unknown'}`);
    },
  };
}

function normalizeTestOutlinePayload(input) {
  const payload = input || {};
  if (!Array.isArray(payload.reference_knowledge_document_ids)) {
    payload.reference_knowledge_document_ids = [];
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'outline_expansion_mode')) {
    payload.outline_expansion_mode = 'ai-complement';
  }
  if (!payload.word_control_options || typeof payload.word_control_options !== 'object') {
    payload.word_control_options = {};
  }
  const wordControlOptions = payload.word_control_options;
  if (!Object.prototype.hasOwnProperty.call(wordControlOptions, 'enabled')) {
    wordControlOptions.enabled = false;
  }
  if (!Object.prototype.hasOwnProperty.call(wordControlOptions, 'minimumWords')) {
    wordControlOptions.minimumWords = 0;
  }
  if (!Object.prototype.hasOwnProperty.call(wordControlOptions, 'maximumWords')) {
    wordControlOptions.maximumWords = 0;
  }
  if (!Object.prototype.hasOwnProperty.call(wordControlOptions, 'sectionWords')) {
    wordControlOptions.sectionWords = 0;
  }
  if (!Object.prototype.hasOwnProperty.call(wordControlOptions, 'strictSectionWords')) {
    wordControlOptions.strictSectionWords = false;
  }
  return payload;
}

function runCase({
  fixture,
  name,
  aiServiceOptions = {},
  configureInput,
  expectedOutlineTransform,
  expectSuccess,
  testHarness,
  signal,
  preRun,
}) {
  const fixtureInput = clone(fixture.input);
  if (configureInput) {
    configureInput(fixtureInput);
  }
  normalizeTestOutlinePayload(fixtureInput.payload || {});

  const workspaceStore = createWorkspaceStore({
    workflowKind: fixtureInput.workflowKind || 'technical-plan',
    bidAnalysisTasks: fixtureInput.bidAnalysisTasks,
    projectOverview: fixtureInput.projectOverview,
    techRequirements: fixtureInput.techRequirements,
    originalPlanFile: fixtureInput.originalPlanMarkdown ? 'original-plan.md' : undefined,
    outlineExpansionMode: fixtureInput.payload?.outline_expansion_mode || 'ai-complement',
  }, fixtureInput.originalPlanMarkdown || '');

  const originalTask = {
    status: 'idle',
    progress: 0,
    logs: [],
    stats: {},
  };

  workspaceStore.updateTechnicalPlan({ outlineGenerationTask: originalTask });

  const updateTask = (task) => task;
  const isExistingMode = fixtureInput.workflowKind === 'existing-plan-expansion';
  const aiService = createAiService(fixture, aiServiceOptions);
  const agentService = createAgentService(isExistingMode);

  if (typeof preRun === 'function') {
    preRun();
  }

  if (!expectSuccess) {
    return runOutlineGenerationTask({
      aiService,
      agentService,
      workspaceStore,
      knowledgeBaseService: null,
      updateTask,
      testHarness,
      payload: fixtureInput.payload || {},
      signal,
    });
  }

  return runOutlineGenerationTask({
    aiService,
    agentService,
    workspaceStore,
    knowledgeBaseService: null,
    updateTask,
    testHarness,
    payload: fixtureInput.payload || {},
    signal,
  }).then(() => {
    const actualState = workspaceStore.loadTechnicalPlan();
    const actualOutline = actualState.outlineData;
    if (expectedOutlineTransform) {
      expectedOutlineTransform(actualOutline, actualState);
      return;
    }
    if (fixture.expected) {
      assert.equal(actualState.outlineGenerationTask.status, fixture.expected.outlineGenerationTask.status, `${name} final task status`);
      assert.equal(actualState.outlineGenerationTask.progress, fixture.expected.outlineGenerationTask.progress, `${name} final task progress`);
      assert.deepEqual(actualOutline, fixture.expected.outline, `${name} outline content`);
      assert.equal(actualState.outlineGenerationTask.stats.outline.current_leaf_count, fixture.expected.leafCount, `${name} leaf count`);
    }
  });
}

async function runInvalidAiOutputCase() {
  const fixture = readFixture('technical-plan-characterization/j1-standard-outline.fixture.json');
  await assert.rejects(
    runCase({
      fixture,
      name: 'invalid-ai-output',
      aiServiceOptions: { invalidAiAtCall: 1 },
      expectSuccess: false,
    }),
    (error) => Boolean(error),
    'invalid AI output should fail',
  );
}

async function runAiFailureCase() {
  const fixture = readFixture('technical-plan-characterization/j1-standard-outline.fixture.json');
  await assert.rejects(
    runCase({
      fixture,
      name: 'ai-failure',
      aiServiceOptions: { failAtCall: 0, failCode: 'AI_PROVIDER_ERROR' },
      expectSuccess: false,
    }),
    (error) => error?.code === 'AI_PROVIDER_ERROR' || /AI 服务异常/.test(String(error?.message || error)),
    'AI failure should propagate',
  );
}

async function runAbortCase() {
  const fixture = readFixture('technical-plan-characterization/j1-standard-outline.fixture.json');
  await assert.rejects(
    runCase({
      fixture,
      name: 'abort',
      aiServiceOptions: { abortAtCall: 0 },
      expectSuccess: false,
    }),
    (error) => error?.code === 'TASK_ACCEPTANCE_ABORTED' || /任务已取消/.test(String(error?.message || error)),
    'abort should propagate as cancellation',
  );
}

function assertNoElectronImport() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'technical-plan', 'orchestration', 'outlineGenerationTask.cjs'), 'utf8');
  const forbiddenPatterns = [
    /node:electron/,
    /require\(\s*['"]electron\//,
    /from\s+['"]electron\//,
    /require\(\s*['"]\.\.?\/.*electron\//,
  ];
  forbiddenPatterns.forEach((pattern) => {
    assert.equal(Boolean(pattern.test(source)), false, `核心目录任务文件不应包含 electron 依赖：${pattern}`);
  });
}

async function main() {
  assertNoElectronImport();

  const standardFixture = readFixture('technical-plan-characterization/j1-standard-outline.fixture.json');
  const existingFixture = readFixture('technical-plan-characterization/j1-existing-outline.fixture.json');

  await runCase({ fixture: standardFixture, name: 'standard' });
  await assert.rejects(
    runCase({
      fixture: standardFixture,
      name: 'camelCase-rejected',
      configureInput: (input) => {
        input.payload = { ...(input.payload || {}), outlineExpansionMode: 'ai-complement' };
      },
      expectSuccess: false,
    }),
    (error) => error?.code === 'TASK_INVALID_INPUT' || /outlineExpansionMode/.test(String(error?.message || error)),
    'camelCase field should be rejected',
  );
  await assert.rejects(
    runCase({
      fixture: standardFixture,
      name: 'debug-force-rejected',
      configureInput: (input) => {
        input.payload = { ...(input.payload || {}), debug_force_outline_agent_repair: true };
      },
      expectSuccess: false,
    }),
    (error) => error?.code === 'TASK_INVALID_INPUT' || /debug_force_outline_agent_repair/.test(String(error?.message || error)),
    'debug force field should be rejected',
  );
  await assert.rejects(
    runCase({
      fixture: standardFixture,
      name: 'pre-abort-rejected',
      signal: (() => {
        const controller = new AbortController();
        controller.abort(new Error('pre-run abort'));
        return controller.signal;
      })(),
      expectSuccess: false,
    }),
    (error) => error?.code === 'TASK_ACCEPTANCE_ABORTED' && /pre-run abort/.test(String(error?.message || error)),
    'pre-abort should be rejected immediately',
  );
  await assert.rejects(
    runCase({
      fixture: standardFixture,
      name: 'mid-flight-abort-rejected',
      aiServiceOptions: { hangAtCall: 0, hangMessage: 'mid-flight abort test' },
      signal: (() => {
        const controller = new AbortController();
        setTimeout(() => {
          controller.abort(new Error('mid-flight abort reason'));
        }, 10);
        return controller.signal;
      })(),
      expectSuccess: false,
    }),
    (error) => error?.code === 'TASK_ACCEPTANCE_ABORTED' && /mid-flight abort reason/.test(String(error?.message || error)),
    'mid-flight abort should reject',
  );
  await runCase({
    fixture: existingFixture,
    name: 'existing-original-only',
    configureInput: (input) => {
      input.payload = { ...(input.payload || {}), outline_expansion_mode: 'original-only' };
    },
    expectedOutlineTransform: (_, actualState) => {
      const outline = actualState.outlineData;
      assert.equal(actualState.outlineGenerationTask.status, 'success', 'existing original-only final task status');
      assert.equal(actualState.outlineGenerationTask.progress, 100, 'existing original-only final task progress');
      assert.equal(Array.isArray(outline?.outline), true, 'existing original-only should output outline array');
      assert.equal(outline?.outline?.[0]?.title, '既有方案实施框架', 'existing original-only should keep original first-level title');
      assert.equal((outline?.outline?.[0]?.children || []).length, 0, 'existing original-only should keep original only children empty');
    },
    expectSuccess: true,
  });

  await runInvalidAiOutputCase();
  await runAiFailureCase();
  await runAbortCase();

  console.log('WP-J portable orchestration test passed');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
