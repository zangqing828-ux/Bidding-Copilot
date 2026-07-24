const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const coreWorkspacePaths = require('../core/workspacePaths.cjs');
const { assertPort, PORT_METHODS } = require('../core/ports.cjs');
const { createTaskEventPort } = require('../core/taskEventPort.cjs');
const { createWorkspaceContext } = require('../server/workspace/workspaceContext.cjs');

const tests = [];
const passes = [];
const fails = [];
const trackedTempDirs = new Set();

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function expectThrow(fn, message) {
  let captured;
  try {
    fn();
  } catch (error) {
    captured = error;
  }
  tests.push(message);
  if (!captured) {
    fails.push(`${message}（未抛错）`);
  }
  return captured;
}

function run(name, fn) {
  try {
    fn();
    passes.push(name);
    return true;
  } catch (error) {
    fails.push(`${name}: ${error.message}`);
    return false;
  }
}

function trackTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  trackedTempDirs.add(dir);
  return dir;
}

function cleanupTempDir(dir, label = '临时目录') {
  if (!dir) {
    return;
  }
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    trackedTempDirs.delete(dir);
  } catch (error) {
    throw new Error(`${label} 清理失败: ${error.message}`);
  }
}

function cleanupTrackedDirs() {
  for (const dir of Array.from(trackedTempDirs)) {
    cleanupTempDir(dir, `临时目录 ${dir}`);
  }
}

function snapshotActiveHandles() {
  const handleTypes = Object.create(null);
  const handles = process._getActiveHandles() || [];
  for (const handle of handles) {
    const name = handle?.constructor?.name || 'Unknown';
    handleTypes[name] = (handleTypes[name] || 0) + 1;
  }
  return { count: handles.length, types: handleTypes };
}

