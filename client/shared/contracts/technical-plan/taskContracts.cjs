const TASK_ERROR_CODES = Object.freeze({
  CONFLICT: 'TASK_CONFLICT',
  INVALID_INPUT: 'TASK_INVALID_INPUT',
  ITEM_NOT_FOUND: 'TASK_ITEM_NOT_FOUND',
  INPUT_CHANGED: 'TASK_INPUT_CHANGED',
  ACCEPTANCE_ABORTED: 'TASK_ACCEPTANCE_ABORTED',
  PAUSE_TIMEOUT: 'TASK_PAUSE_TIMEOUT',
  INTERRUPTED_BY_RESTART: 'TASK_INTERRUPTED_BY_RESTART',
});

const OUTLINE_EXPANSION_MODES = Object.freeze(['original-only', 'ai-complement']);
const CONTENT_TABLE_REQUIREMENTS = Object.freeze(['none', 'light', 'moderate', 'heavy']);
const CONSISTENCY_REPAIR_MODES = Object.freeze(['agent', 'normal']);
const ORIGINAL_PLAN_COVERAGE_MODES = Object.freeze(['agent', 'normal']);
const CONTENT_CONTENT_ACTIONS = Object.freeze([
  'start',
  'regenerate-all',
  'regenerate-section',
  'resume',
  'retry-correction',
  'rerun-illustration-plan',
]);

const MAX_REFERENCE_DOCUMENT_IDS = 200;
const MAX_WORD_BOUNDARY = 200000;
const MAX_SECTION_WORDS = 200000;
const MAX_IMG_COUNT = 128;
const MAX_IMAGE_TYPE_LENGTH = 256;
const MAX_REQUIREMENT_LENGTH = 2048;
const MAX_DOC_ID_LENGTH = 256;

const TASK_CONTENT_RENDERER_FIELDS = Object.freeze({
  canonical: Object.freeze(new Set([
    'action',
    'target_item_id',
    'generation_options',
  ])),
  canonicalCanonicalOnly: Object.freeze(new Set([
    'action',
    'target_item_id',
    'generation_options',
  ])),
  renderer: Object.freeze(new Set([
    'resume',
    'retryContentCorrection',
    'rerunIllustrations',
    'targetItemId',
    'requirement',
    'regenerate',
    'generationOptions',
  ])),
});

const TASK_OUTLINE_RENDERER_FIELDS = Object.freeze({
  canonical: Object.freeze(new Set([
    'reference_knowledge_document_ids',
    'outline_expansion_mode',
    'word_control_options',
    'debug_force_outline_agent_repair',
  ])),
  renderer: Object.freeze(new Set([
    'referenceKnowledgeDocumentIds',
    'outlineExpansionMode',
    'wordControlOptions',
  ])),
});

const FORBIDDEN_FIELD_PATTERNS = Object.freeze([
  /\.\.\//,
  /(^|[\\/])\.\.([\\/]|$)/,
  /^[\\/]/,
]);

const PROTOCOL_KEYWORDS = Object.freeze([
  'http://',
  'https://',
  'file://',
  'smb://',
  'ssh://',
]);

function createInputError(message, code = TASK_ERROR_CODES.INVALID_INPUT) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hasOwnField(obj, field) {
  return Object.prototype.hasOwnProperty.call(obj, field);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertNoCanonicalFieldCollision(fieldSet, input, label) {
  const field = Object.keys(input).find((item) => fieldSet.has(item));
  if (field) {
    throw createInputError(`${label} 不应包含 canonical 字段：${field}`, TASK_ERROR_CODES.INVALID_INPUT);
  }
}

function validateUnknownFields(input, allowedFields, fieldName) {
  const unknownField = Object.keys(input).find((field) => !allowedFields.has(field));
  if (unknownField) {
    throw createInputError(`${fieldName} 不允许字段：${unknownField}`, TASK_ERROR_CODES.INVALID_INPUT);
  }
}

function validateBoolean(value, field) {
  if (typeof value !== 'boolean') {
    throw createInputError(`${field} 必须为布尔值`, TASK_ERROR_CODES.INVALID_INPUT);
  }
  return value;
}

function validateNumber(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value)) {
    throw createInputError(`${field} 必须为整数`, TASK_ERROR_CODES.INVALID_INPUT);
  }
  if (value < min || value > max) {
    throw createInputError(`${field} 必须在 ${min} 到 ${max} 之间`, TASK_ERROR_CODES.INVALID_INPUT);
  }
  return value;
}

