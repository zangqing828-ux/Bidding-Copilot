const crypto = require('node:crypto');

const PROTOCOL_VERSION = 1;
const PROTOCOL_NAME = 'SidecarProtocolV1';

const MAX_CALLS_DEFAULT = 16;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_EXECUTION_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_EXECUTION_TOKEN_LENGTH = 64;

const PROTOCOL_ROUTES = Object.freeze({
  RUNNER_CREATE: '/internal/runner/v1/executions',
  RUNNER_CANCEL: '/internal/runner/v1/executions/{executionId}',
  RUNNER_STATUS: '/internal/runner/v1/executions/{executionId}',
  RUNNER_HEALTH: '/internal/runner/v1/health',
  RUNNER_HANDSHAKE: '/internal/runner/v1/handshake',
  AGENT_LISTENER_HEALTH: '/internal/agent/v1/health',
  AGENT_CAPABILITY: '/internal/agent/v1/executions/{executionId}/capability',
  AGENT_CHAT: '/internal/agent/v1/chat/completions',
  AGENT_RESPONSES: '/internal/agent/v1/responses',
});

const PROTOCOL_METHODS = Object.freeze({
  POST: 'POST',
  GET: 'GET',
  DELETE: 'DELETE',
});

const TOKEN_TYPES = Object.freeze({
  DISPATCH: 'agent_sidecar_dispatch_v1',
  PROXY: 'agent_sidecar_proxy_v1',
  HANDSHAKE: 'agent_sidecar_handshake_v1',
});

const TOKEN_AUDIENCE = Object.freeze({
  RUNNER: 'agent-runner',
  LISTENER: 'agent-listener',
  WEB: 'agent-web',
});

const SIDE_CAR_ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'SIDE_CAR_INVALID_INPUT',
  INVALID_TOKEN: 'SIDE_CAR_INVALID_TOKEN',
  TOKEN_EXPIRED: 'SIDE_CAR_TOKEN_EXPIRED',
  TOKEN_REPLAY: 'SIDE_CAR_TOKEN_REPLAY',
  TOKEN_REVOKED: 'SIDE_CAR_TOKEN_REVOKED',
  BINDING_MISMATCH: 'SIDE_CAR_TOKEN_BINDING_MISMATCH',
  EXECUTION_NOT_FOUND: 'SIDE_CAR_EXECUTION_NOT_FOUND',
  EXECUTION_CONFLICT: 'SIDE_CAR_EXECUTION_CONFLICT',
  EXECUTION_BUSY: 'SIDE_CAR_EXECUTION_BUSY',
  EXECUTION_CLOSED: 'SIDE_CAR_EXECUTION_CLOSED',
  EXECUTION_CLOSING: 'SIDE_CAR_EXECUTION_CLOSING',
  EXECUTION_EXISTS: 'SIDE_CAR_EXECUTION_EXISTS',
  ROUTE_NOT_ALLOWED: 'SIDE_CAR_ROUTE_NOT_ALLOWED',
  LIMIT_EXCEEDED: 'SIDE_CAR_LIMIT_EXCEEDED',
  PROTOCOL_UNSUPPORTED: 'AGENT_PROTOCOL_UNSUPPORTED',
  HANDSHAKE_FAILED: 'AGENT_HANDSHAKE_FAILED',
  INTERNAL: 'SIDE_CAR_INTERNAL_ERROR',
});

const SIDE_CAR_LIMITS = Object.freeze({
  DISPATCH_TOKEN_TTL_MS: 2 * 60 * 1000,
  PROXY_TOKEN_TTL_MS: 10 * 60 * 1000,
  TOKEN_REPLAY_WINDOW_MS: 5 * 60 * 1000,
  MAX_EXECUTION_INPUT_BYTES,
  MAX_CHAT_REQUEST_BYTES: 2 * 1024 * 1024,
  MAX_RESULT_BYTES,
  MAX_CALLS_DEFAULT,
  MAX_CALLS_HARD_LIMIT: 128,
  MAX_TASK_SPEC_ID_LENGTH: 128,
  MAX_MANIFEST_HASH_LENGTH: 128,
  MAX_WORKSPACE_ID_LENGTH: 128,
  MAX_EXECUTION_ID_LENGTH: 128,
  MAX_TOKEN_ID_LENGTH: 64,
  MAX_EXECUTION_TOKEN_LENGTH,
  MAX_PATH_LENGTH: 160,
  MAX_STRING_LENGTH: 2048,
  MAX_CALLBACK_EVENT_LENGTH: 128,
  MAX_CALLBACK_RETRIES: 16,
  MAX_HEADER_FIELD_LENGTH: 512,
  MAX_QUEUE_BYTES: 4 * 1024 * 1024,
});

