const assert = require('node:assert/strict');
const {
  PROTOCOL_METHODS,
  buildChatPath,
  buildCapabilityPath,
  buildRunnerCancelPath,
  buildRunnerStatusPath,
} = require('../shared/contracts/agent-sidecar/sidecarProtocolV1.cjs');
const { createTokenManager } = require('../server/agent-sidecar/tokenService.cjs');
const { createSidecarCoordinator } = require('../server/agent-sidecar/sidecarCoordinator.cjs');

function makeEnvelope(executionId, workspaceId = 'crash-workspace-a') {
  return {
    executionId,
    workspaceId,
    workspaceGeneration: 1,
    taskSpecId: 'technical-plan.crash.v1',
    manifestHash: `crash-manifest-${executionId}`,
    input: { executionId },
    requestModel: 'crash-model',
    resultFileName: 'result.json',
    resultMaxBytes: 4096,
    proxyMaxCalls: 4,
    callback: { event: 'crash-window', retries: 2 },
    expiresAt: Date.now() + 60_000,
  };
}

function issue(manager, envelope) {
  return manager.issueDispatchToken({
    workspaceId: envelope.workspaceId,
    workspaceGeneration: envelope.workspaceGeneration,
    executionId: envelope.executionId,
    taskSpecId: envelope.taskSpecId,
    manifestHash: envelope.manifestHash,
  });
}

function runCase(name, callback) {
  return Promise.resolve().then(callback).then(() => name);
}

async function main() {
  const calls = [];
  const executionRunner = {
    start(execution, { onStarted, onResult, onError }) {
      calls.push({ type: 'start', executionId: execution.executionId });
      if (execution.executionId.includes('timeout')) {
        queueMicrotask(() => onError({ code: 'AGENT_TIMEOUT', message: 'deadline reached', retryable: true }));
      } else if (execution.executionId.includes('failure')) {
        queueMicrotask(() => onError({ code: 'AGENT_RUNTIME_FAILED', message: 'runner crashed', retryable: true }));
      } else {
        queueMicrotask(() => {
          onStarted();
          onResult({ success: true, result: { executionId: execution.executionId } });
        });
      }
      return Promise.resolve();
    },
    cancel(executionId, reason) {
      calls.push({ type: 'cancel', executionId, reason });
      return true;
    },
  };
  const manager = createTokenManager({ secret: 'crash-window-secret' });
  const coordinator = createSidecarCoordinator({ tokenManager: manager, executionRunner });
  const cases = [];
  try {
    cases.push(await runCase('success receipt can be read once and is stable on retry', async () => {
      const envelope = makeEnvelope('crash-retry');
      const created = coordinator.createExecution(envelope, issue(manager, envelope));
      await new Promise((resolve) => setImmediate(resolve));
      const first = coordinator.getExecutionResult(created.executionId, created.statusToken);
      const second = coordinator.getExecutionResult(created.executionId, created.statusToken);
      assert.equal(first.status, 'succeeded');
      assert.deepEqual(second.result, first.result);
      assert.equal(calls.filter((item) => item.type === 'start' && item.executionId === envelope.executionId).length, 1);
    }));

    cases.push(await runCase('timeout preserves AGENT_TIMEOUT and releases active slot', async () => {
      const envelope = makeEnvelope('crash-timeout');
      const created = coordinator.createExecution(envelope, issue(manager, envelope));
      await new Promise((resolve) => setImmediate(resolve));
      const status = coordinator.getExecutionResult(created.executionId, created.statusToken);
      assert.equal(status.status, 'failed');
      assert.equal(status.failure.code, 'AGENT_TIMEOUT');
      assert.equal(coordinator.getState().active, 0);
    }));

    cases.push(await runCase('cancel is idempotent and does not leak proxy capability', async () => {
      const envelope = makeEnvelope('crash-cancel');
      const created = coordinator.createExecution(envelope, issue(manager, envelope));
      const first = coordinator.cancelExecution(created.executionId, created.cancelToken, { reason: 'user-cancel' });
      const second = coordinator.cancelExecution(created.executionId, created.cancelToken, { reason: 'retry-cancel' });
      assert.equal(first.cancelled, true);
      assert.equal(second.idempotent, true);
      assert.equal(second.reason, 'user-cancel');
    }));

    cases.push(await runCase('close cancels outstanding execution and redacts token-like diagnostics', async () => {
      const slowRunner = {
        start() { return new Promise(() => {}); },
        cancel(executionId, reason) { calls.push({ type: 'cancel', executionId, reason }); return true; },
      };
      const closeManager = createTokenManager({ secret: 'close-secret' });
      const closeCoordinator = createSidecarCoordinator({ tokenManager: closeManager, executionRunner: slowRunner });
      const envelope = makeEnvelope('crash-close');
      const created = closeCoordinator.createExecution(envelope, issue(closeManager, envelope));
      closeCoordinator.setExecutionFailure(created.executionId, { code: 'AGENT_RUNTIME_FAILED', message: 'Bearer super-secret-token secret=hidden', retryable: false });
      const status = closeCoordinator.getExecutionResult(created.executionId, created.statusToken);
      assert.doesNotMatch(status.failure.message, /super-secret-token|hidden/);
      closeCoordinator.close('shutdown');
      closeManager.close();
    }));
  } finally {
    coordinator.close('crash window test complete');
    manager.close();
  }
  assert.equal(cases.length, 4);
  assert.equal(calls.some((item) => item.type === 'cancel'), true);
  console.log(`PASS: Sidecar crash windows (${cases.join(', ')})`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