function validateEnum(value, field, allowed) {
  if (!allowed.includes(value)) {
    throw createInputError(`${field} 无效`, TASK_ERROR_CODES.INVALID_INPUT);
  }
  return value;
}

function validateIdentifierText(value, field, {
  minLength = 1,
  maxLength = MAX_DOC_ID_LENGTH,
  allowEmpty = false,
} = {}) {
  if (typeof value !== 'string') {
    throw createInputError(`${field} 必须为字符串`, TASK_ERROR_CODES.INVALID_INPUT);
  }
  const trimmed = value.trim();
  if (!allowEmpty && trimmed.length < minLength) {
    throw createInputError(`${field} 长度不能小于 ${minLength}`, TASK_ERROR_CODES.INVALID_INPUT);
  }
  if (trimmed.length > maxLength) {
    throw createInputError(`${field} 长度不能超过 ${maxLength}`, TASK_ERROR_CODES.INVALID_INPUT);
  }
  const lowered = trimmed.toLowerCase();
  if (FORBIDDEN_FIELD_PATTERNS.some((pattern) => pattern.test(trimmed))
    || FORBIDDEN_FIELD_PATTERNS.some((pattern) => pattern.test(lowered))) {
    throw createInputError(`${field} 包含不允许的路径片段`, TASK_ERROR_CODES.INVALID_INPUT);
  }
  if (PROTOCOL_KEYWORDS.some((protocol) => lowered.includes(protocol))) {
    throw createInputError(`${field} 不允许包含外部协议`, TASK_ERROR_CODES.INVALID_INPUT);
  }
  return trimmed;
}

function validateSecureText(value, field, { minLength = 1, maxLength = MAX_REQUIREMENT_LENGTH, allowEmpty = false } = {}) {
  if (typeof value !== 'string') {
    throw createInputError(`${field} 必须为字符串`, TASK_ERROR_CODES.INVALID_INPUT);
  }
  const trimmed = value.trim();
  if (!allowEmpty && trimmed.length < minLength) {
    throw createInputError(`${field} 长度不能小于 ${minLength}`, TASK_ERROR_CODES.INVALID_INPUT);
  }
  if (trimmed.length > maxLength) {
    throw createInputError(`${field} 长度不能超过 ${maxLength}`, TASK_ERROR_CODES.INVALID_INPUT);
  }
  return trimmed;
}

function normalizeReferenceDocumentIds(input) {
  if (!Array.isArray(input)) {
    throw createInputError('reference_knowledge_document_ids 必须为数组', TASK_ERROR_CODES.INVALID_INPUT);
  }
  if (input.length > MAX_REFERENCE_DOCUMENT_IDS) {
    throw createInputError(`reference_knowledge_document_ids 数量不能超过 ${MAX_REFERENCE_DOCUMENT_IDS}`, TASK_ERROR_CODES.INVALID_INPUT);
  }
  const normalized = [];
  const seen = new Set();
  for (const raw of input) {
    const docId = validateIdentifierText(raw, 'reference_knowledge_document_id', { maxLength: MAX_DOC_ID_LENGTH });
    if (seen.has(docId)) continue;
    normalized.push(docId);
    seen.add(docId);
  }
  return Object.freeze(normalized);
}

