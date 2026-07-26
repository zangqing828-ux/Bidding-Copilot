const assert = require('node:assert/strict');
const { createWorkspaceMutationExecutor } = require('../server/workspace/workspaceMutationExecutor.cjs');

async function main() {
  const executor = createWorkspaceMutationExecutor();
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

  const first = executor.execute(async () => {
    order.push('first:start');
    await firstGate;
    order.push('first:end');
    return 'first';
  });
  const second = executor.execute(async () => {
    order.push('second');
    return 'second';
  });

  await Promise.resolve();
  assert.deepEqual(executor.getStatus(), { active: 1, queued: 1, accepting: true });
  releaseFirst();
  assert.equal(await first, 'first');
  assert.equal(await second, 'second');
  assert.deepEqual(order, ['first:start', 'first:end', 'second']);

  await executor.close();
  await assert.rejects(
    () => executor.execute(() => undefined),
    (reason) => reason?.code === 'WORKSPACE_UNAVAILABLE' && reason?.retryable === true,
  );
  console.log('Workspace Mutation Executor tests passed.');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
