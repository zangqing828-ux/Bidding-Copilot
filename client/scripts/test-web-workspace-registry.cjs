const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createWorkspaceRegistry } = require('../server/workspace/workspaceRegistry.cjs');

const passed = [];
const failed = [];

function run(name, callback) {
  try {
    callback();
    passed.push(name);
    console.log(`  PASS: ${name}`);
  } catch (error) {
    failed.push(`${name}: ${error.message}`);
    console.error(`  FAIL: ${name}: ${error.message}`);
  }
}

async function runAsync(name, callback) {
  try {
    await callback();
    passed.push(name);
    console.log(`  PASS: ${name}`);
  } catch (error) {
    failed.push(`${name}: ${error.message}`);
    console.error(`  FAIL: ${name}: ${error.message}`);
  }
}

function waitFor(predicate, timeoutMs = 1200) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('等待 workspace registry 状态超时'));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

function createFakeContextFactory(states, closeCounts) {
  return ({ workspaceId }) => {
    const state = {
      taskCount: 0,
      aiActive: 0,
      aiQueued: 0,
      failClose: false,
      closeGate: null,
    };
    states.set(workspaceId, state);
    return {
      workspaceId,
      getActivitySnapshot() {
        return {
          activeTaskCount: state.taskCount,
          aiActiveCount: state.aiActive,
          aiQueuedCount: state.aiQueued,
          active: state.taskCount > 0 || state.aiActive > 0 || state.aiQueued > 0,
          unknown: false,
        };
      },
      close() {
        closeCounts.set(workspaceId, (closeCounts.get(workspaceId) || 0) + 1);
        if (state.failClose) {
          return Promise.reject(new Error(`close failed: ${workspaceId}`));
        }
        return state.closeGate || Promise.resolve();
      },
    };
  };
}

function createTestRegistry(states = new Map(), closeCounts = new Map(), registryOptions = {}) {
  return {
    registry: createWorkspaceRegistry({
      dataDir: '/tmp/web-workspace-registry-test',
      createContext: createFakeContextFactory(states, closeCounts),
      idleTtlMs: 25,
      sweepIntervalMs: 5,
      ...registryOptions,
    }),
    states,
    closeCounts,
  };
}

async function main() {
  await runAsync('registry 创建 100 个上下文并通过 TTL 自动回收', async () => {
    const { registry, closeCounts } = createTestRegistry();
    for (let index = 0; index < 100; index += 1) {
      registry.getWorkspaceContext(`account-${index}`);
    }
    assert.equal(registry.getStatus().size, 100);
    await waitFor(() => registry.getStatus().size === 0);
    assert.equal(closeCounts.size, 100);
    assert([...closeCounts.values()].every((count) => count === 1));
    assert.equal(registry.getStatus().timerActive, false);
  });

  await runAsync('同一账号多 lease 在 SSE 断开前阻止回收，全部 release 后可回收', async () => {
    const { registry } = createTestRegistry();
    const first = registry.acquireWorkspaceContext('sse-account');
    const second = registry.acquireWorkspaceContext('sse-account');
    assert.equal(registry.getStatus().entries[0].leaseCount, 2);
    first.release();
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.equal(registry.getStatus().size, 1);
    second.release();
    await waitFor(() => registry.getStatus().size === 0);
  });

  await runAsync('active task、AI active 和 AI queued 均延后回收，清空后自动回收', async () => {
    const { registry, states } = createTestRegistry();
    const context = registry.getWorkspaceContext('active-account');
    const state = states.get('active-account');
    state.taskCount = 1;
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.equal(registry.getStatus().size, 1);
    state.taskCount = 0;
    state.aiActive = 1;
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.equal(registry.getStatus().size, 1);
    state.aiActive = 0;
    state.aiQueued = 1;
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.equal(registry.getStatus().size, 1);
    state.aiQueued = 0;
    assert.equal(context.workspaceId, 'active-account');
    await waitFor(() => registry.getStatus().size === 0);
  });

  await runAsync('close 失败保留上下文并可重试，closeAll 清理定时器', async () => {
    const states = new Map();
    const { registry } = createTestRegistry(states);
    const context = registry.getWorkspaceContext('retry-account');
    states.get('retry-account').failClose = true;
    await new Promise((resolve) => setTimeout(resolve, 45));
    const afterFailure = registry.getStatus();
    assert.equal(afterFailure.size, 1);
    assert(afterFailure.entries[0].closeAttempts >= 1);
    assert(afterFailure.entries[0].closeError.includes('close failed'));
    states.get('retry-account').failClose = false;
    const closeResult = await registry.closeAll();
    assert.equal(closeResult.failed, 0);
    assert.equal(registry.getStatus().size, 0);
    assert.equal(registry.getStatus().timerActive, false);
    assert.equal(context.workspaceId, 'retry-account');
  });

  await runAsync('closeAll 等待异步 close，失败准确计数并保留失败上下文', async () => {
    const states = new Map();
    const { registry } = createTestRegistry(states, new Map(), {
      idleTtlMs: 10_000,
      sweepIntervalMs: 10_000,
    });
    registry.getWorkspaceContext('async-failed-account');
    registry.getWorkspaceContext('async-success-account');
    states.get('async-failed-account').failClose = true;

    const closeResult = await registry.closeAll();
    assert.equal(closeResult.closed, 1);
    assert.equal(closeResult.failed, 1);
    assert.equal(registry.getStatus().size, 1);
    assert.equal(registry.getStatus().entries[0].workspaceId, 'async-failed-account');

    states.get('async-failed-account').failClose = false;
    assert.equal(await registry.closeWorkspaceContext('async-failed-account'), true);
    assert.equal(registry.getStatus().size, 0);
  });

  await runAsync('并发重复 close 共享同一异步关闭并避免双关', async () => {
    const states = new Map();
    const closeCounts = new Map();
    const { registry } = createTestRegistry(states, closeCounts, {
      idleTtlMs: 10_000,
      sweepIntervalMs: 10_000,
    });
    registry.getWorkspaceContext('concurrent-account');
    let resolveClose;
    states.get('concurrent-account').closeGate = new Promise((resolve) => {
      resolveClose = resolve;
    });

    const first = registry.closeWorkspaceContext('concurrent-account');
    const second = registry.closeWorkspaceContext('concurrent-account');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closeCounts.get('concurrent-account'), 1);
    resolveClose();
    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.equal(closeCounts.get('concurrent-account'), 1);
    assert.equal(registry.getStatus().size, 0);
  });

  run('SSE 路由通过 acquire/release lease 管理连接生命周期', () => {
    const source = fs.readFileSync(path.join(__dirname, '../server/routes/sse.cjs'), 'utf8');
    assert(source.includes('acquireWorkspaceContext'), 'SSE 必须 acquire workspace lease');
    assert(source.includes('lease.release()'), 'SSE 断开必须 release workspace lease');
  });

  console.log(`\n=== Web workspace registry 测试结果 ===`);
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
