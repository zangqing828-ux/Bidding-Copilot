const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTokenManager } = require('../server/agent-sidecar/tokenService.cjs');
const { createInternalAgentApi, createInternalAgentHttpServer } = require('../server/agent-sidecar/internalListener.cjs');
const { createSidecarCoordinator } = require('../server/agent-sidecar/sidecarCoordinator.cjs');
const { createRunnerApi, createRunnerHttpServer } = require('../server/agent-sidecar/runnerApi.cjs');
const { createWebSidecarAgentAdapter } = require('../server/agent-sidecar/webSidecarClient.cjs');
const { createSidecarExecutionService } = require('../agent-runner/executionService.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bidmaster-sidecar-execution-'));
const fixtureDir = path.join(__dirname, 'fixtures');
const fixtureBinary = path.join(fixtureDir, 'opencode-tool-call-fixture.cjs');
const prlimitBinary = path.join(fixtureDir, 'prlimit-fixture.cjs');
fs.chmodSync(fixtureBinary, 0o755);
fs.chmodSync(prlimitBinary, 0o755);

function completion(message, finishReason = 'stop') {
  return {
    id: 'fixture-completion',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'fixture-model',
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
}

async function main() {
  const webTokens = createTokenManager({ secret: 'execution-test-secret' });
  let calls = 0;
  const internalApi = createInternalAgentApi({
    tokenManager: webTokens,
    chatHandler: async (request) => {
      calls += 1;
      if (calls === 1) {
        return completion({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-write-result',
            type: 'function',
            function: { name: 'write', arguments: JSON.stringify({ filePath: 'result.json', content: JSON.stringify({ ok: true, source: 'real-runner-execution' }) }) },
          }],
        }, 'tool_calls');
      }
      assert.equal(request.messages.some((message) => message.role === 'tool'), true, '第二轮必须携带工具执行结果');
      return completion({ role: 'assistant', content: 'result.json 已写入。' });
    },
  });
  const internalServer = createInternalAgentHttpServer({ api: internalApi, host: '127.0.0.1', port: 0 });
  const internalAddress = await internalServer.start();
  const runnerEnv = {
    ...process.env,
    YIBIAO_WEB_OPENCODE_BIN: fixtureBinary,
    YIBIAO_WEB_PRLIMIT_BIN: prlimitBinary,
  };
  const executionService = createSidecarExecutionService({ env: runnerEnv, workspaceRoot: root });
  const runnerTokens = createTokenManager({ secret: 'execution-test-secret', statelessDispatch: true, statelessProxy: true });
  const coordinator = createSidecarCoordinator({ tokenManager: runnerTokens, executionRunner: executionService });
  const runnerServer = createRunnerHttpServer({ api: createRunnerApi({ coordinator }), host: '127.0.0.1', port: 0 });
  const runnerAddress = await runnerServer.start();
  const adapter = createWebSidecarAgentAdapter({
    workspaceId: 'execution-workspace-001',
    workspaceGeneration: 1,
    tokenManager: webTokens,
    internalApi,
    runnerUrl: `http://127.0.0.1:${runnerAddress.port}`,
    agentListenerUrl: `http://127.0.0.1:${internalAddress.port}`,
    pollIntervalMs: 20,
  });
  try {
    const result = await adapter.run({
      executionId: 'execution-real-child-001',
      taskSpec: { id: 'technical-plan.test.v1', version: 1, limits: { maxOutputBytes: 4096, maxModelCalls: 4 } },
      input: { request: 'write deterministic result' },
      inputFiles: { 'input/source.txt': 'runner input is read-only' },
      prompt: 'Use the allowed write tool to create result.json.',
      modelSnapshot: { provider: 'fixture', modelName: 'fixture-model', baseUrl: 'http://internal.invalid' },
      timeoutMs: 20_000,
    });
    assert.deepEqual(result.output, { ok: true, source: 'real-runner-execution' });
    assert.equal(calls, 2, 'Runner 必须通过 Web internal listener 完成两轮 tool-call');
    assert.equal(executionService.getActiveCount(), 0, '执行完成后释放 Runner active slot');
    assert.equal(fs.existsSync(path.join(root, '.agent-tasks')), false, 'execution workspace 完成后必须清理');
    console.log('PASS: Sidecar child process execution, bounded workspace, two-round tool call and cleanup');
  } finally {
    await adapter.close();
    await runnerServer.close();
    await executionService.close();
    coordinator.close('execution test complete');
    runnerTokens.close();
    await internalServer.close();
    webTokens.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  process.exitCode = 1;
});
