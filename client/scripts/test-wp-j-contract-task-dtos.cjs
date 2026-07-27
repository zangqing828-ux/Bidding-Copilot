const assert = require('node:assert/strict');
const {
  TASK_ERROR_CODES,
  validateStartBidSectionExtractionInput,
  validateStartOutlineGenerationInput,
  validateStartGlobalFactsGenerationInput,
  validateStartContentGenerationInput,
  validatePauseContentGenerationInput,
} = require('../shared/contracts/technical-plan/taskContracts.cjs');

const generationOptions = {
  useAiImages: true,
  maxAiImages: 4,
  useMermaidImages: true,
  maxMermaidImages: 3,
  useHtmlImages: true,
  maxHtmlImages: 2,
  htmlImageTypes: '图表,表格',
  tableRequirement: 'moderate',
  enableConsistencyAudit: true,
  consistencyRepairMode: 'agent',
  enableOriginalPlanCoverageAudit: false,
  originalPlanCoverageRepairMode: 'normal',
};

function expectError(input, fn, code = TASK_ERROR_CODES.INVALID_INPUT) {
  assert.throws(() => fn(input), (error) => error?.code === code);
}

assert.deepEqual(validateStartBidSectionExtractionInput({}), {}, 'startBidSectionExtraction 空对象应通过');
expectError([], validateStartBidSectionExtractionInput);
expectError({ unexpected: true }, validateStartBidSectionExtractionInput);

const outline = validateStartOutlineGenerationInput({
  reference_knowledge_document_ids: ['doc-b', 'doc-a'],
  outline_expansion_mode: 'ai-complement',
  word_control_options: {
    enabled: true,
    minimumWords: 300,
    maximumWords: 800,
    sectionWords: 220,
    strictSectionWords: false,
  },
});
assert.equal(outline.outline_expansion_mode, 'ai-complement', 'startOutlineGeneration 枚举值应通过');
assert.equal(outline.reference_knowledge_document_ids.length, 2, '起始文档 ID 去重并保留');
assert.equal(validateStartOutlineGenerationInput({
  reference_knowledge_document_ids: [],
  outline_expansion_mode: 'ai-complement',
  word_control_options: {
    enabled: true,
    minimumWords: 300,
    maximumWords: 800,
    sectionWords: 220,
    strictSectionWords: false,
  },
}).reference_knowledge_document_ids.length, 0, '空文档列表应合法');
expectError({
  reference_knowledge_document_ids: ['/etc/passwd'],
  outline_expansion_mode: 'ai-complement',
  word_control_options: {
    enabled: true,
    minimumWords: 300,
    maximumWords: 800,
    sectionWords: 220,
    strictSectionWords: false,
  },
}, validateStartOutlineGenerationInput);
expectError({
  reference_knowledge_document_ids: ['a'],
  outline_expansion_mode: 'bad',
  word_control_options: {
    enabled: true,
    minimumWords: 300,
    maximumWords: 800,
    sectionWords: 220,
    strictSectionWords: false,
  },
}, validateStartOutlineGenerationInput, TASK_ERROR_CODES.INVALID_INPUT);
expectError({
  reference_knowledge_document_ids: ['a'],
  outline_expansion_mode: 'ai-complement',
  word_control_options: {
    enabled: true,
    minimumWords: 300,
    maximumWords: 800,
    sectionWords: 220,
    strictSectionWords: false,
    unknown: true,
  },
}, validateStartOutlineGenerationInput);
expectError({
  reference_knowledge_document_ids: ['a'],
  outline_expansion_mode: 'ai-complement',
  word_control_options: {
    enabled: true,
    minimumWords: 900,
    maximumWords: 800,
    sectionWords: 220,
    strictSectionWords: false,
  },
}, validateStartOutlineGenerationInput);

assert.deepEqual(validateStartGlobalFactsGenerationInput({}), {}, 'startGlobalFactsGeneration 空对象应通过');
expectError({ unexpected: true }, validateStartGlobalFactsGenerationInput);

assert.deepEqual(validateStartContentGenerationInput({
  action: 'start',
  generation_options: generationOptions,
}), {
  action: 'start',
  generation_options: generationOptions,
}, 'content start canonical 入参应可通过');
assert.deepEqual(validateStartContentGenerationInput({
  action: 'regenerate-all',
  generation_options: generationOptions,
}), {
  action: 'regenerate-all',
  generation_options: generationOptions,
}, 'content regenerate-all canonical 入参应可通过');
assert.deepEqual(validateStartContentGenerationInput({
  action: 'regenerate-section',
  target_item_id: 'sec-1',
  requirement: '测试要求',
  generation_options: generationOptions,
}), {
  action: 'regenerate-section',
  target_item_id: 'sec-1',
  requirement: '测试要求',
  generation_options: generationOptions,
}, 'content regenerate-section canonical 入参应可通过');
assert.deepEqual(validateStartContentGenerationInput({
  action: 'resume',
}), { action: 'resume' }, 'canonical resume 应通过');
assert.deepEqual(validateStartContentGenerationInput({
  action: 'retry-correction',
}), { action: 'retry-correction' }, 'canonical retry-correction 应通过');
assert.deepEqual(validateStartContentGenerationInput({
  action: 'rerun-illustration-plan',
}), { action: 'rerun-illustration-plan' }, 'canonical rerun-illustration-plan 应通过');

expectError({}, validateStartContentGenerationInput);
expectError({
  generationOptions,
}, validateStartContentGenerationInput);
expectError({
  action: 'start',
  generationOptions,
}, validateStartContentGenerationInput);
expectError({
  action: 'retry-correction',
  generation_options: generationOptions,
}, validateStartContentGenerationInput);
expectError({
  action: 'start',
  generation_options: {
    ...generationOptions,
    maxAiImages: -1,
  },
}, validateStartContentGenerationInput, TASK_ERROR_CODES.INVALID_INPUT);
expectError({
  action: 'start',
  generation_options: {
    ...generationOptions,
    maxAiImages: '3',
  },
}, validateStartContentGenerationInput, TASK_ERROR_CODES.INVALID_INPUT);

assert.deepEqual(validateStartContentGenerationInput({
  action: 'regenerate-section',
  target_item_id: 'sec-1',
  requirement: '包含路径片段 ../ 和 URL https://example.com 的需求不应被阻断',
  generation_options: generationOptions,
}), {
  action: 'regenerate-section',
  target_item_id: 'sec-1',
  requirement: '包含路径片段 ../ 和 URL https://example.com 的需求不应被阻断',
  generation_options: generationOptions,
}, '自由文本 requirement 不应按路径字段约束');

assert.deepEqual(validatePauseContentGenerationInput({}), {}, 'pause 入参应仅接受空对象');
expectError({ reason: 'x' }, validatePauseContentGenerationInput);

console.log('WP-J Contracts DTO tests passed');
