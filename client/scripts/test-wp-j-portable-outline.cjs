const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  assertOutlineNodeLimit,
  buildOutlineStructure,
  buildOutlineSemanticHash,
} = require('../core/technical-plan/outline/outlineStructure.cjs');
const {
  normalizeOutlineWordControlOptions,
  validateOutlineWordControlOptions,
  deriveOutlineWordControl,
  validateLeafBounds,
} = require('../core/technical-plan/outline/outlineWordControl.cjs');
const {
  DECISION_AGENT_QUALITY_DISABLED,
  DECISION_PLAN_READY,
  buildOutlineExecutionPlan,
} = require('../core/technical-plan/outline/outlineExecutionPlan.cjs');

function readFixture(fileName) {
  const fixturePath = path.join(__dirname, '..', 'fixtures', fileName);
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

function collectFiles(dir, files = []) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((result, entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(entryPath, result);
    }
    if (entry.isFile() && (entry.name.endsWith('.cjs') || entry.name.endsWith('.js'))) {
      result.push(entryPath);
    }
    return result;
  }, files);
}

function assertThrowsMessage(fn, expectedMessage, label) {
  let error;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  assert.ok(error, `${label} 应该抛错`);
  assert.equal(error?.code, 'TASK_INVALID_INPUT', `${label} 错误码应为 TASK_INVALID_INPUT`);
  const message = String(error?.message || '');
  assert.ok(message.includes(expectedMessage), `${label} 错误应包含：${expectedMessage}，实际：${message}`);
}

