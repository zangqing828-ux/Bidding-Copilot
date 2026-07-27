const crypto = require('node:crypto');
const {
  assertOutlineNodeLimit,
  normalizeOutlineTree,
} = require('../../core/technical-plan/outline/outlineStructure.cjs');
const {
  createBusinessAgentTaskRegistry,
} = require('./businessAgentTaskRegistry.cjs');

const TECHNICAL_PLAN_AGENT_SPEC_VERSION = 1;
const TECHNICAL_PLAN_AGENT_SNAPSHOT_VERSION = 'technical-plan-agent-snapshot.v1';
const ILLUSTRATION_PLAN_VERSION = 1;
const SNAPSHOT_BINDING = 'technical-plan-agent-snapshot';
const MAX_PROMPT_BYTES = 16 * 1024;
const MAX_CONTENT_CHARS = 120_000;
const MAX_SOURCE_IDS = 32;
const MAX_CHANGES = 100;
const MAX_ILLUSTRATION_ITEMS = 100;
const MAX_ILLUSTRATION_SECTIONS = 8;

const TECHNICAL_PLAN_AGENT_SPEC_IDS = Object.freeze([
  'technical-plan.outline-repair.v1',
  'technical-plan.outline-word-adjust.v1',
  'technical-plan.content-repair.v1',
  'technical-plan.original-coverage-repair.v1',
  'technical-plan.consistency-repair.v1',
  'technical-plan.illustration-plan.v1',
]);

const STAGE_REVISION_FIELDS = Object.freeze([
  'source_revision',
  'analysis_revision',
  'outline_revision',
  'facts_revision',
  'content_revision',
]);

const COMMON_SCHEMA_PROPERTIES = Object.freeze({
  schema_version: { type: 'string' },
  base_input_revision: { type: 'integer', minimum: 0 },
  base_stage_revisions: {
    type: 'object',
    additionalProperties: false,
    required: [...STAGE_REVISION_FIELDS],
    properties: Object.fromEntries(STAGE_REVISION_FIELDS.map((field) => [field, { type: 'integer', minimum: 0 }])),
  },
  source_snapshot_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
});

const OUTLINE_NODE_SCHEMA = Object.freeze({
  $id: 'technical-plan-outline-node.v1',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'description'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 256, pattern: '^\\d+(?:\\.\\d+){0,2}$' },
    title: { type: 'string', minLength: 1, maxLength: 2048 },
    description: { type: 'string', minLength: 1, maxLength: 4096 },
    source_requirement_id: { type: 'string', minLength: 1, maxLength: 4096 },
    source_requirement_title: { type: 'string', minLength: 1, maxLength: 4096 },
    children: {
      type: 'array',
      maxItems: 1000,
      items: { $ref: '#/$defs/outlineNode' },
    },
  },
});

function createAgentTaskSpecError(message, code = 'AGENT_TASK_SPEC_INVALID') {
  const error = new Error(message);
  error.code = code;
  error.retryable = true;
  return error;
}

function createOutputError(message) {
  return createAgentTaskSpecError(message, 'AGENT_OUTPUT_INVALID');
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cloneJson(value, label = 'value') {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw createAgentTaskSpecError(`${label} 必须是可序列化 JSON：${error.message}`);
  }
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function canonicalize(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (!isPlainObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function assertJsonBytes(value, maxBytes, label) {
  const bytes = jsonBytes(value);
  if (bytes > maxBytes) throw createAgentTaskSpecError(`${label} 超过 ${maxBytes} bytes`, 'AGENT_OUTPUT_INVALID');
  return bytes;
}

function assertNoSensitiveFields(value, path = 'value') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveFields(item, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:api[_-]?key|secret|token|password|file[_-]?path|content[_-]?path|markdown[_-]?path|server[_-]?path|absolute[_-]?path)$/i.test(key)) {
      throw createAgentTaskSpecError(`${path}.${key} 不允许进入 Agent Task Spec 输入输出`, 'AGENT_TASK_SPEC_INVALID');
    }
    assertNoSensitiveFields(child, `${path}.${key}`);
  }
}

function requireObject(value, label) {
  if (!isPlainObject(value)) throw createAgentTaskSpecError(`${label} 必须是对象`);
  return value;
}