function normalizeOutlineWordControlOptions(input) {
  if (!isPlainObject(input)) {
    throw createInputError('word_control_options 必须为对象', TASK_ERROR_CODES.INVALID_INPUT);
  }
  validateUnknownFields(input, new Set([
    'enabled',
    'minimumWords',
    'maximumWords',
    'sectionWords',
    'strictSectionWords',
  ]), 'word_control_options');
  const enabled = validateBoolean(input.enabled, 'word_control_options.enabled');
  const minimumWords = validateNumber(input.minimumWords, 'word_control_options.minimumWords', { min: 0, max: MAX_WORD_BOUNDARY });
  const maximumWords = validateNumber(input.maximumWords, 'word_control_options.maximumWords', { min: 0, max: MAX_WORD_BOUNDARY });
  const sectionWords = validateNumber(input.sectionWords, 'word_control_options.sectionWords', { min: 0, max: MAX_SECTION_WORDS });
  const strictSectionWords = validateBoolean(input.strictSectionWords, 'word_control_options.strictSectionWords');

  if (enabled && sectionWords > 0 && minimumWords > maximumWords && maximumWords !== 0) {
    throw createInputError('word_control_options.minimumWords 必须不超过 maximumWords', TASK_ERROR_CODES.INVALID_INPUT);
  }

  return Object.freeze({
    enabled,
    minimumWords,
    maximumWords,
    sectionWords,
    strictSectionWords,
  });
}

function normalizeGenerationOptions(input) {
  if (!isPlainObject(input)) {
    throw createInputError('generation_options 必须为对象', TASK_ERROR_CODES.INVALID_INPUT);
  }
  validateUnknownFields(input, new Set([
    'useAiImages',
    'maxAiImages',
    'useMermaidImages',
    'maxMermaidImages',
    'useHtmlImages',
    'maxHtmlImages',
    'htmlImageTypes',
    'tableRequirement',
    'enableConsistencyAudit',
    'consistencyRepairMode',
    'enableOriginalPlanCoverageAudit',
    'originalPlanCoverageRepairMode',
  ]), 'generation_options');

  const useAiImages = validateBoolean(input.useAiImages, 'generation_options.useAiImages');
  const maxAiImages = validateNumber(input.maxAiImages, 'generation_options.maxAiImages', { min: 0, max: MAX_IMG_COUNT });
  const useMermaidImages = validateBoolean(input.useMermaidImages, 'generation_options.useMermaidImages');
  const maxMermaidImages = validateNumber(input.maxMermaidImages, 'generation_options.maxMermaidImages', { min: 0, max: MAX_IMG_COUNT });
  const useHtmlImages = validateBoolean(input.useHtmlImages, 'generation_options.useHtmlImages');
  const maxHtmlImages = validateNumber(input.maxHtmlImages, 'generation_options.maxHtmlImages', { min: 0, max: MAX_IMG_COUNT });
  const htmlImageTypes = validateSecureText(input.htmlImageTypes, 'generation_options.htmlImageTypes', {
    minLength: 0,
    maxLength: MAX_IMAGE_TYPE_LENGTH,
    allowEmpty: true,
  });
  const tableRequirement = validateEnum(input.tableRequirement, 'generation_options.tableRequirement', CONTENT_TABLE_REQUIREMENTS);
  const enableConsistencyAudit = validateBoolean(input.enableConsistencyAudit, 'generation_options.enableConsistencyAudit');
  const consistencyRepairMode = validateEnum(input.consistencyRepairMode, 'generation_options.consistencyRepairMode', CONSISTENCY_REPAIR_MODES);
  const enableOriginalPlanCoverageAudit = validateBoolean(input.enableOriginalPlanCoverageAudit, 'generation_options.enableOriginalPlanCoverageAudit');
  const originalPlanCoverageRepairMode = input.originalPlanCoverageRepairMode === undefined
    ? undefined
    : validateEnum(input.originalPlanCoverageRepairMode, 'generation_options.originalPlanCoverageRepairMode', ORIGINAL_PLAN_COVERAGE_MODES);

  if (htmlImageTypes.length > MAX_IMAGE_TYPE_LENGTH) {
    throw createInputError(`generation_options.htmlImageTypes 长度不能超过 ${MAX_IMAGE_TYPE_LENGTH}`, TASK_ERROR_CODES.INVALID_INPUT);
  }

  return Object.freeze({
    useAiImages,
    maxAiImages,
    useMermaidImages,
    maxMermaidImages,
    useHtmlImages,
    maxHtmlImages,
    htmlImageTypes,
    tableRequirement,
    enableConsistencyAudit,
    consistencyRepairMode,
    enableOriginalPlanCoverageAudit,
    originalPlanCoverageRepairMode,
  });
}

