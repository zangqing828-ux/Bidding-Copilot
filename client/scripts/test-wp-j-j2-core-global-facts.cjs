const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const coreGlobalFacts = require('../core/technical-plan/content/globalFactsTask.cjs');
const electronGlobalFacts = require('../electron/services/globalFactsTask.cjs');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createPlanStore(preset = {}) {
  const state = {
    projectOverview: '项目概述：开发与交付平台改造，目标在 12 个月上线。',
    workflowKind: 'technical-plan',
    bidSections: [
      { id: 'section-1', title: '招标文件' },
    ],
    bidAnalysisTasks: {
      projectInfo: { status: 'success', content: '招标方为工业企业，拟实施智能化升级。' },
      partAInfo: { status: 'success', content: '联系人：张总。' },
      deliveryAndServiceRequirements: { status: 'success', content: '交付周期为 4 个月。' },
    },
    outlineData: {
      outline: [
        {
          id: '1',
          title: '总体方案',
          description: '承诺与实施安排',
        },
      ],
    },
    globalFactsTask: undefined,
    globalFacts: [],
    ...preset,
  };

  return {
    loadTechnicalPlan: () => state,
    updateTechnicalPlan: (patch) => {
      Object.assign(state, patch || {});
      return state;
    },
    readTenderMarkdown: () => '第一段：本项目采用容器化交付，时长 4 个月。\n\n第二段：服务可用性不低于 99.5%。',
    readOriginalPlanMarkdown: () => preset.originalPlanContent || '',
  };
}

function createAiService(sequence) {
  let index = 0;
  return {
    getConfig: () => ({ context_length_limit: 400000 }),
    collectJsonResponse: (options = {}) => {
      const step = sequence[index++];
      if (!step) {
        throw new Error(`AI mock 调用不足，当前请求序号 ${index}`);
      }
      if (step.label && options.logTitle && !String(options.logTitle).includes(step.label)) {
        throw new Error(`AI payload 不匹配 ${step.label}`);
      }
      let value = clone(step.response);
      if (typeof options.normalizer === 'function') {
        value = options.normalizer(value);
      }
      if (typeof options.validator === 'function') {
        options.validator(value);
      }
      return value;
    },
    requestJson: function (options = {}) {
      return this.collectJsonResponse(options);
    },
    isDeveloperMode: () => false,
  };
}

function createUpdateTaskCollector() {
  const snapshots = [];
  return {
    records: snapshots,
    fn: (task) => {
      snapshots.push(clone(task));
      return task;
    },
  };
}

async function assertPortableParityRun() {
  const coreFixture = createPlanStore();
  const electronFixture = createPlanStore();

  const responses = [
    { response: { groups: [{ id: 'delivery', title: '交付与服务', content: '- 工期 4 个月：包含实施与验收。' }] } },
    { response: { groups: [{ id: 'delivery', title: '交付与服务', content: '- 服务可用性 99.5%，按月报。' }, { id: 'team', title: '组织', content: '- 项目经理负责统筹' }] } },
    { response: { groups: [{ id: 'delivery', title: '交付与服务', content: '- 工期 4 个月：包含实施与验收。\n- 服务可用性 99.5%，按月报。' }, { id: 'team', title: '组织', content: '- 项目经理负责统筹' }] } },
  ];

  const coreUpdate = createUpdateTaskCollector();
  await coreGlobalFacts.runGlobalFactsTask({
    aiService: createAiService(responses, ['全局事实变量-招标文件-第1段', '全局事实变量-招标文件-合并', '全局事实变量-最终整理']),
    workspaceStore: coreFixture,
    knowledgeBaseService: null,
    updateTask: coreUpdate.fn,
  });

  const electronUpdate = createUpdateTaskCollector();
  await electronGlobalFacts.runGlobalFactsTask({
    aiService: createAiService(responses, ['全局事实变量-招标文件-第1段', '全局事实变量-招标文件-合并', '全局事实变量-最终整理']),
    workspaceStore: electronFixture,
    knowledgeBaseService: null,
    updateTask: electronUpdate.fn,
  });

  assert.deepEqual(
    coreFixture.loadTechnicalPlan().globalFacts,
    electronFixture.loadTechnicalPlan().globalFacts,
    '同输入下 core 与 electron 全局事实任务结果应完全一致',
  );
  assert.equal(coreFixture.loadTechnicalPlan().globalFactsTask.status, 'success', 'core 跑成功态');
  assert.equal(electronFixture.loadTechnicalPlan().globalFactsTask.status, 'success', 'electron 跑成功态');
}

function assertNormalizationParity() {
  const response = {
    result: {
      groups: [
        {
          id: 'g1',
          title: '  组织与角色  ',
          markdown: [{ name: '总监', value: '张三' }, { name: 'PM', detail: '李四' }],
        },
      ],
    },
  };
  const normalized = coreGlobalFacts.normalizeGlobalFactsResponse(response);
  assert.ok(Array.isArray(normalized.groups), 'groups 需归一化');
  assert.equal(normalized.groups[0].id, 'g1', 'id 保持来源 id');
  assert.ok(normalized.groups[0].content.includes('- **总监**：张三'), '数组对象应转 Markdown');

  const patchResponse = {
    result: {
      items: [
        {
          mode: 'replace',
          target_group_id: 'g1',
          title: '  组织与角色  ',
          markdown: '替换为 1 套统一口径。',
        },
      ],
    },
  };
  const patch = coreGlobalFacts.normalizeGlobalFactsPatchResponse(patchResponse);
  assert.equal(patch.patches.length, 1, '补丁归一化');
  assert.equal(patch.patches[0].mode, 'replace', 'mode normalize 不降级');
  assert.deepEqual(
    coreGlobalFacts.mergeGlobalFactPatches(normalized.groups, patch.patches),
    [{ id: 'g1', title: '组织与角色', content: '替换为 1 套统一口径。' }],
    'replace 补丁应覆盖同名分组',
  );
}

function assertErrorBoundary() {
  assert.throws(
    () => coreGlobalFacts.validateGlobalFactsPatchResponse({ patches: [{ content: '' }] }),
    (error) => String(error?.message || '').includes('缺少 content'),
    '空 content 应报错',
  );
}

function assertAdapterUsesCoreSource() {
  const electronSource = fs.readFileSync(path.join(__dirname, '..', 'electron/services/globalFactsTask.cjs'), 'utf8');
  const expectPattern = /require\(\s*['"]\.\.\/\.\.\/core\/technical-plan\/content\/globalFactsTask\.cjs['"]\s*\)/;
  assert.ok(
    expectPattern.test(electronSource),
    'Electron adapter 应直接从 core 引用 globalFactsTask',
  );
}

async function assertMissingOutlineFailfast() {
  const fixture = createPlanStore({ outlineData: {} });
  const aiService = createAiService([]);
  const updateTask = createUpdateTaskCollector().fn;

  await assert.rejects(
    () => coreGlobalFacts.runGlobalFactsTask({
      aiService,
      workspaceStore: fixture,
      knowledgeBaseService: null,
      updateTask,
    }),
    (error) => String(error?.message || '').includes('请先生成目录'),
    '缺失目录应拒绝',
  );
}

async function main() {
  assertAdapterUsesCoreSource();
  assertNormalizationParity();
  assertErrorBoundary();
  await assertPortableParityRun();
  await assertMissingOutlineFailfast();
  console.log('WP-J J2 global facts characterization tests passed');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
