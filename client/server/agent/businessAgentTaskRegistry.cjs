const path = require('node:path');

const ALLOWED_RUNTIME = 'opencode';
const REQUIRED_LIMITS = Object.freeze([
  'timeoutMs',
  'maxInputBytes',
  'maxOutputBytes',
  'maxModelCalls',
  'maxTotalTokens',
]);
const SERVER_LIMIT_CEILINGS = Object.freeze({
  timeoutMs: 600_000,
  maxInputBytes: 8 * 1024 * 1024,
  maxOutputBytes: 4 * 1024 * 1024,
  maxModelCalls: 8,
  maxTotalTokens: 64_000,
});

const TASK_SPEC_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}(?:\.[a-z][a-z0-9-]{1,63})*$/;
const FORBIDDEN_SPEC_IMPORTS = Object.freeze([
  'node:fs',
  'fs',
  'better-sqlite3',
  'sqlite',
  'workspaceRuntime',
  'workspaceMutationExecutor',
  'storeBridgeExecutor',
]);

function createSpecError(message, code = 'AGENT_TASK_SPEC_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createSpecError(`${label} 必须是对象`);
  }
  return value;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function normalizeLimit(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || Math.floor(number) !== number) {
    throw createSpecError(`Task Spec limits.${name} 必须是正整数`);
  }
  if (number > SERVER_LIMIT_CEILINGS[name]) {
    throw createSpecError(`Task Spec limits.${name} 超过服务端上限`);
  }
  return number;
}

function validateSpec(spec) {
  const source = requirePlainObject(spec, 'Task Spec');
  const expectedKeys = new Set([
    'id', 'version', 'runtime', 'capabilities', 'limits', 'inputBindings', 'commitOperationId',
    'captureSnapshot', 'buildInput', 'buildPrompt', 'validateOutput', 'applyResult', 'testOnly',
  ]);
  for (const key of Object.keys(source)) {
    if (!expectedKeys.has(key)) throw createSpecError(`Task Spec 包含未知字段 ${key}`);
  }
  const id = String(source.id || '').trim();
  if (!TASK_SPEC_ID_PATTERN.test(id)) throw createSpecError('Task Spec id 非法');
  const version = Number(source.version);
  if (!Number.isInteger(version) || version <= 0) throw createSpecError('Task Spec version 非法');
  if (source.runtime !== ALLOWED_RUNTIME) throw createSpecError('Task Spec runtime 非法');
  const capabilities = requirePlainObject(source.capabilities, 'Task Spec capabilities');
  if (!Array.isArray(capabilities.read) || capabilities.read.some((item) => typeof item !== 'string')) {
    throw createSpecError('Task Spec capabilities.read 非法');
  }
  if (capabilities.bash !== false || capabilities.network !== false) {
    throw createSpecError('Task Spec 必须显式禁用 bash 与 network');
  }
  const limits = requirePlainObject(source.limits, 'Task Spec limits');
  const normalizedLimits = {};
  for (const name of REQUIRED_LIMITS) normalizedLimits[name] = normalizeLimit(limits[name], name);
  const inputBindings = Array.isArray(source.inputBindings) ? source.inputBindings.map((item) => String(item || '').trim()) : [];
  if (!inputBindings.length || inputBindings.some((item) => !/^[a-z][a-z0-9-]{0,63}$/.test(item))) {
    throw createSpecError('Task Spec inputBindings 非法');
  }
  if (new Set(inputBindings).size !== inputBindings.length) throw createSpecError('Task Spec inputBindings 不可重复');
  const commitOperationId = String(source.commitOperationId || '').trim();
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(commitOperationId)) throw createSpecError('Task Spec commitOperationId 非法');
  for (const name of ['captureSnapshot', 'buildInput', 'buildPrompt', 'validateOutput', 'applyResult']) {
    if (typeof source[name] !== 'function') throw createSpecError(`Task Spec ${name} 必须是函数`);
  }
  if (source.applyResult.constructor?.name === 'AsyncFunction') {
    throw createSpecError('Task Spec applyResult 必须是同步函数');
  }
  return deepFreeze({
    id,
    version,
    runtime: ALLOWED_RUNTIME,
    capabilities: { read: [...capabilities.read], glob: Boolean(capabilities.glob), grep: Boolean(capabilities.grep), bash: false, network: false },
    limits: normalizedLimits,
    inputBindings,
    commitOperationId,
    captureSnapshot: source.captureSnapshot,
    buildInput: source.buildInput,
    buildPrompt: source.buildPrompt,
    validateOutput: source.validateOutput,
    applyResult: source.applyResult,
    testOnly: source.testOnly === true,
  });
}

function assertNoForbiddenImports(specPath, source) {
  const normalizedPath = path.resolve(specPath || '');
  if (!normalizedPath) return;
  for (const forbidden of FORBIDDEN_SPEC_IMPORTS) {
    if (source.includes(`require('${forbidden}')`) || source.includes(`require(\"${forbidden}\")`)) {
      throw createSpecError(`Task Spec 引入了禁止依赖 ${forbidden}`);
    }
  }
}

function createBusinessAgentTaskRegistry({ specs = [], env = process.env, sidecarReady = false } = {}) {
  if (!Array.isArray(specs)) throw createSpecError('Task Spec registry 必须是数组');
  const isTest = env.NODE_ENV === 'test';
  const productionSpecs = specs.filter((rawSpec) => rawSpec && rawSpec.testOnly !== true);
  const productionGateOpen = isTest || (
    String(env.AGENT_QUALITY_ENABLED || '').toLowerCase() === 'true'
    && (sidecarReady === true || sidecarReady?.status === 'ready')
  );
  if (!isTest && productionSpecs.length) {
    if (String(env.AGENT_QUALITY_ENABLED || '').toLowerCase() !== 'true') {
      throw createSpecError('Agent Quality 默认关闭，生产 Task Spec 不开放', 'AGENT_QUALITY_DISABLED');
    }
    if (sidecarReady !== true && sidecarReady?.status !== 'ready') {
      throw createSpecError('Agent Runner Sidecar 未通过 readiness gate', 'AGENT_SANDBOX_UNAVAILABLE');
    }
  }
  const registry = new Map();
  for (const rawSpec of specs) {
    const spec = validateSpec(rawSpec);
    if (spec.testOnly && !isTest) throw createSpecError('测试 Task Spec 只能在 NODE_ENV=test 装配');
    if (!spec.testOnly && !productionGateOpen) throw createSpecError('生产 Task Spec readiness gate 未打开', 'AGENT_SANDBOX_UNAVAILABLE');
    const key = `${spec.id}@${spec.version}`;
    if (registry.has(key)) throw createSpecError(`重复 Task Spec ${key}`);
    registry.set(key, spec);
  }
  return Object.freeze({
    get(id, version) {
      const spec = registry.get(`${String(id || '').trim()}@${Number(version)}`);
      if (!spec) throw createSpecError('未找到 Agent Task Spec', 'AGENT_TASK_SPEC_NOT_FOUND');
      return spec;
    },
    list() {
      return Array.from(registry.values()).map((spec) => ({ id: spec.id, version: spec.version, runtime: spec.runtime }));
    },
    size: registry.size,
  });
}

module.exports = {
  FORBIDDEN_SPEC_IMPORTS,
  SERVER_LIMIT_CEILINGS,
  TASK_SPEC_ID_PATTERN,
  assertNoForbiddenImports,
  createBusinessAgentTaskRegistry,
  createSpecError,
  validateSpec,
};