function requireString(value, label, { minLength = 1, maxLength = 2048 } = {}) {
  if (typeof value !== 'string' || value.length < minLength || value.length > maxLength) {
    throw createOutputError(`${label} 必须是 ${minLength}-${maxLength} 字符的字符串`);
  }
  return value;
}

function requireInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) throw createOutputError(`${label} 必须是合法整数`);
  return value;
}

function requireExactKeys(value, schema, label) {
  const allowed = new Set(Object.keys(schema.properties || {}));
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw createOutputError(`${label} 包含未声明字段 ${key}`);
  }
  for (const key of schema.required || []) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw createOutputError(`${label} 缺少字段 ${key}`);
  }
}

function resolveSchemaRef(ref, root) {
  if (ref === '#/$defs/outlineNode') return root.$defs.outlineNode;
  throw createOutputError(`未知 JSON Schema ref ${ref}`);
}

function validateJsonSchema(value, schema, root = schema, path = '$') {
  if (schema.$ref) return validateJsonSchema(value, resolveSchemaRef(schema.$ref, root), root, path);
  if (schema.const !== undefined && value !== schema.const) throw createOutputError(`${path} 必须等于 ${schema.const}`);
  if (schema.type === 'object') {
    requireObject(value, path);
    if (schema.additionalProperties === false) requireExactKeys(value, schema, path);
    for (const required of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) throw createOutputError(`${path}.${required} 缺失`);
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(value, key)) validateJsonSchema(value[key], childSchema, root, `${path}.${key}`);
    }
    return value;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw createOutputError(`${path} 必须是数组`);
    if (schema.minItems !== undefined && value.length < schema.minItems) throw createOutputError(`${path} 数量不足`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw createOutputError(`${path} 数量超过限制`);
    value.forEach((item, index) => validateJsonSchema(item, schema.items, root, `${path}[${index}]`));
    return value;
  }
  if (schema.type === 'string') {
    requireString(value, path, { minLength: schema.minLength || 0, maxLength: schema.maxLength || 2048 });
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw createOutputError(`${path} 格式非法`);
    if (schema.enum && !schema.enum.includes(value)) throw createOutputError(`${path} 枚举值非法`);
    return value;
  }
  if (schema.type === 'integer') {
    requireInteger(value, path, { min: schema.minimum ?? 0, max: schema.maximum ?? Number.MAX_SAFE_INTEGER });
    return value;
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean') throw createOutputError(`${path} 必须是布尔值`);
  return value;
}

function normalizeStageRevisions(value, label = 'base_stage_revisions') {
  const source = requireObject(value, label);
  const normalized = {};
  for (const field of STAGE_REVISION_FIELDS) normalized[field] = requireInteger(source[field], `${label}.${field}`, { min: 0 });
  if (Object.keys(source).some((field) => !STAGE_REVISION_FIELDS.includes(field))) {
    throw createAgentTaskSpecError(`${label} 包含未知字段`);
  }
  return normalized;
}

function normalizeSnapshot(rawSnapshot, currentInputRevision) {
  const source = requireObject(rawSnapshot, 'technical-plan agent snapshot');
  if (source.snapshot_version !== TECHNICAL_PLAN_AGENT_SNAPSHOT_VERSION) {
    throw createAgentTaskSpecError('技术方案 Agent snapshot 版本不支持', 'AGENT_INPUT_INVALID');
  }
  if (source.input_revision !== currentInputRevision) {
    throw createAgentTaskSpecError('技术方案 Agent snapshot 与当前输入 revision 不一致', 'AGENT_INPUT_CHANGED');
  }
  normalizeStageRevisions(source.stage_revisions, 'snapshot.stage_revisions');
  const snapshot = cloneJson({
    snapshot_version: source.snapshot_version,
    input_revision: source.input_revision,
    stage_revisions: source.stage_revisions,
    workflow_kind: source.workflow_kind,
    request: source.request || {},
    outline_expansion_mode: source.outline_expansion_mode || 'ai-complement',
    outline_word_control_options: source.outline_word_control_options || {},
    outline_word_control_snapshot: source.outline_word_control_snapshot || null,
    reference_knowledge_document_ids: Array.isArray(source.reference_knowledge_document_ids)
      ? source.reference_knowledge_document_ids
      : [],
    outline: source.outline || null,
    global_facts: Array.isArray(source.global_facts) ? source.global_facts : [],
    content_sections: source.content_sections || {},
    content_plans: source.content_plans || {},
    original_plan_markdown: source.original_plan_markdown || '',
    illustration_plan: source.illustration_plan || null,
  }, 'technical-plan agent snapshot');
  assertNoSensitiveFields(snapshot, 'snapshot');
  assertJsonBytes(snapshot, 8 * 1024 * 1024, 'technical-plan agent snapshot');
  return deepFreeze(snapshot);
}

