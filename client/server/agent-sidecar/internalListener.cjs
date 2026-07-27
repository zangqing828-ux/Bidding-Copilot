const http = require('node:http');

const {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  PROTOCOL_METHODS,
  PROTOCOL_ROUTES,
  SIDE_CAR_ERROR_CODES,
  SIDE_CAR_LIMITS,
  createSidecarError,
  normalizeBearerToken,
  normalizeChatRequest,
  normalizeExecutionEnvelope,
  buildChatPath,
  buildResponsesPath,
  buildCapabilityPath,
  buildRunnerCancelPath,
  buildRunnerStatusPath,
  MAX_CALLS_DEFAULT,
} = require('../../shared/contracts/agent-sidecar/sidecarProtocolV1.cjs');
const { responsesToChatRequest, writeResponsesSse } = require('../agent/agentOpenAiProxy.cjs');
const { redactSidecarMessage } = require('./errorPolicy.cjs');

function routeNotAllowed(method, path) {
  return createSidecarError(`Agent internal 路由未开放：${method} ${path}`, SIDE_CAR_ERROR_CODES.ROUTE_NOT_ALLOWED, { statusCode: 404 });
}

function requireBearer(headers = {}) {
  const token = normalizeBearerToken(headers.authorization || headers.Authorization || '');
  if (!token) {
    throw createSidecarError('Agent internal 请求缺少 Bearer token', SIDE_CAR_ERROR_CODES.INVALID_TOKEN, { statusCode: 401 });
  }
  return token;
}

function decodeExecutionIdFromPath(path) {
  const prefix = '/internal/agent/v1/executions/';
  const suffix = '/capability';
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return null;
  const encoded = path.slice(prefix.length, -suffix.length);
  if (!encoded || encoded.includes('/')) return null;
  let executionId;
  try {
    executionId = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  if (!executionId || buildCapabilityPath(executionId) !== path) return null;
  return executionId;
}

function assertBoundedJson(value, maxBytes, label) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw createSidecarError(`${label} 无法序列化`, SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
  }
  if (Buffer.byteLength(serialized || '', 'utf8') > maxBytes) {
    throw createSidecarError(`${label} 超过限制`, SIDE_CAR_ERROR_CODES.LIMIT_EXCEEDED, { statusCode: 413 });
  }
  return value;
}

