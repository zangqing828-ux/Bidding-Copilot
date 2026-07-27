const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  SIDE_CAR_ERROR_CODES,
  PROTOCOL_METHODS,
  buildChatPath,
  buildRunnerCancelPath,
  buildCapabilityPath,
} = require('../shared/contracts/agent-sidecar/sidecarProtocolV1.cjs');
const { createSidecarCoordinator } = require('../server/agent-sidecar/sidecarCoordinator.cjs');
const { createTokenManager } = require('../server/agent-sidecar/tokenService.cjs');
const { RUNNER_SECURITY_POLICY, validateRunnerSecurityPolicy, getRunnerPolicyEvidence } = require('../agent-runner/securityPolicy.cjs');

function decodeClaims(rawToken) {
  const payload = String(rawToken || '').split('.')[0];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

function makeEnvelope(executionId) {
  return {
    executionId,
    workspaceId: 'ws-security-001',
    workspaceGeneration: 1,
    taskSpecId: 'task-spec-001',
    manifestHash: 'manifest-security-001',
    input: { source: 'security-fixture' },
    requestModel: 'security-model',
    resultFileName: 'result.json',
    resultMaxBytes: 2048,
    proxyMaxCalls: 2,
    callback: { event: 'event-security', retries: 0 },
    expiresAt: Date.now() + 60 * 1000,
  };
}

function issueDispatch(tokenManager, envelope) {
  return tokenManager.issueDispatchToken({
    workspaceId: envelope.workspaceId,
    workspaceGeneration: envelope.workspaceGeneration,
    executionId: envelope.executionId,
    taskSpecId: envelope.taskSpecId,
    manifestHash: envelope.manifestHash,
  });
}

function expectCode(fn, code) {
  try {
    fn();
    throw new Error(`应抛出 ${code}`);
  } catch (error) {
    assert.equal(error.code, code);
  }
}

function main() {
  assert.equal(validateRunnerSecurityPolicy(RUNNER_SECURITY_POLICY), true, 'Runner security policy 必须通过自校验');
  const dockerfile = fs.readFileSync(path.join(__dirname, '../../docker/agent-runner/Dockerfile'), 'utf8');
  assert.match(dockerfile, /prepare-agent-runner-assets\.cjs/, 'Runner image 必须执行固定资产准备脚本');
  assert.match(dockerfile, /agent-runner-assets\.json/, 'Runner image 必须复制固定资产清单');
  assert.match(dockerfile, /COPY --from=runner-assets \/opt\/agent-assets/, 'Runner image 必须复制独立资产层');
  assert.match(dockerfile, /opencode --version/, 'Runner image 必须在构建期校验 OpenCode');
  assert.match(dockerfile, /rg --version/, 'Runner image 必须在构建期校验 rg');
  assert.match(dockerfile, /fd --version/, 'Runner image 必须在构建期校验 fd');
  assert.match(dockerfile, /jq -n/, 'Runner image 必须在构建期校验 jq');
  assert.match(dockerfile, /prlimit --version/, 'Runner image 必须在构建期校验 prlimit');
  assert.match(dockerfile, /USER 10001:10001/, 'Runner image 必须以非 root 用户运行');
  assert.match(dockerfile, /COPY client\/server\/agent-sidecar/, 'Runner image 必须独立复制 Sidecar runtime');
  const seccomp = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docker/agent-runner/seccomp/agent-runner.json'), 'utf8'));
  const seccompNames = seccomp.syscalls.flatMap((entry) => entry.names || []);
  assert.equal(seccomp.defaultAction, 'SCMP_ACT_ERRNO', 'seccomp 默认必须拒绝');
  assert.equal(seccompNames.includes('connect'), true, 'Runner seccomp 必须允许连接内部 Proxy 网络');
  assert.equal(seccompNames.includes('ptrace'), false, 'Runner seccomp 不得允许 ptrace');
  const policyEvidence = getRunnerPolicyEvidence();
  assert.equal(policyEvidence.network.mode, 'internal-proxy-only');
  assert.equal(policyEvidence.network.egress, 'deny');
  assert.equal(policyEvidence.seccomp.defaultAction, 'SCMP_ACT_ERRNO');
  assert.equal(policyEvidence.seccomp.connect, 'agent-internal-network-only');
  assert.match(policyEvidence.seccomp.sha256, /^[a-f0-9]{64}$/);

  const tokenManager = createTokenManager({ secret: 'security-test-secret' });
  const coordinator = createSidecarCoordinator({ tokenManager, executionTtlMs: 2 * 60 * 1000 });

  const envelope = makeEnvelope('exec-security-replay');
  const dispatchToken = issueDispatch(tokenManager, envelope);
  const created = coordinator.createExecution(envelope, dispatchToken);

  assert.equal(created.created, true, '执行体创建成功');

  expectCode(
    () => coordinator.createExecution({ ...envelope, resultFileName: '../escape.json' }, issueDispatch(tokenManager, envelope)),
    SIDE_CAR_ERROR_CODES.INVALID_INPUT,
  );

  expectCode(
    () => tokenManager.verifyProxyToken(created.cancelToken, {
      executionId: envelope.executionId,
      expectedMethod: PROTOCOL_METHODS.POST,
      expectedPath: buildChatPath(),
    }),
    SIDE_CAR_ERROR_CODES.BINDING_MISMATCH,
  );

  expectCode(
    () => tokenManager.consumeProxyCall(created.proxyToken, {
      executionId: envelope.executionId,
    }),
    SIDE_CAR_ERROR_CODES.INVALID_INPUT,
  );

  // method/path 都不能为空（Issue Proxy token 前置校验）
  assert.throws(
    () => tokenManager.issueProxyToken({
      workspaceId: envelope.workspaceId,
      workspaceGeneration: envelope.workspaceGeneration,
      executionId: envelope.executionId,
      taskSpecId: envelope.taskSpecId,
      manifestHash: envelope.manifestHash,
      method: '',
      path: buildChatPath(),
      maxCalls: 1,
    }),
    /不能为空|不可为空|invalid/i,
    'issueProxyToken 空 method 会失败',
  );

  assert.throws(
    () => tokenManager.issueProxyToken({
      workspaceId: envelope.workspaceId,
      workspaceGeneration: envelope.workspaceGeneration,
      executionId: envelope.executionId,
      taskSpecId: envelope.taskSpecId,
      manifestHash: envelope.manifestHash,
      method: PROTOCOL_METHODS.POST,
      path: '   ',
      maxCalls: 1,
    }),
    /不能为空|不可为空|invalid/i,
    'issueProxyToken 空 path 会失败',
  );

  // dispatch 一次性语义：同 token 重放应拒绝
  expectCode(
    () => coordinator.createExecution(envelope, dispatchToken),
    SIDE_CAR_ERROR_CODES.TOKEN_REPLAY,
  );

  // proxy 重放/限流：先验证可调用，再验证用尽后拒绝
  const firstChat = {
    executionId: envelope.executionId,
    messages: [{ role: 'user', content: 'ping 1' }],
    model: envelope.requestModel,
    stream: false,
  };
  coordinator.consumeCall(created.proxyToken, envelope.executionId, firstChat);
  coordinator.consumeCall(created.proxyToken, envelope.executionId, firstChat);
  expectCode(
    () => coordinator.consumeCall(created.proxyToken, envelope.executionId, firstChat),
    SIDE_CAR_ERROR_CODES.LIMIT_EXCEEDED,
  );

  // method/path 绑定：混用能力/取消 token，必须拒绝
  expectCode(
    () => coordinator.getCapability(envelope.executionId, created.cancelToken),
    SIDE_CAR_ERROR_CODES.BINDING_MISMATCH,
  );
  expectCode(
    () => coordinator.getCapability(envelope.executionId, decodeClaims(created.proxyToken).jti),
    SIDE_CAR_ERROR_CODES.INVALID_TOKEN,
  );

  // capability 与 cancel/proxy 不可交叉使用
  const badExecution = makeEnvelope('exec-security-mismatch');
  const badToken = tokenManager.issueProxyToken({
    workspaceId: badExecution.workspaceId,
    workspaceGeneration: badExecution.workspaceGeneration,
    executionId: badExecution.executionId,
    taskSpecId: badExecution.taskSpecId,
    manifestHash: badExecution.manifestHash,
    method: PROTOCOL_METHODS.GET,
    path: buildCapabilityPath(badExecution.executionId),
    maxCalls: 1,
  });
  expectCode(
    () => coordinator.consumeCall(badToken, envelope.executionId, firstChat),
    SIDE_CAR_ERROR_CODES.BINDING_MISMATCH,
  );
  expectCode(
    () => coordinator.consumeCall(created.proxyToken, badExecution.executionId, firstChat),
    SIDE_CAR_ERROR_CODES.BINDING_MISMATCH,
  );

  // revoke：撤销后应不可再使用
  tokenManager.revokeToken(created.proxyToken);
  expectCode(
    () => coordinator.consumeCall(created.proxyToken, envelope.executionId, firstChat),
    SIDE_CAR_ERROR_CODES.TOKEN_REVOKED,
  );

  tokenManager.revokeToken(created.capabilityToken);
  expectCode(
    () => coordinator.getCapability(envelope.executionId, created.capabilityToken),
    SIDE_CAR_ERROR_CODES.TOKEN_REVOKED,
  );

  tokenManager.revokeToken(created.cancelToken);
  expectCode(
    () => coordinator.cancelExecution(envelope.executionId, created.cancelToken),
    SIDE_CAR_ERROR_CODES.TOKEN_REVOKED,
  );

  // 取消后 token 对其他能力失效；同一取消请求在短期内幂等返回原始 receipt
  const secondTokenManager = createTokenManager({ secret: 'security-test-secret' });
  const secondCoordinator = createSidecarCoordinator({ tokenManager: secondTokenManager });
  const secondEnvelope = makeEnvelope('exec-security-close');
  const secondDispatch = secondTokenManager.issueDispatchToken({
    workspaceId: secondEnvelope.workspaceId,
    workspaceGeneration: secondEnvelope.workspaceGeneration,
    executionId: secondEnvelope.executionId,
    taskSpecId: secondEnvelope.taskSpecId,
    manifestHash: secondEnvelope.manifestHash,
  });
  const second = secondCoordinator.createExecution(
    secondEnvelope,
    secondDispatch,
  );
  const secondCancelResult = secondCoordinator.cancelExecution(second.executionId, second.cancelToken, {
    reason: 'user-stop',
  });
  assert.equal(secondCancelResult.cancelled, true, '取消请求成功执行');
  const repeatedCancel = secondCoordinator.cancelExecution(second.executionId, second.cancelToken, {
    reason: 'repeat',
  });
  assert.equal(repeatedCancel.idempotent, true, '重复取消返回幂等 receipt');
  assert.equal(repeatedCancel.reason, 'user-stop', '幂等取消保留首次 reason');
  expectCode(
    () => secondCoordinator.consumeCall(second.proxyToken, second.executionId, {
      executionId: second.executionId,
      messages: [{ role: 'user', content: 'after cancel' }],
      model: secondEnvelope.requestModel,
      stream: false,
    }),
    SIDE_CAR_ERROR_CODES.TOKEN_REVOKED,
  );

  const thirdEnvelope = makeEnvelope('exec-security-output-limit');
  const third = secondCoordinator.createExecution(thirdEnvelope, issueDispatch(secondTokenManager, thirdEnvelope));
  const oversizedResult = { result: 'x'.repeat(4096) };
  expectCode(
    () => secondCoordinator.setExecutionResult(third.executionId, oversizedResult),
    SIDE_CAR_ERROR_CODES.LIMIT_EXCEEDED,
  );

  console.log('PASS: WP-J sidecar security boundary');
}

main();
