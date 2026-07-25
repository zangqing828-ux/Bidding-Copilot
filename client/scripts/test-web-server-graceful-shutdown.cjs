const assert = require('node:assert/strict');

const {
  createGracefulShutdownHandler,
  SHUTDOWN_TIMEOUT_MS,
} = require('../server/index.cjs');

const passed = [];
const failed = [];

function run(name, fn) {
  try {
    fn();
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
    log: (...args) => {
      logs.push(['log', ...args]);
    },
    warn: (...args) => {
      logs.push(['warn', ...args]);
    },
    error: (...args) => {
      logs.push(['error', ...args]);
    },
  };
}

function createExitSpy() {
  const calls = [];
  return {
    calls,
    exit: (code) => {
      calls.push(code);
    },
  };
}

function createServer() {
  return {
    close: (callback) => {
      callback();
    },
  };
}

function runTest() {
  run('closeAll 成功时记录成功并 exit 0', () => {
    const logger = createLogger();
    const exit = createExitSpy();

    const gracefulShutdown = createGracefulShutdownHandler({
      server: createServer(),
      closeAllFn: () => ({ closed: 2, failed: 0 }),
      logger,
      exit: exit.exit,
      timeoutMs: 1,
    });

    gracefulShutdown('SIGTERM');

    assert.equal(exit.calls.length, 1);
    assert.equal(exit.calls[0], 0);
    assert.equal(logger.logs.some((entry) => entry[1].includes('workspace 连接已释放')), true);
    assert.equal(
      logger.logs.some((entry) => entry[0] === 'warn' && /失败数量/.test(entry[1])),
      false,
    );
  });

  run('closeAll 返回 failed>0 时记录失败数量并 exit 1', () => {
    const logger = createLogger();
    const exit = createExitSpy();

    const gracefulShutdown = createGracefulShutdownHandler({
      server: createServer(),
      closeAllFn: () => ({ closed: 1, failed: 2, errors: [new Error('a'), new Error('b')] }),
      logger,
      exit: exit.exit,
      timeoutMs: 1,
    });

    gracefulShutdown('SIGINT');

    assert.equal(exit.calls.length, 1);
    assert.equal(exit.calls[0], 1);
    assert.equal(
      logger.logs.some((entry) => {
        if (entry[0] !== 'warn') {
          return false;
        }
        const message = entry.slice(1).map((part) => String(part)).join('');
        return /失败数量/.test(message) && /2/.test(message);
      }),
      true,
    );
  });

  run('超时仍保持 10s 默认（常量）', () => {
    assert.equal(SHUTDOWN_TIMEOUT_MS, 10_000);
  });
}

runTest();

console.log(`\n=== Web graceful shutdown 测试结果 ===`);
console.log(`通过: ${passed.length}`);
console.log(`失败: ${failed.length}`);

if (failed.length > 0) {
  console.log('\n失败项:');
  failed.forEach((item) => {
    console.log(`  - ${item}`);
  });
  process.exitCode = 1;
}