function validateStartBidSectionExtractionInput(input) {
  if (!isPlainObject(input)) {
    throw createInputError('startBidSectionExtraction 入参必须为对象', TASK_ERROR_CODES.INVALID_INPUT);
  }
  validateUnknownFields(input, new Set(), 'startBidSectionExtraction');
  return Object.freeze({});
}

function validateStartOutlineGenerationInput(input) {
  if (!isPlainObject(input)) {
    throw createInputError('startOutlineGeneration 入参必须为对象', TASK_ERROR_CODES.INVALID_INPUT);
  }
  const allowed = new Set([
    'reference_knowledge_document_ids',
    'outline_expansion_mode',
    'word_control_options',
  ]);
  validateUnknownFields(input, allowed, 'startOutlineGeneration');
  if (hasOwnField(input, 'debug_force_outline_agent_repair')) {
    throw createInputError('debug_force_outline_agent_repair 为测试专用字段，生产 DTO 禁止', TASK_ERROR_CODES.INVALID_INPUT);
  }
  const referenceKnowledgeDocumentIds = normalizeReferenceDocumentIds(input.reference_knowledge_document_ids);
  const outlineExpansionMode = validateEnum(input.outline_expansion_mode, 'outline_expansion_mode', OUTLINE_EXPANSION_MODES);
  const wordControlOptions = normalizeOutlineWordControlOptions(input.word_control_options);
  return Object.freeze({
    reference_knowledge_document_ids: referenceKnowledgeDocumentIds,
    outline_expansion_mode: outlineExpansionMode,
    word_control_options: wordControlOptions,
  });
}

function canonicalizeStartContentGenerationInput(input) {
  if (!isPlainObject(input)) {
    throw createInputError('startContentGeneration 入参必须为对象', TASK_ERROR_CODES.INVALID_INPUT);
  }
  const action = validateEnum(input.action, 'action', CONTENT_CONTENT_ACTIONS);

  if (action === 'resume' || action === 'retry-correction' || action === 'rerun-illustration-plan') {
    validateUnknownFields(input, new Set(['action']), 'startContentGeneration');
    return Object.freeze({ action });
  }

  if (action === 'start' || action === 'regenerate-all') {
    validateUnknownFields(input, new Set(['action', 'generation_options']), 'startContentGeneration');
    const generationOptions = normalizeGenerationOptions(input.generation_options);
    return Object.freeze({
      action,
      generation_options: generationOptions,
    });
  }

  validateUnknownFields(input, new Set(['action', 'generation_options', 'target_item_id', 'requirement']), 'startContentGeneration');
  if (!hasOwnField(input, 'generation_options')) {
    throw createInputError('startContentGeneration 缺少 generation_options', TASK_ERROR_CODES.INVALID_INPUT);
  }
  const targetItemId = validateIdentifierText(input.target_item_id, 'target_item_id', { maxLength: MAX_DOC_ID_LENGTH });
  const requirement = validateSecureText(input.requirement, 'requirement', { maxLength: MAX_REQUIREMENT_LENGTH });
  const generationOptions = normalizeGenerationOptions(input.generation_options);
  return Object.freeze({
    action: 'regenerate-section',
    target_item_id: targetItemId,
    requirement,
    generation_options: generationOptions,
  });
}