function createSidecarError(message, code, { statusCode = 400, retryable = false } = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.retryable = Boolean(retryable);
  return error;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertPlainObject(value, label) {
  if (!isObject(value)) {
    throw createSidecarError(`${label} 必须是对象`, SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
  }
  return value;
}

function assertAllowedFields(value, label, allowedFields) {
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) {
      throw createSidecarError(`字段不允许：${label}.${key}`, SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
    }
  }
}

function assertString(value, label, { minLength = 1, maxLength = SIDE_CAR_LIMITS.MAX_STRING_LENGTH, allowEmpty = false } = {}) {
  if (typeof value !== 'string') {
    throw createSidecarError(`${label} 必须为字符串`, SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
  }
  const normalized = value.trim();
  if (!allowEmpty && normalized.length === 0) {
    throw createSidecarError(`${label} 不能为空`, SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
  }
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw createSidecarError(`${label} 长度需在 ${minLength} 到 ${maxLength} 之间`, SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
  }
  return normalized;
}

function assertNumber(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw createSidecarError(`${label} 必须为整数`, SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
  }
  if (value < min || value > max) {
    throw createSidecarError(`${label} 不在合法区间`, SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
  }
  return value;
}

function assertBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw createSidecarError(`${label} 必须为布尔值`, SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
  }
  return value;
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw createSidecarError(`${label} 必须为数组`, SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
  }
  return value;
}

function assertSet(value, label, allowedSet) {
  if (!allowedSet.has(value)) {
    throw createSidecarError(`${label} 不合法`, SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
  }
  return value;
}

function assertMessageContent(content) {
  if (typeof content !== 'string') {
    throw createSidecarError('chat message.content 必须为字符串', SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
  }
  if (content.length > 16 * 1024) {
    throw createSidecarError('chat message.content 超过限制', SIDE_CAR_ERROR_CODES.LIMIT_EXCEEDED, { statusCode: 413 });
  }
  return content;
}

function canonicalize(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === undefined) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }
  const keys = Object.keys(value).sort();
  const pairs = keys.map((key) => `"${key}":${canonicalize(value[key])}`);
  return `{${pairs.join(',')}}`;
}

function normalizeTokenType(value, label, expectedType) {
  const normalized = assertString(value, `${label}.tokenType`, { maxLength: 64 });
  if (expectedType !== undefined && normalized !== expectedType) {
    throw createSidecarError(`${label}.tokenType 不匹配`, SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
  }
  return normalized;
}

function normalizeTokenAudience(value, label, expectedAudience) {
  const normalized = assertString(value, `${label}.aud`, { minLength: 4, maxLength: 48 });
  if (expectedAudience !== undefined && normalized !== expectedAudience) {
    throw createSidecarError(`${label}.aud 绑定不匹配`, SIDE_CAR_ERROR_CODES.BINDING_MISMATCH, { statusCode: 401 });
  }
  return normalized;
}

function normalizeTokenId(value, label) {
  return assertString(value, label, {
    minLength: 20,
    maxLength: SIDE_CAR_LIMITS.MAX_TOKEN_ID_LENGTH,
  });
}

function normalizeExecutionId(value) {
  return assertString(value, 'executionId', {
    minLength: 4,
    maxLength: SIDE_CAR_LIMITS.MAX_EXECUTION_ID_LENGTH,
  });
}

function normalizeWorkspaceId(value) {
  return assertString(value, 'workspaceId', {
    minLength: 4,
    maxLength: SIDE_CAR_LIMITS.MAX_WORKSPACE_ID_LENGTH,
  });
}

function normalizeTaskSpecId(value) {
  return assertString(value, 'taskSpecId', {
    minLength: 4,
    maxLength: SIDE_CAR_LIMITS.MAX_TASK_SPEC_ID_LENGTH,
  });
}

function normalizeManifestHash(value) {
  return assertString(value, 'manifestHash', {
    minLength: 8,
    maxLength: SIDE_CAR_LIMITS.MAX_MANIFEST_HASH_LENGTH,
  });
}

function normalizeTokenClaims(value, label) {
  const payload = assertPlainObject(value, label);
  assertAllowedFields(payload, label, new Set([
    'protocol',
    'tokenType',
    'version',
    'aud',
    'jti',
    'issuedAt',
    'expiresAt',
    'singleUse',
    'method',
    'path',
    'workspaceId',
    'workspaceGeneration',
    'executionId',
    'taskSpecId',
    'manifestHash',
    'maxCalls',
    'remainingCalls',
  ]));

  const version = assertNumber(payload.version, `${label}.version`, { min: 1, max: PROTOCOL_VERSION });
  if (version !== PROTOCOL_VERSION) {
    throw createSidecarError('protocol version 不匹配', SIDE_CAR_ERROR_CODES.INVALID_TOKEN, { statusCode: 401 });
  }

  const protocol = assertString(payload.protocol, `${label}.protocol`, { maxLength: 64 });
  if (protocol !== PROTOCOL_NAME) {
    throw createSidecarError('protocol 不匹配', SIDE_CAR_ERROR_CODES.INVALID_TOKEN, { statusCode: 401 });
  }

  const method = assertString(payload.method, `${label}.method`, { maxLength: 16, allowEmpty: false });
  const path = assertString(payload.path, `${label}.path`, { maxLength: SIDE_CAR_LIMITS.MAX_PATH_LENGTH });
  const issuedAt = assertNumber(payload.issuedAt, `${label}.issuedAt`, { min: 1, max: Number.MAX_SAFE_INTEGER });
  const expiresAt = assertNumber(payload.expiresAt, `${label}.expiresAt`, { min: 1, max: Number.MAX_SAFE_INTEGER });
  if (expiresAt <= issuedAt) {
    throw createSidecarError(`${label}.expiresAt 必须晚于 issuedAt`, SIDE_CAR_ERROR_CODES.INVALID_TOKEN, { statusCode: 401 });
  }

  return {
    version,
    protocol,
    tokenType: normalizeTokenType(payload.tokenType, label, undefined),
    aud: payload.aud,
    jti: normalizeTokenId(payload.jti, `${label}.jti`),
    issuedAt,
    expiresAt,
    singleUse: assertBoolean(payload.singleUse, `${label}.singleUse`),
    method,
    path,
    workspaceId: normalizeWorkspaceId(payload.workspaceId),
    workspaceGeneration: assertNumber(payload.workspaceGeneration, `${label}.workspaceGeneration`, { min: 1, max: Number.MAX_SAFE_INTEGER }),
    executionId: normalizeExecutionId(payload.executionId),
    taskSpecId: normalizeTaskSpecId(payload.taskSpecId),
    manifestHash: normalizeManifestHash(payload.manifestHash),
    maxCalls: assertNumber(payload.maxCalls, `${label}.maxCalls`, { min: 1, max: SIDE_CAR_LIMITS.MAX_CALLS_HARD_LIMIT }),
    remainingCalls: assertNumber(payload.remainingCalls, `${label}.remainingCalls`, { min: 0, max: SIDE_CAR_LIMITS.MAX_CALLS_HARD_LIMIT }),
  };
}

function normalizeDispatchTokenClaims(value) {
  const claims = normalizeTokenClaims(value, 'dispatch token claims');
  normalizeTokenAudience(claims.aud, 'dispatch token claims', TOKEN_AUDIENCE.RUNNER);
  normalizeTokenType(claims.tokenType, 'dispatch token claims', TOKEN_TYPES.DISPATCH);
  return claims;
}

function normalizeProxyTokenClaims(value) {
  const claims = normalizeTokenClaims(value, 'proxy token claims');
  normalizeTokenAudience(claims.aud, 'proxy token claims', TOKEN_AUDIENCE.LISTENER);
  normalizeTokenType(claims.tokenType, 'proxy token claims', TOKEN_TYPES.PROXY);
  return claims;
}

function normalizeHandshakeClaims(value) {
  const payload = assertPlainObject(value, 'handshake claims');
  assertAllowedFields(payload, 'handshake claims', new Set([
    'protocol',
    'tokenType',
    'version',
    'aud',
    'jti',
    'issuedAt',
    'expiresAt',
    'challenge',
    'policyHash',
  ]));
  const version = assertNumber(payload.version, 'handshake claims.version', { min: 1, max: PROTOCOL_VERSION });
  const protocol = assertString(payload.protocol, 'handshake claims.protocol', { maxLength: 64 });
  const tokenType = normalizeTokenType(payload.tokenType, 'handshake claims', TOKEN_TYPES.HANDSHAKE);
  const aud = normalizeTokenAudience(payload.aud, 'handshake claims', TOKEN_AUDIENCE.WEB);
  const issuedAt = assertNumber(payload.issuedAt, 'handshake claims.issuedAt', { min: 1, max: Number.MAX_SAFE_INTEGER });
  const expiresAt = assertNumber(payload.expiresAt, 'handshake claims.expiresAt', { min: 1, max: Number.MAX_SAFE_INTEGER });
  if (expiresAt <= issuedAt) {
    throw createSidecarError('handshake claims.expiresAt 必须晚于 issuedAt', SIDE_CAR_ERROR_CODES.INVALID_TOKEN, { statusCode: 401 });
  }
  if (protocol !== PROTOCOL_NAME || version !== PROTOCOL_VERSION) {
    throw createSidecarError('handshake protocol 不匹配', SIDE_CAR_ERROR_CODES.INVALID_TOKEN, { statusCode: 401 });
  }
  return Object.freeze({
    protocol,
    tokenType,
    version,
    aud,
    jti: normalizeTokenId(payload.jti, 'handshake claims.jti'),
    issuedAt,
    expiresAt,
    challenge: assertString(payload.challenge, 'handshake claims.challenge', { maxLength: 256 }),
    policyHash: assertString(payload.policyHash, 'handshake claims.policyHash', { maxLength: 128 }),
  });
}

function normalizeExecutionEnvelope(value) {
  const envelope = assertPlainObject(value, 'execution envelope');
  assertAllowedFields(envelope, 'execution envelope', new Set([
    'executionId',
    'workspaceId',
    'workspaceGeneration',
    'taskSpecId',
    'manifestHash',
    'input',
    'requestModel',
    'resultFileName',
    'resultMaxBytes',
    'proxyMaxCalls',
    'callback',
    'agentListenerUrl',
    'proxyToken',
    'capabilityToken',
    'cancelToken',
    'statusToken',
    'inputFiles',
    'prompt',
    'timeoutMs',
    'inputChecksum',
    'inputSizeBytes',
    'expiresAt',
  ]));

  const input = envelope.input !== undefined ? envelope.input : {};
  if (!isObject(input)) {
    throw createSidecarError('execution envelope.input 必须为对象', SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
  }

  const executionId = normalizeExecutionId(envelope.executionId);
  const workspaceId = normalizeWorkspaceId(envelope.workspaceId);
  const workspaceGeneration = assertNumber(envelope.workspaceGeneration, 'execution envelope.workspaceGeneration', { min: 1, max: Number.MAX_SAFE_INTEGER });
  const taskSpecId = normalizeTaskSpecId(envelope.taskSpecId);
  const manifestHash = normalizeManifestHash(envelope.manifestHash);

  const inputMaxBytes = SIDE_CAR_LIMITS.MAX_EXECUTION_INPUT_BYTES;
  const resultMaxBytes = assertNumber(envelope.resultMaxBytes === undefined ? SIDE_CAR_LIMITS.MAX_RESULT_BYTES : envelope.resultMaxBytes, 'execution envelope.resultMaxBytes', {
    min: 1024,
    max: SIDE_CAR_LIMITS.MAX_RESULT_BYTES,
  });

  const proxyMaxCalls = assertNumber(envelope.proxyMaxCalls === undefined ? MAX_CALLS_DEFAULT : envelope.proxyMaxCalls, 'execution envelope.proxyMaxCalls', {
    min: 1,
    max: SIDE_CAR_LIMITS.MAX_CALLS_HARD_LIMIT,
  });

  const callback = envelope.callback === undefined ? { event: '', retries: 0 } : assertPlainObject(envelope.callback, 'execution envelope.callback');
  assertAllowedFields(callback, 'execution envelope.callback', new Set(['event', 'retries']));
  const callbackEvent = assertString(callback.event || '', 'execution envelope.callback.event', {
    allowEmpty: true,
    maxLength: SIDE_CAR_LIMITS.MAX_CALLBACK_EVENT_LENGTH,
  });
  const callbackRetries = assertNumber(callback.retries || 0, 'execution envelope.callback.retries', {
    min: 0,
    max: SIDE_CAR_LIMITS.MAX_CALLBACK_RETRIES,
  });

  const requestModel = assertString(envelope.requestModel || 'default', 'execution envelope.requestModel', {
    allowEmpty: false,
    maxLength: 80,
  });

  let agentListenerUrl = '';
  if (envelope.agentListenerUrl !== undefined) {
    let parsed;
    try {
      parsed = new URL(assertString(envelope.agentListenerUrl, 'execution envelope.agentListenerUrl', { maxLength: 256 }));
    } catch {
      throw createSidecarError('execution envelope.agentListenerUrl 必须是合法 URL', SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw createSidecarError('execution envelope.agentListenerUrl 只允许无凭据的 HTTP(S) URL', SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
    }
    agentListenerUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  }

  const normalizeOptionalToken = (value, label) => value === undefined
    ? ''
    : assertString(value, label, { minLength: 32, maxLength: 4096 });

  const proxyToken = normalizeOptionalToken(envelope.proxyToken, 'execution envelope.proxyToken');
  const capabilityToken = normalizeOptionalToken(envelope.capabilityToken, 'execution envelope.capabilityToken');
  const cancelToken = normalizeOptionalToken(envelope.cancelToken, 'execution envelope.cancelToken');
  const statusToken = normalizeOptionalToken(envelope.statusToken, 'execution envelope.statusToken');

  let inputFiles = {};
  if (envelope.inputFiles !== undefined) {
    if (!isObject(envelope.inputFiles)) {
      throw createSidecarError('execution envelope.inputFiles 必须为对象', SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
    }
    inputFiles = {};
    for (const [relativePath, content] of Object.entries(envelope.inputFiles)) {
      if (typeof content !== 'string' && !Buffer.isBuffer(content)) {
        throw createSidecarError(`execution envelope.inputFiles.${relativePath} 必须为文本`, SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
      }
      inputFiles[relativePath] = Buffer.isBuffer(content) ? content.toString('utf8') : content;
    }
  }

  const prompt = envelope.prompt === undefined
    ? ''
    : assertString(envelope.prompt, 'execution envelope.prompt', { maxLength: 32 * 1024 });
  const timeoutMs = assertNumber(envelope.timeoutMs === undefined ? 10 * 60 * 1000 : envelope.timeoutMs, 'execution envelope.timeoutMs', {
    min: 1_000,
    max: 10 * 60 * 1000,
  });

  const resultFileName = assertString(envelope.resultFileName || 'result.json', 'execution envelope.resultFileName', {
    minLength: 5,
    maxLength: 120,
  });
  if (resultFileName === '.' || resultFileName === '..' || resultFileName.includes('/') || resultFileName.includes('\\') || resultFileName.includes('..')) {
    throw createSidecarError('execution envelope.resultFileName 必须为单层文件名', SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
  }

  const canonicalInput = canonicalize(input);
  const inputSizeBytes = Buffer.byteLength(canonicalInput, 'utf8');
  if (inputSizeBytes > inputMaxBytes) {
    throw createSidecarError('execution input 超过上限', SIDE_CAR_ERROR_CODES.LIMIT_EXCEEDED, { statusCode: 413 });
  }

  return Object.freeze({
    executionId,
    workspaceId,
    workspaceGeneration,
    taskSpecId,
    manifestHash,
    requestModel,
    resultFileName,
    resultMaxBytes,
    proxyMaxCalls,
    callback: { event: callbackEvent, retries: callbackRetries },
    ...(agentListenerUrl ? { agentListenerUrl } : {}),
    ...(proxyToken ? { proxyToken } : {}),
    ...(capabilityToken ? { capabilityToken } : {}),
    ...(cancelToken ? { cancelToken } : {}),
    ...(statusToken ? { statusToken } : {}),
    inputFiles,
    prompt,
    timeoutMs,
    input,
    inputSizeBytes,
    inputChecksum: crypto.createHash('sha256').update(canonicalInput).digest('hex'),
    expiresAt: assertNumber(envelope.expiresAt || Date.now() + 20 * 60 * 1000, 'execution envelope.expiresAt', {
      min: Date.now() - 1,
      max: Date.now() + 24 * 60 * 60 * 1000,
    }),
  });
}

function normalizeCreateExecutionRequest(value) {
  const request = assertPlainObject(value, 'runner create request');
  assertAllowedFields(request, 'runner create request', new Set([
    'executionId',
    'workspaceId',
    'workspaceGeneration',
    'taskSpecId',
    'manifestHash',
    'input',
    'requestModel',
    'resultFileName',
    'resultMaxBytes',
    'proxyMaxCalls',
    'callback',
    'agentListenerUrl',
    'proxyToken',
    'capabilityToken',
    'cancelToken',
    'statusToken',
    'inputFiles',
    'prompt',
    'timeoutMs',
    'expiresAt',
  ]));
  return normalizeExecutionEnvelope(request);
}

function normalizeCancelExecutionRequest(value) {
  const request = assertPlainObject(value, 'runner cancel request');
  assertAllowedFields(request, 'runner cancel request', new Set(['reason', 'cause']));
  return {
    reason: assertString(request.reason || 'user-cancel', 'runner cancel request.reason', { maxLength: 200, allowEmpty: true }),
    cause: request.cause === undefined ? undefined : assertString(request.cause, 'runner cancel request.cause', { maxLength: 200 }),
  };
}

function normalizeChatRequest(value) {
  const request = assertPlainObject(value, 'agent chat request');
  assertAllowedFields(request, 'agent chat request', new Set([
    'executionId',
    'messages',
    'model',
    'temperature',
    'max_tokens',
    'top_p',
    'tools',
    'tool_choice',
    'stream',
    'messagesHash',
  ]));

  const executionId = normalizeExecutionId(request.executionId);
  const messages = assertArray(request.messages, 'agent chat request.messages');
  if (messages.length === 0 || messages.length > 128) {
    throw createSidecarError('messages 长度非法', SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
  }

  const normalizedMessages = messages.map((message, index) => {
    const normalizedMessage = assertPlainObject(message, `agent chat request.messages[${index}]`);
    assertAllowedFields(normalizedMessage, `agent chat message[${index}]`, new Set(['role', 'content', 'tool_calls', 'tool_call_id', 'name']));
    const role = assertString(normalizedMessage.role, `agent chat message[${index}].role`, { maxLength: 16, minLength: 1 });
    const content = normalizedMessage.content === null
      ? null
      : assertMessageContent(assertString(normalizedMessage.content || '', `agent chat message[${index}].content`, { maxLength: 8192 }));
    const toolCalls = normalizedMessage.tool_calls === undefined ? undefined : (() => {
      if (!Array.isArray(normalizedMessage.tool_calls) || normalizedMessage.tool_calls.length > 32) {
        throw createSidecarError(`agent chat message[${index}].tool_calls 数量非法`, SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
      }
      return normalizedMessage.tool_calls;
    })();
    return {
      role,
      content,
      ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
      ...(normalizedMessage.tool_call_id === undefined ? {} : { tool_call_id: assertString(normalizedMessage.tool_call_id, `agent chat message[${index}].tool_call_id`, { maxLength: 128 }) }),
      ...(normalizedMessage.name === undefined ? {} : { name: assertString(normalizedMessage.name, `agent chat message[${index}].name`, { maxLength: 128 }) }),
    };
  });

  const model = assertString(request.model || '', 'agent chat request.model', { allowEmpty: true, maxLength: 80 });
  const temperature = request.temperature === undefined ? undefined : (() => {
    const value = Number(request.temperature);
    if (!Number.isFinite(value) || value < 0 || value > 2) {
      throw createSidecarError('chat request.temperature 必须在 0-2 区间', SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
    }
    return value;
  })();

  const maxTokens = request.max_tokens === undefined ? undefined : assertNumber(request.max_tokens, 'agent chat request.max_tokens', {
    min: 1,
    max: 4096,
  });

  const topP = request.top_p === undefined ? undefined : (() => {
    const value = Number(request.top_p);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw createSidecarError('chat request.top_p 必须在 0-1 区间', SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
    }
    return value;
  })();

  const messagesHash = request.messagesHash === undefined ? undefined : assertString(request.messagesHash, 'agent chat request.messagesHash', {
    minLength: 8,
    maxLength: 128,
  });

  return Object.freeze({
    executionId,
    messages: normalizedMessages,
    model,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    ...(topP !== undefined ? { top_p: topP } : {}),
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    ...(request.tool_choice === undefined ? {} : { tool_choice: request.tool_choice }),
    ...(typeof request.stream === 'boolean' ? { stream: request.stream } : {}),
    ...(messagesHash ? { messagesHash } : {}),
  });
}

function buildRunnerCreatePath() {
  return PROTOCOL_ROUTES.RUNNER_CREATE;
}

function buildRunnerCancelPath(executionId) {
  return `/internal/runner/v1/executions/${encodeURIComponent(String(executionId || '').trim())}`;
}

function buildRunnerStatusPath(executionId) {
  return `/internal/runner/v1/executions/${encodeURIComponent(String(executionId || '').trim())}`;
}

function buildCapabilityPath(executionId) {
  return `/internal/agent/v1/executions/${encodeURIComponent(String(executionId || '').trim())}/capability`;
}

function buildChatPath() {
  return PROTOCOL_ROUTES.AGENT_CHAT;
}

function buildResponsesPath() {
  return PROTOCOL_ROUTES.AGENT_RESPONSES;
}

function parseExecutionTokenBinding(claims) {
  return {
    workspaceId: claims.workspaceId,
    workspaceGeneration: claims.workspaceGeneration,
    executionId: claims.executionId,
    taskSpecId: claims.taskSpecId,
    manifestHash: claims.manifestHash,
  };
}

function isSupportedProtocol(value) {
  return value === PROTOCOL_NAME;
}

function validateExecutionIdentity(expected, actual) {
  return expected.executionId === actual.executionId
    && expected.workspaceId === actual.workspaceId
    && expected.workspaceGeneration === actual.workspaceGeneration
    && expected.taskSpecId === actual.taskSpecId
    && expected.manifestHash === actual.manifestHash;
}

function normalizeBearerToken(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('Bearer ')) return null;
  const token = trimmed.slice(7).trim();
  return token || null;
}

module.exports = {
  PROTOCOL_VERSION,
  PROTOCOL_NAME,
  PROTOCOL_ROUTES,
  PROTOCOL_METHODS,
  TOKEN_TYPES,
  TOKEN_AUDIENCE,
  SIDE_CAR_ERROR_CODES,
  SIDE_CAR_LIMITS,

  createSidecarError,
  canonicalize,
  isSupportedProtocol,
  normalizeTokenClaims,
  normalizeDispatchTokenClaims,
  normalizeProxyTokenClaims,
  normalizeHandshakeClaims,
  normalizeExecutionEnvelope,
  normalizeCreateExecutionRequest,
  normalizeCancelExecutionRequest,
  normalizeChatRequest,
  normalizeBearerToken,
  buildRunnerCreatePath,
  buildRunnerCancelPath,
  buildRunnerStatusPath,
  buildCapabilityPath,
  buildChatPath,
  buildResponsesPath,
  validateExecutionIdentity,
  parseExecutionTokenBinding,
  MAX_CALLS_DEFAULT,
  MAX_RESULT_BYTES,
  MAX_EXECUTION_INPUT_BYTES,
  MAX_EXECUTION_TOKEN_LENGTH,
  PROTOCOL_METHODS,
  PROTOCOL_ROUTES,
};
