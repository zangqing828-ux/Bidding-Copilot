const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const {
  validateStartContentGenerationInput,
  canonicalizeRendererStartContentGenerationInput,
  canonicalizeRendererStartOutlineGenerationInput,
  validateStartOutlineGenerationInput,
} = require('../shared/contracts/technical-plan/taskContracts.cjs');

const fixturePath = path.join(__dirname, '../fixtures/technical-plan-contracts/content-generation/renderer-canonicalization.samples.json');
const cases = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

for (const caseItem of cases.valid || []) {
  const actual = canonicalizeRendererStartContentGenerationInput(caseItem.input);
  assert.deepEqual(actual, caseItem.expected, `case ${caseItem.name}: should map to canonical payload`);
}

for (const caseItem of cases.invalid || []) {
  assert.throws(
    () => canonicalizeRendererStartContentGenerationInput(caseItem.input),
    (error) => error?.code === 'TASK_INVALID_INPUT',
    `case ${caseItem.name}: should reject invalid mixed/partial payload`,
  );
}

assert.deepEqual(
  canonicalizeRendererStartOutlineGenerationInput({
    referenceKnowledgeDocumentIds: ['doc-a'],
    outlineExpansionMode: 'original-only',
    wordControlOptions: {
      enabled: false,
      minimumWords: 100,
      maximumWords: 200,
      sectionWords: 80,
      strictSectionWords: true,
    },
  }),
  {
    reference_knowledge_document_ids: ['doc-a'],
    outline_expansion_mode: 'original-only',
    word_control_options: {
      enabled: false,
      minimumWords: 100,
      maximumWords: 200,
      sectionWords: 80,
      strictSectionWords: true,
    },
  },
  'outline renderer mapping should produce canonical snake_case payload',
);

assert.throws(
  () => canonicalizeRendererStartContentGenerationInput({
    action: 'start',
    generationOptions: {
      useAiImages: true,
      maxAiImages: 1,
      useMermaidImages: true,
      maxMermaidImages: 1,
      useHtmlImages: false,
      maxHtmlImages: 0,
      htmlImageTypes: '图表',
      tableRequirement: 'moderate',
      enableConsistencyAudit: true,
      consistencyRepairMode: 'normal',
      enableOriginalPlanCoverageAudit: false,
      originalPlanCoverageRepairMode: 'normal',
    },
  }),
  (error) => error?.code === 'TASK_INVALID_INPUT',
  'renderer adapter should reject canonical action field',
);

assert.throws(
  () => canonicalizeRendererStartContentGenerationInput({
    generation_options: {
      useAiImages: true,
      maxAiImages: 1,
      useMermaidImages: true,
      maxMermaidImages: 1,
      useHtmlImages: false,
      maxHtmlImages: 0,
      htmlImageTypes: '图表',
      tableRequirement: 'moderate',
      enableConsistencyAudit: true,
      consistencyRepairMode: 'normal',
      enableOriginalPlanCoverageAudit: false,
      originalPlanCoverageRepairMode: 'normal',
    },
  }),
  (error) => error?.code === 'TASK_INVALID_INPUT',
  'renderer adapter should reject canonical generation_options field',
);

assert.throws(
  () => canonicalizeRendererStartOutlineGenerationInput({
    reference_knowledge_document_ids: ['doc-a'],
    outlineExpansionMode: 'original-only',
    wordControlOptions: {
      enabled: false,
      minimumWords: 100,
      maximumWords: 200,
      sectionWords: 80,
      strictSectionWords: true,
    },
  }),
  (error) => error?.code === 'TASK_INVALID_INPUT',
  'outline renderer adapter should reject canonical input field',
);

assert.throws(
  () => canonicalizeRendererStartOutlineGenerationInput({
    referenceKnowledgeDocumentIds: ['doc-a'],
    outline_expansion_mode: 'original-only',
    wordControlOptions: {
      enabled: false,
      minimumWords: 100,
      maximumWords: 200,
      sectionWords: 80,
      strictSectionWords: true,
    },
  }),
  (error) => error?.code === 'TASK_INVALID_INPUT',
  'outline renderer adapter should reject canonical snake_case field',
);

assert.throws(
  () => validateStartOutlineGenerationInput({
    referenceKnowledgeDocumentIds: ['doc-a'],
    outlineExpansionMode: 'original-only',
    wordControlOptions: {
      enabled: false,
      minimumWords: 100,
      maximumWords: 200,
      sectionWords: 80,
      strictSectionWords: true,
    },
  }),
  (error) => error?.code === 'TASK_INVALID_INPUT',
  'portable outline validator should reject camelCase fields',
);

assert.throws(
  () => validateStartContentGenerationInput({
    generationOptions: {
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
    },
  }),
  (error) => error?.code === 'TASK_INVALID_INPUT',
  'portable content validator should reject camelCase payload',
);

assert.throws(
  () => validateStartContentGenerationInput({
    action: 'start',
    targetItemId: 'sec-1',
    generation_options: {
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
    },
  }),
  (error) => error?.code === 'TASK_INVALID_INPUT',
  'portable content validator should reject canonical/internal mixed fields',
);

const canonicalResume = canonicalizeRendererStartContentGenerationInput({ resume: true });
assert.deepEqual(canonicalResume, { action: 'resume' }, 'canonical resume mapping should pass');

console.log('WP-J Contracts adapter mapping tests passed');