function detectRendererContentAction(input) {
  const requested = [];
  if (hasOwnField(input, 'resume')) requested.push('resume');
  if (hasOwnField(input, 'retryContentCorrection')) requested.push('retry');
  if (hasOwnField(input, 'rerunIllustrations')) requested.push('rerun');
  if (hasOwnField(input, 'targetItemId') || hasOwnField(input, 'requirement')) requested.push('section');
  if (hasOwnField(input, 'regenerate') && input.regenerate === true) requested.push('regenerate');
  if (hasOwnField(input, 'generationOptions') && !requested.length) requested.push('start');

  if (requested.length !== 1) {
    throw createInputError('startContentGeneration 动作缺失或不完整', TASK_ERROR_CODES.INVALID_INPUT);
  }

  if (requested.includes('resume') && input.resume !== true) requested.length = 0;
  if (requested.includes('retry') && input.retryContentCorrection !== true) requested.length = 0;
  if (requested.includes('rerun') && input.rerunIllustrations !== true) requested.length = 0;
  if (requested.includes('regenerate') && input.regenerate !== true) requested.length = 0;

  if (requested.length !== 1) {
    throw createInputError('startContentGeneration 动作缺失或不完整', TASK_ERROR_CODES.INVALID_INPUT);
  }

  const action = requested[0];
  if (action === 'resume') return 'resume';
  if (action === 'retry') return 'retry-correction';
  if (action === 'rerun') return 'rerun-illustration-plan';
  if (action === 'section') return 'regenerate-section';
  return action === 'start' ? 'start' : 'regenerate-all';
}

function canonicalizeRendererStartContentGenerationInput(input) {
  if (!isPlainObject(input)) {
    throw createInputError('startContentGeneration 入参必须为对象', TASK_ERROR_CODES.INVALID_INPUT);
  }
  assertNoCanonicalFieldCollision(TASK_CONTENT_RENDERER_FIELDS.canonicalCanonicalOnly, input, 'startContentGeneration');
  const action = detectRendererContentAction(input);

  if (action === 'resume') {
    validateUnknownFields(input, new Set(['resume']), 'startContentGeneration');
    return Object.freeze({ action: 'resume' });
  }
  if (action === 'retry-correction') {
    validateUnknownFields(input, new Set(['retryContentCorrection']), 'startContentGeneration');
    return Object.freeze({ action: 'retry-correction' });
  }
  if (action === 'rerun-illustration-plan') {
    validateUnknownFields(input, new Set(['rerunIllustrations']), 'startContentGeneration');
    return Object.freeze({ action: 'rerun-illustration-plan' });
  }

  if (!hasOwnField(input, 'generationOptions')) {
    throw createInputError('startContentGeneration 缺少 generationOptions', TASK_ERROR_CODES.INVALID_INPUT);
  }
  const generationOptions = normalizeGenerationOptions(input.generationOptions);

  if (action === 'start') {
    validateUnknownFields(input, new Set(['regenerate', 'generationOptions']), 'startContentGeneration');
    return Object.freeze({
      action: 'start',
      generation_options: generationOptions,
    });
  }

  if (action === 'regenerate-all') {
    validateUnknownFields(input, new Set(['regenerate', 'generationOptions']), 'startContentGeneration');
    return Object.freeze({
      action: 'regenerate-all',
      generation_options: generationOptions,
    });
  }

  if (!hasOwnField(input, 'targetItemId')) {
    throw createInputError('startContentGeneration 缺少 targetItemId', TASK_ERROR_CODES.INVALID_INPUT);
  }
  if (!hasOwnField(input, 'requirement')) {
    throw createInputError('startContentGeneration 缺少 requirement', TASK_ERROR_CODES.INVALID_INPUT);
  }
  validateUnknownFields(input, new Set(['targetItemId', 'requirement', 'generationOptions']), 'startContentGeneration');
  const targetItemId = validateIdentifierText(input.targetItemId, 'targetItemId', { maxLength: MAX_DOC_ID_LENGTH });
  const requirement = validateSecureText(input.requirement, 'requirement', { maxLength: MAX_REQUIREMENT_LENGTH });
  return Object.freeze({
    action: 'regenerate-section',
    target_item_id: targetItemId,
    requirement,
    generation_options: generationOptions,
  });
}

