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
      assert(identity.clientId === 'server-stable-id', '服务端身份接管后返回 server id');
      assert(runtime.events.includes('removeItem:analytics_client_id'), '服务端身份接管后清理 legacy localStorage');
      assert(loadCount === 1, 'identity retirement 只读取一次服务端配置');
      assert(!runtime.events.includes('save'), 'identity retirement 不回写浏览器 legacy id');
      assert(runtime.storage.analytics_client_id === undefined, 'retirement 后 localStorage 不再持有 analytics_client_id');
      assert(runtime.savePayloads.length === 0, 'identity retirement 不触发 config.save');
      return true;
    });
}

async function runNoServerIdentityCase() {
  const runtime = createAnalyticsRuntime({
    loadSequence: { analytics_created_at: serverConfig.analytics_created_at },
    saveResult: { success: true },
  });

  const identity = await runtime.analytics.getAnalyticsIdentity();
  const loadCount = runtime.events.filter((event) => event === 'load:before-save').length;
  assert(identity.clientId === '', '服务端身份缺失时不伪造 legacy identity');
  assert(runtime.storage.analytics_client_id === 'legacy-for-renderer-migration', '服务端身份缺失时保留 legacy localStorage');
  assert(!runtime.events.includes('removeItem:analytics_client_id'), '服务端身份缺失时不清理 legacy localStorage');
  assert(runtime.savePayloads.length === 0, '服务端身份缺失时也不回写 legacy id');
  assert(loadCount === 1, '服务端身份缺失时只读取一次配置');
}

(async () => {
  try {
    await runCaseSuccess();
    await runNoServerIdentityCase();
  } catch (error) {
    failed.push(`脚本执行异常：${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(`\n=== Analytics Identity Retirement Renderer 测试结果 ===`);
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
