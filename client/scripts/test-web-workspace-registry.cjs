const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createWorkspaceRegistry } = require('../server/workspace/workspaceRegistry.cjs');

const passed = [];
const failed = [];

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

function createTestRegistry() {
  const state = {
    active: false,
    failClose: false,
    closeGate: null,
  };
  const counters = {
    create: 0,
    close: 0,
  };
  const registry = createWorkspaceRegistry({
    tenantId: 'tenant-test',
    dataDir: '/tmp/bidmaster-tenant-context-test',
    createContext({ workspaceId }) {
      counters.create += 1;
      const generation = counters.create;
      return {
        workspaceId,
        generation,
        getActivitySnapshot() {
          return {
            active: state.active,
            unknown: false,
          };
        },
        close() {
          counters.close += 1;
          if (state.failClose) {
            return Promise.reject(new Error('tenant close failed'));
          }
          return state.closeGate || Promise.resolve();
        },
      };
    },
  });
  return { registry, state, counters };
}

function assertUnavailable(callback, expectedState) {
  assert.throws(callback, (error) => (
    error?.code === 'WORKSPACE_UNAVAILABLE'
      && error?.state === expectedState
      && error?.retryable === true
  ));
}

async function main() {
  await run('同一 tenant ID 始终复用唯一上下文且不启动 TTL 定时器', async () => {
    const { registry, counters } = createTestRegistry();
    const first = registry.getWorkspaceContext('tenant-test');
    const second = registry.getWorkspaceContext('tenant-test');
    const lease = registry.acquireWorkspaceContext('tenant-test');
    assert.equal(first, second);
    assert.equal(first, lease.context);
    assert.equal(counters.create, 1);
    assert.equal(registry.getStatus().size, 1);
    assert.equal(registry.getStatus().entries[0].leaseCount, 1);
    assert.equal(lease.release(), true);
    assert.equal(lease.release(), false);
    assert.equal(registry.getStatus().size, 1);
    assert.equal('timerActive' in registry.getStatus(), false);
    assert.equal('idleTtlMs' in registry.getStatus(), false);
    await registry.closeAll();
  });

  await run('拒绝创建第二个 tenant 上下文', async () => {
    const { registry, counters } = createTestRegistry();
    registry.getWorkspaceContext('tenant-test');
    assert.throws(
      () => registry.getWorkspaceContext('tenant-other'),
      (error) => error?.code === 'TENANT_CONTEXT_MISMATCH',
    );
    assert.throws(
      () => registry.acquireWorkspaceContext('tenant-other'),
      (error) => error?.code === 'TENANT_CONTEXT_MISMATCH',
    );
    assert.equal(counters.create, 1);
    assert.equal(registry.getStatus().size, 1);
    await registry.closeAll();
  });

  await run('非强制关闭会保护 SSE lease 和活动任务', async () => {
    const { registry, state, counters } = createTestRegistry();
    const lease = registry.acquireWorkspaceContext('tenant-test');
    await assert.rejects(
      registry.closeWorkspaceContext('tenant-test'),
      (error) => error?.code === 'WORKSPACE_BUSY',
    );
    assert.equal(counters.close, 0);
    lease.release();

    state.active = true;
    await assert.rejects(
      registry.closeWorkspaceContext('tenant-test'),
      (error) => error?.code === 'WORKSPACE_BUSY',
    );
    assert.equal(counters.close, 0);

    state.active = false;
    assert.equal(await registry.closeWorkspaceContext('tenant-test'), true);
    assert.equal(counters.close, 1);
  });

  await run('关闭期间拒绝新请求，完成后可重建同一 tenant', async () => {
    const { registry, state, counters } = createTestRegistry();
    const original = registry.getWorkspaceContext('tenant-test');
    let resolveClose;
    state.closeGate = new Promise((resolve) => {
      resolveClose = resolve;
    });

    const closing = registry.closeWorkspaceContext('tenant-test', { force: true });
    assert.equal(registry.getStatus().entries[0].state, 'closing');
    assertUnavailable(() => registry.getWorkspaceContext('tenant-test'), 'closing');
    assertUnavailable(() => registry.acquireWorkspaceContext('tenant-test'), 'closing');
    assertUnavailable(() => registry.touchWorkspaceContext('tenant-test'), 'closing');

    resolveClose();
    assert.equal(await closing, true);
    assert.equal(registry.getStatus().size, 0);

    state.closeGate = null;
    const replacement = registry.getWorkspaceContext('tenant-test');
    assert.notEqual(replacement, original);
    assert.equal(replacement.generation, 2);
    assert.equal(counters.create, 2);
    await registry.closeAll();
  });

  await run('关闭失败会隔离上下文并允许显式重试', async () => {
    const { registry, state, counters } = createTestRegistry();
    registry.getWorkspaceContext('tenant-test');
    state.failClose = true;

    await assert.rejects(
      registry.closeWorkspaceContext('tenant-test', { force: true }),
      /tenant close failed/,
    );
    assert.equal(registry.getStatus().entries[0].state, 'close_failed');
    assertUnavailable(() => registry.getWorkspaceContext('tenant-test'), 'close_failed');

    state.failClose = false;
    assert.equal(await registry.closeWorkspaceContext('tenant-test', { force: true }), true);
    assert.equal(counters.close, 2);
    assert.equal(registry.getStatus().size, 0);
  });

  await run('并发 close 共享同一 Promise 且只关闭一次', async () => {
    const { registry, state, counters } = createTestRegistry();
    registry.getWorkspaceContext('tenant-test');
    let resolveClose;
    state.closeGate = new Promise((resolve) => {
      resolveClose = resolve;
    });

    const first = registry.closeWorkspaceContext('tenant-test', { force: true });
    const second = registry.closeWorkspaceContext('tenant-test', { force: true });
    assert.equal(first, second);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(counters.close, 1);
    resolveClose();
    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.equal(counters.close, 1);
  });

  await run('closeAll 准确报告失败并可在下一次调用恢复', async () => {
    const { registry, state, counters } = createTestRegistry();
    assert.deepEqual(await registry.closeAll(), { closed: 0, failed: 0, errors: [] });

    registry.getWorkspaceContext('tenant-test');
    state.failClose = true;
    const failedClose = await registry.closeAll();
    assert.equal(failedClose.closed, 0);
    assert.equal(failedClose.failed, 1);
    assert.equal(failedClose.errors.length, 1);
    assert.equal(registry.getStatus().entries[0].state, 'close_failed');

    state.failClose = false;
    const recovered = await registry.closeAll();
    assert.equal(recovered.closed, 1);
    assert.equal(recovered.failed, 0);
    assert.equal(counters.close, 2);
    assert.equal(registry.getStatus().size, 0);
  });

  await run('SSE 路由继续通过 acquire/release 管理连接生命周期', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../server/routes/sse.cjs'), 'utf8');
    assert(source.includes('acquireWorkspaceContext'));
    assert(source.includes('lease.release()'));
  });

  console.log('\n=== Web 单例 TenantContext 测试结果 ===');
  console.log(`通过: ${passed.length}`);
  console.log(`失败: ${failed.length}`);
  if (failed.length) {
    failed.forEach((message) => console.error(`- ${message}`));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
