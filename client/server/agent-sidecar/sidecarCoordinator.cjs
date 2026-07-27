const {
  createTokenManager,
} = require('./tokenService.cjs');
const {
  SIDE_CAR_ERROR_CODES,
  createSidecarError,
  normalizeCreateExecutionRequest,
  normalizeCancelExecutionRequest,
  normalizeChatRequest,
  buildRunnerCancelPath,
  buildRunnerStatusPath,
  buildRunnerCreatePath,
  buildCapabilityPath,
  buildChatPath,
  MAX_CALLS_DEFAULT,
  MAX_RESULT_BYTES,
  SIDE_CAR_LIMITS,
  PROTOCOL_METHODS,
} = require('../../shared/contracts/agent-sidecar/sidecarProtocolV1.cjs');
const { redactSidecarMessage } = require('./errorPolicy.cjs');

const GLOBAL_ACTIVE_LIMIT = 1;

function redactFailureMessage(value) {
  return redactSidecarMessage(value || 'Agent execution failed');
}

function sameExecutionEnvelope(execution, envelope) {
  return execution.workspaceId === envelope.workspaceId
    && execution.workspaceGeneration === envelope.workspaceGeneration
    && execution.taskSpecId === envelope.taskSpecId
    && execution.manifestHash === envelope.manifestHash
    && execution.inputChecksum === envelope.inputChecksum
    && execution.inputSizeBytes === envelope.inputSizeBytes
    && execution.requestModel === envelope.requestModel
    && execution.resultFileName === envelope.resultFileName
    && execution.resultMaxBytes === envelope.resultMaxBytes
    && execution.proxyMaxCalls === envelope.proxyMaxCalls;
}

