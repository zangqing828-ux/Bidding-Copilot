const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const sourcePath = path.join(__dirname, '../src/shared/analytics/analytics.ts');
const source = fs.readFileSync(sourcePath, 'utf-8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    moduleResolution: ts.ModuleResolutionKind.Node10,
  },
}).outputText;

const passed = [];
const failed = [];
const serverConfig = {
  analytics_client_id: 'server-stable-id',
  analytics_created_at: '2026-07-25T00:00:00.000Z',
  api_key: 'sk-server',
};

function assert(condition, message) {
  if (condition) {
    passed.push(message);
    return;
  }

  failed.push(message);
  console.error(`  FAIL: ${message}`);
}

function createAnalyticsRuntime({ loadSequence, saveResult }) {
  const events = [];
  const storage = {
    analytics_client_id: 'legacy-for-renderer-migration',
  };
  const savePayloads = [];

  const load = () => {
    events.push('load:before-save');
    if (typeof loadSequence === 'function') {
      const value = loadSequence();
      events.push('load:after-call');
      return Promise.resolve(value);
    }

    events.push('load:after-call');
    return Promise.resolve(loadSequence);
  };

  const localStorage = {
    getItem(key) {
      events.push(`getItem:${key}`);
      return storage[key] || null;
    },
    setItem(key, value) {
      events.push(`setItem:${key}`);
      storage[key] = String(value);
    },
    removeItem(key) {
      events.push(`removeItem:${key}`);
      delete storage[key];
    },
  };

  const save = (...args) => {
    events.push('save');
    savePayloads.push(args[0] || null);
    const result = typeof saveResult === 'function'
      ? saveResult(...args)
      : saveResult;
    return Promise.resolve(result);
  };

  const configLoad = async () => {
    const next = load();
    return next;
  };

  const configSave = async (...args) => {
    const result = save(...args);
    return result;
  };

  const module = { exports: {} };
  const wrapped = new Function(
    'require',
    'exports',
    'module',
    '__filename',
    '__dirname',
    'window',
    'localStorage',
    `${transpiled}\nreturn module.exports;`,
  );

  wrapped(
    () => {
      throw new Error('unexpected require');
    },
    module.exports,
    module,
    sourcePath,
    __dirname,
    {
      yibiao: {
        config: {
          load: configLoad,
          save: configSave,
        },
        platform: 'web',
      },
      yibiaoClient: {},
    },
    localStorage,
  );

  return {
    analytics: module.exports,
    savePayloads,
    events,
    storage,
  };
}

function runCaseSuccess() {
  let loadCount = 0;
  const runtime = createAnalyticsRuntime({
    loadSequence: () => {
      loadCount += 1;
      return {
        ...serverConfig,
      };
    },
    saveResult: {
      success: true,
      message: '配置已保存',
    },
  });

  return runtime.analytics.getAnalyticsIdentity()
    .then((identity) => {
      assert(identity.clientId === 'server-stable-id', '成功迁移返回服务端 id');
      assert(runtime.events.includes('removeItem:analytics_client_id'), '成功迁移后移除 legacy localStorage');
      assert(loadCount === 2, '成功迁移触发两次 config.load（迁移前与迁移后）');
      const saveIndex = runtime.events.indexOf('save');
      const reloadIndex = saveIndex >= 0
        ? runtime.events.indexOf('load:before-save', saveIndex + 1)
        : -1;
      const clearIndex = runtime.events.indexOf('removeItem:analytics_client_id');
      assert(
        saveIndex >= 0 && reloadIndex > saveIndex && clearIndex > reloadIndex,
        '成功迁移顺序为 save 后 reload，再清理 legacy localStorage',
      );
      assert(runtime.storage.analytics_client_id === undefined, 'legacy 清理后 localStorage 不再持有 analytics_client_id');
      assert(runtime.savePayloads.length === 1, '成功迁移流程触发一次 config.save');
      assert(
        runtime.savePayloads[0]?.analytics_client_id !== undefined,
        '保存 payload 包含 analytics_client_id 字段',
      );
      assert(loadCount >= 2, '成功迁移会再次读取最新服务端身份');
      return true;
    });
}

async function runFailureCase({
  label,
  loadSequence = () => ({ ...serverConfig }),
  saveResult,
  expectedLoadCount,
}) {
  const runtime = createAnalyticsRuntime({
    loadSequence,
    saveResult,
  });

  const identity = await runtime.analytics.getAnalyticsIdentity();
  const loadCount = runtime.events.filter((event) => event === 'load:before-save').length;
  assert(identity.clientId === serverConfig.analytics_client_id, `${label}：当前运行使用 server id`);
  assert(identity.clientCreatedAt === serverConfig.analytics_created_at, `${label}：当前运行使用 server created_at`);
  assert(runtime.storage.analytics_client_id === 'legacy-for-renderer-migration', `${label}：legacy localStorage 保留`);
  assert(!runtime.events.includes('removeItem:analytics_client_id'), `${label}：不清理 legacy localStorage`);
  assert(runtime.savePayloads.length === 1, `${label}：仅尝试一次 config.save`);
  assert(loadCount === expectedLoadCount, `${label}：config.load 次数正确`);
}

function createReloadFailureSequence(reloadValue) {
  let loadCount = 0;
  return () => {
    loadCount += 1;
    if (loadCount === 1) {
      return { ...serverConfig };
    }
    if (reloadValue instanceof Error) {
      throw reloadValue;
    }
    return reloadValue;
  };
}

(async () => {
  try {
    await runCaseSuccess();
    await runFailureCase({
      label: 'save false',
      saveResult: {
        success: false,
        message: '模拟失败',
      },
      expectedLoadCount: 1,
    });
    await runFailureCase({
      label: 'save reject',
      saveResult: () => Promise.reject(new Error('模拟 save reject')),
      expectedLoadCount: 1,
    });
    await runFailureCase({
      label: 'reload reject',
      loadSequence: createReloadFailureSequence(new Error('模拟 reload reject')),
      saveResult: {
        success: true,
        message: '配置已保存',
      },
      expectedLoadCount: 2,
    });
    await runFailureCase({
      label: 'reload 缺少 analytics_client_id',
      loadSequence: createReloadFailureSequence({
        analytics_created_at: serverConfig.analytics_created_at,
      }),
      saveResult: {
        success: true,
        message: '配置已保存',
      },
      expectedLoadCount: 2,
    });
  } catch (error) {
    failed.push(`脚本执行异常：${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(`\n=== Analytics Migration Renderer 测试结果 ===`);
  console.log(`通过: ${passed.length}`);
  console.log(`失败: ${failed.length}`);
  if (failed.length > 0) {
    failed.forEach((item) => {
      console.error(`  - ${item}`);
    });
    process.exit(1);
  }

  console.log('全部通过 ✅');
})();
