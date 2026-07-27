const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const {
  PROTOCOL_METHODS,
  SIDE_CAR_ERROR_CODES,
  buildRunnerCreatePath,
  buildRunnerCancelPath,
} = require('../shared/contracts/agent-sidecar/sidecarProtocolV1.cjs');
const { createTokenManager } = require('../server/agent-sidecar/tokenService.cjs');
const { createInternalAgentApi } = require('../server/agent-sidecar/internalListener.cjs');
const { createInternalAgentHttpServer } = require('../server/agent-sidecar/internalListener.cjs');

const SECRET = 'cross-process-sidecar-test-secret';

function requestJson(baseUrl, pathName, { method = 'GET', token, body } = {}) {
  return fetch(`${baseUrl}${pathName}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
}

function makeEnvelope(workspaceId = 'cross-workspace-a') {
  return {
    executionId: 'cross-process-execution-001',
    workspaceId,
    workspaceGeneration: 1,
    taskSpecId: 'technical-plan.test.v1',
    manifestHash: 'cross-process-manifest-001',
    input: { source: 'cross-process' },
    requestModel: 'cross-model',
    resultFileName: 'result.json',
    resultMaxBytes: 4096,
    proxyMaxCalls: 4,
    callback: { event: 'cross-process.completed', retries: 1 },
    agentListenerUrl: 'http://web-internal:7201',
    inputFiles: { 'input/source.txt': 'cross-process input' },
    prompt: 'Write the deterministic result.json fixture.',
    timeoutMs: 60_000,
    expiresAt: Date.now() + 60_000,
  };
}

async function startRunnerProcess() {
  const child = spawn(process.execPath, [__filename, '--runner'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, SIDECAR_TEST_SECRET: SECRET },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let errorOutput = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const address = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`runner child 启动超时：${errorOutput}`)), 5000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/READY (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr.on('data', (chunk) => { errorOutput += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code && !output.includes('READY')) reject(new Error(`runner child 退出 ${code}：${errorOutput}`));
    });
  });
  return { child, baseUrl: `http://127.0.0.1:${address}` };
}

async function runRunnerProcess() {
  const { createSidecarCoordinator } = require('../server/agent-sidecar/sidecarCoordinator.cjs');
  const { createRunnerApi, createRunnerHttpServer } = require('../server/agent-sidecar/runnerApi.cjs');
  const tokenManager = createTokenManager({ secret: process.env.SIDECAR_TEST_SECRET, statelessDispatch: true, statelessProxy: true });
  const coordinator = createSidecarCoordinator({ tokenManager });
  const server = createRunnerHttpServer({ api: createRunnerApi({ coordinator }), host: '127.0.0.1', port: 0 });
  const address = await server.start();
  process.stdout.write(`READY ${address.port}\n`);
  const stop = async () => {
    await server.close().catch(() => undefined);
    coordinator.close('cross process test');
    tokenManager.close();
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

async function main() {
  if (process.argv[2] === '--runner') {
    await runRunnerProcess();
    return;
  }

  const webTokenManager = createTokenManager({ secret: SECRET });
  const webInternalApi = createInternalAgentApi({
    tokenManager: webTokenManager,
    chatHandler: async () => ({ ok: true }),
  });
  const internalServer = createInternalAgentHttpServer({ api: webInternalApi, host: '127.0.0.1', port: 0 });
  const internalAddress = await internalServer.start();
  const internalBaseUrl = `http://127.0.0.1:${internalAddress.port}`;
  const processRuntime = await startRunnerProcess();
  try {
    const envelope = makeEnvelope();
    const proxyTokens = webInternalApi.issueExecutionTokens(envelope);
    const dispatchToken = webTokenManager.issueDispatchToken({
      workspaceId: envelope.workspaceId,
      workspaceGeneration: envelope.workspaceGeneration,
      executionId: envelope.executionId,
      taskSpecId: envelope.taskSpecId,
      manifestHash: envelope.manifestHash,
    });
    const created = await requestJson(processRuntime.baseUrl, buildRunnerCreatePath(), {
      method: PROTOCOL_METHODS.POST,
      token: dispatchToken,
      body: { ...envelope, ...proxyTokens },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.created, true, '独立 Runner runtime 应接受 Web runtime 签发的 dispatch');
    assert.equal(created.body.proxyToken, proxyTokens.proxyToken, 'Runner 必须复用 Web internal listener 签发的 proxy token');

    const capability = await requestJson(internalBaseUrl, `/internal/agent/v1/executions/${encodeURIComponent(envelope.executionId)}/capability`, {
      token: proxyTokens.capabilityToken,
    });
    assert.equal(capability.status, 200);
    assert.equal(capability.body.executionId, envelope.executionId);
    const chat = await requestJson(internalBaseUrl, '/internal/agent/v1/chat/completions', {
      method: 'POST',
      token: proxyTokens.proxyToken,
      body: { executionId: envelope.executionId, messages: [{ role: 'user', content: 'listener check' }], model: envelope.requestModel, stream: false },
    });
    assert.equal(chat.status, 200);
    assert.equal(chat.body.ok, true, 'Web internal listener 必须验证并消费 proxy token');

    const replay = await requestJson(processRuntime.baseUrl, buildRunnerCreatePath(), {
      method: PROTOCOL_METHODS.POST,
      token: dispatchToken,
      body: { ...envelope, ...proxyTokens },
    });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, SIDE_CAR_ERROR_CODES.TOKEN_REPLAY);

    const wrongWorkspace = makeEnvelope('cross-workspace-b');
    const wrongToken = webTokenManager.issueDispatchToken({
      workspaceId: wrongWorkspace.workspaceId,
      workspaceGeneration: wrongWorkspace.workspaceGeneration,
      executionId: wrongWorkspace.executionId,
      taskSpecId: wrongWorkspace.taskSpecId,
      manifestHash: wrongWorkspace.manifestHash,
    });
    const wrong = await requestJson(processRuntime.baseUrl, buildRunnerCreatePath(), {
      method: PROTOCOL_METHODS.POST,
      token: wrongToken,
      body: { ...envelope, ...proxyTokens },
    });
    assert.equal(wrong.status, 401, 'workspace token 混用必须拒绝');
    assert.equal(wrong.body.error.code, SIDE_CAR_ERROR_CODES.BINDING_MISMATCH);

    const cancelled = await requestJson(processRuntime.baseUrl, buildRunnerCancelPath(envelope.executionId), {
      method: PROTOCOL_METHODS.DELETE,
      token: proxyTokens.cancelToken,
      body: { reason: 'cross-process-cleanup' },
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.cancelled, true);
    console.log('PASS: Web issuer + independent Runner verifier cross-process token ownership');
  } finally {
    processRuntime.child.kill('SIGTERM');
    await new Promise((resolve) => processRuntime.child.once('exit', resolve));
    await internalServer.close();
    webTokenManager.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