function withBlockedElectronRequire() {
  const factoryPath = path.resolve(__dirname, '../server/workspace/workspaceRuntimeFactory.cjs');
  const script = `
    const Module = require('node:module');
    const factoryPath = ${JSON.stringify(factoryPath)};
    const originalLoad = Module._load;

    Module._load = function blockedLoad(request, parent, isMain) {
      if (request === 'electron' || request === 'node:electron' || (typeof request === 'string' && request.startsWith('electron/'))) {
        throw new Error('electron 依赖被禁止: ' + request);
      }
      return originalLoad.apply(this, arguments);
    };

    try {
      const factoryModule = require(factoryPath);
      if (!factoryModule || typeof factoryModule.createWorkspaceRuntimeFactory !== 'function') {
        console.error('factory not loaded');
        process.exit(1);
      }
      process.exit(0);
    } catch (error) {
      console.error(error && error.stack ? error.stack : String(error));
      process.exit(1);
    }
  `;

  const result = spawnSync(process.execPath, ['--eval', script], {
    encoding: 'utf8',
    cwd: process.cwd(),
    env: process.env,
  });
  if (result.error) {
    throw result.error;
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}

run('ports: 七类契约声明完整且字段缺失可定位', () => {
  assert(Object.keys(PORT_METHODS).length === 7, 'ports: 需保留七类端口声明');
  assert(Array.isArray(PORT_METHODS.fileParser), 'ports: fileParser 声明存在');
  assert(Array.isArray(PORT_METHODS.renderer), 'ports: renderer 声明存在');
  assert(Array.isArray(PORT_METHODS.exporter), 'ports: exporter 声明存在');

  assertPort('config', { load: () => ({}), save: () => ({}) });
  assertPort('fileParser', { parseDocument: () => '' });
  assertPort('ai', {
    withQueueScope: () => ({}),
    pauseQueueScope: () => {},
    resumeQueueScope: () => {},
  });
  assertPort('agent', {
    bindSelectedRuntime: () => ({}),
    close: () => {},
  });
  assertPort('renderer', {
    renderMermaidToPng: () => Buffer.from(''),
    renderHtmlToPng: () => Buffer.from(''),
  });
  assertPort('exporter', { buildDocxBuffer: () => ({ success: true }) });
  assertPort('taskEvents', { subscribe: () => {}, close: () => {} });

  const bad = expectThrow(() => assertPort('config', { load: () => {} }), 'ports: 缺少 save 时应抛错');
  assert(bad instanceof Error && /缺少/.test(bad.message), 'ports: 缺少方法报错应包含“缺少”字样');
});

run('taskEvents: 多订阅/单独取消/关闭聚合错误/幂等', () => {
  const callbacks = new Set();
  const taskService = {
    subscribeCallback(callback) {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
  };

  const taskEvents = createTaskEventPort(taskService);
  let a = 0;
  let b = 0;

  const unsubscribeA = taskEvents.subscribe(() => {
    a += 1;
  });
  const unsubscribeB = taskEvents.subscribe(() => {
    b += 1;
  });
  const unsubscribeA2 = taskEvents.subscribe(() => {
    a += 1;
  });

  for (const cb of [...callbacks]) {
    cb({});
  }
  assert(a === 2 && b === 1, 'taskEvents: 三订阅应分发到全部');

  unsubscribeA();
  for (const cb of [...callbacks]) {
    cb({});
  }
  assert(a === 3 && b === 2, 'taskEvents: A 取消后不再收到');

  unsubscribeA2();
  for (const cb of [...callbacks]) {
    cb({});
  }
  assert(a === 3 && b === 3, 'taskEvents: 仅 B 收到');
  const callbacksBeforeBUnsub = callbacks.size;
  unsubscribeB();
  assert(callbacks.size === callbacksBeforeBUnsub - 1, 'taskEvents: unsubscribeB 应移除订阅');

  const closeErrorTaskService = {
    subscribeCallback(callback) {
      return () => {
        throw new Error('close fail');
      };
    },
  };
  const closeErrorPort = createTaskEventPort(closeErrorTaskService);
  closeErrorPort.subscribe(() => {});
  closeErrorPort.subscribe(() => {});
  const closeErr = expectThrow(() => closeErrorPort.close(), 'taskEvents: close 应聚合全部订阅释放失败');
  assert(closeErr instanceof AggregateError, 'taskEvents: close 返回 AggregateError');
  assert(closeErr.errors.length === 2, 'taskEvents: close 聚合了两个订阅释放异常');
  closeErrorPort.close();

  const explicitUnsubscribeTaskService = {
    subscribeCallback() {
      return () => {
        throw new Error('explicit unsubscribe fail');
      };
    },
  };
  const explicitPort = createTaskEventPort(explicitUnsubscribeTaskService);
  const explicitUnsubscribe = explicitPort.subscribe(() => {});
  const explicitErr = expectThrow(() => explicitUnsubscribe(), 'taskEvents: 显式 unsubscribe 不应吞异常');
  assert(
    explicitErr instanceof Error && /explicit unsubscribe fail/.test(explicitErr.message),
    'taskEvents: 明确异常透传',
  );

  const invalidUnsubscribeTaskService = {
    subscribeCallback() {
      return null;
    },
  };
  const invalidPort = createTaskEventPort(invalidUnsubscribeTaskService);
  const invalidErr = expectThrow(() => invalidPort.subscribe(() => {}), 'taskEvents: subscribeCallback 非函数返回应报错');
  assert(invalidErr instanceof Error && /未返回取消订阅函数/.test(invalidErr.message), 'taskEvents: 非函数返回必须失败');

  taskEvents.close();
  assert(callbacks.size === 0, 'taskEvents: close 后内部分发集合应清空');
  taskEvents.close();

  explicitPort.close();
  const noOp = explicitPort.subscribe(() => {});
  noOp();

  let called = false;
  const noSideEffectPort = createTaskEventPort({
    subscribeCallback() {
      called = true;
      return () => {};
    },
  });
  noSideEffectPort.close();
  const closedSubscribe = noSideEffectPort.subscribe(() => {
    called = true;
  });
  closedSubscribe();
  assert(!called, 'taskEvents: 已关闭端口再次 subscribe 不应触发 taskService.subscribeCallback');
});

run('workspaceContext: 默认行为与显式 factory 注入', () => {
  const baseDir = trackTempDir('wc-ctx');
  let ctx;
  let ctx2;
  let fakeRuntime;
  let runtimeFactoryCalled = false;

  try {
    ctx = createWorkspaceContext({
      workspaceId: 'default-user',
      dataDir: baseDir,
    });

    const expectedWorkspaceRoot = path.join(baseDir, 'users', 'default-user', 'workspace');
    assert(ctx.workspaceId === 'default-user', 'context: workspaceId 保持不变');
    assert(ctx.workspaceRoot === expectedWorkspaceRoot, 'context: workspaceRoot 精确');
    assert(ctx.paths.databasePath === path.join(expectedWorkspaceRoot, 'yibiao.sqlite'), 'context: paths.databasePath 精确');
    assert(fs.existsSync(ctx.paths.uploadsDir), 'context: uploadsDir 已创建');
    assert(Boolean(ctx.stores), 'context: stores 存在');
    assert(Boolean(ctx.taskService), 'context: taskService 存在');
    assert(Boolean(ctx.taskEvents), 'context: taskEvents 新增存在');
    assert(typeof ctx.taskEvents.subscribe === 'function', 'context: taskEvents.subscribe 为函数');
    assert(typeof ctx.close === 'function', 'context: close 存在');
    assert(Boolean(ctx.db && ctx.db.open), 'context: db 初始打开');

    ctx.close();
    assert(ctx.db.open === false, 'context: close 后 db 关闭');

    ctx.close();

    fakeRuntime = {
      closeCalled: false,
      db: { open: true },
      sqliteDatabase: {
        close() {
          fakeRuntime.closeCalled = true;
          fakeRuntime.sqliteDatabase.closed = true;
        },
      },
      configStore: {},
      stores: {},
      taskService: {},
      taskEvents: { subscribe() {}, close() {} },
      close() {
        fakeRuntime.closeCalled = true;
      },
    };
    fakeRuntime.sqliteDatabase.closed = false;
    const runtimeFactory = (opts) => {
      runtimeFactoryCalled = true;
      assert(opts.workspaceId === 'injected-user', 'context: runtimeFactory 收到 workspaceId');
      assert(opts.paths?.databasePath === path.join(opts.workspaceRoot, 'yibiao.sqlite'), 'context: runtimeFactory 收到 databasePath');
      return fakeRuntime;
    };

    ctx2 = createWorkspaceContext({
      workspaceId: 'injected-user',
      dataDir: baseDir,
      runtimeFactory,
    });
    assert(runtimeFactoryCalled, 'context: runtimeFactory 显式注入被调用');
    ctx2.close();
    assert(fakeRuntime.closeCalled, 'context: runtime.close 被 context.close 转发');
  } finally {
    if (ctx) {
      ctx.close();
    }
    if (ctx2) {
      ctx2.close();
    }
    cleanupTempDir(baseDir, 'context 测试目录');
  }
});

run('workspaceRuntimeFactory: 中途失败回滚且原异常保留，electron 阻断环境可加载', () => {
  const baseDir = trackTempDir('wc-factory-fail');
  const workspaceRoot = path.join(baseDir, 'users', 'rollback-user', 'workspace');
  const paths = coreWorkspacePaths.resolveWorkspacePaths(workspaceRoot);
  fs.mkdirSync(paths.uploadsDir, { recursive: true });
  const sqlitePath = paths.databasePath;
  const configPath = path.join(baseDir, 'users', 'rollback-user', 'config.enc.json');

  const factoryModulePath = '../server/workspace/workspaceRuntimeFactory.cjs';
  const sqliteModulePath = require.resolve('../core/sqliteDatabase.cjs');
  const taskServiceModulePath = require.resolve('../electron/services/taskService.cjs');
  const runtimeFactoryPath = require.resolve(factoryModulePath);
  const originalLoad = Module._load;
  const realSqliteModule = originalLoad(sqliteModulePath);

  const expectedError = new Error('受控装配失败');
  let sqliteClosed = false;
  let caughtError;

  const overrides = new Map();
  overrides.set(sqliteModulePath, {
    createSqliteDatabase(config) {
      const sqliteDatabase = realSqliteModule.createSqliteDatabase(config);
      return {
        ...sqliteDatabase,
        close() {
          sqliteClosed = true;
          return sqliteDatabase.close();
        },
      };
    },
  });
  overrides.set(taskServiceModulePath, {
    createTaskService() {
      throw expectedError;
    },
  });

  try {
    Module._load = function loadWithOverrides(request, parent, isMain) {
      if (overrides.has(request)) {
        return overrides.get(request);
      }
      let resolved;
      try {
        resolved = Module._resolveFilename(request, parent, isMain);
      } catch {
        resolved = undefined;
      }
      if (resolved && overrides.has(path.resolve(resolved))) {
        return overrides.get(path.resolve(resolved));
      }
      return originalLoad.apply(this, [request, parent, isMain]);
    };

    delete require.cache[runtimeFactoryPath];
    const { createWorkspaceRuntimeFactory } = require(runtimeFactoryPath);
    caughtError = expectThrow(() => createWorkspaceRuntimeFactory({
      workspaceId: 'rollback-user',
      userDir: path.join(baseDir, 'users', 'rollback-user'),
      workspaceRoot,
      paths,
      databasePath: sqlitePath,
      configPath,
    }), 'factory 回滚: createWorkspaceRuntimeFactory 应抛原始异常');
  } finally {
    Module._load = originalLoad;
    delete require.cache[runtimeFactoryPath];
    assert(caughtError === expectedError, 'factory 回滚: 抛出原始异常对象');
    assert(sqliteClosed, 'factory 回滚: SQLite 已关闭');
    assert(!caughtError?.cleanupErrors, 'factory 回滚: 无清理失败时不挂载 cleanupErrors');
    cleanupTempDir(baseDir, 'factory 回滚测试目录');
  }

  const loadResult = withBlockedElectronRequire();
  assert(loadResult.ok, `factory: 阻断 electron 后 factory 可加载 (status=${loadResult.status})`);
});

run('workspaceRuntimeFactory: close 失败聚合，幂等并保留主语义', () => {
  const baseDir = trackTempDir('wc-factory-closeerr');
  const workspaceRoot = path.join(baseDir, 'users', 'closeerr', 'workspace');
  const paths = coreWorkspacePaths.resolveWorkspacePaths(workspaceRoot);
  const databasePath = paths.databasePath;
  const configPath = path.join(baseDir, 'users', 'closeerr', 'config.enc.json');
  const runtimeFactoryPath = require.resolve('../server/workspace/workspaceRuntimeFactory.cjs');
  const taskServicePath = require.resolve('../electron/services/taskService.cjs');
  const webServicesPath = require.resolve('../server/workspace/webServices.cjs');
  const originalLoad = Module._load;
  let runtime;

  try {
    const overrides = new Map();
    const realTaskService = originalLoad(taskServicePath);
    const realWebServices = originalLoad(webServicesPath);

    overrides.set(taskServicePath, {
      createTaskService(options) {
        const original = realTaskService.createTaskService(options);
        return {
          ...original,
          close() {
            throw new Error('taskService close fail');
          },
        };
      },
    });
    overrides.set(webServicesPath, {
      ...realWebServices,
      createWebAgentServiceStub() {
        const original = realWebServices.createWebAgentServiceStub();
        return {
          ...original,
          close() {
            throw new Error('agent close fail');
          },
        };
      },
    });

    Module._load = function loadWithOverrides(request, parent, isMain) {
      if (overrides.has(request)) {
        return overrides.get(request);
      }
      let resolved;
      try {
        resolved = Module._resolveFilename(request, parent, isMain);
      } catch {
        resolved = undefined;
      }
      if (resolved && overrides.has(path.resolve(resolved))) {
        return overrides.get(path.resolve(resolved));
      }
      return originalLoad.apply(this, [request, parent, isMain]);
    };

    delete require.cache[runtimeFactoryPath];
    const { createWorkspaceRuntimeFactory } = require(runtimeFactoryPath);
    runtime = createWorkspaceRuntimeFactory({
      workspaceId: 'closeerr',
      userDir: path.join(baseDir, 'users', 'closeerr'),
      workspaceRoot,
      paths,
      databasePath,
      configPath,
    });

    assert(!runtime.ports.fileParser, 'factory: 当前只装配 config/ai/agent/taskEvents');
    assert(!runtime.ports.renderer, 'factory: 当前只装配 config/ai/agent/taskEvents');
    assert(!runtime.ports.exporter, 'factory: 当前只装配 config/ai/agent/taskEvents');

    const closeErr = expectThrow(() => runtime.close(), 'factory.close: 聚合错误');
    assert(closeErr instanceof AggregateError, 'factory.close: 聚合关闭返回 AggregateError');
    assert(closeErr.errors.length === 2, 'factory.close: 聚合错误数为 2');
    assert(runtime.db.open === false, 'factory.close: 即使失败也应继续清理并关闭 db');

    try {
      runtime.close();
    } catch (closeSecondError) {
      throw new Error(`factory.close: 幂等调用不应抛错（${closeSecondError.message}）`);
    }
  } finally {
    Module._load = originalLoad;
    if (runtime?.taskService?.activeTasks?.size) {
      runtime.taskService.activeTasks.clear();
    }
    delete require.cache[runtimeFactoryPath];
    cleanupTempDir(baseDir, 'factory closeErr 测试目录');
  }
});

run('workspaceContext x100: create/close 不泄漏资源', () => {
  const baseDir = trackTempDir('wc-loop');
  const before = snapshotActiveHandles();
  let maxCount = before.count;
  const dbRefs = [];
  const iterationDeltas = [];

  try {
    for (let i = 0; i < 100; i += 1) {
      let ctx;
      let unsubscribe;
      const shouldUnsubscribe = i % 2 === 0;
      try {
        ctx = createWorkspaceContext({
          workspaceId: `wp-${String(i).padStart(3, '0')}`,
          dataDir: baseDir,
        });

        unsubscribe = ctx.taskEvents.subscribe(() => {});
        if (shouldUnsubscribe) {
          unsubscribe();
        }

        const db = ctx.db;
        assert(db && db.open, 'context loop: 上下文创建后 db 应打开');
        dbRefs.push(db);
      } finally {
        if (ctx) {
          ctx.close();
        }
        if (i % 2 === 0 && unsubscribe) {
          try {
            unsubscribe();
          } catch (error) {
            throw new Error(`context loop: 重复 unsubscribe 应不抛错（第 ${i} 次）`);
          }
        }

        const snapshot = snapshotActiveHandles();
        if (snapshot.count > maxCount) {
          maxCount = snapshot.count;
        }
        if (((i + 1) % 10 === 0) || ((i + 1) % 20 === 0)) {
          iterationDeltas.push({
            iteration: i + 1,
            count: snapshot.count,
            delta: snapshot.count - before.count,
          });
        }
      }
    }

    const after = snapshotActiveHandles();
    const maxDelta = maxCount - before.count;
    assert(maxDelta <= 16, `context loop: 创建期间句柄增长必须可控（max=${maxDelta}）`);
    assert(after.count - before.count <= 16, `context loop: 100 次 close 后句柄回落（delta=${after.count - before.count}）`);
    assert(dbRefs.length === 100, 'context loop: 已记录 100 个 db 引用');
    assert(dbRefs.every((db) => db && db.open === false), 'context loop: 全部 db 引用均已关闭');
    for (const sample of iterationDeltas) {
      assert(sample.delta <= 16, `context loop: 第 ${sample.iteration} 次句柄增量(${sample.delta}) 应稳定`);
    }
  } finally {
    cleanupTempDir(baseDir, 'workspace loop 测试目录');
  }
});

if (fails.length) {
  cleanupTrackedDirs();
  console.error(`\n=== Workspace 生命周期测试失败：${fails.length} ===`);
  fails.forEach((item) => {
    console.error(`- ${item}`);
  });
  process.exit(1);
}

cleanupTrackedDirs();
console.log(`\n=== Workspace 生命周期测试结果 ===`);
console.log(`通过: ${passes.length}`);
console.log(`失败: ${fails.length}`);