function captureSnapshot(reader) {
  const inputRevision = requireInteger(reader.getInputRevision(), 'input_revision', { min: 0 });
  const snapshot = normalizeSnapshot(reader.readBinding(SNAPSHOT_BINDING), inputRevision);
  return Object.freeze({
    readonlySnapshot: snapshot,
    inputRevision,
    inputHash: sha256(snapshot),
  });
}

function makeInput(specId, snapshot) {
  const input = {
    schema_version: 'technical-plan-agent-input.v1',
    task_spec_id: specId,
    input_revision: snapshot.input_revision,
    stage_revisions: snapshot.stage_revisions,
    source_snapshot_hash: sha256(snapshot),
    request: snapshot.request,
    snapshot,
  };
  assertNoSensitiveFields(input, 'input');
  assertJsonBytes(input, 8 * 1024 * 1024, 'Agent input');
  return deepFreeze(input);
}

function makePrompt(specId, instruction, snapshot = null) {
  const request = snapshot?.request && typeof snapshot.request === 'object' ? snapshot.request : {};
  const requestPrompt = String(request.prompt || '').trim();
  const outputFile = String(request.output_file || 'result.json').trim();
  const prompt = [
    `Task Spec: ${specId}`,
    'Protocol: technical-plan-agent-prompt.v1',
    instruction,
    `请读取 input/request.json 了解本次受控业务请求和输入文件；最终只使用 write 工具写入 ${outputFile}，文件内容必须是符合 Task Spec schema 的纯 JSON 对象。`,
    requestPrompt ? `业务请求补充说明：\n${requestPrompt}` : '',
    '不得输出 Markdown 围栏、额外字段、路径、Token 或模型凭据。',
  ].join('\n');
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) throw createAgentTaskSpecError('Agent prompt 超过限制');
  return prompt;
}

function commonSchema(specId, customProperties, customRequired) {
  return {
    $id: `https://bidmaster.local/schemas/${specId}.schema.json`,
    type: 'object',
    additionalProperties: false,
    required: ['schema_version', 'base_input_revision', 'base_stage_revisions', 'source_snapshot_hash', ...customRequired],
    properties: {
      ...COMMON_SCHEMA_PROPERTIES,
      schema_version: { const: specId },
      ...customProperties,
    },
  };
}

