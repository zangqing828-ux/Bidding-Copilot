const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const coreTask = require('../core/technical-plan/content/contentGenerationTask.cjs');
const electronTask = require('../electron/services/contentGenerationTask.cjs');
const illustrationPlanning = require('../core/technical-plan/content/contentIllustrationPlanning.cjs');

const coreRuntime = coreTask.__contentGenerationTestRuntime;
const electronRuntime = electronTask.__contentGenerationTestRuntime;

function clone(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

function createPlanStore(initialState) {
  const state = clone(initialState);
  const savedItems = [];

  function update(partial) {
    Object.assign(state, partial || {});
    return state;
  }

  return {
    state,
    savedItems,
    loadTechnicalPlan: () => state,
    updateTechnicalPlan: update,
    updateTechnicalPlanWithoutReload: update,
    saveContentGenerationItem({ nodeId, section, storedPlan, runtime }) {
      savedItems.push({ nodeId, section: clone(section), storedPlan: clone(storedPlan), runtime: clone(runtime) });
      if (section) {
        state.contentGenerationSections = { ...(state.contentGenerationSections || {}), [nodeId]: clone(section) };
      }
      if (storedPlan) {
        state.contentGenerationPlans = { ...(state.contentGenerationPlans || {}), [nodeId]: clone(storedPlan) };
      }
      if (runtime) state.contentGenerationRuntime = clone(runtime);
      return state;
    },
    readOriginalPlanMarkdown: () => String(state.__originalPlanMarkdown || ''),
    clearMermaidCache() {},
    clearIllustrationFiles() {},
  };
}

function baseState(overrides = {}) {
  return {
    workflowKind: 'technical-plan',
    outlineExpansionMode: 'ai-complement',
    projectOverview: '项目概述：统一交付平台建设。',
    techRequirements: '要求具备实施组织、质量控制和验收机制。',
    bidAnalysisTasks: {
      projectInfo: { status: 'success', content: '项目属于平台建设。' },
      partAInfo: { status: 'success', content: '甲方为企业客户。' },
      deliveryAndServiceRequirements: { status: 'success', content: '交付周期为 4 个月。' },
    },
    outlineData: {
      project_overview: '统一交付平台建设。',
      outline: [{ id: '1.1', title: '实施方案', description: '说明实施组织、流程和验收。' }],
    },
    globalFactsTask: { status: 'success' },
    globalFacts: [{ title: '项目事实', content: '交付周期为 4 个月，服务可用性不低于 99.5%。' }],
    outlineWordControlSnapshot: { enabled: false },
    contentGenerationOptions: {
      tableRequirement: 'none',
      enableConsistencyAudit: false,
      enableOriginalPlanCoverageAudit: false,
      useHtmlImages: false,
      useAiImages: false,
      useMermaidImages: false,
    },
    contentGenerationSections: {},
    contentGenerationPlans: {},
    ...clone(overrides),
  };
}

function contentPlan() {
  return {
    writing_focus: '围绕实施组织和验收安排展开。',
    knowledge: { item_ids: [] },
    facts: { titles: ['项目事实'] },
    table: { needed: false, purpose: '' },
  };
}

function createAiService(options = {}) {
  const calls = [];
  let pauseAfterPlan = Boolean(options.pauseAfterPlan);
  let paused = false;
  const chatContent = String(options.chatContent || '短文。');

  function planResponse() {
    const response = contentPlan();
    if (pauseAfterPlan) paused = true;
    return response;
  }

  return {
    calls,
    getConfig: () => ({ context_length_limit: 400000, concurrency_limit: 1, image_model: { concurrency_limit: 1 } }),
    getImageModelAvailability: () => ({ available: false }),
    isDeveloperMode: () => false,
    collectJsonResponse(optionsArg = {}) {
      const label = String(optionsArg.progressLabel || optionsArg.logTitle || '');
      calls.push({ kind: 'json', label, messages: clone(optionsArg.messages || []) });
      if (label.includes('正文编排决策')) return planResponse();
      if (label.includes('全文一致性审计')) return { conflicts: [] };
      if (label.includes('正文字数调整')) {
        const isShrink = !optionsArg.messages?.some((message) => String(message?.content || '').includes('执行扩写'));
        return {
          mode: isShrink ? 'shrink' : 'expand',
          granularity: 'sentence',
          operations: [{
            operation: isShrink ? 'replace' : 'insert_after',
            target_text: '短文。',
            content: isShrink ? '短文。' : '补充。',
          }],
        };
      }
      throw new Error(`测试未预期的 JSON 请求：${label}`);
    },
    chat(optionsArg = {}) {
      calls.push({ kind: 'chat', label: String(optionsArg.logTitle || ''), messages: clone(optionsArg.messages || []) });
      return chatContent;
    },
    createTechnicalPlanDeveloperLogger: () => ({ enabled: false, write() {} }),
    shouldPause: () => paused,
  };
}

function createUpdateCollector() {
  const records = [];
  return {
    records,
    update(task) {
      records.push(clone(task));
      return task;
    },
  };
}

function taskOptions(overrides = {}) {
  return {
    generationOptions: {
      tableRequirement: 'none',
      enableConsistencyAudit: false,
      enableOriginalPlanCoverageAudit: false,
      useHtmlImages: false,
      useAiImages: false,
      useMermaidImages: false,
    },
    ...overrides,
  };
}

function comparableState(state) {
  const stripTimestamps = (value) => {
    if (Array.isArray(value)) return value.map(stripTimestamps);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !['updated_at', 'created_at'].includes(key))
      .map(([key, item]) => [key, stripTimestamps(item)]));
  };
  return {
    content: stripTimestamps(state.contentGenerationSections),
    plans: stripTimestamps(state.contentGenerationPlans),
    task: {
      status: state.contentGenerationTask?.status,
      progress: state.contentGenerationTask?.progress,
    },
    illustrationPlan: state.contentIllustrationPlan?.items || [],
  };
}

