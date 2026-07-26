const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const coreWorkspacePaths = require('../core/workspacePaths.cjs');
const { assertPort, PORT_METHODS } = require('../core/ports.cjs');
const { createTaskEventPort } = require('../core/taskEventPort.cjs');
const { createWorkspaceContext } = require('../server/workspace/workspaceContext.cjs');

const passed = [];
const failed = [];
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
  if (!captured) {
    throw new Error(`${message}（未抛错）`);
  }
  return captured;
}

async function expectReject(fn, message) {
  let captured;
  try {
    await fn();
  } catch (error) {
    captured = error;
  }
  if (!captured) {
    throw new Error(`${message}（未拒绝）`);
  }
  return captured;
}

async function run(name, fn) {
  try {
    await fn();
    passed.push(name);
    return true;
  } catch (error) {
    failed.push(`${name}: ${error.message}`);
    return false;
  }
}

function trackTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  trackedTempDirs.add(dir);
  return dir;
}

function cleanupTempDir(dir, label = '临时目录') {
  if (!dir) return;
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

async function cleanupContext(ctx) {
  if (ctx && typeof ctx.close === 'function') {
    try {
      await ctx.close();
    } catch {
      // 需要在调用层统计
    }
  }
}

async function withTempDir(prefix, fn) {
  const dir = trackTempDir(prefix);
  try {
    return await fn(dir);
  } finally {
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
      const { createWorkspaceRuntimeFactory } = require(factoryPath);
      if (typeof createWorkspaceRuntimeFactory !== 'function') {
        throw new Error('工厂导出缺失');
      }
      process.exit(0);
    } catch (error) {
      console.error(error && error.stack ? error.stack : String(error));
      process.exit(1);
    } finally {
      Module._load = originalLoad;
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
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function main() {
await run('ports: 七类端口契约完整且缺失提示清晰', () => {
  assert(Object.keys(PORT_METHODS).length === 7, '必须是七类端口契约');
  assert(Array.isArray(PORT_METHODS.config) && PORT_METHODS.config.join(',') === 'load,save', 'config 契约不变');
  assert(Array.isArray(PORT_METHODS.fileParser), 'fileParser 契约存在');
  assert(Array.isArray(PORT_METHODS.renderer), 'renderer 契约存在');
  assert(Array.isArray(PORT_METHODS.exporter), 'exporter 契约存在');

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

  const bad = expectThrow(() => assertPort('config', { load: () => ({}) }), '缺少 save 应直接报错');
  assert(/缺少/.test(bad.message), '缺少方法错误需含“缺少”');
});

await run('taskEvents: 多订阅/单独取消/close 聚合/幂等/异常路径', () => {
  const incompleteService = {
    subscribeCount: 0,
    subscribeCallback() {
      this.subscribeCount += 1;
      return () => {};
    },
  };
  const incompleteServiceError = expectThrow(
    () => createTaskEventPort(incompleteService),
    '缺少 unsubscribeCallback 时构造应直接失败',
  );
  assert(
    /unsubscribeCallback/.test(incompleteServiceError.message),
    '缺少 unsubscribeCallback 的错误应明确指出方法名',
  );
  assert(incompleteService.subscribeCount === 0, '构造失败前不得注册任何订阅');

  const callbacks = new Set();
  const taskService = {
    subscribeCallback(callback) {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
    unsubscribeCallback(callback) {
      callbacks.delete(callback);
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

  for (const cb of Array.from(callbacks)) {
    cb({});
  }
  assert(a === 2 && b === 1, '三订阅发事件计数应正确');

  unsubscribeA();
  for (const cb of Array.from(callbacks)) {
    cb({});
  }
  assert(a === 3 && b === 2, 'A 取消后仅剩 B、A2');

  unsubscribeA2();
  for (const cb of Array.from(callbacks)) {
    cb({});
  }
  assert(a === 3 && b === 3, 'A2 取消后仅 B 收到');

  unsubscribeB();
  assert(callbacks.size === 0, '明确 unsubscribe 应清理本体');

  taskEvents.close();
  assert(callbacks.size === 0, 'taskEvents.close 后应清空 callbacks');
  taskEvents.close();

  const closeRetryService = {
    fallbackCallCount: 0,
    subscribeCallback(callback) {
      this.callCount = (this.callCount || 0) + 1;
      return () => {
        this.unsubscribeCall = (this.unsubscribeCall || 0) + 1;
        if (this.unsubscribeCall === 1) {
          throw new Error('first unsubscribe fail');
        }
      };
    },
    unsubscribeCallback() {
      this.fallbackCallCount = (this.fallbackCallCount || 0) + 1;
    },
  };

  const closeRetryPort = createTaskEventPort(closeRetryService);
  closeRetryPort.subscribe(() => {});
  const closeRetryErr = expectThrow(() => closeRetryPort.close(), '首次 close 应支持失败聚合');
  assert(closeRetryErr instanceof AggregateError, '首次 close 失败应聚合异常');
  assert(closeRetryService.fallbackCallCount === 0, 'unsub 失败后不应走 fallback');
  closeRetryPort.close();
  assert(closeRetryService.fallbackCallCount === 0, '重试成功后仍不应走 fallback');

  const closeErrorService = {
    callbacks: new Set(),
    subscribeCallback(callback) {
      this.callbacks.add(callback);
      return () => {
        throw new Error('explicit unsubscribe fail');
      };
    },
    unsubscribeCallback(callback) {
      this.callbacks.delete(callback);
    },
  };

  const closeErrorPort = createTaskEventPort(closeErrorService);
  closeErrorPort.subscribe(() => {});
  closeErrorPort.subscribe(() => {});
  const closeError = expectThrow(() => closeErrorPort.close(), 'close 应聚合多个释放异常');
  assert(closeError instanceof AggregateError, 'close 需要返回 AggregateError');
  assert(closeError.errors.length === 2, 'close 需聚合两个订阅错误');
  const closeErrorAgain = expectThrow(() => closeErrorPort.close(), '重试 close 后仍应尝试每个订阅');
  assert(closeErrorAgain instanceof AggregateError, '重试 close 仍应返回 AggregateError');

  const explicitUnsubscribeService = {
    subscribeCallback() {
      return () => {
        throw new Error('explicit unsubscribe fail');
      };
    },
    unsubscribeCallback() {},
  };
  const explicitPort = createTaskEventPort(explicitUnsubscribeService);
  const explicitUnsubscribe = explicitPort.subscribe(() => {});
  const explicitErr = expectThrow(() => explicitUnsubscribe(), '显式 unsubscribe 不能吞异常');
  assert(/explicit unsubscribe fail/.test(explicitErr.message), '显式 unsubscribe 需透传底层异常');

  const invalidReturnService = {
    cleanupCount: 0,
    subscribeCallback() {
      return null;
    },
    unsubscribeCallback() {
      this.cleanupCount = (this.cleanupCount || 0) + 1;
    },
  };
  const invalidReturnErr = expectThrow(() => createTaskEventPort(invalidReturnService).subscribe(() => {}), '非函数返回需失败');
  assert(invalidReturnService.cleanupCount === 1, 'invalid-return 仅清理一次');
  assert(
    /未返回取消订阅函数/.test(invalidReturnErr.message),
    'subscribeCallback 非函数返回应报错',
  );

  const replayThrowServiceCallbacks = new Set();
  const replayThrowService = {
    subscribeCallback(callback) {
      replayThrowServiceCallbacks.add(callback);
      callback({});
      throw new Error('replay throw');
    },
    unsubscribeCallback(callback) {
      replayThrowServiceCallbacks.delete(callback);
    },
  };
  const replayThrowPort = createTaskEventPort(replayThrowService);
  const replayThrowErr = expectThrow(() => replayThrowPort.subscribe(() => {}), 'replay throw 要透传');
  assert(/replay throw/.test(replayThrowErr.message), 'replay throw 应可见');
  assert(replayThrowServiceCallbacks.size === 0, 'replay throw 后 callback 必须清理');

  const closedService = {
    called: 0,
    subscribeCallback() {
      this.called += 1;
      return () => {};
    },
    unsubscribeCallback() {
      this.called += 1;
    },
  };
  const closedPort = createTaskEventPort(closedService);
  closedPort.close();
  const noopUnsubscribe = closedPort.subscribe(() => {});
  noopUnsubscribe();
  assert(closedService.called === 0, '已关闭端口再次 subscribe 不应触发底层 callback');
});

await run('workspaceContext: 默认创建和注入 factory 的关闭校验', async () => {
  await withTempDir('wc-ctx-default', async (baseDir) => {
    const ctx = createWorkspaceContext({
      workspaceId: 'default-user',
      dataDir: baseDir,
    });

    try {
      const expectedWorkspaceRoot = path.join(baseDir, 'users', 'default-user', 'workspace');
      assert(ctx.workspaceId === 'default-user', 'context workspaceId 正确');
      assert(ctx.workspaceRoot === expectedWorkspaceRoot, 'context workspaceRoot 正确');
      assert(ctx.paths.databasePath === path.join(expectedWorkspaceRoot, 'yibiao.sqlite'), 'context databasePath 正确');
      assert(fs.existsSync(ctx.paths.uploadsDir), 'uploadsDir 已创建');
      assert(Boolean(ctx.stores), 'stores 存在');
      assert(ctx.taskEvents && typeof ctx.taskEvents.subscribe === 'function', 'taskEvents 存在');
      assert(ctx.db && ctx.db.open === true, 'db 初始打开');

      await ctx.close();
      assert(ctx.db.open === false, 'default close 后 db 关闭');
      await ctx.close();
    } finally {
      await cleanupContext(ctx);
    }
  });

  const closeOrder = [];
  const fakeRuntime = {
    db: { open: true },
    sqliteDatabase: {
      close() {
        closeOrder.push('sqliteDatabase');
        fakeRuntime.db.open = false;
      },
    },
    taskService: {
      close() {
        closeOrder.push('taskService');
      },
    },
    taskEvents: {
      close() {
        closeOrder.push('taskEvents');
      },
      subscribe() {
        return () => {};
      },
    },
    ports: {
      agent: {
        close() {
          closeOrder.push('agent');
        },
      },
    },
    close() {
      if (this !== fakeRuntime) {
        throw new Error('runtime close this lost');
      }
      closeOrder.push('runtime');
      this.db.open = false;
    },
  };
  let closeCalled = false;

  await withTempDir('wc-ctx-factory', async (baseDir) => {
    const runtimeFactory = (opts) => {
      assert(opts.workspaceId === 'injected-user', 'runtimeFactory 接收 workspaceId');
      assert(opts.databasePath === path.join(opts.workspaceRoot, 'yibiao.sqlite'), 'runtimeFactory 接收 databasePath');
      return fakeRuntime;
    };

    const ctx = createWorkspaceContext({
      workspaceId: 'injected-user',
      dataDir: baseDir,
      runtimeFactory,
    });

    try {
      await ctx.close();
      closeCalled = true;
      assert(fakeRuntime.db.open === false, 'sqlite db 已关闭');
      assert(closeOrder.join(',') === 'runtime', 'context close 仅走 runtime.close');
    } finally {
      await cleanupContext(ctx);
    }
  });

  assert(closeCalled, 'runtimeFactory 注入生效');

  await withTempDir('wc-ctx-invalid-close', async (baseDir) => {
    function createFallbackRuntime(prefix, closeGetter) {
      const closeOrder = [];
      const sharedClosePrototype = {
        close() {
          if (!this || !this.label) {
            throw new Error(`${prefix}: shared close this lost`);
          }
          this.closed = true;
          closeOrder.push(this.label);
        },
      };
      const taskService = Object.assign(Object.create(sharedClosePrototype), {
        label: `${prefix}-taskService`,
        closed: false,
      });
      const agent = Object.assign(Object.create(sharedClosePrototype), {
        label: `${prefix}-agent`,
        closed: false,
      });
      const taskEvents = {
        label: `${prefix}-taskEvents`,
        closed: false,
        close() {
          if (this !== taskEvents) {
            throw new Error(`${prefix}: taskEvents close this lost`);
          }
          this.closed = true;
          closeOrder.push(this.label);
        },
      };
      const sqliteDatabase = {
        label: `${prefix}-sqliteDatabase`,
        closed: false,
        close() {
          if (this !== sqliteDatabase) {
            throw new Error(`${prefix}: sqlite close this lost`);
          }
          this.closed = true;
          closeOrder.push(this.label);
        },
      };
      const runtime = {
        taskService,
        taskEvents,
        ports: { agent },
        sqliteDatabase,
      };

      if (closeGetter) {
        Object.defineProperty(runtime, 'close', {
          get: closeGetter,
        });
      }

      return {
        runtime,
        resources: [taskEvents, taskService, agent, sqliteDatabase],
        closeOrder,
      };
    }

    const missingClose = createFallbackRuntime('missing');

    const missingCloseError = expectThrow(() => createWorkspaceContext({
      workspaceId: 'invalid-close',
      dataDir: baseDir,
      runtimeFactory: () => missingClose.runtime,
    }), 'runtime 缺少 close 时应抛错并兜底清理');
    assert(
      missingClose.closeOrder.join(',') === 'missing-taskEvents,missing-taskService,missing-agent,missing-sqliteDatabase',
      '缺少 runtime.close 时应按约定顺序兜底关闭四个资源',
    );
    assert(missingClose.resources.every((resource) => resource.closed), '缺少 runtime.close 时 close 应保留 this 且关闭全部资源');
    assert(/runtime 缺少 close 方法|runtime.close/.test(missingCloseError.message), '缺 close 的异常应可见');

    const getterClose = createFallbackRuntime('getter', () => {
      throw new Error('runtime close getter throw');
    });

    const getterError = expectThrow(() => createWorkspaceContext({
      workspaceId: 'getter-close',
      dataDir: baseDir,
      runtimeFactory: () => getterClose.runtime,
    }), 'runtime close getter 抛错应抛主错误');
    assert(getterError instanceof Error, 'getter 抛错应为异常');
    assert(/runtime close getter throw/.test(getterError.message), 'getter 错误消息应可见');
    assert(
      getterClose.closeOrder.join(',') === 'getter-taskEvents,getter-taskService,getter-agent,getter-sqliteDatabase',
      'getter close 失败后应按约定顺序兜底关闭四个资源',
    );
    assert(getterClose.resources.every((resource) => resource.closed), 'getter close 失败时 close 应保留 this 且关闭全部资源');
  });
});

await run('workspaceRuntimeFactory: 依赖失败需回滚并保留原始错误', async () => {
  await withTempDir('wc-factory-rollback', async (baseDir) => {
    const workspaceRoot = path.join(baseDir, 'users', 'rollback-user', 'workspace');
    const paths = coreWorkspacePaths.resolveWorkspacePaths(workspaceRoot);
    const databasePath = paths.databasePath;
    const configPath = path.join(baseDir, 'users', 'rollback-user', 'config.enc.json');

    const factoryPath = require.resolve('../server/workspace/workspaceRuntimeFactory.cjs');
    const sqlitePath = require.resolve('../core/sqliteDatabase.cjs');
    const webServicesPath = require.resolve('../server/workspace/webServices.cjs');

    const originalLoad = Module._load;
    const realSqlite = originalLoad(sqlitePath);
    const realWebServices = originalLoad(webServicesPath);
    const expectedError = new Error('受控装配失败');
    let sqliteClosed = false;

    let caughtError;
    try {
      Module._load = function loadWithOverrides(request, parent, isMain) {
        if (request === sqlitePath || request === webServicesPath) {
          const resolved = Module._resolveFilename(request, parent, isMain);
          if (path.resolve(resolved) === sqlitePath) {
            return {
              ...realSqlite,
              createSqliteDatabase(options) {
                const sqliteDatabase = realSqlite.createSqliteDatabase(options);
                return {
                  ...sqliteDatabase,
                  close() {
                    sqliteClosed = true;
                    return sqliteDatabase.close();
                  },
                };
              },
            };
          }
          if (path.resolve(resolved) === webServicesPath) {
            return {
              ...realWebServices,
              createWebTaskServiceStub() {
                throw expectedError;
              },
            };
          }
        }

        let resolved;
        try {
          resolved = Module._resolveFilename(request, parent, isMain);
        } catch {
          resolved = undefined;
        }
        if (resolved && path.resolve(resolved) === sqlitePath) {
          return {
            ...realSqlite,
            createSqliteDatabase(options) {
              const sqliteDatabase = realSqlite.createSqliteDatabase(options);
              return {
                ...sqliteDatabase,
                close() {
                  sqliteClosed = true;
                  return sqliteDatabase.close();
                },
              };
            },
          };
        }
        if (resolved && path.resolve(resolved) === webServicesPath) {
          return {
            ...realWebServices,
            createWebTaskServiceStub() {
              throw expectedError;
            },
          };
        }

        return originalLoad.apply(this, arguments);
      };

      delete require.cache[factoryPath];
      const { createWorkspaceRuntimeFactory } = require(factoryPath);
      caughtError = expectThrow(
        () => createWorkspaceRuntimeFactory({
          workspaceId: 'rollback-user',
          userDir: path.join(baseDir, 'users', 'rollback-user'),
          workspaceRoot,
          paths,
          databasePath,
          configPath,
        }),
        '回滚期间应抛原始装配错误',
      );
    } finally {
      Module._load = originalLoad;
      delete require.cache[factoryPath];
    }

    assert(caughtError === expectedError, '回滚异常引用不变');
    assert(sqliteClosed, '回滚前的 sqlite 已关闭');
    assert(!caughtError?.cleanupErrors, '不应给错误追加 cleanupErrors 属性');
  });

  const blockedResult = withBlockedElectronRequire();
  assert(blockedResult.ok, `electron 禁止环境加载 factory 成功 (status=${blockedResult.status})`);
});

await run('workspaceRuntimeFactory: close 按顺序关闭并聚合失败', async () => {
  await withTempDir('wc-factory-close', async (baseDir) => {
    const workspaceRoot = path.join(baseDir, 'users', 'closeerr', 'workspace');
    const paths = coreWorkspacePaths.resolveWorkspacePaths(workspaceRoot);
    const databasePath = paths.databasePath;
    const configPath = path.join(baseDir, 'users', 'closeerr', 'config.enc.json');
    const factoryPath = require.resolve('../server/workspace/workspaceRuntimeFactory.cjs');
    const webServicesPath = require.resolve('../server/workspace/webServices.cjs');

    const originalLoad = Module._load;
    const realWebServices = originalLoad(webServicesPath);
    let runtime;

    try {
      Module._load = function loadWithOverrides(request, parent, isMain) {
        if (request === webServicesPath) {
          const resolved = Module._resolveFilename(request, parent, isMain);
          if (path.resolve(resolved) === webServicesPath) {
            return {
              ...realWebServices,
              createWebAgentServiceStub() {
                const originalAgent = realWebServices.createWebAgentServiceStub();
                return {
                  ...originalAgent,
                  close() {
                    throw new Error('agent close fail');
                  },
                };
              },
              createWebTaskServiceStub() {
                const stub = realWebServices.createWebTaskServiceStub();
                return {
                  ...stub,
                  close() {
                    throw new Error('taskService close fail');
                  },
                };
              },
            };
          }
        }

        let resolved;
        try {
          resolved = Module._resolveFilename(request, parent, isMain);
        } catch {
          resolved = undefined;
        }
        if (resolved && path.resolve(resolved) === webServicesPath) {
          return {
            ...realWebServices,
            createWebAgentServiceStub() {
              const originalAgent = realWebServices.createWebAgentServiceStub();
              return {
                ...originalAgent,
                close() {
                  throw new Error('agent close fail');
                },
              };
            },
            createWebTaskServiceStub() {
              const stub = realWebServices.createWebTaskServiceStub();
              return {
                ...stub,
                close() {
                  throw new Error('taskService close fail');
                },
              };
            },
          };
        }

        return originalLoad.apply(this, arguments);
      };

      delete require.cache[factoryPath];
      const { createWorkspaceRuntimeFactory } = require(factoryPath);
      runtime = createWorkspaceRuntimeFactory({
        workspaceId: 'closeerr',
        userDir: path.join(baseDir, 'users', 'closeerr'),
        workspaceRoot,
        paths,
        databasePath,
        configPath,
      });

      assert(!runtime.ports.fileParser, 'Web factory 不暴露 fileParser');
      assert(!runtime.ports.renderer, 'Web factory 不暴露 renderer');
      assert(!runtime.ports.exporter, 'Web factory 不暴露 exporter');

      const closeError = await expectReject(() => runtime.close(), 'close 异常应聚合');
      assert(closeError instanceof AggregateError, 'close 应聚合多个关闭错误');
      assert(closeError.errors.length === 2, '关闭错误数应为 2');
      assert(runtime.db.open === false, 'runtime.close 即使部分失败也应关闭 sqlite');
    } finally {
      Module._load = originalLoad;
      if (runtime && runtime.db?.open) {
        runtime.db.close();
      }
      delete require.cache[factoryPath];
    }
  });
});

await run('workspaceRuntimeFactory: close 重试会保留失败 handler，成功 handler 不重复执行', async () => {
  await withTempDir('wc-factory-close-retry', async (baseDir) => {
    const workspaceRoot = path.join(baseDir, 'users', 'closeretry', 'workspace');
    const paths = coreWorkspacePaths.resolveWorkspacePaths(workspaceRoot);
    const databasePath = paths.databasePath;
    const configPath = path.join(baseDir, 'users', 'closeretry', 'config.enc.json');
    const factoryPath = require.resolve('../server/workspace/workspaceRuntimeFactory.cjs');
    const sqlitePath = require.resolve('../core/sqliteDatabase.cjs');
    const taskEventPortPath = require.resolve('../core/taskEventPort.cjs');
    const webServicesPath = require.resolve('../server/workspace/webServices.cjs');

    const originalLoad = Module._load;
    const realWebServices = originalLoad(webServicesPath);
    const realSqlite = originalLoad(sqlitePath);
    const realTaskEventPort = originalLoad(taskEventPortPath);
    const closeStats = {
      agentClose: 0,
      sqliteClose: 0,
      taskServiceClose: 0,
      taskEventsClose: 0,
      agentCloseAttempts: 0,
    };
    let runtime;

    try {
      Module._load = function loadWithOverrides(request, parent, isMain) {
        let resolved;
        try {
          resolved = Module._resolveFilename(request, parent, isMain);
        } catch {
          resolved = undefined;
        }

        if (resolved && path.resolve(resolved) === sqlitePath) {
          return {
            ...realSqlite,
            createSqliteDatabase(options) {
              const sqliteDatabase = realSqlite.createSqliteDatabase(options);
              const originalClose = sqliteDatabase.close;
              return {
                ...sqliteDatabase,
                close() {
                  closeStats.sqliteClose += 1;
                  return originalClose.call(sqliteDatabase);
                },
              };
            },
          };
        }

        if (resolved && path.resolve(resolved) === taskEventPortPath) {
          return {
            ...realTaskEventPort,
            createTaskEventPort(taskService) {
              const taskEvents = realTaskEventPort.createTaskEventPort(taskService);
              const originalClose = taskEvents.close;
              return {
                ...taskEvents,
                close() {
                  closeStats.taskEventsClose += 1;
                  return originalClose.call(taskEvents);
                },
              };
            },
          };
        }

        if (resolved && path.resolve(resolved) === webServicesPath) {
          return {
            ...realWebServices,
            createWebAgentServiceStub() {
              const originalAgent = realWebServices.createWebAgentServiceStub();
              return {
                ...originalAgent,
                close() {
                  closeStats.agentCloseAttempts += 1;
                  closeStats.agentClose += 1;
                  if (closeStats.agentCloseAttempts === 1) {
                    throw new Error('agent close should fail once');
                  }
                },
              };
            },
            createWebTaskServiceStub() {
              const stub = realWebServices.createWebTaskServiceStub();
              return {
                ...stub,
                close() {
                  closeStats.taskServiceClose += 1;
                },
              };
            },
          };
        }

        return originalLoad.apply(this, arguments);
      };

      delete require.cache[factoryPath];
      const { createWorkspaceRuntimeFactory } = require(factoryPath);
      runtime = createWorkspaceRuntimeFactory({
        workspaceId: 'closeretry',
        userDir: path.join(baseDir, 'users', 'closeretry'),
        workspaceRoot,
        paths,
        databasePath,
        configPath,
      });

      const first = await expectReject(() => runtime.close(), '第一次 close 应透出首次失败');
      assert(first instanceof Error, '第一次 close 需可见错误');
      assert(closeStats.agentClose === 1, 'agent close 首次执行一次');
      assert(closeStats.taskServiceClose === 1, 'taskService close 应只执行一次');
      assert(closeStats.taskEventsClose === 1, 'taskEvents close 应只执行一次');
      assert(closeStats.sqliteClose === 1, 'sqlite close 执行一次');

      await runtime.close();
      assert(closeStats.agentClose === 2, 'agent 失败后重试只执行第二次并成功');
      assert(closeStats.taskServiceClose === 1, 'taskService close 不应在成功后重复');
      assert(closeStats.taskEventsClose === 1, 'taskEvents close 不应在成功后重复');
      assert(closeStats.sqliteClose === 1, 'sqlite close 不应在成功后重复');
    } finally {
      Module._load = originalLoad;
      if (runtime && runtime.db?.open) {
        runtime.db.close();
      }
      delete require.cache[factoryPath];
    }
  });
});

await run('workspaceContext x100: 每次只开一个上下文并完整回收', async () => {
  await withTempDir('wc-loop', async (baseDir) => {
    const before = snapshotActiveHandles();
    const dbRefs = [];
    let maxDelta = 0;
    const iterationSnapshots = [];

    for (let i = 0; i < 100; i += 1) {
      let ctx;
      let unsubscribe;
      let snapshot;
      let shouldUnsubscribe = i % 2 === 0;

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
        assert(db && db.open, `第 ${i + 1} 次上下文 db 打开`);
        dbRefs.push(db);
      } finally {
        if (ctx) {
          try {
            await ctx.close();
          } catch (error) {
            throw new Error(`第 ${i + 1} 次 ctx.close 失败: ${error.message}`);
          }
        }
        if (!shouldUnsubscribe && typeof unsubscribe === 'function') {
          try {
            unsubscribe();
          } catch (error) {
            throw new Error(`第 ${i + 1} 次重复 unsubscribe 失败: ${error.message}`);
          }
        }
      }

      snapshot = snapshotActiveHandles();
      if (snapshot.count > maxDelta + before.count) {
        maxDelta = snapshot.count - before.count;
      }
      if ((i + 1) % 10 === 0) {
        iterationSnapshots.push({
          iteration: i + 1,
          delta: snapshot.count - before.count,
        });
      }
      assert(snapshot.count - before.count <= 4, `第 ${i + 1} 次循环句柄增量受控`);
    }

    const after = snapshotActiveHandles();
    const finalDelta = after.count - before.count;
    assert(finalDelta <= 4, `100 次循环后句柄回落 <=4（实际 ${finalDelta}）`);
    assert(maxDelta <= 4, `100 次循环过程中句柄最大增量 <=4（实际 ${maxDelta}）`);
    assert(dbRefs.length === 100, '记录 100 个 db 引用');
    assert(dbRefs.every((db) => db.open === false), '全部 db 已关闭');

    for (const item of iterationSnapshots) {
      assert(item.delta <= 4, `第 ${item.iteration} 次句柄增量 ${item.delta} 超限`);
    }
  });
});

if (failed.length) {
  cleanupTrackedDirs();
  console.error(`\n=== Workspace 生命周期测试失败：${failed.length} ===`);
  failed.forEach((item) => {
    console.error(`- ${item}`);
  });
  process.exit(1);
}

cleanupTrackedDirs();
console.log(`\n=== Workspace 生命周期测试结果 ===`);
console.log(`通过: ${passed.length}`);
console.log(`失败: ${failed.length}`);
}

main().catch((error) => {
  cleanupTrackedDirs();
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
