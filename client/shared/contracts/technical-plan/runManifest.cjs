const crypto = require('node:crypto');

const RUN_MANIFEST_VERSION = 1;
const RUN_MANIFEST_TOP_LEVEL_KEYS = Object.freeze([
  'manifest_version',
  'task_id',
  'execution_id',
  'task_type',
  'workspace_runtime_generation',
  'stage_revision_vector',
  'normalized_input_hash',
  'source_hashes',
  'selected_bid_section',
  'upstream_result_hashes',
  'generation_config_hash',
  'prompt_template_version',
  'model_snapshot_ref',
  'output_schema_version',
]);
const RUN_MANIFEST_REQUIRED_KEYS = Object.freeze([...RUN_MANIFEST_TOP_LEVEL_KEYS]);
const RUN_MANIFEST_TASK_TYPES = Object.freeze([
  'bid-section-extraction',
  'outline-generation',
  'global-facts-generation',
  'content-generation',
]);
const RUN_MANIFEST_STAGE_REVISION_KEYS = Object.freeze([
  'source_revision',
  'analysis_revision',
  'outline_revision',
  'facts_revision',
  'content_revision',
]);
const RUN_MANIFEST_SOURCE_HASH_KEYS = Object.freeze([
  'tender_document_hash',
  'original_plan_hash',
  'reference_documents',
]);
const RUN_MANIFEST_UPSTREAM_HASH_KEYS = Object.freeze([
  'bid_analysis_hash',
  'outline_hash',
  'global_facts_hash',
  'content_hash',
]);
const RUN_MANIFEST_FORBIDDEN_FIELDS = Object.freeze([
  'progress',
  'logs',
  'timestamps',
  'checkpoint',
  'error',
  'receipt',
]);

const RUN_MANIFEST_HASH_PATTERN = /^[0-9a-f]{64}$/;
const RUN_MANIFEST_MAX_ID_LENGTH = 256;
const RUN_MANIFEST_MAX_STRING_LENGTH = 512;
const RUN_MANIFEST_MAX_PARSE_VERSION_LENGTH = 256;

function createManifestError(message) {
  const error = new Error(message);
  error.code = 'MANIFEST_INVALID';
  return error;
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertFieldAllowed(path, key, allowedSet) {
  if (!allowedSet.has(key)) {
    throw createManifestError(`${path} 包含未知字段 ${key}`);
  }
}

function assertNoForbiddenField(path, key) {
  if (RUN_MANIFEST_FORBIDDEN_FIELDS.includes(key)) {
    throw createManifestError(`${path} 不允许出现执行态字段 ${key}`);
  }
}

function validateInteger(value, path, { min = 0 } = {}) {
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value)) {
    throw createManifestError(`${path} 必须为整数`);
  }
  if (value < min) {
    throw createManifestError(`${path} 不能小于 ${min}`);
  }
  return value;
}

function validateEnum(value, path, allowed) {
  if (!allowed.includes(value)) {
    throw createManifestError(`${path} 无效`);
  }
  return value;
}

function validateString(value, path, { minLength = 1, maxLength = RUN_MANIFEST_MAX_STRING_LENGTH } = {}) {
  if (typeof value !== 'string') {
    throw createManifestError(`${path} 必须为字符串`);
  }
  const text = value.trim();
  if (text.length < minLength) {
    throw createManifestError(`${path} 长度不能小于 ${minLength}`);
  }
  if (text.length > maxLength) {
    throw createManifestError(`${path} 长度不能超过 ${maxLength}`);
  }
  return text;
}

function validateIdentifier(value, path, maxLength = RUN_MANIFEST_MAX_ID_LENGTH) {
  return validateString(value, path, { minLength: 1, maxLength });
}

function validateSha256(value, path, { allowNull = false } = {}) {
  if (value === null) {
    if (!allowNull) {
      throw createManifestError(`${path} 不允许为 null`);
    }
    return null;
  }
  if (typeof value !== 'string') {
    throw createManifestError(`${path} 必须为字符串`);
  }
  const hash = value.trim();
  if (!RUN_MANIFEST_HASH_PATTERN.test(hash)) {
    throw createManifestError(`${path} 必须为小写 SHA-256`);
  }
  return hash;
}