function createInternalAgentApi({ coordinator = null, tokenManager = null, chatHandler = async () => ({}) } = {}) {
  if (!coordinator && !tokenManager) {
    throw new TypeError('Agent internal API 需要 Sidecar coordinator 或 tokenManager');
  }
  if (typeof chatHandler !== 'function') throw new TypeError('Agent internal API chatHandler 必须为函数');

  function issueExecutionTokens(rawEnvelope) {
    if (!tokenManager || typeof tokenManager.issueProxyToken !== 'function') {
      throw createSidecarError('Agent internal listener 未配置 token issuer', SIDE_CAR_ERROR_CODES.INTERNAL, { statusCode: 503, retryable: true });
    }
    const envelope = normalizeExecutionEnvelope(rawEnvelope);
    const issue = (method, path, maxCalls) => tokenManager.issueProxyToken({
      workspaceId: envelope.workspaceId,
      workspaceGeneration: envelope.workspaceGeneration,
      executionId: envelope.executionId,
      taskSpecId: envelope.taskSpecId,
      manifestHash: envelope.manifestHash,
      method,
      path,
      maxCalls,
    });
    return Object.freeze({
      proxyToken: issue(PROTOCOL_METHODS.POST, buildChatPath(), envelope.proxyMaxCalls || MAX_CALLS_DEFAULT),
      capabilityToken: issue(PROTOCOL_METHODS.GET, buildCapabilityPath(envelope.executionId), MAX_CALLS_DEFAULT),
      cancelToken: issue(PROTOCOL_METHODS.DELETE, buildRunnerCancelPath(envelope.executionId), 8),
      statusToken: issue(PROTOCOL_METHODS.GET, buildRunnerStatusPath(envelope.executionId), 16),
    });
  }

  function getCapability(executionId, capabilityToken) {
    if (coordinator?.getCapability) return coordinator.getCapability(executionId, capabilityToken);
    const claims = tokenManager.verifyProxyToken(capabilityToken, {
      executionId,
      expectedMethod: PROTOCOL_METHODS.GET,
      expectedPath: buildCapabilityPath(executionId),
    });
    return {
      executionId: claims.executionId,
      taskSpecId: claims.taskSpecId,
      manifestHash: claims.manifestHash,
      maxCalls: claims.maxCalls,
      remainingCalls: tokenManager.remainingCalls(capabilityToken),
      status: 'accepted',
      expiresAt: claims.expiresAt,
    };
  }

  function consumeChat(proxyToken, body, requestPath = buildChatPath()) {
    const isResponses = requestPath === buildResponsesPath();
    if (coordinator?.consumeCall) {
      const executionId = body?.executionId;
      const translated = isResponses ? { ...responsesToChatRequest(body || {}), executionId } : body;
      return coordinator.consumeCall(proxyToken, executionId, translated);
    }
    const claims = tokenManager.verifyProxyToken(proxyToken, {
      executionId: undefined,
      expectedMethod: PROTOCOL_METHODS.POST,
      expectedPath: buildChatPath(),
    });
    const translated = isResponses
      ? { ...responsesToChatRequest(body || {}), executionId: claims.executionId }
      : body;
    const request = normalizeChatRequest(translated || {});
    const result = tokenManager.consumeProxyCall(proxyToken, {
      executionId: request.executionId,
      expectedMethod: PROTOCOL_METHODS.POST,
      expectedPath: buildChatPath(),
    });
    if (result.claims.executionId !== request.executionId) {
      throw createSidecarError('chat executionId 与 proxy token 不一致', SIDE_CAR_ERROR_CODES.BINDING_MISMATCH, { statusCode: 401 });
    }
    return request;
  }

  async function handleRequest({ method, path, headers = {}, body = {} } = {}) {
    const normalizedMethod = String(method || '').toUpperCase();
    const normalizedPath = String(path || '');

    if (normalizedMethod === PROTOCOL_METHODS.GET && normalizedPath === PROTOCOL_ROUTES.AGENT_LISTENER_HEALTH) {
      return {
        statusCode: 200,
        body: { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, ready: true },
      };
    }

    if (normalizedMethod === PROTOCOL_METHODS.GET) {
      const executionId = decodeExecutionIdFromPath(normalizedPath);
      if (executionId) {
        const capabilityToken = requireBearer(headers);
        return { statusCode: 200, body: getCapability(executionId, capabilityToken) };
      }
    }

    if (normalizedMethod === PROTOCOL_METHODS.POST && [buildChatPath(), buildResponsesPath()].includes(normalizedPath)) {
      const proxyToken = requireBearer(headers);
      const acceptedRequest = consumeChat(proxyToken, body, normalizedPath);
      const result = await chatHandler(acceptedRequest, { executionId: acceptedRequest.executionId });
      return {
        statusCode: 200,
        body: assertBoundedJson(result, SIDE_CAR_LIMITS.MAX_RESULT_BYTES, 'Agent chat result'),
        ...(normalizedPath === buildResponsesPath() ? { streamResponse: true } : {}),
      };
    }

    throw routeNotAllowed(normalizedMethod, normalizedPath);
  }

  return Object.freeze({ handleRequest, issueExecutionTokens });
}

function jsonResponse(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function errorBody(error) {
  return {
    error: {
      code: error?.code || 'INTERNAL_ERROR',
      message: redactSidecarMessage(error?.message || 'Agent internal request failed'),
      retryable: Boolean(error?.retryable),
    },
  };
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(createSidecarError('Agent internal 请求体超过限制', SIDE_CAR_ERROR_CODES.LIMIT_EXCEEDED, { statusCode: 413 }));
      req.resume();
      return;
    }
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(createSidecarError('Agent internal 请求体超过限制', SIDE_CAR_ERROR_CODES.LIMIT_EXCEEDED, { statusCode: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (total === 0) return resolve({});
      try {
        return resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        return reject(createSidecarError('Agent internal 请求体必须为 JSON', SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function createInternalAgentHttpServer({ api, host = '127.0.0.1', port = 0 } = {}) {
  if (!api || typeof api.handleRequest !== 'function') throw new TypeError('Agent internal HTTP server 需要 API');
  const server = http.createServer(async (req, res) => {
    try {
      const body = req.method === PROTOCOL_METHODS.POST ? await readJsonBody(req, SIDE_CAR_LIMITS.MAX_CHAT_REQUEST_BYTES) : {};
      const result = await api.handleRequest({ method: req.method, path: req.url, headers: req.headers, body });
      if (result.streamResponse) {
        writeResponsesSse(res, result.body);
        return;
      }
      jsonResponse(res, result.statusCode || 200, result.body);
    } catch (error) {
      jsonResponse(res, error.statusCode || 500, errorBody(error));
    }
  });
  return Object.freeze({
    server,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve(server.address());
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  });
}

module.exports = {
  createInternalAgentApi,
  createInternalAgentHttpServer,
  decodeExecutionIdFromPath,
};