const TECHNICAL_PLAN_AGENT_SCHEMAS = Object.freeze({
  'technical-plan.outline-repair.v1': commonSchema('technical-plan.outline-repair.v1', {
    outline: { type: 'array', minItems: 1, maxItems: 1000, items: { $ref: '#/$defs/outlineNode' } },
    project_name: { type: 'string', minLength: 1, maxLength: 2048 },
    project_overview: { type: 'string', minLength: 1, maxLength: 4096 },
    repair_summary: { type: 'string', minLength: 1, maxLength: 4000 },
  }, ['outline', 'repair_summary']),
  'technical-plan.outline-word-adjust.v1': commonSchema('technical-plan.outline-word-adjust.v1', {
    outline: { type: 'array', minItems: 1, maxItems: 1000, items: { $ref: '#/$defs/outlineNode' } },
    word_control: {
      type: 'object',
      additionalProperties: false,
      required: ['enabled', 'minimumWords', 'maximumWords', 'sectionWords', 'strictSectionWords'],
      properties: {
        enabled: { type: 'boolean' },
        minimumWords: { type: 'integer', minimum: 0, maximum: 200000 },
        maximumWords: { type: 'integer', minimum: 0, maximum: 200000 },
        sectionWords: { type: 'integer', minimum: 0, maximum: 200000 },
        strictSectionWords: { type: 'boolean' },
      },
    },
    repair_summary: { type: 'string', minLength: 1, maxLength: 4000 },
  }, ['outline', 'word_control', 'repair_summary']),
  'technical-plan.content-repair.v1': commonSchema('technical-plan.content-repair.v1', {
    node_id: { type: 'string', minLength: 1, maxLength: 256 },
    content: { type: 'string', minLength: 1, maxLength: MAX_CONTENT_CHARS },
    repair_summary: { type: 'string', minLength: 1, maxLength: 4000 },
  }, ['node_id', 'content', 'repair_summary']),
  'technical-plan.original-coverage-repair.v1': commonSchema('technical-plan.original-coverage-repair.v1', {
    node_id: { type: 'string', minLength: 1, maxLength: 256 },
    content: { type: 'string', minLength: 1, maxLength: MAX_CONTENT_CHARS },
    source_ids: { type: 'array', minItems: 1, maxItems: MAX_SOURCE_IDS, items: { type: 'string', minLength: 1, maxLength: 256 } },
    covered_requirements: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 256 } },
    repair_summary: { type: 'string', minLength: 1, maxLength: 4000 },
  }, ['node_id', 'content', 'source_ids', 'covered_requirements', 'repair_summary']),
  'technical-plan.consistency-repair.v1': commonSchema('technical-plan.consistency-repair.v1', {
    changes: {
      type: 'array', minItems: 1, maxItems: MAX_CHANGES,
      items: {
        type: 'object', additionalProperties: false, required: ['node_id', 'content', 'reason'],
        properties: {
          node_id: { type: 'string', minLength: 1, maxLength: 256 },
          content: { type: 'string', minLength: 1, maxLength: MAX_CONTENT_CHARS },
          reason: { type: 'string', minLength: 1, maxLength: 1000 },
        },
      },
    },
    repair_summary: { type: 'string', minLength: 1, maxLength: 4000 },
  }, ['changes', 'repair_summary']),
  'technical-plan.illustration-plan.v1': commonSchema('technical-plan.illustration-plan.v1', {
    plan_version: { const: ILLUSTRATION_PLAN_VERSION },
    content_revision: { type: 'integer', minimum: 0 },
    outline_revision: { type: 'integer', minimum: 0 },
    manifest_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    revision: { type: 'string', minLength: 1, maxLength: 128 },
    items: {
      type: 'array', maxItems: MAX_ILLUSTRATION_ITEMS,
      items: {
        type: 'object', additionalProperties: false,
        required: ['item_id', 'kind', 'image_type', 'title', 'section_ids', 'placement', 'priority'],
        properties: {
          item_id: { type: 'string', minLength: 1, maxLength: 128 },
          kind: { type: 'string', enum: ['html', 'ai', 'mermaid'] },
          image_type: { type: 'string', minLength: 1, maxLength: 128 },
          title: { type: 'string', minLength: 1, maxLength: 64 },
          section_ids: { type: 'array', minItems: 1, maxItems: MAX_ILLUSTRATION_SECTIONS, items: { type: 'string', minLength: 1, maxLength: 256 } },
          placement: { type: 'string', enum: ['before', 'after'] },
          priority: { type: 'integer', minimum: 1, maximum: 5 },
          intent: { type: 'string', minLength: 1, maxLength: 1000 },
          description: { type: 'string', minLength: 1, maxLength: 2000 },
        },
      },
    },
  }, ['plan_version', 'content_revision', 'outline_revision', 'manifest_hash', 'revision', 'items']),
});

for (const schema of Object.values(TECHNICAL_PLAN_AGENT_SCHEMAS)) {
  schema.$defs = { outlineNode: OUTLINE_NODE_SCHEMA };
}

function normalizeOutlineOutput(output) {
  try {
    const normalized = normalizeOutlineTree(output.outline, { mode: 'existing' });
    assertOutlineNodeLimit(normalized);
    return normalized;
  } catch (error) {
    throw createOutputError(`目录结构无效：${error.message}`);
  }
}