function normalizeReferenceDocument(value, path) {
  if (!isPlainObject(value)) {
    throw createManifestError(`${path} 必须为对象`);
  }
  const allowed = new Set(['document_id', 'content_hash', 'parse_version', 'source_record_hash']);
  for (const key of Object.keys(value)) {
    assertNoForbiddenField(path, key);
    assertFieldAllowed(path, key, allowed);
  }
  for (const field of allowed) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw createManifestError(`${path} 缺少字段 ${field}`);
    }
  }
  return Object.freeze({
    document_id: validateIdentifier(value.document_id, `${path}.document_id`),
    content_hash: validateSha256(value.content_hash, `${path}.content_hash`),
    parse_version: validateString(value.parse_version, `${path}.parse_version`, { maxLength: RUN_MANIFEST_MAX_PARSE_VERSION_LENGTH }),
    source_record_hash: validateSha256(value.source_record_hash, `${path}.source_record_hash`),
  });
}

function normalizeReferenceDocuments(value, path) {
  if (!Array.isArray(value)) {
    throw createManifestError(`${path} 必须为数组`);
  }
  return Object.freeze(value.map((item, index) => normalizeReferenceDocument(item, `${path}[${index}]`)));
}

function normalizeStageRevisionVector(value, path) {
  if (!isPlainObject(value)) {
    throw createManifestError(`${path} 必须为对象`);
  }
  const allowed = new Set(RUN_MANIFEST_STAGE_REVISION_KEYS);
  for (const key of Object.keys(value)) {
    assertNoForbiddenField(path, key);
    assertFieldAllowed(path, key, allowed);
  }
  for (const field of RUN_MANIFEST_STAGE_REVISION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw createManifestError(`${path} 缺少字段 ${field}`);
    }
  }
  return Object.freeze({
    source_revision: validateInteger(value.source_revision, `${path}.source_revision`, { min: 0 }),
    analysis_revision: validateInteger(value.analysis_revision, `${path}.analysis_revision`, { min: 0 }),
    outline_revision: validateInteger(value.outline_revision, `${path}.outline_revision`, { min: 0 }),
    facts_revision: validateInteger(value.facts_revision, `${path}.facts_revision`, { min: 0 }),
    content_revision: validateInteger(value.content_revision, `${path}.content_revision`, { min: 0 }),
  });
}

function normalizeSourceHashes(value, path) {
  if (!isPlainObject(value)) {
    throw createManifestError(`${path} 必须为对象`);
  }
  const allowed = new Set(RUN_MANIFEST_SOURCE_HASH_KEYS);
  for (const key of Object.keys(value)) {
    assertNoForbiddenField(path, key);
    assertFieldAllowed(path, key, allowed);
  }
  for (const field of RUN_MANIFEST_SOURCE_HASH_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw createManifestError(`${path} 缺少字段 ${field}`);
    }
  }
  return Object.freeze({
    tender_document_hash: validateSha256(value.tender_document_hash, `${path}.tender_document_hash`, { allowNull: true }),
    original_plan_hash: validateSha256(value.original_plan_hash, `${path}.original_plan_hash`, { allowNull: true }),
    reference_documents: normalizeReferenceDocuments(value.reference_documents, `${path}.reference_documents`),
  });
}

function normalizeSelectedBidSection(value, path) {
  if (value === null) {
    return null;
  }
  if (!isPlainObject(value)) {
    throw createManifestError(`${path} 必须为对象或 null`);
  }
  const allowed = new Set(['section_id', 'content_hash']);
  for (const key of Object.keys(value)) {
    assertNoForbiddenField(path, key);
    assertFieldAllowed(path, key, allowed);
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'section_id') || !Object.prototype.hasOwnProperty.call(value, 'content_hash')) {
    throw createManifestError(`${path} 缺少 section_id 或 content_hash`);
  }
  return Object.freeze({
    section_id: validateIdentifier(value.section_id, `${path}.section_id`),
    content_hash: validateSha256(value.content_hash, `${path}.content_hash`),
  });
}

function normalizeUpstreamResultHashes(value, path) {
  if (!isPlainObject(value)) {
    throw createManifestError(`${path} 必须为对象`);
  }
  const allowed = new Set(RUN_MANIFEST_UPSTREAM_HASH_KEYS);
  for (const key of Object.keys(value)) {
    assertNoForbiddenField(path, key);
    assertFieldAllowed(path, key, allowed);
  }
  for (const field of RUN_MANIFEST_UPSTREAM_HASH_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw createManifestError(`${path} 缺少字段 ${field}`);
    }
  }
  return Object.freeze({
    bid_analysis_hash: validateSha256(value.bid_analysis_hash, `${path}.bid_analysis_hash`, { allowNull: true }),
    outline_hash: validateSha256(value.outline_hash, `${path}.outline_hash`, { allowNull: true }),
    global_facts_hash: validateSha256(value.global_facts_hash, `${path}.global_facts_hash`, { allowNull: true }),
    content_hash: validateSha256(value.content_hash, `${path}.content_hash`, { allowNull: true }),
  });
}