function createSidecarCoordinator({
  executionTtlMs = 20 * 60 * 1000,
  maxResultBytes = MAX_RESULT_BYTES,
  tokenManager = createTokenManager(),
  clock = () => Date.now(),
  executionRunner = null,
} = {}) {
  const executions = new Map();
  const activeExecutionOrder = [];

  function releaseActiveExecution(executionId) {
    const index = activeExecutionOrder.indexOf(executionId);
    if (index >= 0) activeExecutionOrder.splice(index, 1);
  }

  function revokeTerminalTokens(execution) {
    const keepJtis = [];
    try {
      const statusClaims = tokenManager.parseToken(execution.statusToken);
      if (statusClaims?.jti) keepJtis.push(statusClaims.jti);
    } catch {}
    if (typeof tokenManager.revokeExecutionTokensExcept === 'function') {
      tokenManager.revokeExecutionTokensExcept(execution.executionId, keepJtis);
      return;
    }
    tokenManager.revokeExecutionTokens(execution.executionId);
  }

  function assertLimit() {
    const active = activeExecutionOrder.length;
    if (active >= GLOBAL_ACTIVE_LIMIT) {
      const error = createSidecarError('当前仅允许 1 个并发 execution', SIDE_CAR_ERROR_CODES.EXECUTION_BUSY, { statusCode: 429 });
      error.retryAfterSeconds = 5;
      error.retryable = true;
      throw error;
    }
  }

  function touch(executionId) {
    const execution = executions.get(executionId);
    if (!execution) return null;
    execution.lastAccessedAt = clock();
    return execution;
  }

  function listExecutionStatus(executionId) {
    const execution = touch(executionId);
    if (!execution) return null;
    return {
      executionId: execution.executionId,
      workspaceId: execution.workspaceId,
      workspaceGeneration: execution.workspaceGeneration,
      taskSpecId: execution.taskSpecId,
      manifestHash: execution.manifestHash,
      status: execution.status,
      createdAt: execution.createdAt,
      updatedAt: execution.updatedAt,
      expiresAt: execution.expiresAt,
      result: execution.result,
      resultHash: execution.resultHash,
      failure: execution.failure,
      resultMaxBytes: execution.resultMaxBytes,
      inputSizeBytes: execution.inputSizeBytes,
      callBudget: {
        maxCalls: execution.proxyMaxCalls,
        remainingCalls: execution.proxyRemainingCalls,
      },
    };
  }

  function sweepExpiredExecutions() {
    const now = clock();
    for (const [executionId, execution] of executions.entries()) {
      if (execution.expiresAt <= now && execution.status !== 'expired') {
        execution.status = 'expired';
        execution.closedAt = now;
      }
      if (execution.status === 'expired' && execution.closedAt + 15_000 < now) {
        releaseActiveExecution(executionId);
        executions.delete(executionId);
        tokenManager.revokeExecutionTokens(executionId);
      }
    }
  }

  function createExecution(rawRequest, rawToken) {
    sweepExpiredExecutions();
    const envelope = normalizeCreateExecutionRequest(rawRequest);
    const claims = tokenManager.verifyDispatchToken(rawToken, {
      workspaceId: envelope.workspaceId,
      workspaceGeneration: envelope.workspaceGeneration,
      executionId: envelope.executionId,
      taskSpecId: envelope.taskSpecId,
      manifestHash: envelope.manifestHash,
      expectedMethod: PROTOCOL_METHODS.POST,
      expectedPath: buildRunnerCreatePath(),
    });

    if (claims.expiresAt <= clock()) {
      throw createSidecarError('dispatch token 已过期', SIDE_CAR_ERROR_CODES.TOKEN_EXPIRED, { statusCode: 401 });
    }

    const existing = executions.get(envelope.executionId);
    if (existing) {
      if (sameExecutionEnvelope(existing, envelope)) {
        return {
          executionId: existing.executionId,
          status: existing.status,
          createdAt: existing.createdAt,
          expiresAt: existing.expiresAt,
          cancelToken: existing.cancelToken,
          capabilityToken: existing.capabilityToken,
          proxyToken: existing.proxyToken,
          statusToken: existing.statusToken,
          statusPath: buildRunnerStatusPath(existing.executionId),
          capabilityPath: buildCapabilityPath(existing.executionId),
          chatPath: buildChatPath(),
          created: false,
        };
      }
      throw createSidecarError('executionId 已存在但绑定不一致', SIDE_CAR_ERROR_CODES.EXECUTION_CONFLICT, { statusCode: 409 });
    }

    assertLimit();

    if (tokenManager.isStatelessProxy === true && (!envelope.proxyToken || !envelope.capabilityToken || !envelope.cancelToken || !envelope.statusToken)) {
      throw createSidecarError('Runner 必须接收 Web internal listener 签发的完整 proxy capability', 'AGENT_PROXY_UNAVAILABLE', { statusCode: 401, retryable: true });
    }

    const issuedProxyToken = envelope.proxyToken ? '' : tokenManager.issueProxyToken({
      workspaceId: envelope.workspaceId,
      workspaceGeneration: envelope.workspaceGeneration,
      executionId: envelope.executionId,
      taskSpecId: envelope.taskSpecId,
      manifestHash: envelope.manifestHash,
      method: PROTOCOL_METHODS.POST,
      path: buildChatPath(),
      maxCalls: envelope.proxyMaxCalls || MAX_CALLS_DEFAULT,
    });
    const now = clock();
    const proxyTokenClaims = issuedProxyToken ? tokenManager.verifyProxyToken(issuedProxyToken, {
      workspaceId: envelope.workspaceId,
      workspaceGeneration: envelope.workspaceGeneration,
      executionId: envelope.executionId,
      taskSpecId: envelope.taskSpecId,
      manifestHash: envelope.manifestHash,
      expectedMethod: PROTOCOL_METHODS.POST,
      expectedPath: buildChatPath(),
    }) : null;
    const issuedCapabilityToken = envelope.capabilityToken ? '' : tokenManager.issueProxyToken({
      workspaceId: envelope.workspaceId,
      workspaceGeneration: envelope.workspaceGeneration,
      executionId: envelope.executionId,
      taskSpecId: envelope.taskSpecId,
      manifestHash: envelope.manifestHash,
      method: PROTOCOL_METHODS.GET,
      path: buildCapabilityPath(envelope.executionId),
      maxCalls: MAX_CALLS_DEFAULT,
    });
    if (issuedCapabilityToken) tokenManager.verifyProxyToken(issuedCapabilityToken, {
      workspaceId: envelope.workspaceId,
      workspaceGeneration: envelope.workspaceGeneration,
      executionId: envelope.executionId,
      taskSpecId: envelope.taskSpecId,
      manifestHash: envelope.manifestHash,
      expectedMethod: PROTOCOL_METHODS.GET,
      expectedPath: buildCapabilityPath(envelope.executionId),
    });
    const issuedCancelToken = envelope.cancelToken ? '' : tokenManager.issueProxyToken({
      workspaceId: envelope.workspaceId,
      workspaceGeneration: envelope.workspaceGeneration,
      executionId: envelope.executionId,
      taskSpecId: envelope.taskSpecId,
      manifestHash: envelope.manifestHash,
      method: PROTOCOL_METHODS.DELETE,
      path: buildRunnerCancelPath(envelope.executionId),
      maxCalls: 8,
    });
    const issuedStatusToken = envelope.statusToken ? '' : tokenManager.issueProxyToken({
      workspaceId: envelope.workspaceId,
      workspaceGeneration: envelope.workspaceGeneration,
      executionId: envelope.executionId,
      taskSpecId: envelope.taskSpecId,
      manifestHash: envelope.manifestHash,
      method: PROTOCOL_METHODS.GET,
      path: buildRunnerStatusPath(envelope.executionId),
      maxCalls: 16,
    });
    const suppliedTokens = {
      proxyToken: envelope.proxyToken || issuedProxyToken,
      capabilityToken: envelope.capabilityToken || issuedCapabilityToken,
      cancelToken: envelope.cancelToken || issuedCancelToken,
      statusToken: envelope.statusToken || issuedStatusToken,
    };
    const verifySupplied = (token, method, path) => tokenManager.verifyProxyToken(token, {
      workspaceId: envelope.workspaceId,
      workspaceGeneration: envelope.workspaceGeneration,
      executionId: envelope.executionId,
      taskSpecId: envelope.taskSpecId,
      manifestHash: envelope.manifestHash,
      expectedMethod: method,
      expectedPath: path,
    });
    const suppliedProxyClaims = verifySupplied(suppliedTokens.proxyToken, PROTOCOL_METHODS.POST, buildChatPath());
    verifySupplied(suppliedTokens.capabilityToken, PROTOCOL_METHODS.GET, buildCapabilityPath(envelope.executionId));
    verifySupplied(suppliedTokens.cancelToken, PROTOCOL_METHODS.DELETE, buildRunnerCancelPath(envelope.executionId));
    verifySupplied(suppliedTokens.statusToken, PROTOCOL_METHODS.GET, buildRunnerStatusPath(envelope.executionId));
    const execution = Object.freeze({
      executionId: envelope.executionId,
      workspaceId: envelope.workspaceId,
      workspaceGeneration: envelope.workspaceGeneration,
      taskSpecId: envelope.taskSpecId,
      manifestHash: envelope.manifestHash,
      status: 'accepted',
      createdAt: now,
      updatedAt: now,
      expiresAt: Math.min(envelope.expiresAt, now + executionTtlMs),
      inputSizeBytes: envelope.inputSizeBytes,
      inputChecksum: envelope.inputChecksum,
      resultMaxBytes: Math.min(envelope.resultMaxBytes || maxResultBytes, maxResultBytes),
      input: envelope.input,
      cancelToken: suppliedTokens.cancelToken,
      capabilityToken: suppliedTokens.capabilityToken,
      proxyToken: suppliedTokens.proxyToken,
      statusToken: suppliedTokens.statusToken,
      proxyMaxCalls: suppliedProxyClaims.maxCalls,
      proxyRemainingCalls: suppliedProxyClaims.maxCalls,
      runnerToken: claims.jti,
      callback: envelope.callback,
      resultFileName: envelope.resultFileName || 'result.json',
      requestModel: envelope.requestModel,
      agentListenerUrl: envelope.agentListenerUrl || '',
      inputFiles: envelope.inputFiles || {},
      prompt: envelope.prompt || '',
      timeoutMs: envelope.timeoutMs,
    });
    const mutable = { ...execution };
    executions.set(execution.executionId, mutable);
    activeExecutionOrder.push(execution.executionId);
    if (executionRunner && typeof executionRunner.start === 'function') {
      queueMicrotask(() => {
        executionRunner.start(mutable, {
          onStarted: () => markExecutionRunning(mutable.executionId),
          onResult: (result) => setExecutionResult(mutable.executionId, result),
          onError: (error) => setExecutionFailure(mutable.executionId, error),
        }).catch((error) => setExecutionFailure(mutable.executionId, error));
      });
    }
    return {
      executionId: mutable.executionId,
      status: mutable.status,
      createdAt: mutable.createdAt,
      expiresAt: mutable.expiresAt,
      cancelToken: mutable.cancelToken,
      capabilityToken: mutable.capabilityToken,
      proxyToken: mutable.proxyToken,
      statusToken: mutable.statusToken,
      capabilityPath: buildCapabilityPath(mutable.executionId),
      statusPath: buildRunnerStatusPath(mutable.executionId),
      chatPath: buildChatPath(),
      created: true,
    };
  }

  function cancelExecution(executionId, rawToken, body = {}) {
    const normalizedId = String(executionId || '').trim();
    if (!normalizedId) {
      throw createSidecarError('executionId 不能为空', SIDE_CAR_ERROR_CODES.INVALID_INPUT, { statusCode: 400 });
    }
    const request = normalizeCancelExecutionRequest(body || {});
    const execution = executions.get(normalizedId);
    if (!execution) {
      return { executionId: normalizedId, status: 'not_found', reason: request.reason, cancelled: false };
    }
    const tokenBinding = {
      workspaceId: execution.workspaceId,
      workspaceGeneration: execution.workspaceGeneration,
      executionId: execution.executionId,
      taskSpecId: execution.taskSpecId,
      manifestHash: execution.manifestHash,
      expectedMethod: PROTOCOL_METHODS.DELETE,
      expectedPath: buildRunnerCancelPath(normalizedId),
    };
    if (execution.status === 'cancelled' && rawToken === execution.cancelToken) {
      tokenManager.verifyRevokedProxyToken(rawToken, tokenBinding);
      return { ...execution.cancelReceipt, idempotent: true };
    }
    const proxyClaims = tokenManager.verifyProxyToken(rawToken, {
      ...tokenBinding,
    });
    if (proxyClaims.executionId !== normalizedId) {
      throw createSidecarError('execution 绑定 mismatch', SIDE_CAR_ERROR_CODES.BINDING_MISMATCH, { statusCode: 401 });
    }
    if (execution.status === 'cancelled' || execution.status === 'succeeded' || execution.status === 'failed') {
      return { executionId: normalizedId, status: execution.status, cancelled: false, reason: request.reason };
    }
    const receipt = Object.freeze({
      executionId: normalizedId,
      status: 'cancelled',
      cancelled: true,
      reason: request.reason,
      ...(request.cause === undefined ? {} : { cause: request.cause }),
    });
    execution.status = 'cancelled';
    execution.updatedAt = clock();
    execution.cancelReason = request.reason;
    execution.cancelReceipt = receipt;
    execution.closedAt = clock();
    execution.proxyRemainingCalls = 0;
    tokenManager.revokeExecutionTokens(normalizedId);
    releaseActiveExecution(normalizedId);
    executionRunner?.cancel?.(normalizedId, request.reason);
    return receipt;
  }

  function getCapability(executionId, rawToken) {
    const normalizedId = String(executionId || '').trim();
    const execution = executions.get(normalizedId);
    if (!execution) {
      throw createSidecarError('Execution 不存在', SIDE_CAR_ERROR_CODES.EXECUTION_NOT_FOUND, { statusCode: 404 });
    }
    const claims = tokenManager.verifyProxyToken(rawToken, {
      workspaceId: execution.workspaceId,
      workspaceGeneration: execution.workspaceGeneration,
      executionId: execution.executionId,
      taskSpecId: execution.taskSpecId,
      manifestHash: execution.manifestHash,
      expectedMethod: PROTOCOL_METHODS.GET,
      expectedPath: buildCapabilityPath(normalizedId),
    });
    return {
      executionId: normalizedId,
      taskSpecId: execution.taskSpecId,
      manifestHash: execution.manifestHash,
      maxCalls: claims.maxCalls,
      remainingCalls: Math.max(0, execution.proxyRemainingCalls),
      status: execution.status,
      expiresAt: execution.expiresAt,
    };
  }

  function consumeCall(proxyToken, executionId, body) {
    const request = normalizeChatRequest(body || {});
    const claims = tokenManager.verifyProxyToken(proxyToken, {
      workspaceId: undefined,
      workspaceGeneration: undefined,
      executionId,
      taskSpecId: undefined,
      manifestHash: undefined,
      expectedMethod: PROTOCOL_METHODS.POST,
      expectedPath: buildChatPath(),
    });
    const execution = executions.get(claims.executionId);
    if (!execution) {
      throw createSidecarError('execution 不存在', SIDE_CAR_ERROR_CODES.EXECUTION_NOT_FOUND, { statusCode: 404 });
    }
    if (execution.executionId !== executionId) {
      throw createSidecarError('executionId 与 token 不一致', SIDE_CAR_ERROR_CODES.BINDING_MISMATCH, { statusCode: 401 });
    }
    if (request.executionId !== execution.executionId) {
      throw createSidecarError('chat request.executionId 与 token 不一致', SIDE_CAR_ERROR_CODES.BINDING_MISMATCH, { statusCode: 401 });
    }
    if (execution.status === 'cancelled' || execution.status === 'failed' || execution.status === 'succeeded') {
      throw createSidecarError('execution 已结束，禁止继续调用', SIDE_CAR_ERROR_CODES.EXECUTION_BUSY, { statusCode: 409 });
    }
    if (execution.expiresAt < clock()) {
      execution.status = 'expired';
      throw createSidecarError('execution 已过期', SIDE_CAR_ERROR_CODES.TOKEN_EXPIRED, { statusCode: 401 });
    }
    const payload = JSON.stringify(request);
    if (Buffer.byteLength(payload, 'utf8') > SIDE_CAR_LIMITS.MAX_CHAT_REQUEST_BYTES) {
      throw createSidecarError('请求体过大', SIDE_CAR_ERROR_CODES.LIMIT_EXCEEDED, { statusCode: 413 });
    }
    tokenManager.consumeProxyCall(proxyToken, {
      workspaceId: execution.workspaceId,
      workspaceGeneration: execution.workspaceGeneration,
      executionId,
      taskSpecId: execution.taskSpecId,
      manifestHash: execution.manifestHash,
      expectedMethod: PROTOCOL_METHODS.POST,
      expectedPath: buildChatPath(),
    });
    execution.proxyRemainingCalls = Math.max(0, execution.proxyRemainingCalls - 1);
    execution.lastModelUseAt = clock();
    execution.updatedAt = clock();
    return request;
  }

  function setExecutionResult(executionId, result) {
    const execution = executions.get(executionId);
    if (!execution) return;
    if (!['accepted', 'running'].includes(execution.status)) return;
    const text = JSON.stringify(result);
    if (Buffer.byteLength(text, 'utf8') > execution.resultMaxBytes) {
      throw createSidecarError('result 超过限制', SIDE_CAR_ERROR_CODES.LIMIT_EXCEEDED, { statusCode: 413 });
    }
    execution.result = result;
    execution.status = 'succeeded';
    execution.resultHash = require('node:crypto').createHash('sha256').update(text).digest('hex');
    execution.updatedAt = clock();
    execution.closedAt = clock();
    releaseActiveExecution(execution.executionId);
    revokeTerminalTokens(execution);
  }

  function markExecutionRunning(executionId) {
    const execution = executions.get(executionId);
    if (!execution || execution.status !== 'accepted') return false;
    execution.status = 'running';
    execution.updatedAt = clock();
    return true;
  }

  function getExecutionResult(executionId, rawToken) {
    const execution = executions.get(String(executionId || '').trim());
    if (!execution) {
      throw createSidecarError('Execution 不存在', SIDE_CAR_ERROR_CODES.EXECUTION_NOT_FOUND, { statusCode: 404 });
    }
    tokenManager.verifyProxyToken(rawToken, {
      workspaceId: execution.workspaceId,
      workspaceGeneration: execution.workspaceGeneration,
      executionId: execution.executionId,
      taskSpecId: execution.taskSpecId,
      manifestHash: execution.manifestHash,
      expectedMethod: PROTOCOL_METHODS.GET,
      expectedPath: buildRunnerStatusPath(execution.executionId),
    });
    return listExecutionStatus(execution.executionId);
  }

  function setExecutionFailure(executionId, error) {
    const execution = executions.get(executionId);
    if (!execution || ['cancelled', 'succeeded', 'failed', 'expired'].includes(execution.status)) return false;
    execution.status = 'failed';
    execution.updatedAt = clock();
    execution.closedAt = clock();
    execution.failure = {
      code: String(error?.code || SIDE_CAR_ERROR_CODES.INTERNAL),
      message: redactFailureMessage(error?.message),
      retryable: Boolean(error?.retryable),
    };
    releaseActiveExecution(executionId);
    revokeTerminalTokens(execution);
    return true;
  }

  function close(reason = 'shutting down') {
    for (const execution of executions.values()) {
      if (execution.status === 'accepted' || execution.status === 'running') {
        execution.status = 'failed';
        execution.failureReason = reason;
      }
      executionRunner?.cancel?.(execution.executionId, 'shutdown');
      tokenManager.revokeExecutionTokens(execution.executionId);
    }
    activeExecutionOrder.length = 0;
    executions.clear();
  }

  return Object.freeze({
    createExecution,
    cancelExecution,
    getCapability,
    getExecution: listExecutionStatus,
    getExecutionResult,
    consumeCall,
    markExecutionRunning,
    setExecutionFailure,
    setExecutionResult,
    sweepExpiredExecutions,
    close,
    getState: () => ({
      active: activeExecutionOrder.length,
      executions: Array.from(executions.keys()),
    }),
  });
}

module.exports = {
  createSidecarCoordinator,
};