function validateCommonOutput(output, schema) {
  requireObject(output, 'Agent result');
  assertJsonBytes(output, 4 * 1024 * 1024, 'Agent result');
  assertNoSensitiveFields(output, 'result');
  validateJsonSchema(output, schema, schema);
  normalizeStageRevisions(output.base_stage_revisions);
  return output;
}

function validateOutlineRepair(output) {
  validateCommonOutput(output, TECHNICAL_PLAN_AGENT_SCHEMAS['technical-plan.outline-repair.v1']);
  const outline = normalizeOutlineOutput(output);
  return deepFreeze({ ...cloneJson(output), outline });
}

function validateOutlineWordAdjust(output) {
  validateCommonOutput(output, TECHNICAL_PLAN_AGENT_SCHEMAS['technical-plan.outline-word-adjust.v1']);
  const outline = normalizeOutlineOutput(output);
  if (output.word_control.minimumWords > 0 && output.word_control.maximumWords > 0
    && output.word_control.minimumWords > output.word_control.maximumWords) {
    throw createOutputError('word_control.minimumWords 不能大于 maximumWords');
  }
  if (output.word_control.strictSectionWords && output.word_control.sectionWords <= 0) {
    throw createOutputError('strictSectionWords 开启时 sectionWords 必须大于 0');
  }
  return deepFreeze({ ...cloneJson(output), outline });
}

function validateContentRepair(output) {
  validateCommonOutput(output, TECHNICAL_PLAN_AGENT_SCHEMAS['technical-plan.content-repair.v1']);
  return deepFreeze(cloneJson(output));
}

function validateOriginalCoverageRepair(output) {
  validateCommonOutput(output, TECHNICAL_PLAN_AGENT_SCHEMAS['technical-plan.original-coverage-repair.v1']);
  if (new Set(output.source_ids).size !== output.source_ids.length) throw createOutputError('source_ids 不得重复');
  if (new Set(output.covered_requirements).size !== output.covered_requirements.length) throw createOutputError('covered_requirements 不得重复');
  return deepFreeze(cloneJson(output));
}

function validateConsistencyRepair(output) {
  validateCommonOutput(output, TECHNICAL_PLAN_AGENT_SCHEMAS['technical-plan.consistency-repair.v1']);
  const ids = output.changes.map((item) => item.node_id);
  if (new Set(ids).size !== ids.length) throw createOutputError('consistency changes 的 node_id 不得重复');
  return deepFreeze(cloneJson(output));
}

function validateIllustrationPlan(output) {
  validateCommonOutput(output, TECHNICAL_PLAN_AGENT_SCHEMAS['technical-plan.illustration-plan.v1']);
  const itemIds = new Set();
  const sectionIds = new Set();
  for (const item of output.items) {
    if (itemIds.has(item.item_id)) throw createOutputError(`配图 item_id 重复：${item.item_id}`);
    itemIds.add(item.item_id);
    if (new Set(item.section_ids).size !== item.section_ids.length) throw createOutputError(`配图 section_ids 重复：${item.item_id}`);
    for (const sectionId of item.section_ids) {
      if (sectionIds.has(sectionId)) throw createOutputError(`同一小节只能编排一张图：${sectionId}`);
      sectionIds.add(sectionId);
    }
    if (item.section_ids.length > 1 && item.kind !== 'html') throw createOutputError('AI 或 Mermaid 图片只能引用一个正文小节');
    if (item.section_ids.length === 1 && item.placement !== 'after') throw createOutputError('单节图片 placement 必须为 after');
  }
  return deepFreeze(cloneJson(output));
}

function createApplyResult(operationId) {
  return function applyResult(validatedOutput, transaction) {
    transaction.assertInputRevision(validatedOutput.base_input_revision);
    transaction.applyDeclaredOperation(operationId, validatedOutput);
  };
}