function normalizeRunManifestV1(manifest) {
  if (!isPlainObject(manifest)) {
    throw createManifestError('RunManifestV1 输入必须为对象');
  }

  for (const key of Object.keys(manifest)) {
    assertNoForbiddenField('RunManifestV1', key);
    assertFieldAllowed('RunManifestV1', key, new Set(RUN_MANIFEST_TOP_LEVEL_KEYS));
  }
  for (const key of RUN_MANIFEST_REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(manifest, key)) {
      throw createManifestError(`RunManifestV1 缺少字段 ${key}`);
    }
  }

  if (typeof manifest.manifest_version !== 'number') {
    throw createManifestError('manifest_version 必须为数字');
  }
  if (manifest.manifest_version !== RUN_MANIFEST_VERSION) {
    throw createManifestError(`manifest_version 必须为 ${RUN_MANIFEST_VERSION}`);
  }

  return Object.freeze({
    manifest_version: RUN_MANIFEST_VERSION,
    task_id: validateIdentifier(manifest.task_id, 'task_id'),
    execution_id: validateIdentifier(manifest.execution_id, 'execution_id'),
    task_type: validateEnum(manifest.task_type, 'task_type', RUN_MANIFEST_TASK_TYPES),
    workspace_runtime_generation: validateInteger(manifest.workspace_runtime_generation, 'workspace_runtime_generation', { min: 0 }),
    stage_revision_vector: normalizeStageRevisionVector(manifest.stage_revision_vector, 'stage_revision_vector'),
    normalized_input_hash: validateSha256(manifest.normalized_input_hash, 'normalized_input_hash'),
    source_hashes: normalizeSourceHashes(manifest.source_hashes, 'source_hashes'),
    selected_bid_section: normalizeSelectedBidSection(manifest.selected_bid_section, 'selected_bid_section'),
    upstream_result_hashes: normalizeUpstreamResultHashes(manifest.upstream_result_hashes, 'upstream_result_hashes'),
    generation_config_hash: validateSha256(manifest.generation_config_hash, 'generation_config_hash'),
    prompt_template_version: validateString(manifest.prompt_template_version, 'prompt_template_version'),
    model_snapshot_ref: validateString(manifest.model_snapshot_ref, 'model_snapshot_ref'),
    output_schema_version: validateString(manifest.output_schema_version, 'output_schema_version'),
  });
}

function canonicalSort(value, path = 'runManifest') {
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => canonicalSort(item, path)));
  }
  if (typeof value !== 'object') {
    if (typeof value === 'number' && (!Number.isFinite(value) || Number.isNaN(value))) {
      throw createManifestError(`${path} 不允许 NaN 或 Infinity`);
    }
    return value;
  }
  if (!isPlainObject(value)) {
    throw createManifestError(`${path} 仅支持 object/array/字符串/数字/布尔/null`);
  }
  const out = {};
  const keys = Object.keys(value).sort();
  for (const key of keys) {
    assertNoForbiddenField(path, key);
    out[key] = canonicalSort(value[key], `${path}.${key}`);
  }
  return Object.freeze(out);
}

function canonicalizeRunManifestV1(manifest) {
  const normalized = normalizeRunManifestV1(manifest);
  return canonicalSort(normalized);
}

function stringifyRunManifestV1(manifest) {
  return JSON.stringify(canonicalizeRunManifestV1(manifest));
}

function computeRunManifestV1Hash(manifest) {
  const canonicalJson = stringifyRunManifestV1(manifest);
  return crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

function normalizeRunManifestToImmutableProjection(manifest) {
  return canonicalizeRunManifestV1(manifest);
}

module.exports = {
  RUN_MANIFEST_VERSION,
  RUN_MANIFEST_TOP_LEVEL_KEYS,
  RUN_MANIFEST_FORBIDDEN_FIELDS,
  canonicalizeRunManifestV1,
  normalizeRunManifestToImmutableProjection,
  stringifyRunManifestV1,
  computeRunManifestV1Hash,
};