async function runTask(taskModule, state, aiService, payload, taskControl = {}) {
  const store = createPlanStore(state);
  const updates = createUpdateCollector();
  await taskModule.runContentGenerationTask({
    aiService,
    agentService: null,
    workspaceStore: store,
    knowledgeBaseService: null,
    updateTask: updates.update,
    payload,
    taskControl,
    previousState: payload.resume ? store.state : undefined,
  });
  return { store, updates };
}

async function assertStandardParity() {
  const coreState = baseState();
  const electronState = baseState();
  const coreResult = await runTask(coreTask, coreState, createAiService({ chatContent: '标准方案正文。' }), taskOptions());
  const electronResult = await runTask(electronTask, electronState, createAiService({ chatContent: '标准方案正文。' }), taskOptions());
  assert.deepEqual(comparableState(coreResult.store.state), comparableState(electronResult.store.state), 'Electron adapter 与 portable core 标准方案结果应一致');
  assert.equal(coreResult.store.state.contentGenerationTask.status, 'success', '标准方案正文应成功');
  assert.equal(coreResult.store.state.contentGenerationSections['1.1'].content, '标准方案正文。', '标准方案正文应落盘');
  assert.ok(Array.isArray(coreResult.store.state.contentIllustrationPlan.items), '标准方案应落盘 IllustrationPlan');
}

