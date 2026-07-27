const assert = require('node:assert/strict');

const {
  SIDE_CAR_ERROR_CODES,
  PROTOCOL_METHODS,
  PROTOCOL_ROUTES,
  buildChatPath,
  buildRunnerCancelPath,
  buildCapabilityPath,
  buildRunnerCreatePath,
} = require('../shared/contracts/agent-sidecar/sidecarProtocolV1.cjs');
const { createSidecarCoordinator } = require('../server/agent-sidecar/sidecarCoordinator.cjs');
const { createTokenManager } = require('../server/agent-sidecar/tokenService.cjs');
const { createRunnerApi, createRunnerHttpServer } = require('../server/agent-sidecar/runnerApi.cjs');
const { createInternalAgentApi, createInternalAgentHttpServer } = require('../server/agent-sidecar/internalListener.cjs');

function makeEnvelope(executionId) {
  return {
    executionId,
    workspaceId: 'ws-api-001',
    workspaceGeneration: 1,
    taskSpecId: 'task-spec-api-001',
    manifestHash: 'manifest-api-001',
    input: { source: 'api-fixture' },
    requestModel: 'api-model',
    resultFileName: 'result.json',
    resultMaxBytes: 2048,
    proxyMaxCalls: 2,
    callback: { event: 'api-event', retries: 0 },
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

async function requestJson(baseUrl, path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

function assertErrorResponse(result, code) {
  assert.equal(result.body?.error?.code, code, `应返回 ${code}`);
}

async function main() {
  const tokenManager = createTokenManager({ secret: 'api-test-secret' });
  const coordinator = createSidecarCoordinator({ tokenManager, executionTtlMs: 2 * 60 * 1000 });
  const runnerApi = createRunnerApi({ coordinator });
  const runnerServer = createRunnerHttpServer({ api: runnerApi, host: '127.0.0.1', port: 0 });
  const runnerAddress = await runnerServer.start();
  const runnerBaseUrl = `http://127.0.0.1:${runnerAddress.port}`;

  try {
    const envelope = makeEnvelope('exec-api-001');
    const dispatchToken = issueDispatch(tokenManager, envelope);
    const created = await requestJson(runnerBaseUrl, buildRunnerCreatePath(), {
      method: PROTOCOL_METHODS.POST,
      token: dispatchToken,
      body: envelope,
    });
    assert.equal(created.status, 201, 'Runner create 返回 201');
    assert.equal(created.body.created, true, '首次创建 execution');

    const replay = await requestJson(runnerBaseUrl, buildRunnerCreatePath(), {
      method: PROTOCOL_METHODS.POST,
      token: dispatchToken,
      body: envelope,
    });
    assert.equal(replay.status, 401, 'dispatch replay 返回 401');
    assertErrorResponse(replay, SIDE_CAR_ERROR_CODES.TOKEN_REPLAY);

    const reconnect = await requestJson(runnerBaseUrl, buildRunnerCreatePath(), {
      method: PROTOCOL_METHODS.POST,
      token: issueDispatch(tokenManager, envelope),
      body: envelope,
    });
    assert.equal(reconnect.status, 201, '重连 create 仍返回成功 HTTP 状态');
    assert.equal(reconnect.body.created, false, '重连复用已有 execution');
    assert.equal(reconnect.body.proxyToken, created.body.proxyToken, '重连复用 proxy capability');
    assert.equal(coordinator.getState().active, 1, '重连不产生第二个 active execution');

    const conflictEnvelope = { ...envelope, manifestHash: 'manifest-api-conflict' };
    const conflict = await requestJson(runnerBaseUrl, buildRunnerCreatePath(), {
      method: PROTOCOL_METHODS.POST,
      token: issueDispatch(tokenManager, conflictEnvelope),
      body: conflictEnvelope,
    });
    assert.equal(conflict.status, 409, '同 execution 不同 manifest 返回冲突');
    assertErrorResponse(conflict, SIDE_CAR_ERROR_CODES.EXECUTION_CONFLICT);

    const cancelPath = buildRunnerCancelPath(envelope.executionId);
    const canceled = await requestJson(runnerBaseUrl, cancelPath, {
      method: PROTOCOL_METHODS.DELETE,
      token: created.body.cancelToken,
      body: { reason: 'user-stop', cause: 'api-test' },
    });
    assert.equal(canceled.status, 200, '取消返回 200');
    assert.equal(canceled.body.cancelled, true, '首次取消成功');

    const repeated = await requestJson(runnerBaseUrl, cancelPath, {
      method: PROTOCOL_METHODS.DELETE,
      token: created.body.cancelToken,
      body: { reason: 'second-retry' },
    });
    assert.equal(repeated.status, 200, '重复取消保持 200');
    assert.equal(repeated.body.idempotent, true, '重复取消为幂等结果');
    assert.equal(repeated.body.reason, 'user-stop', '重复取消返回第一次 receipt');

    const routeDenied = await requestJson(runnerBaseUrl, `/internal/runner/v1/executions/${encodeURIComponent(envelope.executionId)}/capability`);
    assert.equal(routeDenied.status, 404, 'Runner 不暴露 capability 路由');
    assertErrorResponse(routeDenied, SIDE_CAR_ERROR_CODES.ROUTE_NOT_ALLOWED);

    // 新 execution 供 Agent internal listener 做 capability / chat / revoke 验证。
    const secondEnvelope = makeEnvelope('exec-api-002');
    const second = coordinator.createExecution(secondEnvelope, issueDispatch(tokenManager, secondEnvelope));
    const internalApi = createInternalAgentApi({
      coordinator,
      chatHandler: async (request) => ({ ok: true, executionId: request.executionId, content: 'mock-chat' }),
    });
    const internalServer = createInternalAgentHttpServer({ api: internalApi, host: '127.0.0.1', port: 0 });
    const internalAddress = await internalServer.start();
    const internalBaseUrl = `http://127.0.0.1:${internalAddress.port}`;
    try {
      const capability = await requestJson(internalBaseUrl, buildCapabilityPath(secondEnvelope.executionId), {
        token: second.capabilityToken,
      });
      assert.equal(capability.status, 200, 'capability endpoint 真实可访问');
      assert.equal(capability.body.executionId, secondEnvelope.executionId, 'capability 绑定 execution');

      const chat = await requestJson(internalBaseUrl, buildChatPath(), {
        method: PROTOCOL_METHODS.POST,
        token: second.proxyToken,
        body: {
          executionId: secondEnvelope.executionId,
          messages: [{ role: 'user', content: 'hello' }],
          model: secondEnvelope.requestModel,
          stream: false,
        },
      });
      assert.equal(chat.status, 200, 'chat endpoint 真实可访问');
      assert.equal(chat.body.body?.ok, undefined, '响应不额外包内部 token');
      assert.equal(chat.body.ok, true, 'chat handler 输出透传');

      const wrongCapabilityToken = await requestJson(internalBaseUrl, buildCapabilityPath(secondEnvelope.executionId), {
        token: second.proxyToken,
      });
      assert.equal(wrongCapabilityToken.status, 401, 'proxy token 不能访问 capability');
      assertErrorResponse(wrongCapabilityToken, SIDE_CAR_ERROR_CODES.BINDING_MISMATCH);

      const wrongChatToken = await requestJson(internalBaseUrl, buildChatPath(), {
        method: PROTOCOL_METHODS.POST,
        token: second.cancelToken,
        body: {
          executionId: secondEnvelope.executionId,
          messages: [{ role: 'user', content: 'wrong token' }],
          model: secondEnvelope.requestModel,
          stream: false,
        },
      });
      assert.equal(wrongChatToken.status, 401, 'cancel token 不能访问 chat');
      assertErrorResponse(wrongChatToken, SIDE_CAR_ERROR_CODES.BINDING_MISMATCH);

      const deniedPublicRoute = await requestJson(internalBaseUrl, '/api/health');
      assert.equal(deniedPublicRoute.status, 404, 'internal listener 拒绝公共 API');
      assertErrorResponse(deniedPublicRoute, SIDE_CAR_ERROR_CODES.ROUTE_NOT_ALLOWED);

      tokenManager.revokeToken(second.proxyToken);
      const revoked = await requestJson(internalBaseUrl, buildChatPath(), {
        method: PROTOCOL_METHODS.POST,
        token: second.proxyToken,
        body: {
          executionId: secondEnvelope.executionId,
          messages: [{ role: 'user', content: 'revoked' }],
          model: secondEnvelope.requestModel,
          stream: false,
        },
      });
      assert.equal(revoked.status, 401, '撤销 proxy token 返回 401');
      assertErrorResponse(revoked, SIDE_CAR_ERROR_CODES.TOKEN_REVOKED);
    } finally {
      await internalServer.close();
    }
  } finally {
    await runnerServer.close();
    coordinator.close('api test complete');
    tokenManager.close();
  }

  console.log('PASS: WP-J sidecar HTTP API replay/revoke/reconnect/idempotent cancel');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
