const assert = require('node:assert/strict');
const { createAgentCoordinator } = require('../server/agent/agentCoordinator.cjs');

const passed = [];
const failed = [];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function run(name, callback) {
  try {
    await callback();
    passed.push(name);
    console.log(`  PASS: ${name}`);
  } catch (error) {
    failed.push(`${name}: ${error.message}`);
    console.error(`  FAIL: ${name}: ${error.message}`);
  }
}

function envelope(suffix = '1') {
  return {
    taskSpecId: 'contract-fixture',
    taskSpecVersion: 1,
    inputRevision: `revision-${suffix}`,
    inputHash: `hash-${suffix}`,
  };
}

async function main() {
  await run('相同 workspace 与 execution 会去重，不同 envelope 会失败', async () => {
    const coordinator = createAgentCoordinator();
    const first = coordinator.reserve({ workspaceId: 'a', executionId: 'same', envelope: envelope() });
    const second = coordinator.reserve({ workspaceId: 'a', executionId: 'same', envelope: envelope() });
    assert.strictEqual(first, second);
    assert.throws(
      () => coordinator.reserve({ workspaceId: 'a', executionId: 'same', envelope: envelope('changed') }),
      (error) => error?.code === 'AGENT_EXECUTION_CONFLICT',
    );
    first.cancel();
    await assert.rejects(first.completion, (error) => error?.code === 'AGENT_CANCELLED');
  });

  await run('跨 workspace round-robin，workspace 内保持 FIFO', async () => {
    const coordinator = createAgentCoordinator({ limits: { globalActive: 1, globalQueued: 4, workspaceQueued: 2 } });
    const gate = deferred();
    const order = [];
    const a1 = coordinator.reserve({ workspaceId: 'a', executionId: 'a1', envelope: envelope('a1') });
    const a2 = coordinator.reserve({ workspaceId: 'a', executionId: 'a2', envelope: envelope('a2') });
    const b1 = coordinator.reserve({ workspaceId: 'b', executionId: 'b1', envelope: envelope('b1') });
    const a1Done = a1.admit(async () => { order.push('a1'); await gate.promise; return 'a1'; });
    const a2Done = a2.admit(async () => { order.push('a2'); return 'a2'; });
    const b1Done = b1.admit(async () => { order.push('b1'); return 'b1'; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ['a1']);
    gate.resolve();
    await Promise.all([a1Done, a2Done, b1Done]);
    assert.deepEqual(order, ['a1', 'b1', 'a2']);
  });

  await run('Workspace 与全局排队上限返回稳定过载错误', async () => {
    const coordinator = createAgentCoordinator({ limits: { globalActive: 1, globalQueued: 1, workspaceQueued: 1 } });
    const first = coordinator.reserve({ workspaceId: 'a', executionId: 'r1', envelope: envelope('r1') });
    assert.throws(
      () => coordinator.reserve({ workspaceId: 'a', executionId: 'r2', envelope: envelope('r2') }),
      (error) => error?.code === 'AGENT_QUEUE_OVERLOADED' && error.retryable === true && error.retryAfterSeconds === 5,
    );
    first.cancel();
    await assert.rejects(first.completion);
  });

  await run('取消 queued task 会立即移除，Workspace snapshot 归零', async () => {
    const coordinator = createAgentCoordinator({ limits: { globalActive: 1, globalQueued: 3, workspaceQueued: 2 } });
    const gate = deferred();
    const active = coordinator.reserve({ workspaceId: 'a', executionId: 'active', envelope: envelope('active') });
    const queued = coordinator.reserve({ workspaceId: 'a', executionId: 'queued', envelope: envelope('queued') });
    const activeDone = active.admit(async () => gate.promise);
    const queuedDone = queued.admit(async () => 'never');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(coordinator.getWorkspaceSnapshot('a').queued, 1);
    queued.cancel();
    await assert.rejects(queuedDone, (error) => error?.code === 'AGENT_CANCELLED');
    assert.equal(coordinator.getWorkspaceSnapshot('a').queued, 0);
    gate.resolve('done');
    await activeDone;
    assert.deepEqual(coordinator.getWorkspaceSnapshot('a'), { reserved: 0, admitting: 0, active: 0, queued: 0, cleanup: 0 });
  });

  await run('beginClosing 取消现存 reservation 并拒绝新 reservation', async () => {
    const coordinator = createAgentCoordinator();
    const reservation = coordinator.reserve({ workspaceId: 'a', executionId: 'close', envelope: envelope('close') });
    coordinator.beginClosing();
    await assert.rejects(reservation.completion, (error) => error?.code === 'AGENT_CLOSING');
    assert.throws(
      () => coordinator.reserve({ workspaceId: 'a', executionId: 'later', envelope: envelope('later') }),
      (error) => error?.code === 'AGENT_CLOSING',
    );
  });
}

main().finally(() => {
  console.log(`Web Agent Coordinator 测试：${passed.length} 通过，${failed.length} 失败`);
  for (const message of failed) console.error(`  FAIL: ${message}`);
  process.exitCode = failed.length ? 1 : 0;
});