async function assertExpansionModes() {
  for (const mode of ['original-only', 'ai-complement']) {
    const originalMarkdown = '# 原方案实施\n\n核心技术路线与交付周期。';
    const segments = coreRuntime.splitOriginalPlanSegments(originalMarkdown);
    const source = segments[0];
    const restoredContent = source.content.replace(/^#\s+/, '').trim();
    const plan = {
      plan_version: 4,
      table_requirement: 'none',
      plan: {
        ...contentPlan(),
        original_material: {
          restored: true,
          optimized: false,
          source_ids: [source.id],
          source_titles: source.title_path,
          source_hashes: [source.hash],
          restored_chars: restoredContent.length,
        },
      },
    };
    const state = baseState({
      workflowKind: 'existing-plan-expansion',
      outlineExpansionMode: mode,
      originalPlanFile: 'original.md',
      __originalPlanMarkdown: originalMarkdown,
      outlineData: { project_overview: '既有方案扩写。', outline: [{ id: '1.1', title: '实施方案', description: '延续既有方案并补齐验收。', content: restoredContent }] },
      contentGenerationSections: { '1.1': { id: '1.1', title: '实施方案', status: 'success', content: restoredContent } },
      contentGenerationPlans: { '1.1': plan },
    });
    const result = await runTask(electronTask, state, createAiService({ chatContent: `${mode} 扩写正文。` }), taskOptions());
    const finalPlan = result.store.state.contentGenerationPlans['1.1'].plan;
    assert.equal(result.store.state.outlineExpansionMode, mode, `${mode} 模式应保持不变`);
    assert.equal(finalPlan.original_material.optimized, true, `${mode} 应进入原方案优化扩写路径`);
    assert.deepEqual(finalPlan.original_material.source_ids, [source.id], `${mode} 应保留原方案来源引用`);
    assert.equal(result.store.state.contentGenerationTask.status, 'success', `${mode} 正文应成功`);
  }
}

async function assertCheckpointResume() {
  const initial = baseState();
  const pausedAi = createAiService({ pauseAfterPlan: true, chatContent: '不应在暂停前生成。' });
  const paused = await runTask(coreTask, initial, pausedAi, taskOptions(), { isPauseRequested: pausedAi.shouldPause });
  assert.equal(paused.store.state.contentGenerationTask.status, 'paused', '逐章 checkpoint 应保存 paused 状态');
  assert.ok(paused.store.state.contentGenerationPlans['1.1'], '暂停前应保存当前章节编排 checkpoint');
  assert.equal(paused.store.state.contentGenerationSections['1.1'].status, 'idle', '编排 checkpoint 不应伪造正文成功');
  assert.equal(paused.store.state.contentGenerationRuntime.phase, 'planning', 'checkpoint 应记录 planning 阶段');

  const resumeAi = createAiService({ chatContent: '继续后的正文。' });
  const resumed = await runTask(coreTask, paused.store.state, resumeAi, { ...taskOptions(), resume: true }, { isPauseRequested: () => false });
  assert.equal(resumed.store.state.contentGenerationTask.status, 'success', '继续后应完成正文生成');
  assert.equal(resumed.store.state.contentGenerationSections['1.1'].content, '继续后的正文。', '继续后应写回正文');
  assert.equal(resumeAi.calls.filter((call) => call.kind === 'json').length, 0, '继续应复用 checkpoint，不重复执行章节编排');
}

async function assertWordAndAuditOrder() {
  const state = baseState({
    outlineWordControlSnapshot: {
      enabled: true,
      minimumWords: 0,
      maximumWords: 0,
      sectionWords: 20,
      strictSectionWords: true,
    },
  });
  const ai = createAiService({ chatContent: '短文。' });
  const result = await runTask(coreTask, state, ai, {
    generationOptions: {
      ...taskOptions().generationOptions,
      enableConsistencyAudit: true,
      consistencyRepairMode: 'normal',
    },
  });
  const logs = result.store.state.contentGenerationTask.logs || [];
  const auditIndex = logs.findIndex((line) => String(line).includes('一致性审计未发现需要修复'));
  const wordIndexes = logs.map((line, index) => String(line).includes('调整小节字数') ? index : -1).filter((index) => index >= 0);
  const firstWordIndex = wordIndexes[0];
  const finalWordIndex = wordIndexes[wordIndexes.length - 1];
  assert.ok(auditIndex >= 0, '应记录一致性审校结果');
  assert.ok(wordIndexes.length >= 2, '应记录正文阶段和最终阶段的字数调整');
  assert.ok(firstWordIndex < auditIndex && auditIndex < finalWordIndex, '正文初步字数控制、审校、最终字数控制顺序应稳定');
  assert.equal(result.store.state.contentGenerationTask.status, 'success', '字数调整后的任务应成功');
  assert.ok(coreRuntime.countContentWords(result.store.state.contentGenerationSections['1.1'].content) > 2, '最终字数调整应增加可读正文');
}

function assertIllustrationPlanOnly() {
  const context = illustrationPlanning.buildIllustrationPlanningContext({
    outlineData: { outline: [{ id: '1.1', title: '实施方案', children: [] }] },
    sections: { '1.1': { status: 'success', content: '正文内容。' } },
    options: { useMermaidImages: true, maxMermaidImages: 1 },
    aiImagesAvailable: false,
  });
  const resolved = illustrationPlanning.resolveIllustrationPlan({ items: [{ kind: 'mermaid', image_type: 'process', title: '实施流程', section_ids: ['1.1'], placement: 'after', priority: 5 }] }, context);
  assert.equal(resolved.plan.plan_version, illustrationPlanning.ILLUSTRATION_PLAN_VERSION, 'IllustrationPlan 版本应正确');
  assert.equal(resolved.plan.items[0].generation.status, 'pending', 'IllustrationPlan 只记录 pending 计划');
  assert.equal(Object.prototype.hasOwnProperty.call(resolved.plan.items[0], 'asset_url'), false, '计划不应包含渲染资产');
  assert.equal(Object.prototype.hasOwnProperty.call(resolved.plan.items[0], 'render_status'), false, '计划不应包含渲染状态');
}

function assertAdapterAndPortableStaticBoundary() {
  const adapterSource = fs.readFileSync(path.join(__dirname, '..', 'electron/services/contentGenerationTask.cjs'), 'utf8');
  const coreSource = fs.readFileSync(path.join(__dirname, '..', 'core/technical-plan/content/contentGenerationTask.cjs'), 'utf8');
  assert.match(adapterSource, /core\/technical-plan\/content\/contentGenerationTask\.cjs/, 'Electron 文件应指向 portable core');
  assert.match(adapterSource, /contentIllustrationGeneration\.cjs/, 'Electron adapter 应显式注入渲染 ports');
  assert.doesNotMatch(coreSource, /electron|ipcRenderer|BrowserWindow|app\.getPath|contentIllustrationGeneration/, 'portable core 不得静态导入 Electron 或渲染实现');
}

async function main() {
  assertAdapterAndPortableStaticBoundary();
  assertIllustrationPlanOnly();
  await assertStandardParity();
  await assertExpansionModes();
  await assertCheckpointResume();
  await assertWordAndAuditOrder();
  console.log('WP-J J2 content generation portable parity/checkpoint/quality-order tests passed');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
