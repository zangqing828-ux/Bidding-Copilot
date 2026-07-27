const assert = require('node:assert/strict');

const {
  MAX_CALLS_DEFAULT,
  MAX_RESULT_BYTES,
  SIDE_CAR_ERROR_CODES,
  PROTOCOL_METHODS,
  buildChatPath,
  buildCapabilityPath,
  buildRunnerCancelPath,
  buildRunnerCreatePath,
  SIDE_CAR_LIMITS,
  MAX_EXECUTION_TOKEN_LENGTH,
} = require('../shared/contracts/agent-sidecar/sidecarProtocolV1.cjs');
const { createSidecarCoordinator } = require('../server/agent-sidecar/sidecarCoordinator.cjs');
const { createTokenManager } = require('../server/agent-sidecar/tokenService.cjs');

function decodeTokenClaims(token) {
  const [payloadPart] = String(token || '').split('.');
  if (!payloadPart) {
    throw new Error('token payload 缺失');
  }
  return JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
}

function makeEnvelope() {
  return {
    executionId: 'exec-protocol-001',
    workspaceId: 'ws-protocol-001',
    workspaceGeneration: 1,
    taskSpecId: 'task-spec-001',
    manifestHash: 'manifest-protocol-001',
    input: { source: 'fixture' },
    requestModel: 'mock-model-v1',
    resultFileName: 'result.json',
    resultMaxBytes: 2048,
    proxyMaxCalls: 2,
    callback: { event: 'event-protocol', retries: 0 },
    expiresAt: Date.now() + 60 * 1000,
  };
}

function makeDispatchToken(tokenManager, envelope) {
  return tokenManager.issueDispatchToken({
    workspaceId: envelope.workspaceId,
    workspaceGeneration: envelope.workspaceGeneration,
    executionId: envelope.executionId,
    taskSpecId: envelope.taskSpecId,
    manifestHash: envelope.manifestHash,
  });
}

function ensureErrorCode(fn, expectedCode) {
  try {
    fn();
    throw new Error(`应抛出错误: ${expectedCode}`);
  } catch (error) {
    assert.equal(error.code, expectedCode);
  }
}