function assertStaticIsolation() {
  const baseDir = path.join(__dirname, '..', 'core', 'technical-plan');
  const files = collectFiles(baseDir);
  const forbidden = [
    /(\belectron\/|\brequire\(\s*['"](?:node:)?electron['"]|from\s+['"](?:node:)?electron['"])/,
    /\bBrowserWindow\b/,
    /\bipcRenderer\b/,
    /\bdialog\b/,
    /\bapp[-_]?path\b/,
  ];
  files.forEach((filePath) => {
    const source = fs.readFileSync(filePath, 'utf8');
    const absolute = path.relative(process.cwd(), filePath);
    forbidden.forEach((pattern) => {
      assert.ok(!pattern.test(source), `${absolute} 不应包含受限引用：${pattern}`);
    });
  });
}

function runOutlineModes() {
  const standardFixture = readFixture('technical-plan-characterization/j1-standard-outline.fixture.json');
  const existingFixture = readFixture('technical-plan-characterization/j1-existing-outline.fixture.json');
  const standardOutline = standardFixture.expected.outline?.outline || [];
  const existingOutline = existingFixture.expected.outline?.outline || [];

  const standard = buildOutlineStructure(standardOutline, { mode: 'standard' });
  assert.equal(standard.leafCount, standardFixture.expected.leafCount, '标准方案叶子数应匹配');
  assert.equal(standard.mode, 'standard', '标准方案模式应为 standard');
  assert.equal(standard.semanticHash, buildOutlineSemanticHash(standard.outline, { mode: 'standard' }), '标准方案 hash 应稳定');

  const existing = buildOutlineStructure(existingOutline, { mode: 'existing' });
  assert.equal(existing.leafCount, existingFixture.expected.leafCount, '既有方案叶子数应匹配');
  assert.equal(existing.mode, 'existing', '既有方案模式应为 existing');
}

function runHardConstraintCases() {
  const fixture = readFixture('technical-plan-portable/outline-hard-constraints.fixture.json');
  for (const entry of fixture.cases || []) {
    assertThrowsMessage(
      () => buildOutlineStructure(entry.outline, { mode: entry.mode || 'standard' }),
      entry.expectedError,
      `outline case ${entry.name}`,
    );
  }

  const buildNode = (index) => ({
    id: String(index + 1),
    title: `目录 ${index + 1}`,
    description: `目录 ${index + 1} 描述`,
    source_requirement_id: `REQ-${index + 1}`,
    source_requirement_title: `需求 ${index + 1}`,
  });
  const allowed = Array.from({ length: 1000 }, (_, index) => buildNode(index));
  assert.equal(buildOutlineStructure(allowed, { mode: 'standard' }).outline.length, 1000, '1000 个目录节点应允许');
  assertThrowsMessage(
    () => buildOutlineStructure([...allowed, buildNode(1000)], { mode: 'standard' }),
    '目录节点数量不能超过 1000',
    '1001 个目录节点',
  );
  const nestedOverflow = [{
    ...buildNode(0),
    children: Array.from({ length: 1000 }, (_, index) => ({
      id: `1.${index + 1}`,
      title: `子目录 ${index + 1}`,
      description: `子目录 ${index + 1} 描述`,
    })),
  }];
  assertThrowsMessage(
    () => buildOutlineStructure(nestedOverflow, { mode: 'standard' }),
    '目录节点数量不能超过 1000',
    '嵌套目录节点同样计入总数',
  );

  const deepRoot = buildNode(0);
  let cursor = deepRoot;
  for (let index = 1; index < 10_000; index += 1) {
    const child = {
      id: `deep-${index}`,
      title: `深层目录 ${index}`,
      description: `深层目录 ${index} 描述`,
    };
    cursor.children = [child];
    cursor = child;
  }
  assertThrowsMessage(
    () => assertOutlineNodeLimit([deepRoot]),
    '目录节点数量不能超过 1000',
    '一万层恶意目录应在迭代计数阶段 fail-closed',
  );
  const wideOutline = Array.from({ length: 120_000 }, (_, index) => ({
    title: `宽目录 ${index}`,
  }));
  assertThrowsMessage(
    () => assertOutlineNodeLimit(wideOutline),
    '目录节点数量不能超过 1000',
    '十二万个超宽目录不得触发参数栈溢出',
  );
}

function runWordControlChecks() {
  const normalized = normalizeOutlineWordControlOptions({
    enabled: true,
    minimumWords: 10000,
    maximumWords: 18000,
    sectionWords: 3000,
  });
  assert.equal(normalized.enabled, true, '开启状态应保留');
  assert.equal(normalized.sectionWords, 3000, 'sectionWords 应可解析');

  const derived = deriveOutlineWordControl({
    enabled: true,
    minimumWords: 10000,
    maximumWords: 18000,
    sectionWords: 3000,
  });
  assert.equal(derived.minimumLeafCount, 4, 'minimumLeafCount 计算正确');
  assert.equal(derived.maximumLeafCount, 6, 'maximumLeafCount 计算正确');

  const disabled = deriveOutlineWordControl({
    enabled: false,
    minimumWords: 10000,
    maximumWords: 18000,
    sectionWords: 3000,
  });
  assert.equal(disabled.minimumLeafCount, null, '禁用字数控制时 min 为空');
  assert.equal(disabled.maximumLeafCount, null, '禁用字数控制时 max 为空');

  assert.equal(normalizeOutlineWordControlOptions({}).strictSectionWords, false, 'strictSectionWords 缺失时应默认 false');
  assert.throws(
    () => validateOutlineWordControlOptions({ enabled: 'true', minimumWords: 5000, maximumWords: 2000 }),
    (error) => error?.code === 'TASK_INVALID_INPUT' && String(error.message).includes('enabled 必须为布尔值'),
    'enabled 非布尔应报错',
  );

  assertThrowsMessage(
    () => validateOutlineWordControlOptions({ enabled: true, minimumWords: 5000, maximumWords: 0, strictSectionWords: true, sectionWords: 0 }),
    'strictSectionWords',
    'strictSectionWords false-boundary',
  );

  assertThrowsMessage(
    () => validateOutlineWordControlOptions({
      enabled: false,
      minimumWords: 3000,
      maximumWords: 2000,
      sectionWords: 0,
    }),
    'minimumWords 不能大于 maximumWords',
    'word control min-max 顺序',
  );

  assertThrowsMessage(
    () => normalizeOutlineWordControlOptions({ enabled: true, minimumWords: 200001, maximumWords: 0, sectionWords: 0 }),
    'minimumWords 不能超过 200000',
    'minimumWords upper bound',
  );

  const bounded = deriveOutlineWordControl({
    enabled: false,
    sectionWords: 0,
  });
  assert.equal(bounded.effectiveSectionWords, 3000, '未设置 sectionWords 时使用默认值');

  assert.equal(
    JSON.stringify(validateLeafBounds(3, 5, 10)),
    JSON.stringify({ valid: false, distance: 2 }),
    'leaf distance 下限判断',
  );
}

function runExecutionPlanChecks() {
  const standardWithoutCap = buildOutlineExecutionPlan({
    workflowKind: 'technical-plan',
    outlineExpansionMode: 'ai-complement',
    capabilities: {},
  });
  assert.equal(standardWithoutCap.workflowKind, 'technical-plan', '技术方案工作流应为 technical-plan');
  assert.equal(standardWithoutCap.decision, DECISION_PLAN_READY, '可选质量能力关闭时主计划仍应可执行');
  assert.equal(standardWithoutCap.agentQualityDecision, DECISION_AGENT_QUALITY_DISABLED, '缺能力应单独提示质量决策不可用');
  assert.equal(
    standardWithoutCap.stages.filter((item) => item.required).length,
    5,
    'technical-plan 标准阶段应保留 5 个必需阶段',
  );
  const standardRequiredStageKinds = new Set(standardWithoutCap.stages.filter((item) => item.required).map((item) => item.kind));
  assert.equal(
    standardRequiredStageKinds.has('extract-requirement-groups')
      && standardRequiredStageKinds.has('build-outline')
      && standardRequiredStageKinds.has('validate-core-outline')
      && standardRequiredStageKinds.has('finalize-core-outline')
      && standardRequiredStageKinds.has('persist-outline'),
    true,
    'technical-plan 标准阶段应包含提取、构建、校验、定稿、持久化',
  );
  assert.equal(
    standardWithoutCap.decisions.some((item) => item.decision === DECISION_AGENT_QUALITY_DISABLED),
    true,
    '缺能力时应产生命名决策',
  );

  const standardWithCap = buildOutlineExecutionPlan({
    workflowKind: 'technical-plan',
    outlineExpansionMode: 'ai-complement',
    capabilities: { qualityRepair: true },
  });
  assert.equal(
    standardWithCap.decisions.length,
    0,
    '有能力时不应产生命名决策',
  );
  assert.equal(standardWithCap.agentQualityDecision, DECISION_PLAN_READY, '质量能力可用时应标记为可执行');

  const existingOriginal = buildOutlineExecutionPlan({
    workflowKind: 'existing-plan-expansion',
    outlineExpansionMode: 'original-only',
    capabilities: {},
  });
  assert.equal(existingOriginal.outlineExpansionMode, 'original-only', '既有方案 original-only');
  assert.equal(
    existingOriginal.stages.filter((item) => item.required).length,
    3,
    'existing original-only 应有 3 个必需阶段',
  );
  assert.equal(
    existingOriginal.stages.every((item) => item.runnable),
    true,
    'existing original-only 必需阶段应可运行',
  );
  assert.equal(existingOriginal.runnable, true, 'existing original-only 主计划可运行');

  const existingAiWithoutCap = buildOutlineExecutionPlan({
    workflowKind: 'existing-plan-expansion',
    outlineExpansionMode: 'ai-complement',
    capabilities: {},
  });
  assert.equal(existingAiWithoutCap.stages.filter((item) => item.required).length, 7, 'existing ai-complement 应保留 7 个必需阶段');
  assert.equal(
    existingAiWithoutCap.decisions.some((item) => item.decision === DECISION_AGENT_QUALITY_DISABLED),
    true,
    '既有方案 ai-complement 缺能力也应给出禁用决策',
  );
}

function main() {
  assertStaticIsolation();
  runOutlineModes();
  runHardConstraintCases();
  runWordControlChecks();
  runExecutionPlanChecks();
  console.log('WP-J portable outline/word-control/执行计划校验通过');
}

main();