const SPEC_DEFINITIONS = Object.freeze([
  {
    id: 'technical-plan.outline-repair.v1',
    operationId: 'technical-plan-apply-outline-repair',
    instruction: '修复目录结构、遗漏和硬约束；只返回完整目录树和修复摘要，不写正文、不生成图片资产。',
    validateOutput: validateOutlineRepair,
  },
  {
    id: 'technical-plan.outline-word-adjust.v1',
    operationId: 'technical-plan-apply-outline-word-adjust',
    instruction: '根据冻结字数配置调整叶子章节；保持目录语义和层级合法，只返回完整目录树、字数配置和修复摘要。',
    validateOutput: validateOutlineWordAdjust,
  },
  {
    id: 'technical-plan.content-repair.v1',
    operationId: 'technical-plan-apply-content-repair',
    instruction: '修复指定正文叶子小节；只返回目标 node_id、完整正文和修复摘要。',
    validateOutput: validateContentRepair,
  },
  {
    id: 'technical-plan.original-coverage-repair.v1',
    operationId: 'technical-plan-apply-original-coverage-repair',
    instruction: '补齐原方案覆盖缺口；保留来源引用和覆盖需求 ID，只返回目标正文、来源 ID、覆盖需求 ID 和摘要。',
    validateOutput: validateOriginalCoverageRepair,
  },
  {
    id: 'technical-plan.consistency-repair.v1',
    operationId: 'technical-plan-apply-consistency-repair',
    instruction: '修复跨章节事实一致性；只返回有界的正文变更集合和每项原因，不改变目录结构。',
    validateOutput: validateConsistencyRepair,
  },
  {
    id: 'technical-plan.illustration-plan.v1',
    operationId: 'technical-plan-apply-illustration-plan',
    instruction: '生成结构化 IllustrationPlan v1；只保存配图计划，不创建 asset、不渲染、不生成 render receipt。',
    validateOutput: validateIllustrationPlan,
  },
]);

function createTechnicalPlanAgentTaskSpecs() {
  return Object.freeze(SPEC_DEFINITIONS.map((definition) => Object.freeze({
    id: definition.id,
    version: TECHNICAL_PLAN_AGENT_SPEC_VERSION,
    runtime: 'opencode',
    capabilities: {
      read: [SNAPSHOT_BINDING],
      glob: false,
      grep: false,
      bash: false,
      network: false,
    },
    limits: {
      timeoutMs: 10 * 60 * 1000,
      maxInputBytes: 8 * 1024 * 1024,
      maxOutputBytes: 4 * 1024 * 1024,
      maxModelCalls: 8,
      maxTotalTokens: 64_000,
    },
    inputBindings: [SNAPSHOT_BINDING],
    commitOperationId: definition.operationId,
    captureSnapshot,
    buildInput: (snapshot) => makeInput(definition.id, snapshot),
    buildPrompt: (snapshot) => makePrompt(definition.id, definition.instruction, snapshot),
    validateOutput: definition.validateOutput,
    applyResult: createApplyResult(definition.operationId),
    testOnly: false,
  })));
}

function isSidecarReady(sidecarReadiness) {
  return sidecarReadiness === true || sidecarReadiness?.status === 'ready';
}

function isEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function createTechnicalPlanAgentTaskRegistry({ env = process.env, sidecarReadiness = false } = {}) {
  const specs = createTechnicalPlanAgentTaskSpecs();
  const enabled = isEnabled(env.AGENT_QUALITY_ENABLED);
  if (env.NODE_ENV !== 'test' && (!enabled || !isSidecarReady(sidecarReadiness))) {
    return createBusinessAgentTaskRegistry({ specs: [], env });
  }
  return createBusinessAgentTaskRegistry({ specs, env, sidecarReady: isSidecarReady(sidecarReadiness) });
}

module.exports = {
  ILLUSTRATION_PLAN_VERSION,
  MAX_CONTENT_CHARS,
  SNAPSHOT_BINDING,
  STAGE_REVISION_FIELDS,
  TECHNICAL_PLAN_AGENT_SCHEMAS,
  TECHNICAL_PLAN_AGENT_SNAPSHOT_VERSION,
  TECHNICAL_PLAN_AGENT_SPEC_IDS,
  TECHNICAL_PLAN_AGENT_SPEC_VERSION,
  createTechnicalPlanAgentTaskRegistry,
  createTechnicalPlanAgentTaskSpecs,
  sha256,
  validateJsonSchema,
};
