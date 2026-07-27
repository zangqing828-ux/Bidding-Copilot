const crypto = require('node:crypto');

const {
  PROTOCOL_VERSION,
  PROTOCOL_NAME,
  TOKEN_TYPES,
  TOKEN_AUDIENCE,
  PROTOCOL_METHODS,
  PROTOCOL_ROUTES,
  SIDE_CAR_ERROR_CODES,
  SIDE_CAR_LIMITS,
  createSidecarError,
  normalizeDispatchTokenClaims,
  normalizeProxyTokenClaims,
  buildRunnerCancelPath,
  buildCapabilityPath,
  buildChatPath,
} = require('../../shared/contracts/agent-sidecar/sidecarProtocolV1.cjs');

const DEFAULT_SECRET = 'change-me-before-production';

function nowMs() {
  return Date.now();
}

function toBase64Url(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function fromBase64Url(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function randomTokenId() {
  return crypto.randomBytes(Math.ceil(SIDE_CAR_LIMITS.MAX_EXECUTION_TOKEN_LENGTH * 3 / 4)).toString('base64url').slice(0, SIDE_CAR_LIMITS.MAX_EXECUTION_TOKEN_LENGTH);
}

function assertBindingString(value, label) {
  if (typeof value !== 'string') {
    throw createSidecarError(`${label} 必须为字符串`, SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
  }
  const normalized = value.trim();
  if (!normalized) {
    throw createSidecarError(`${label} 不可为空`, SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
  }
  return normalized;
}

function assertKnownProxyBinding({ method, path, executionId }) {
  const expectedPath = method === PROTOCOL_METHODS.POST
    ? buildChatPath()
    : method === PROTOCOL_METHODS.GET
      ? buildCapabilityPath(executionId)
      : method === PROTOCOL_METHODS.DELETE
        ? buildRunnerCancelPath(executionId)
        : null;
  if (!expectedPath || path !== expectedPath) {
    throw createSidecarError('proxy token method/path 不属于已注册 Sidecar 路由', SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
  }
}

function hmac(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function serializeClaims(claims) {
  return JSON.stringify(claims);
}

function parseToken(rawToken, secret) {
  if (typeof rawToken !== 'string' || !rawToken.includes('.')) {
    throw createSidecarError('token 格式不合法', SIDE_CAR_ERROR_CODES.INVALID_TOKEN, { statusCode: 401 });
  }
  const parts = rawToken.split('.');
  if (parts.length !== 2) {
    throw createSidecarError('token 片段数不合法', SIDE_CAR_ERROR_CODES.INVALID_TOKEN, { statusCode: 401 });
  }

  const [payloadPart, signaturePart] = parts;
  const payloadString = fromBase64Url(payloadPart);
  const expectedSignature = hmac(payloadString, secret);
  const actualSignature = signaturePart || '';
  const expectedBuffer = Buffer.from(expectedSignature);
  const actualBuffer = Buffer.from(actualSignature);

  if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
    throw createSidecarError('token 签名不匹配', SIDE_CAR_ERROR_CODES.INVALID_TOKEN, { statusCode: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(payloadString);
  } catch {
    throw createSidecarError('token payload 解码失败', SIDE_CAR_ERROR_CODES.INVALID_TOKEN, { statusCode: 401 });
  }

  return payload;
}

function createToken(payload, secret) {
  const serialized = serializeClaims(payload);
  const signature = hmac(serialized, secret);
  return `${toBase64Url(serialized)}.${signature}`;
}

function createManagerState() {
  return {
    dispatchStates: new Map(), // jti -> { used, expiresAt, executionId, issuedAt }
    proxyStates: new Map(), // jti -> { remainingCalls, executionId, expiresAt, issuedAt }
    revoked: new Map(), // jti -> revokedAt
    executionTokens: new Map(), // executionId -> Set(jti)
  };
}

function createTokenManager({
  secret = process.env.YIBIAO_SIDECAR_SECRET || DEFAULT_SECRET,
  clock = nowMs,
  replayWindowMs = SIDE_CAR_LIMITS.TOKEN_REPLAY_WINDOW_MS,
  cleanupEveryMs = 60 * 1000,
} = {}) {
  const state = createManagerState();
  let cleanupTimer = null;

  function getIssuedTokens() {
    return {
      dispatch: state.dispatchStates.size,
      proxy: state.proxyStates.size,
      revoked: state.revoked.size,
    };
  }

  function now() {
    return clock();
  }

  function ensureCleanupTimer() {
    if (cleanupTimer) return;
    cleanupTimer = setInterval(() => {
      sweepExpired();
    }, cleanupEveryMs);
    cleanupTimer.unref?.();
  }

  function sweepExpired() {
    const nowAt = now();
    for (const [jti, entry] of state.dispatchStates.entries()) {
      if (entry.used && entry.consumedAt + replayWindowMs < nowAt) {
        state.dispatchStates.delete(jti);
        continue;
      }
      if (entry.expiresAt < nowAt - replayWindowMs) {
        state.dispatchStates.delete(jti);
        state.revoked.delete(jti);
      }
    }
    for (const [jti, entry] of state.proxyStates.entries()) {
      if (entry.expiresAt < nowAt - replayWindowMs) {
        state.proxyStates.delete(jti);
        state.revoked.delete(jti);
      }
    }
    for (const [executionId, tokens] of state.executionTokens.entries()) {
      if (tokens.size === 0) {
        state.executionTokens.delete(executionId);
      }
    }
  }

  function isExpired(claims) {
    if (typeof claims.expiresAt !== 'number' || claims.expiresAt <= now()) {
      return true;
    }
    return false;
  }

  function ensureNotExpired(claims) {
    if (isExpired(claims)) {
      throw createSidecarError('token 已过期', SIDE_CAR_ERROR_CODES.TOKEN_EXPIRED, { statusCode: 401 });
    }
  }

  function ensureNotRevoked(jti) {
    if (state.revoked.has(jti)) {
      throw createSidecarError('token 已撤销', SIDE_CAR_ERROR_CODES.TOKEN_REVOKED, { statusCode: 401 });
    }
  }

  function trackExecutionToken(executionId, jti) {
    if (!state.executionTokens.has(executionId)) {
      state.executionTokens.set(executionId, new Set());
    }
    state.executionTokens.get(executionId).add(jti);
  }

  function issueDispatchToken({
    workspaceId,
    workspaceGeneration,
    executionId,
    taskSpecId,
    manifestHash,
  }) {
    const claims = {
      protocol: PROTOCOL_NAME,
      version: PROTOCOL_VERSION,
      tokenType: TOKEN_TYPES.DISPATCH,
      aud: TOKEN_AUDIENCE.RUNNER,
      jti: randomTokenId(),
      issuedAt: now(),
      expiresAt: now() + SIDE_CAR_LIMITS.DISPATCH_TOKEN_TTL_MS,
      singleUse: true,
      method: PROTOCOL_METHODS.POST,
      path: PROTOCOL_ROUTES.RUNNER_CREATE,
      workspaceId,
      workspaceGeneration,
      executionId,
      taskSpecId,
      manifestHash,
      maxCalls: 1,
      remainingCalls: 1,
    };
    const normalized = normalizeDispatchTokenClaims(claims);
    const token = createToken(normalized, secret);
    state.dispatchStates.set(normalized.jti, {
      used: false,
      issuedAt: normalized.issuedAt,
      consumedAt: 0,
      expiresAt: normalized.expiresAt,
      executionId: normalized.executionId,
      workspaceId: normalized.workspaceId,
    });
    trackExecutionToken(normalized.executionId, normalized.jti);
    ensureCleanupTimer();
    return token;
  }

  function issueProxyToken({
    workspaceId,
    workspaceGeneration,
    executionId,
    taskSpecId,
    manifestHash,
    method,
    path,
    maxCalls,
  }) {
    const normalizedMethod = assertBindingString(method, 'proxy token binding method');
    const normalizedPath = assertBindingString(path, 'proxy token binding path');
    const tokenMaxCalls = Math.max(1, Math.min(
      maxCalls === undefined ? MAX_CALLS_DEFAULT : maxCalls,
      SIDE_CAR_LIMITS.MAX_CALLS_HARD_LIMIT,
    ));
    assertKnownProxyBinding({ method: normalizedMethod, path: normalizedPath, executionId });
    const issuedAt = now();
    const claims = {
      protocol: PROTOCOL_NAME,
      version: PROTOCOL_VERSION,
      tokenType: TOKEN_TYPES.PROXY,
      aud: TOKEN_AUDIENCE.LISTENER,
      jti: randomTokenId(),
      issuedAt,
      expiresAt: issuedAt + SIDE_CAR_LIMITS.PROXY_TOKEN_TTL_MS,
      singleUse: false,
      method: normalizedMethod,
      path: normalizedPath,
      workspaceId,
      workspaceGeneration,
      executionId,
      taskSpecId,
      manifestHash,
      maxCalls: tokenMaxCalls,
      remainingCalls: tokenMaxCalls,
    };
    const normalized = normalizeProxyTokenClaims(claims);
    const token = createToken(normalized, secret);
    state.proxyStates.set(normalized.jti, {
      remainingCalls: normalized.maxCalls,
      issuedAt,
      consumedAt: 0,
      expiresAt: normalized.expiresAt,
      executionId: normalized.executionId,
      workspaceId: normalized.workspaceId,
    });
    trackExecutionToken(normalized.executionId, normalized.jti);
    ensureCleanupTimer();
    return token;
  }

  function revokeJti(jti) {
    state.revoked.set(jti, now());
  }

  function revokeToken(rawToken) {
    const parsed = parseToken(rawToken, secret);
    const claims = (parsed.tokenType === TOKEN_TYPES.DISPATCH)
      ? normalizeDispatchTokenClaims(parsed)
      : normalizeProxyTokenClaims(parsed);
    revokeJti(claims.jti);
  }

  function revokeExecutionTokens(executionId) {
    const tokenSet = state.executionTokens.get(executionId);
    if (!tokenSet) return;
    for (const jti of tokenSet) {
      revokeJti(jti);
    }
  }

  function verifyBinding({
    claims,
    tokenType,
    expectedMethod,
    expectedPath,
    workspaceId,
    workspaceGeneration,
    executionId,
    taskSpecId,
    manifestHash,
    maxReplayMs,
    allowRevoked = false,
  } = {}) {
    if (tokenType === TOKEN_TYPES.DISPATCH) {
      claims = normalizeDispatchTokenClaims(claims);
    } else {
      claims = normalizeProxyTokenClaims(claims);
    }

    if (expectedMethod && claims.method !== expectedMethod) {
      throw createSidecarError('token method 绑定不匹配', SIDE_CAR_ERROR_CODES.BINDING_MISMATCH, { statusCode: 401 });
    }

    if (expectedPath && claims.path !== expectedPath) {
      throw createSidecarError('token path 绑定不匹配', SIDE_CAR_ERROR_CODES.BINDING_MISMATCH, { statusCode: 401 });
    }

    if (workspaceId && claims.workspaceId !== workspaceId) {
      throw createSidecarError('token workspaceId 绑定不匹配', SIDE_CAR_ERROR_CODES.BINDING_MISMATCH, { statusCode: 401 });
    }

    if (workspaceGeneration !== undefined && claims.workspaceGeneration !== workspaceGeneration) {
      throw createSidecarError('token workspaceGeneration 绑定不匹配', SIDE_CAR_ERROR_CODES.BINDING_MISMATCH, { statusCode: 401 });
    }

    if (executionId && claims.executionId !== executionId) {
      throw createSidecarError('token executionId 绑定不匹配', SIDE_CAR_ERROR_CODES.BINDING_MISMATCH, { statusCode: 401 });
    }

    if (taskSpecId && claims.taskSpecId !== taskSpecId) {
      throw createSidecarError('token taskSpecId 绑定不匹配', SIDE_CAR_ERROR_CODES.BINDING_MISMATCH, { statusCode: 401 });
    }

    if (manifestHash && claims.manifestHash !== manifestHash) {
      throw createSidecarError('token manifestHash 绑定不匹配', SIDE_CAR_ERROR_CODES.BINDING_MISMATCH, { statusCode: 401 });
    }

    if (claims.aud !== (tokenType === TOKEN_TYPES.DISPATCH ? TOKEN_AUDIENCE.RUNNER : TOKEN_AUDIENCE.LISTENER)) {
      throw createSidecarError('token audience 绑定不匹配', SIDE_CAR_ERROR_CODES.BINDING_MISMATCH, { statusCode: 401 });
    }

    ensureNotExpired(claims);
    if (maxReplayMs && claims.expiresAt + maxReplayMs < now()) {
      throw createSidecarError('token 已过期', SIDE_CAR_ERROR_CODES.TOKEN_EXPIRED, { statusCode: 401 });
    }

    if (!allowRevoked) {
      ensureNotRevoked(claims.jti);
    }

    if (tokenType === TOKEN_TYPES.DISPATCH) {
      const stateEntry = state.dispatchStates.get(claims.jti);
      if (!stateEntry) {
        throw createSidecarError('token 未注册或已过期', SIDE_CAR_ERROR_CODES.INVALID_TOKEN, { statusCode: 401 });
      }
      if (stateEntry.used) {
        const replayWindowExpired = stateEntry.consumedAt + replayWindowMs < now();
        throw createSidecarError(replayWindowExpired ? 'token 已过期' : 'token 可能被重放',
          replayWindowExpired ? SIDE_CAR_ERROR_CODES.TOKEN_EXPIRED : SIDE_CAR_ERROR_CODES.TOKEN_REPLAY,
          { statusCode: 401 });
      }
      if (claims.singleUse !== true) {
        throw createSidecarError('dispatch token 的 singleUse 非法', SIDE_CAR_ERROR_CODES.INVALID_TOKEN, { statusCode: 401 });
      }
      stateEntry.used = true;
      stateEntry.consumedAt = now();
      return { claims, stateEntry };
    }

    const proxyStateEntry = state.proxyStates.get(claims.jti);
    if (!proxyStateEntry) {
      throw createSidecarError('token 未注册或已过期', SIDE_CAR_ERROR_CODES.INVALID_TOKEN, { statusCode: 401 });
    }
    return { claims, stateEntry: proxyStateEntry };
  }

  function verifyDispatchToken(rawToken, options = {}) {
    try {
      const parsed = parseToken(rawToken, secret);
      const result = verifyBinding({
        claims: parsed,
        tokenType: TOKEN_TYPES.DISPATCH,
        expectedMethod: PROTOCOL_METHODS.POST,
        expectedPath: PROTOCOL_ROUTES.RUNNER_CREATE,
        ...options,
        maxReplayMs: replayWindowMs,
      });
      return result.claims;
    } catch (error) {
      throw error;
    }
  }

  function verifyProxyToken(rawToken, options = {}) {
    if (!options.expectedMethod || !options.expectedPath) {
      throw createSidecarError('proxy token 校验必须提供精确 method/path', SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
    }
    const parsed = parseToken(rawToken, secret);
    const result = verifyBinding({ claims: parsed, tokenType: TOKEN_TYPES.PROXY, ...options, maxReplayMs: replayWindowMs });
    return result.claims;
  }

  function verifyRevokedProxyToken(rawToken, options = {}) {
    if (!options.expectedMethod || !options.expectedPath) {
      throw createSidecarError('proxy token 校验必须提供精确 method/path', SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
    }
    const parsed = parseToken(rawToken, secret);
    const result = verifyBinding({
      claims: parsed,
      tokenType: TOKEN_TYPES.PROXY,
      ...options,
      allowRevoked: true,
      maxReplayMs: replayWindowMs,
    });
    return result.claims;
  }

  function consumeProxyCall(rawToken, options) {
    if (!options?.expectedMethod || !options?.expectedPath) {
      throw createSidecarError('proxy token 消费必须提供精确 method/path', SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
    }
    const parsed = parseToken(rawToken, secret);
    const result = verifyBinding({ claims: parsed, tokenType: TOKEN_TYPES.PROXY, ...options, maxReplayMs: replayWindowMs });
    const stateEntry = state.proxyStates.get(result.claims.jti);
    if (stateEntry.remainingCalls <= 0) {
      throw createSidecarError('token 调用已用尽', SIDE_CAR_ERROR_CODES.LIMIT_EXCEEDED, { statusCode: 429 });
    }
    stateEntry.remainingCalls -= 1;
    stateEntry.consumedAt = now();
    return { claims: result.claims, remainingCalls: stateEntry.remainingCalls };
  }

  function remainingCalls(rawToken) {
    const parsed = parseToken(rawToken, secret);
    const claims = normalizeProxyTokenClaims(parsed);
    ensureNotExpired(claims);
    if (claims.aud !== TOKEN_AUDIENCE.LISTENER) {
      return 0;
    }
    const entry = state.proxyStates.get(claims.jti);
    if (!entry) return 0;
    return entry.remainingCalls;
  }

  function close() {
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }

  return {
    issueDispatchToken,
    issueProxyToken,
    verifyDispatchToken,
    verifyProxyToken,
    verifyRevokedProxyToken,
    consumeProxyCall,
    remainingCalls,
    revokeToken,
    revokeExecutionTokens,
    getIssuedTokens,
    sweepExpired,
    close,
  };
}

module.exports = {
  createTokenManager,
};