function main() {
  assert.equal(MAX_CALLS_DEFAULT > 0, true, 'Sidecar Protocol 导出 MAX_CALLS_DEFAULT > 0');
  assert.equal(typeof MAX_RESULT_BYTES, 'number', 'Sidecar Protocol 导出 MAX_RESULT_BYTES');
  assert.equal(MAX_EXECUTION_TOKEN_LENGTH, SIDE_CAR_LIMITS.MAX_EXECUTION_TOKEN_LENGTH, 'Sidecar Protocol 导出 MAX_EXECUTION_TOKEN_LENGTH');
  assert.ok(SIDE_CAR_LIMITS && typeof SIDE_CAR_LIMITS.MAX_EXECUTION_TOKEN_LENGTH === 'number', 'SIDE_CAR_LIMITS.MAX_EXECUTION_TOKEN_LENGTH 已定义');

  const tokenManager = createTokenManager({ secret: 'protocol-test-secret' });
  const coordinator = createSidecarCoordinator({ tokenManager, executionTtlMs: 2 * 60 * 1000 });
  const envelope = makeEnvelope();

  // 基础创建：验证返回字段与绑定关系
  const firstDispatch = makeDispatchToken(tokenManager, envelope);
  const firstResult = coordinator.createExecution(envelope, firstDispatch);

  assert.equal(firstResult.created, true, '首次 createExecution 创建 execution');
  assert.equal(firstResult.executionId, envelope.executionId, '返回 executionId 一致');
  assert.equal(typeof firstResult.proxyToken === 'string', true, '返回 proxyToken');
  assert.equal(typeof firstResult.cancelToken === 'string', true, '返回 cancelToken');
  assert.equal(typeof firstResult.capabilityToken === 'string', true, '返回 capabilityToken');
  assert.notEqual(firstResult.proxyToken, firstResult.cancelToken, 'proxyToken 与 cancelToken 分离');
  assert.notEqual(firstResult.proxyToken, firstResult.capabilityToken, 'proxyToken 与 capabilityToken 分离');
  assert.notEqual(firstResult.cancelToken, firstResult.capabilityToken, 'cancelToken 与 capabilityToken 分离');

  assert.equal(firstResult.capabilityPath, buildCapabilityPath(envelope.executionId), 'capabilityPath 路径正确');
  assert.equal(firstResult.chatPath, buildChatPath(), 'chatPath 路径正确');

  const firstProxyClaims = decodeTokenClaims(firstResult.proxyToken);
  const firstCancelClaims = decodeTokenClaims(firstResult.cancelToken);
  const firstCapabilityClaims = decodeTokenClaims(firstResult.capabilityToken);
  assert.equal(firstProxyClaims.method, PROTOCOL_METHODS.POST, 'proxyToken method = POST');
  assert.equal(firstProxyClaims.path, buildChatPath(), 'proxyToken path = chat');
  assert.equal(firstCancelClaims.method, PROTOCOL_METHODS.DELETE, 'cancelToken method = DELETE');
  assert.equal(firstCancelClaims.path, buildRunnerCancelPath(envelope.executionId), 'cancelToken path = runner cancel');
  assert.equal(firstCapabilityClaims.method, PROTOCOL_METHODS.GET, 'capabilityToken method = GET');
  assert.equal(firstCapabilityClaims.path, buildCapabilityPath(envelope.executionId), 'capabilityToken path = capability');

  const dispatchClaims = decodeTokenClaims(firstDispatch);
  assert.equal(dispatchClaims.jti.length, MAX_EXECUTION_TOKEN_LENGTH, 'dispatch token jti 长度等于协议上限');
  assert.equal(dispatchClaims.method, PROTOCOL_METHODS.POST, 'dispatch token method = POST');
  assert.equal(dispatchClaims.path, buildRunnerCreatePath(), 'dispatch token path = runner create');
  ensureErrorCode(
    () => tokenManager.verifyDispatchToken(firstDispatch, { expectedMethod: PROTOCOL_METHODS.DELETE, expectedPath: buildRunnerCancelPath(envelope.executionId) }),
    SIDE_CAR_ERROR_CODES.BINDING_MISMATCH,
  );

  // 幂等 create：同一个 executionId，携带同参数的二次请求应复用原 execution
  const secondDispatch = makeDispatchToken(tokenManager, envelope);
  const secondResult = coordinator.createExecution(envelope, secondDispatch);
  assert.equal(secondResult.created, false, 'createExecution 幂等返回 created=false');
  assert.equal(secondResult.executionId, firstResult.executionId, '幂等调用返回同一 executionId');
  assert.equal(secondResult.capabilityToken, firstResult.capabilityToken, '幂等场景返回同一 capabilityToken');

  // create 请求若带 cancel 字段应被拒绝（避免 reason 进到 cancel DTO）
  const badEnvelope = { ...envelope, reason: 'user-cancel' };
  const badDispatch = makeDispatchToken(tokenManager, envelope);
  ensureErrorCode(
    () => coordinator.createExecution(badEnvelope, badDispatch),
    SIDE_CAR_ERROR_CODES.INVALID_INPUT,
  );
  const badEnvelopeCause = { ...envelope, cause: 'user-cancel' };
  ensureErrorCode(
    () => coordinator.createExecution(badEnvelopeCause, makeDispatchToken(tokenManager, envelope)),
    SIDE_CAR_ERROR_CODES.INVALID_INPUT,
  );

  // sidecar 协议上限字段可作为参数读取
  const capability = coordinator.getCapability(firstResult.executionId, firstResult.capabilityToken);
  assert.equal(capability.maxCalls, MAX_CALLS_DEFAULT, 'capability 查询返回默认调用上限');
  assert.equal(capability.expiresAt > Date.now(), true, 'capability 返回有效过期时间');
  assert.equal(capability.remainingCalls > 0, true, 'capability 返回剩余调用量 > 0');

  // resultMaxBytes 超限应被拒绝
  const overSized = { ...makeEnvelope(), executionId: 'exec-large-001', resultMaxBytes: MAX_RESULT_BYTES + 1 };
  ensureErrorCode(
    () => coordinator.createExecution(overSized, makeDispatchToken(tokenManager, overSized)),
    SIDE_CAR_ERROR_CODES.INVALID_INPUT,
  );

  coordinator.setExecutionResult(firstResult.executionId, { ok: true, result: 'bounded' });
  assert.equal(coordinator.getState().active, 0, 'execution 成功后释放全局单任务槽位');

  console.log('PASS: WP-J sidecar protocol baseline');
}

main();
