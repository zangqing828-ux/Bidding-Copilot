const assert = require('node:assert/strict');

const {
  createGracefulShutdownHandler,
  SHUTDOWN_TIMEOUT_MS,
} = require('../server/index.cjs');

const passed = [];
const failed = [];

async function run(name, fn) {
  try {
    await fn();
    passed.push(name);
    console.log(`  PASS: ${name}`);
  } catch (error) {
    failed.push(`${name}: ${error.message}`);
    console.error(`  FAIL: ${name}: ${error.message}`);
  }
}

function createLogger() {
  const logs = [];
  return {
    logs,
    log: (...args) => logs.push(['log', ...args]),
    warn: (...args) => logs.push(['warn', ...args]),
    error: (...args) => logs.push(['error', ...args]),
  };
}

function createExitSpy() {
  const calls = [];
  return {
    calls,
    exit: (code) => calls.push(code),
  };
}

function createServer({ error = null, delayMs = 0, hang = false } = {}) {
  return {
    close(callback) {
      if (hang) {
        return;
      }
      if (delayMs > 0) {
        setTimeout(() => callback(error), delayMs);
        return;
      }
      callback(error);
    },
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests() {
  await run('closeAll 异步成功时 await 后 exit 0 且重复信号不双退', async () => {
    const logger = createLogger();
    const exit = createExitSpy();
    let closeCalls = 0;
    const gracefulShutdown = createGracefulShutdownHandler({
      server: createServer({ delayMs: 2 }),
      closeAllFn: async () => {
        closeCalls += 1;
        await wait(2);
        return { closed: 2, failed: 0 };
      },
      logger,
      exit: exit.exit,
      timeoutMs: 100,
    });

    const first = gracefulShutdown('SIGTERM');
    const second = gracefulShutdown('SIGINT');
    assert.equal(first, second, '重复信号应共享同一关闭 Promise');
    await first;
    assert.equal(closeCalls, 1);
    assert.deepEqual(exit.calls, [0]);
    assert.equal(logger.logs.some((entry) => entry[1].includes('workspace 连接已释放')), true);
  });

  await run('closeAll failed>0 时 exit 1', async () => {
    const exit = createExitSpy();
    const gracefulShutdown = createGracefulShutdownHandler({
      server: createServer(),
      closeAllFn: async () => ({ closed: 1, failed: 2, errors: [new Error('a'), new Error('b')] }),
      logger: createLogger(),
      exit: exit.exit,
      timeoutMs: 100,
    });

    await gracefulShutdown('SIGINT');
    assert.deepEqual(exit.calls, [1]);
  });

  await run('closeAll reject 时 exit 1', async () => {
    const exit = createExitSpy();
    const gracefulShutdown = createGracefulShutdownHandler({
      server: createServer(),
      closeAllFn: async () => {
        throw new Error('async close failed');
      },
      logger: createLogger(),
      exit: exit.exit,
      timeoutMs: 100,
    });

    await gracefulShutdown('SIGTERM');
    assert.deepEqual(exit.calls, [1]);
  });

  await run('closeAll 同步 throw 时 exit 1', async () => {
    const exit = createExitSpy();
    const gracefulShutdown = createGracefulShutdownHandler({
      server: createServer(),
      closeAllFn: () => {
        throw new Error('sync close failed');
      },
      logger: createLogger(),
      exit: exit.exit,
      timeoutMs: 100,
    });

    await gracefulShutdown('SIGTERM');
    assert.deepEqual(exit.calls, [1]);
  });

  await run('关闭流程真实挂起超时 exit 1，完成回调不再二次 exit', async () => {
    const exit = createExitSpy();
    let resolveCloseAll;
    const closeAllPromise = new Promise((resolve) => {
      resolveCloseAll = resolve;
    });
    const gracefulShutdown = createGracefulShutdownHandler({
      server: createServer(),
      closeAllFn: () => closeAllPromise,
      logger: createLogger(),
      exit: exit.exit,
      timeoutMs: 5,
    });

    const shutdown = gracefulShutdown('SIGTERM');
    await wait(20);
    assert.deepEqual(exit.calls, [1]);
    resolveCloseAll({ closed: 1, failed: 0 });
    await shutdown;
    assert.deepEqual(exit.calls, [1]);
  });

  await run('HTTP server 关闭 reject 时 exit 1', async () => {
    const exit = createExitSpy();
    const gracefulShutdown = createGracefulShutdownHandler({
      server: createServer({ error: new Error('server close failed') }),
      closeAllFn: async () => ({ closed: 0, failed: 0 }),
      logger: createLogger(),
      exit: exit.exit,
      timeoutMs: 100,
    });

    await gracefulShutdown('SIGTERM');
    assert.deepEqual(exit.calls, [1]);
  });

  assert.equal(SHUTDOWN_TIMEOUT_MS, 10_000);
}

runTests().then(() => {
  console.log(`\n=== Web graceful shutdown 测试结果 ===`);
  console.log(`通过: ${passed.length}`);
  console.log(`失败: ${failed.length}`);
  if (failed.length > 0) {
    console.log('\n失败项:');
    failed.forEach((item) => console.log(`  - ${item}`));
    process.exitCode = 1;
  }
}).catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
