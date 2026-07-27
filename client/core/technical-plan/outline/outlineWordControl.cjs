const DEFAULT_EFFECTIVE_SECTION_WORDS = 3000;
const MAX_WORD_BOUNDARY = 200000;
const MAX_SECTION_WORDS = 200000;

const WORD_CONTROL_ERROR_CODE = 'TASK_INVALID_INPUT';

function createError(message) {
  const error = new Error(message);
  error.code = WORD_CONTROL_ERROR_CODE;
  return error;
}

function normalizeBoolean(value, fieldName) {
  if (value === undefined) {
    return false;
  }
  if (typeof value !== 'boolean') {
    throw createError(`${fieldName} 必须为布尔值`);
  }
  return value;
}

function normalizeInteger(value, fieldName, allowZero = false) {
  if (value === undefined || value === null) {
    return 0;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw createError(`${fieldName} 必须为整数`);
  }
  if (value < 0) {
    throw createError(`${fieldName} 不能小于 0`);
  }
  if (value > MAX_WORD_BOUNDARY && (fieldName !== 'word_control_options.sectionWords')) {
    throw createError(`${fieldName} 不能超过 ${MAX_WORD_BOUNDARY}`);
  }
  if (value > MAX_SECTION_WORDS && fieldName === 'word_control_options.sectionWords') {
    throw createError(`${fieldName} 不能超过 ${MAX_SECTION_WORDS}`);
  }
  return value;
}

function normalizeOutlineWordControlOptions(raw) {
  const options = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  const minimumWords = normalizeInteger(options.minimumWords, 'minimumWords', true);
  const maximumWords = normalizeInteger(options.maximumWords, 'maximumWords', true);
  const sectionWords = normalizeInteger(options.sectionWords, 'sectionWords', true);

  return {
    enabled: normalizeBoolean(options.enabled, 'enabled'),
    minimumWords,
    maximumWords,
    sectionWords,
    strictSectionWords: normalizeBoolean(options.strictSectionWords, 'strictSectionWords'),
  };
}

function validateOutlineWordControlOptions(options) {
  const normalized = normalizeOutlineWordControlOptions(options);
  if (normalized.minimumWords > 0 && normalized.maximumWords > 0 && normalized.minimumWords > normalized.maximumWords) {
    throw createError('minimumWords 不能大于 maximumWords');
  }
  if (normalized.strictSectionWords && normalized.sectionWords <= 0) {
    throw createError('开启 strictSectionWords 时，sectionWords 必须大于 0');
  }
  return normalized;
}

function deriveOutlineWordControl(rawOptions) {
  const options = validateOutlineWordControlOptions(rawOptions);
  const effectiveSectionWords = options.sectionWords > 0 ? options.sectionWords : DEFAULT_EFFECTIVE_SECTION_WORDS;

  const minimumLeafCount = options.enabled && options.minimumWords > 0
    ? Math.ceil(options.minimumWords / effectiveSectionWords)
    : null;
  const maximumLeafCount = options.enabled && options.maximumWords > 0
    ? Math.floor(options.maximumWords / effectiveSectionWords)
    : null;

  return {
    ...options,
    effectiveSectionWords,
    minimumLeafCount,
    maximumLeafCount,
  };
}

function validateLeafBounds(leafCount, minimumLeafCount, maximumLeafCount) {
  if (minimumLeafCount === null && maximumLeafCount === null) {
    return { valid: true, distance: 0 };
  }
  if (minimumLeafCount !== null && leafCount < minimumLeafCount) {
    return { valid: false, distance: minimumLeafCount - leafCount };
  }
  if (maximumLeafCount !== null && leafCount > maximumLeafCount) {
    return { valid: false, distance: leafCount - maximumLeafCount };
  }
  return { valid: true, distance: 0 };
}

module.exports = {
  DEFAULT_EFFECTIVE_SECTION_WORDS,
  normalizeOutlineWordControlOptions,
  validateOutlineWordControlOptions,
  deriveOutlineWordControl,
  validateLeafBounds,
};
