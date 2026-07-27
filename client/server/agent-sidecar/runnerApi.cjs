const http = require('node:http');
const { getRunnerPolicyEvidence } = require('../../agent-runner/securityPolicy.cjs');
const { redactSidecarMessage } = require('./errorPolicy.cjs');

const {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  PROTOCOL_METHODS,
  PROTOCOL_ROUTES,
  SIDE_CAR_ERROR_CODES,
  SIDE_CAR_LIMITS,
  createSidecarError,
  normalizeBearerToken,
  buildRunnerCreatePath,
  buildRunnerCancelPath,
} = require('../../shared/contracts/agent-sidecar/sidecarProtocolV1.cjs');

function getAuthorization(headers = {}) {
  return headers.authorization || headers.Authorization || '';
}

function routeNotAllowed(method, path) {
  return createSidecarError(`Runner 路由未开放：${method} ${path}`, SIDE_CAR_ERROR_CODES.ROUTE_NOT_ALLOWED, { statusCode: 404 });
}

function requireBearer(headers) {
  const token = normalizeBearerToken(getAuthorization(headers));
  if (!token) {
    throw createSidecarError('Runner 请求缺少 Bearer token', SIDE_CAR_ERROR_CODES.INVALID_TOKEN, { statusCode: 401 });
  }
  return token;
}

function decodeExecutionIdFromPath(path) {
  const prefix = '/internal/runner/v1/executions/';
  if (!path.startsWith(prefix)) return null;
  const encoded = path.slice(prefix.length);
  if (!encoded || encoded.includes('/')) return null;
  let executionId;
  try {
    executionId = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  if (!executionId || buildRunnerCancelPath(executionId) !== path) return null;
  return executionId;
}

function createRunnerApi({ coordinator, tokenManager = null, policyEvidence = getRunnerPolicyEvidence() }) {
  if (!coordinator || typeof coordinator.createExecution !== 'function' || typeof coordinator.cancelExecution !== 'function') {
    throw new TypeError('Runner API 需要 Sidecar coordinator');
  }

  function handleRequest({ method, path, headers = {}, body = {} } = {}) {
    const normalizedMethod = String(method || '').toUpperCase();
    const normalizedPath = String(path || '');

    if (normalizedMethod === PROTOCOL_METHODS.GET && normalizedPath === PROTOCOL_ROUTES.RUNNER_HEALTH) {
      return {
        statusCode: 200,
        body: {
          protocol: PROTOCOL_NAME,
          version: PROTOCOL_VERSION,
          ready: true,
          activeLimit: 1,
          policyHash: policyEvidence.policyHash,
        },
      };
    }

    if (normalizedMethod === PROTOCOL_METHODS.GET) {
      let parsed;
      try { parsed = new URL(normalizedPath, 'http://runner.internal'); } catch { parsed = null; }
      if (parsed?.pathname === PROTOCOL_ROUTES.RUNNER_HANDSHAKE) {
        const challenge = parsed.searchParams.get('challenge') || '';
        if (!tokenManager || typeof tokenManager.issueHandshakeToken !== 'function' || challenge.length < 16) {
          throw createSidecarError('Runner handshake 未配置或 challenge 无效', SIDE_CAR_ERROR_CODES.HANDSHAKE_FAILED, { statusCode: 503, retryable: true });
        }
        const handshakeToken = tokenManager.issueHandshakeToken({ challenge, policyHash: policyEvidence.policyHash });
        return {
          statusCode: 200,
          body: {
            protocol: PROTOCOL_NAME,
            version: PROTOCOL_VERSION,
            ready: true,
            handshake: { challenge, token: handshakeToken, policyHash: policyEvidence.policyHash },
            policy: policyEvidence,
          },
        };
      }
    }

    if (normalizedMethod === PROTOCOL_METHODS.POST && normalizedPath === buildRunnerCreatePath()) {
      const dispatchToken = requireBearer(headers);
      return {
        statusCode: 201,
        body: coordinator.createExecution(body, dispatchToken),
      };
    }

    if (normalizedMethod === PROTOCOL_METHODS.GET) {
      const executionId = decodeExecutionIdFromPath(normalizedPath);
      if (executionId && typeof coordinator.getExecutionResult === 'function') {
        const statusToken = requireBearer(headers);
        return {
          statusCode: 200,
          body: coordinator.getExecutionResult(executionId, statusToken),
        };
      }
    }

    if (normalizedMethod === PROTOCOL_METHODS.DELETE) {
      const executionId = decodeExecutionIdFromPath(normalizedPath);
      if (executionId) {
        const cancelToken = requireBearer(headers);
        return {
          statusCode: 200,
          body: coordinator.cancelExecution(executionId, cancelToken, body),
        };
      }
    }

    throw routeNotAllowed(normalizedMethod, normalizedPath);
  }

  return Object.freeze({ handleRequest });
}

function jsonResponse(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(payload);
}

function errorBody(error) {
  return {
    error: {
      code: error?.code || 'INTERNAL_ERROR',
      message: redactSidecarMessage(error?.message || 'Sidecar request failed'),
      retryable: Boolean(error?.retryable),
    },
  };
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(createSidecarError('Runner 请求体超过限制', SIDE_CAR_ERROR_CODES.LIMIT_EXCEEDED, { statusCode: 413 }));
      req.resume();
      return;
    }
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(createSidecarError('Runner 请求体超过限制', SIDE_CAR_ERROR_CODES.LIMIT_EXCEEDED, { statusCode: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (total === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(createSidecarError('Runner 请求体必须为 JSON', SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function createRunnerHttpServer({ api, host = '127.0.0.1', port = 0 } = {}) {
  if (!api || typeof api.handleRequest !== 'function') throw new TypeError('Runner HTTP server 需要 Runner API');
  const server = http.createServer(async (req, res) => {
    try {
      const body = req.method === PROTOCOL_METHODS.POST || req.method === PROTOCOL_METHODS.DELETE
        ? await readJsonBody(req, req.method === PROTOCOL_METHODS.POST ? SIDE_CAR_LIMITS.MAX_EXECUTION_INPUT_BYTES : 64 * 1024)
        : {};
      const result = await api.handleRequest({
        method: req.method,
        path: req.url,
        headers: req.headers,
        body,
      });
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
  createRunnerApi,
  createRunnerHttpServer,
  decodeExecutionIdFromPath,
};