function canonicalizeRendererStartOutlineGenerationInput(input) {
  if (!isPlainObject(input)) {
    throw createInputError('startOutlineGeneration 入参必须为对象', TASK_ERROR_CODES.INVALID_INPUT);
  }
  assertNoCanonicalFieldCollision(TASK_OUTLINE_RENDERER_FIELDS.canonical, input, 'startOutlineGeneration');
  validateUnknownFields(input, TASK_OUTLINE_RENDERER_FIELDS.renderer, 'startOutlineGeneration');
  const referenceKnowledgeDocumentIds = normalizeReferenceDocumentIds(input.referenceKnowledgeDocumentIds);
  const outlineExpansionMode = validateEnum(input.outlineExpansionMode, 'outlineExpansionMode', OUTLINE_EXPANSION_MODES);
  const wordControlOptions = normalizeOutlineWordControlOptions(input.wordControlOptions);
  return Object.freeze({
    reference_knowledge_document_ids: referenceKnowledgeDocumentIds,
    outline_expansion_mode: outlineExpansionMode,
    word_control_options: wordControlOptions,
  });
}

function validateStartGlobalFactsGenerationInput(input) {
  if (!isPlainObject(input)) {
    throw createInputError('startGlobalFactsGeneration 入参必须为对象', TASK_ERROR_CODES.INVALID_INPUT);
  }
  validateUnknownFields(input, new Set(), 'startGlobalFactsGeneration');
  return Object.freeze({});
}

function validatePauseContentGenerationInput(input) {
  if (!isPlainObject(input)) {
    throw createInputError('pauseContentGeneration 入参必须为对象', TASK_ERROR_CODES.INVALID_INPUT);
  }
  validateUnknownFields(input, new Set(), 'pauseContentGeneration');
  return Object.freeze({});
}

function validateStartContentGenerationInput(input) {
  const canonical = canonicalizeStartContentGenerationInput(input);
  if (!Object.prototype.hasOwnProperty.call(canonical, 'action')) {
    throw createInputError('startContentGeneration 未返回 action', TASK_ERROR_CODES.INVALID_INPUT);
  }
  validateEnum(canonical.action, 'action', CONTENT_CONTENT_ACTIONS);
  return canonical;
}

const TASK_DTO_ALLOWED_ERROR_CODES = Object.freeze([
  TASK_ERROR_CODES.INVALID_INPUT,
  TASK_ERROR_CODES.CONFLICT,
  TASK_ERROR_CODES.ITEM_NOT_FOUND,
  TASK_ERROR_CODES.INPUT_CHANGED,
  TASK_ERROR_CODES.ACCEPTANCE_ABORTED,
  TASK_ERROR_CODES.PAUSE_TIMEOUT,
  TASK_ERROR_CODES.INTERRUPTED_BY_RESTART,
]);

const TECHNICAL_PLAN_CONTRACTS_VERSION = '1.0.0';

module.exports = {
  TASK_ERROR_CODES,
  TASK_DTO_ALLOWED_ERROR_CODES,
  TASK_CONTENT_ACTIONS: CONTENT_CONTENT_ACTIONS,
  TASKS_OUTLINE_EXPANSION_MODES: OUTLINE_EXPANSION_MODES,
  TASK_TABLE_REQUIREMENTS: CONTENT_TABLE_REQUIREMENTS,
  TECHNICAL_PLAN_CONTRACTS_VERSION,
  normalizeGenerationOptions,
  normalizeOutlineWordControlOptions,
  canonicalizeStartContentGenerationInput,
  canonicalizeRendererStartContentGenerationInput,
  validateStartBidSectionExtractionInput,
  validateStartOutlineGenerationInput,
  canonicalizeRendererStartOutlineGenerationInput,
  validateStartGlobalFactsGenerationInput,
  validateStartContentGenerationInput,
  validatePauseContentGenerationInput,
  validateSecureText,
};
