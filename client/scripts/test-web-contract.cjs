// Web Bridge Contract 测试：通过 AST 双向比对 webBridge 与 manifest，并验证行为边界。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const ts = require('typescript');

const passed = [];
const failed = [];

const strictMode = process.argv.includes('--strict') || process.env.CONTRACT_STRICT === '1';
const ALLOWED_STATUSES = new Set(['implemented', 'pending', 'removed']);
const FORBIDDEN_PROTOTYPE_IDENTIFIERS = new Set(
  Object.getOwnPropertyNames(Object.prototype).concat(['__proto__'])
);
const REMOVED_MENU_SECTIONS = ['resources', 'bid-opportunity', 'plugin-manager'];
const DELETED_FEATURE_PATHS = [
  'src/features/resources',
  'src/features/bid-opportunity',
  'src/features/plugins',
  'electron/services/pluginContext.cjs',
  'electron/services/pluginService.cjs',
  'electron/services/pluginConfigWindow.cjs',
  'electron/ipc/pluginIpc.cjs',
  'electron/preload-plugin-config.cjs',
];
const DELETED_FEATURE_LEAVES = new Set([
  'resources.list',
  'tenderOpportunities.list',
  'plugins.list',
]);
const DELETED_PRODUCT_COUNT = DELETED_FEATURE_LEAVES.size;
const KB_PENDING_METHODS = [
  'deleteFolder',
  'deleteDocument',
  'moveDocument',
  'retryDocument',
];
const DESKTOP_ONLY_CAPABILITIES = [
  'app.getGpuHardwareAccelerationStatus',
  'app.saveGpuHardwareAccelerationPreference',
  'app.startGpuHardwareAccelerationTrial',
  'app.relaunchWithGpuHardwareAccelerationDisabled',
  'app.getLatestVersion',
  'app.getUpdateDownloadUrl',
  'app.checkUpdate',
  'app.startUpdate',
  'app.quitAndInstall',
  'config.openConfigFolder',
  'developerTokenStats.openWindow',
  'export.openFile',
  'events.onUpdateProgress',
  'events.onUpdateDownloaded',
  'events.onUpdateError',
];

const REQUIRED_WEB_BRIDGE_META_KEYS = [
  'members.appName',
  'members.platform',
  'locals.openExternal',
  'locals.database.getStatus',
  'events.onUpdateProgress',
  'events.onUpdateDownloaded',
  'events.onUpdateError',
  'events.database.onStatus',
  'events.ai.onHttpError',
  'events.agent.onStatus',
  'events.developerTokenStats.onChanged',
  'events.knowledgeBase.onEvent',
  'events.tasks.onTaskEvent',
  'events.export.onWordExportProgress',
];

const requiredMetaFields = ['status', 'owner', 'workPackage', 'transport', 'contractRef', 'input', 'output', 'errors'];

function resolvePropertyPath(target, pathParts) {
  return pathParts.reduce((current, part) => (current && typeof current === 'object' ? current[part] : undefined), target);
}

function assertSourceContains(source, regexOrText, label) {
  const matched = typeof regexOrText === 'string'
    ? source.includes(regexOrText)
    : regexOrText.test(source);
  assert(matched, label);
}

function extractErrorCode(error) {
  if (!error || typeof error !== 'object') {
    return '';
  }
  return typeof error.code === 'string' ? error.code : '';
}

function resolveEventExpectedErrorCode(manifestKey, entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  if (entry.status === 'removed') {
    if (entry.source === 'deleted-product') {
      return 'WEB_BRIDGE_REMOVED';
    }
    if (entry.source === 'desktop-only') {
      return 'WEB_BRIDGE_DESKTOP_ONLY';
    }
    return null;
  }

  if (entry.status === 'pending') {
    return 'WEB_CAPABILITY_PENDING';
  }

  throw new Error(`${manifestKey} 事件状态不合法：${entry.status}`);
}

function loadWebBridgeRuntimeForEventCheck() {
  const source = readSource('src/shared/api/webBridge.ts');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      moduleResolution: ts.ModuleResolutionKind.Node10,
    },
  }).outputText;

  const fakeEventSources = [];

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.closed = false;
      fakeEventSources.push(this);
      this.close = () => {
        this.closed = true;
      };
    }
  }

  const fakeRequire = (request) => {
    if (request === './httpClient') {
      return {
        httpClient: {
          invoke: async () => ({ code: 'OK', message: 'stub' }),
        },
      };
    }
    throw new Error(`Unexpected require in webBridge runtime load: ${request}`);
  };

  const fakeWindow = {
    open: () => {},
  };

  const wrapped = new Function(
    'require',
    'exports',
    'module',
    '__filename',
    '__dirname',
    'window',
    'EventSource',
    `${transpiled}\nreturn module.exports;`
  );

  const module = { exports: {} };
  const moduleExports = wrapped(
    fakeRequire,
    module.exports,
    module,
    '/tmp/webBridge.ts',
    '/tmp',
    fakeWindow,
    FakeEventSource,
  );
  const exportedBridge = moduleExports.webBridge || module.exports.webBridge;

  assert(Boolean(exportedBridge), 'webBridge 对象可从 TypeScript transpileModule 加载');
  assert(typeof exportedBridge === 'object', 'webBridge 加载结果为对象');

  return {
    webBridge: exportedBridge,
    fakeEventSources,
    fakeEventSourceCtor: FakeEventSource,
  };
}

function loadHttpClientRuntimeForFailureBranchCheck() {
  const source = readSource('src/shared/api/httpClient.ts');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      moduleResolution: ts.ModuleResolutionKind.Node10,
    },
  }).outputText;

  const fakeRequire = () => {
    throw new Error('httpClient runtime should not require other modules');
  };

  const wrapped = new Function(
    'require',
    'exports',
    'module',
    '__filename',
    '__dirname',
    'fetch',
    `${transpiled}\nreturn module.exports;`
  );

  const loadHttpClientWithFetch = (fetchImpl) => {
    const module = { exports: {} };
    wrapped(
      fakeRequire,
      module.exports,
      module,
      '/tmp/httpClient.ts',
      '/tmp',
      fetchImpl,
    );
    const exported = module.exports;
    assert(Boolean(exported?.httpClient), 'httpClient 可从 TypeScript transpileModule 加载');
    assert(typeof exported.httpClient.invoke === 'function', 'httpClient.invoke 为函数');
    return exported.httpClient;
  };

  return { loadHttpClientWithFetch };
}

function createErrorFromHttpClientPayloads(payloads, fetchIndexByCall = 0) {
  const responses = Array.isArray(payloads) ? payloads : [];
  return async () => {
    const response = responses[fetchIndexByCall];
    if (!response) {
      throw new Error('httpClient 测试响应耗尽');
    }
    fetchIndexByCall += 1;

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      async json() {
        return response.payload;
      },
    };
  };
}

function assertSetEqual(actualSet, expectedSet, label) {
  const missing = [];
  const extra = [];

  for (const item of expectedSet) {
    if (!actualSet.has(item)) {
      missing.push(item);
    }
  }

  for (const item of actualSet) {
    if (!expectedSet.has(item)) {
      extra.push(item);
    }
  }

  assert(missing.length === 0, `${label} 覆盖完整（缺失=${missing.length ? missing.join(',') : '无'}）`);
  assert(extra.length === 0, `${label} 无超集（多余=${extra.length ? extra.join(',') : '无'}）`);
}

function assert(condition, message) {
  if (condition) {
    passed.push(message);
    return;
  }

  failed.push(message);
  console.error(`  FAIL: ${message}`);
}

function hasOwnProperty(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeTextLiteral(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isNumericLiteral(node)) {
    return node.text;
  }
  return null;
}

function readSource(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf-8');
}

function parseJson(payloadText) {
  try {
    return JSON.parse(payloadText);
  } catch {
    return null;
  }
}

function collectStringLiterals(fileText) {
  const sourceFile = ts.createSourceFile('file.tsx', fileText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const values = new Set();

  const walk = (node) => {
    if (!node) return;

    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const text = normalizeTextLiteral(node);
      if (text != null) {
        values.add(text);
      }
    }

    if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
      values.add(node.literal.text);
    }

    ts.forEachChild(node, walk);
  };

  walk(sourceFile);
  return values;
}

function getPropertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }

  if (ts.isComputedPropertyName(node) && ts.isStringLiteral(node.expression)) {
    return node.expression.text;
  }

  return null;
}

function collectBridgeLeavesFromAst() {
  const bridgeText = readSource('src/shared/api/webBridge.ts');
  const sourceFile = ts.createSourceFile('webBridge.ts', bridgeText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let bridgeDeclaration;

  const walk = (node) => {
    if (bridgeDeclaration) return;

    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name) && node.name.text === 'webBridge' && node.initializer) {
        let value = node.initializer;
        while (ts.isAsExpression(value) || ts.isTypeAssertionExpression(value) || ts.isParenthesizedExpression(value)) {
          value = value.expression;
        }

        if (ts.isObjectLiteralExpression(value)) {
          bridgeDeclaration = value;
        }
        return;
      }
    }
    ts.forEachChild(node, walk);
  };

  walk(sourceFile);
  assert(Boolean(bridgeDeclaration), 'webBridge 对象存在');

  const leaves = new Map();

  const isBridgeMethodCall = (node) => {
    if (!ts.isCallExpression(node)) {
      return false;
    }

    const callee = node.expression;
    if (!ts.isIdentifier(callee) || callee.text !== 'bridgeMethod') {
      return false;
    }

    const [namespaceArg, methodArg] = node.arguments;
    return {
      match: ts.isStringLiteral(namespaceArg) && ts.isStringLiteral(methodArg),
      namespace: namespaceArg?.text,
      method: methodArg?.text,
    };
  };

  const collect = (node, currentPath) => {
    if (ts.isObjectLiteralExpression(node)) {
      node.properties.forEach((property) => {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
          return;
        }

        if (!ts.isPropertyAssignment(property)) {
          return;
        }

        const propertyName = getPropertyName(property.name);
        if (!propertyName) {
          return;
        }

        const nextPath = currentPath ? `${currentPath}.${propertyName}` : propertyName;
        collect(property.initializer, nextPath);
      });
      return;
    }

    const bridgeMethodCall = isBridgeMethodCall(node);
    const leafBase = currentPath.split('.').pop();
    const isEvent = leafBase && /^on/.test(leafBase);

    if (bridgeMethodCall && bridgeMethodCall.match) {
      leaves.set(currentPath, {
        kind: 'rpc',
        namespace: bridgeMethodCall.namespace,
        method: bridgeMethodCall.method,
      });
      return;
    }

    if (currentPath === 'appName' || currentPath === 'platform') {
      leaves.set(currentPath, { kind: 'member' });
      return;
    }

    if (isEvent) {
      leaves.set(currentPath, { kind: 'event' });
      return;
    }

    leaves.set(currentPath, { kind: 'local' });
  };

  collect(bridgeDeclaration, '');
  return leaves;
}

function flattenContractNamespace(namespace, defs, prefix = namespace) {
  const map = new Map();
  const walk = (values, currentPath) => {
    for (const [name, value] of Object.entries(values)) {
      const nextPath = currentPath ? `${currentPath}.${name}` : name;
      if (value && typeof value === 'object' && !Array.isArray(value) && !hasOwnProperty(value, 'status')) {
        walk(value, nextPath);
        continue;
      }
      map.set(nextPath, value || {});
    }
  };

  walk(defs, prefix);
  return map;
}

function flattenManifest() {
  const { methods: contractMethods = {} } = require('../shared/bridgeContract.cjs');
  const allEntries = new Map();
  const removedProductEntries = new Map();

  for (const [namespace, defs] of Object.entries(contractMethods)) {
    for (const [pathKey, entry] of flattenContractNamespace(namespace, defs, namespace)) {
      allEntries.set(pathKey, entry);

      const source = entry && entry.source;
      if (entry?.status === 'removed' && source === 'deleted-product') {
        removedProductEntries.set(pathKey, entry);
      }
    }
  }

  return { allEntries, removedProductEntries };
}

function flattenBindingMetadata(meta) {
  const map = new Map();
  for (const [namespace, members] of Object.entries(meta || {})) {
    for (const [method, spec] of Object.entries(members || {})) {
      if (!hasOwnProperty(members, method) || !spec || typeof spec !== 'object') {
        continue;
      }
      map.set(`${namespace}.${method}`, spec);
    }
  }
  return map;
}

function collectBindingDispatcherKeys(dispatchers) {
  const keys = [];
  for (const [namespace, members] of Object.entries(dispatchers || {})) {
    for (const [method, fn] of Object.entries(members)) {
      if (typeof fn === 'function') {
        keys.push(`${namespace}.${method}`);
      }
    }
  }
  return keys;
}

function toManifestKeyFromWebBridgePath(pathValue, leafInfo) {
  if (leafInfo?.kind === 'rpc') {
    return `${leafInfo.namespace}.${leafInfo.method}`;
  }
  if (leafInfo?.kind === 'member') {
    return `members.${pathValue}`;
  }
  if (leafInfo?.kind === 'event') {
    return `events.${pathValue}`;
  }
  return `locals.${pathValue}`;
}

let server = null;
let port = 0;

function createRequest() {
  return async ({ method, url, headers = {}, payload }) => {
    const requestBody = payload === undefined ? null : (typeof payload === 'string' ? payload : JSON.stringify(payload));
    const reqHeaders = {
      ...headers,
    };

    if (requestBody && !reqHeaders['content-type']) {
      reqHeaders['content-type'] = 'application/json';
    }

    if (requestBody) {
      reqHeaders['content-length'] = Buffer.byteLength(requestBody);
    }

    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method,
        path: url,
        headers: reqHeaders,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: parseJson(data) || data,
          });
        });
      });

      req.on('error', reject);
      if (requestBody) req.write(requestBody);
      req.end();
    });
  };
}

function collectWorkspaceCloseWarnings() {
  const observed = [];

  const originalWarn = console.warn;
  console.warn = (...args) => {
    const message = args
      .map((item) => {
        if (item instanceof Error) {
          return item.message;
        }
        return String(item || '');
      })
      .join(' ');
    if (message.includes('[workspace] 关闭 workspace 失败')) {
      observed.push(message);
    }
    originalWarn(...args);
  };

  return {
    observed,
    restore: () => {
      console.warn = originalWarn;
    },
  };
}

function parseLoginState(authLocation, setCookies) {
  const stateValue = authLocation?.match(/state=([^&]+)/)?.[1] || '';
  const loginCookies = Array.isArray(setCookies) ? setCookies : (setCookies ? [setCookies] : []);
  const stateCookie = loginCookies.find((item) => item.startsWith('yibiao_oauth_state='));
  const stateCookieValue = stateCookie?.match(/yibiao_oauth_state=([^;]+)/)?.[1] || '';
  return { stateValue, stateCookieValue };
}

async function createSessionCookie(inject, userEmail = 'contract@test.com', userName = 'ContractTester') {
  const loginRes = await inject({ method: 'GET', url: '/api/auth/login' });
  assert(loginRes.statusCode === 302, 'auth/login 返回 302');

  const { stateValue, stateCookieValue } = parseLoginState(loginRes.headers.location || '', loginRes.headers['set-cookie']);
  const callbackRes = await inject({
    method: 'POST',
    url: '/api/auth/mock-callback',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `yibiao_oauth_state=${stateCookieValue}`,
    },
    payload: `email=${encodeURIComponent(userEmail)}&name=${encodeURIComponent(userName)}&state=${stateValue}`,
  });
  assert(callbackRes.statusCode === 302, 'mock-callback 返回 302');

  const callbackCookies = Array.isArray(callbackRes.headers['set-cookie'])
    ? callbackRes.headers['set-cookie']
    : (callbackRes.headers['set-cookie'] ? [callbackRes.headers['set-cookie']] : []);
  const sessionCookie = callbackCookies.find((item) => item.startsWith('yibiao_session='));
  const sessionValue = sessionCookie?.match(/yibiao_session=([^;]+)/)?.[1] || '';
  assert(Boolean(sessionValue), 'mock 登录返回 session cookie');

  return `yibiao_session=${sessionValue}`;
}

async function assertContractFieldPresence(entry, manifestKey) {
  for (const field of requiredMetaFields) {
    if (field === 'input') {
      assert(Array.isArray(entry?.input), `${manifestKey} 包含 input 数组`);
      continue;
    }

    if (field === 'output') {
      assert(hasOwnProperty(entry || {}, 'output'), `${manifestKey} 包含 output`);
      continue;
    }

    if (field === 'errors') {
      assert(Array.isArray(entry?.errors), `${manifestKey} 包含 errors 数组`);
      continue;
    }
    assert(typeof entry?.[field] === 'string' && entry[field].length > 0, `${manifestKey} 包含 ${field}`);
  }

  assert(ALLOWED_STATUSES.has(entry.status), `${manifestKey} 状态合法`);
}

function assertRemovedProductWhitelist(removedProductEntries) {
  assert(removedProductEntries.size === DELETED_PRODUCT_COUNT, `deleted-product 条目数量为 ${DELETED_PRODUCT_COUNT}（当前 ${removedProductEntries.size}）`);

  const deletedProductLeaves = new Set();
  for (const [entryKey, spec] of removedProductEntries.entries()) {
    assert(spec.status === 'removed', `${entryKey} removed 状态正确`);
    assert(spec.source === 'deleted-product', `${entryKey} source 为 deleted-product`);
    assert(typeof spec.contractRef === 'string', `${entryKey} contractRef 存在`);
    deletedProductLeaves.add(spec.contractRef);
  }
  assert(deletedProductLeaves.size === DELETED_PRODUCT_COUNT, `deleted-product 可比较项数量为 3（当前 ${deletedProductLeaves.size}）`);
  assertSetEqual(deletedProductLeaves, DELETED_FEATURE_LEAVES, 'deleted-product leaves 白名单');
}

async function runBridgeBehavior(inject, context) {
  const {
    contractEntries,
    removedProductEntries,
    bridgeContractMethods,
    bridgeBindingMetadata,
    routeDispatchers,
    getWorkspaceContext,
    setWorkspaceContextResolver,
    contractVersion,
    webBridgeRuntime,
  } = context;
  const { webBridge, fakeEventSources } = webBridgeRuntime || {};

  const pendingEntries = [];
  const contractMap = contractEntries;
  REQUIRED_WEB_BRIDGE_META_KEYS.forEach((key) => {
    assert(contractMap.has(key), `manifest 包含关键 Web Leaf：${key}`);
  });

  for (const [manifestKey, entry] of contractMap.entries()) {
    assertContractFieldPresence(entry, manifestKey);
    if (entry.status === 'pending') {
      pendingEntries.push(manifestKey);
    }
    if (entry.status === 'removed') {
      assert(
        entry.source === 'desktop-only' || entry.source === 'deleted-product',
        `${manifestKey} removed source 仅允许 desktop-only 或 deleted-product`
      );
    }
  }

  const bridgeLeaves = collectBridgeLeavesFromAst();
  const expectedContractKeys = new Set();

  for (const [pathValue, info] of bridgeLeaves.entries()) {
    if (!info) {
      continue;
    }

    const manifestKey = toManifestKeyFromWebBridgePath(pathValue, info);
    expectedContractKeys.add(manifestKey);

    assert(contractMap.has(manifestKey), `manifest 覆盖 webBridge 叶子：${manifestKey}`);
  }

  for (const [manifestKey, entry] of contractMap.entries()) {
    const isExpected = expectedContractKeys.has(manifestKey);
    if (!isExpected) {
      if (entry.status === 'removed' && entry.source === 'deleted-product') {
        continue;
      }
      assert(false, `manifest 中存在 webBridge 未定义叶子：${manifestKey}`);
    }

    if (['members.appName', 'members.platform', 'locals.openExternal', 'locals.database.getStatus'].includes(manifestKey)) {
      assert(entry.status === 'implemented', `${manifestKey} 实际应为 implemented`);
    }

    if (manifestKey === 'events.database.onStatus') {
      assert(entry.status === 'pending', 'events.database.onStatus 按待实现待定返回');
    }

    if (manifestKey.startsWith('events.')) {
      assert(entry.transport === 'event', `${manifestKey} 事件 transport 应为 event`);
      if (entry.status === 'pending') {
        assert(Array.isArray(entry.errors) && entry.errors.includes('WEB_CAPABILITY_PENDING'), `${manifestKey} pending errors 应包含 WEB_CAPABILITY_PENDING`);
        continue;
      }

      if (entry.status === 'removed') {
        if (entry.source === 'desktop-only') {
          assert(Array.isArray(entry.errors) && entry.errors.includes('WEB_BRIDGE_DESKTOP_ONLY'), `${manifestKey} desktop-only errors 应包含 WEB_BRIDGE_DESKTOP_ONLY`);
          continue;
        }
        if (entry.source === 'deleted-product') {
          assert(Array.isArray(entry.errors) && entry.errors.includes('WEB_BRIDGE_REMOVED'), `${manifestKey} deleted-product errors 应包含 WEB_BRIDGE_REMOVED`);
          continue;
        }
        assert(false, `${manifestKey} removed source 非法：${entry.source}`);
      }
    }

    if (DESKTOP_ONLY_CAPABILITIES.includes(manifestKey)) {
      assert(entry.status === 'removed', `${manifestKey} 标记为 removed`);
      assert(entry.source === 'desktop-only', `${manifestKey} 标记 desktop-only`);
      assert(entry.owner === 'desktop', `${manifestKey} owner 为 desktop`);
      assert(entry.workPackage === 'WP-A', `${manifestKey} workPackage 为 WP-A`);
      assert(Array.isArray(entry.errors) && entry.errors.length === 1 && entry.errors[0] === 'WEB_BRIDGE_DESKTOP_ONLY', `${manifestKey} errors 包含 WEB_BRIDGE_DESKTOP_ONLY`);
    }
  }

  const updateNotifierSource = readSource('src/app/UpdateNotifier.tsx');
  assertSourceContains(
    updateNotifierSource,
    /const isWeb = window\.yibiao\?\.platform === ['"]web['"]/,
    'UpdateNotifier 识别 web 平台',
  );
  assertSourceContains(
    updateNotifierSource,
    /if \(!isWeb\) {\s*void checkUpdate\(\);\s*}/s,
    'UpdateNotifier web 平台不调用 checkUpdate',
  );
  assertSourceContains(
    updateNotifierSource,
    /void checkRemoteNotice\(\)/,
    'UpdateNotifier 保留远程公告检查',
  );

  const settingsPageSource = readSource('src/features/settings/pages/SettingsPage.tsx');
  assertSourceContains(
    settingsPageSource,
    /const isWebPlatform = window\.yibiao\?\.platform === ['"]web['"]/,
    'SettingsPage 识别 web 平台',
  );
  assertSourceContains(
    settingsPageSource,
    /if \(!isWebPlatform\)\s*{[\s\S]*?void window\.yibiao\?\.getVersion\(\)\.then\(setAppVersion\)/,
    'web 平台不会调用 getVersion',
  );
  assertSourceContains(
    settingsPageSource,
    /if \(isWebPlatform\) {\s*setUpdateStatus\('disabled'\);\s*return;\s*}/s,
    'SettingsPage web 分支跳过 checkForUpdates 执行',
  );
  assertSourceContains(
    settingsPageSource,
    /if \(isWebPlatform\) {\s*return;\s*}\s*try {\s*const result = await window\.yibiao\?\.quitAndInstall\(\);/s,
    'SettingsPage web 分支不调用 quitAndInstall',
  );
  assertSourceContains(
    settingsPageSource,
    /{\s*!isWebPlatform \? \(\s*<article className="about-update-card">[\s\S]*?<\/article>\s*\)\s*:\s*null}/,
    'SettingsPage web 平台不渲染自动更新卡片',
  );

  assertRemovedProductWhitelist(removedProductEntries);

  const bindingMetadata = flattenBindingMetadata(bridgeBindingMetadata);
  const bindingKeys = collectBindingDispatcherKeys(routeDispatchers);
  const implementedContractEntries = Array.from(contractMap.entries()).filter(([, entry]) => entry.status === 'implemented');

  const workspaceContext = getWorkspaceContext('contract-test-context');
  try {
    for (const [contractKey, contractEntry] of implementedContractEntries) {
      const isMemberMeta = contractKey.startsWith('members.') || contractKey.startsWith('locals.') || contractKey.startsWith('events.');
      if (isMemberMeta) {
        continue;
      }

      assert(contractEntry && contractEntry.status === 'implemented', `${contractKey} 是 implemented RPC`);

      const binding = bindingMetadata.get(contractKey);
      assert(Boolean(binding), `${contractKey} 有绑定元数据`);
      assert(['direct', 'store'].includes(binding.type), `${contractKey} binding.type 需为 direct 或 store`);

      const dispatcher = routeDispatchers[contractKey.split('.')[0]]?.[contractKey.split('.')[1]];
      assert(typeof dispatcher === 'function', `${contractKey} 有 dispatcher 函数`);

      if (binding.type === 'store') {
        assert(typeof binding.storeName === 'string' && binding.storeName.length > 0, `${contractKey} storeName 有值`);
        assert(typeof binding.storeMethod === 'string' && binding.storeMethod.length > 0, `${contractKey} storeMethod 有值`);

        const store = workspaceContext.stores?.[binding.storeName];
        assert(Boolean(store), `${contractKey} 对应 Store 在真实 context 中存在`);
        assert(typeof store[binding.storeMethod] === 'function', `${contractKey} 对应 Store 方法存在`);
      }

      if (binding.type === 'direct') {
        assert(typeof binding.handler === 'function', `${contractKey} direct handler 已声明为函数`);
      }
    }
  } finally {
    if (workspaceContext && workspaceContext.close) {
      await workspaceContext.close();
    }
  }

  for (const dispatcherKey of bindingKeys) {
    assert(contractMap.has(dispatcherKey), `${dispatcherKey} dispatcher 有对应 manifest 声明`);
    const entry = contractMap.get(dispatcherKey);
    assert(entry.status === 'implemented', `${dispatcherKey} dispatcher 仅对应 implemented manifest`);
  }

  let strictPendingGateMessage = null;
  if (strictMode) {
    strictPendingGateMessage = `strict 模式不允许 pending（当前 ${pendingEntries.length}）`;
    assert(pendingEntries.length === 0, strictPendingGateMessage);
  }

  const session = await createSessionCookie(inject);
  const statusPayload = async (body, sessionCookie) => {
    const cookie = sessionCookie || session;
    const response = await inject({
      method: 'POST',
      url: '/api/bridge',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      payload: body,
    });

    return {
      response,
      payload: response.body || {},
    };
  };

  const unknownRes = await statusPayload({ namespace: 'ghost', method: 'nothing', args: [] });
  assert(unknownRes.response.statusCode === 400, '未知能力返回 400');
  assert(unknownRes.payload.code === 'WEB_BRIDGE_UNKNOWN', '未知能力错误码为 WEB_BRIDGE_UNKNOWN');

  const implementedRes = await statusPayload({ namespace: 'tasks', method: 'getActiveTasks', args: [] });
  assert(implementedRes.response.statusCode === 200, 'implemented 方法返回 200');
  assert(implementedRes.payload.code === 'OK', 'implemented 方法返回 OK');

  const previousResolver = setWorkspaceContextResolver(() => ({
    aiService: {
      listModels: () => {
        const error = new Error('queue overloaded');
        error.code = 'AI_QUEUE_OVERLOADED';
        error.retryable = true;
        return Promise.reject(error);
      },
    },
  }));
  try {
    const overloadedRes = await statusPayload({ namespace: 'config', method: 'listModels', args: [{}] });
    assert(overloadedRes.response.statusCode === 429, 'AI 队列过载通过 Bridge 返回 429');
    assert(overloadedRes.payload.code === 'AI_QUEUE_OVERLOADED', 'AI 队列过载返回 AI_QUEUE_OVERLOADED');
    assert(overloadedRes.response.headers['retry-after'] === '5', 'AI 队列过载返回 Retry-After: 5');
  } finally {
    setWorkspaceContextResolver(previousResolver);
  }

  for (const [manifestKey, entry] of Array.from(contractMap.entries()).filter(([key]) => key.startsWith('events.'))) {
    const eventPath = manifestKey.split('.');
    let eventLeaf = resolvePropertyPath(webBridge, eventPath);
    if (typeof eventLeaf !== 'function' && eventPath.length > 1) {
      eventLeaf = resolvePropertyPath(webBridge, eventPath.slice(1));
    }
    assert(typeof eventLeaf === 'function', `${manifestKey} 在 webBridge 中可执行`);
    if (typeof eventLeaf !== 'function') {
      continue;
    }

    if (entry.status === 'implemented') {
      if (manifestKey === 'events.tasks.onTaskEvent') {
        const before = fakeEventSources.length;
        let unsubscribe;
        try {
          unsubscribe = eventLeaf(() => {});
        } catch (error) {
          assert(false, `${manifestKey} implemented 应可创建 EventSource`);
        }

        assert(typeof unsubscribe === 'function', `${manifestKey} 实现应返回 unsubscribe`);
        assert(fakeEventSources.length === before + 1, `${manifestKey} 实现应创建 EventSource`);
        const eventSource = fakeEventSources[fakeEventSources.length - 1];
        assert(Boolean(eventSource), `${manifestKey} EventSource 实例存在`);
        unsubscribe();
        assert(eventSource.closed === true, `${manifestKey} unsubscribe 后应 close EventSource`);
      } else {
        try {
          eventLeaf(() => {});
        } catch {
          assert(false, `${manifestKey} implemented 在 webBridge 中应可执行`);
        }
      }
      continue;
    }

    let threw = false;
    let actualCode = '';
    try {
      eventLeaf();
    } catch (error) {
      threw = true;
      actualCode = extractErrorCode(error);
    }

    const expectedCode = resolveEventExpectedErrorCode(manifestKey, entry);
    assert(expectedCode, `${manifestKey} removed source 非法：${entry.source}`);
    assert(threw, `${manifestKey} ${entry.status} 运行时应抛错`);
    assert(actualCode === expectedCode, `${manifestKey} ${entry.status} 应抛出 ${expectedCode}`);
  }

  {
    const unknownRemovedEventEntry = {
      status: 'removed',
      source: 'legacy-or-unknown-source',
      errors: ['WEB_BRIDGE_REMOVED'],
    };
    assert(
      resolveEventExpectedErrorCode('events.knowledgeBase.onEvent', unknownRemovedEventEntry) === null,
      '未知 removed event source 无法计算运行时错误码'
    );
  }

  const httpClientRuntime = loadHttpClientRuntimeForFailureBranchCheck();
  const testHttpClientErrors = async (status, code) => {
    const payload = [{ status, payload: { code, message: `contract test ${code}` } }];
    const fetchImpl = createErrorFromHttpClientPayloads(payload);
    const client = httpClientRuntime.loadHttpClientWithFetch(fetchImpl);

    let error;
    try {
      await client.invoke('tasks', 'getActiveTasks', []);
    } catch (caught) {
      error = caught;
    }
    assert(Boolean(error), `httpClient invoke 在状态 ${status} 与 code ${code} 时应抛错`);
    return { error };
  };

  {
    const { error } = await testHttpClientErrors(501, 'WEB_CAPABILITY_PENDING');
    assert(error?.name === 'WebCapabilityPendingError', 'HTTP 501 + WEB_CAPABILITY_PENDING 返回 WebCapabilityPendingError');
    assert(extractErrorCode(error) === 'WEB_CAPABILITY_PENDING', 'HTTP 501 + WEB_CAPABILITY_PENDING 保留 code');
  }

  {
    const { error } = await testHttpClientErrors(501, 'BRIDGE_PROXY_NOT_IMPLEMENTED');
    assert(error?.name === 'WebCapabilityError', 'HTTP 501 + 非 pending code 返回 WebCapabilityError');
    assert(extractErrorCode(error) === 'BRIDGE_PROXY_NOT_IMPLEMENTED', 'HTTP 501 非 pending 保留原 code');
    assert(error.status === 501, 'HTTP 501 非 pending 保留 status');
  }

  {
    const { error } = await testHttpClientErrors(410, 'WEB_BRIDGE_DESKTOP_ONLY');
    assert(error?.name === 'WebCapabilityError', 'HTTP 410 desktop-only 返回 WebCapabilityError');
    assert(extractErrorCode(error) === 'WEB_BRIDGE_DESKTOP_ONLY', 'HTTP 410 保留 desktop-only code');
    assert(error.status === 410, 'HTTP 410 保留 status');
  }

  {
    const { error } = await testHttpClientErrors(500, 'BRIDGE_CONTRACT_MISMATCH');
    assert(error?.name === 'WebCapabilityError', 'HTTP 500 返回 WebCapabilityError');
    assert(extractErrorCode(error) === 'BRIDGE_CONTRACT_MISMATCH', 'HTTP 500 保留契约错误 code');
    assert(error.status === 500, 'HTTP 500 保留 status');
  }

  const pendingRes = await statusPayload({ namespace: 'technicalPlan', method: 'importTenderDocument', args: [] });
  assert(pendingRes.response.statusCode === 501, 'pending 方法返回 501');
  assert(pendingRes.payload.code === 'WEB_CAPABILITY_PENDING', 'pending 方法返回 WEB_CAPABILITY_PENDING');

  for (const method of ['saveFiles', 'updateState']) {
    const contractKey = `duplicateCheck.${method}`;
    const pendingDuplicateCheckRes = await statusPayload({ namespace: 'duplicateCheck', method, args: [{ file_path: '/outside/workspace.txt', content_path: '/outside/content.txt' }] });
    assert(pendingDuplicateCheckRes.response.statusCode === 501, `${contractKey} 返回 501`);
    assert(pendingDuplicateCheckRes.payload.code === 'WEB_CAPABILITY_PENDING', `${contractKey} code 为 WEB_CAPABILITY_PENDING`);
    const bindingSpec = bindingMetadata.get(contractKey);
    assert(!bindingSpec, `${contractKey} 无 binding spec`);
    assert(
      !routeDispatchers?.duplicateCheck || typeof routeDispatchers.duplicateCheck[method] !== 'function',
      `${contractKey} 无 route dispatcher`
    );
  }

  for (const method of KB_PENDING_METHODS) {
    const contractKey = `knowledgeBase.${method}`;
    const pendingKnowledgeRes = await statusPayload({ namespace: 'knowledgeBase', method, args: [] });
    assert(pendingKnowledgeRes.response.statusCode === 501, `${contractKey} 返回 501`);
    assert(pendingKnowledgeRes.payload.code === 'WEB_CAPABILITY_PENDING', `${contractKey} code 为 WEB_CAPABILITY_PENDING`);

    const bindingSpec = bindingMetadata.get(contractKey);
    assert(!bindingSpec, `${contractKey} 无 binding spec`);
    assert(
      !routeDispatchers?.knowledgeBase || typeof routeDispatchers.knowledgeBase[method] !== 'function',
      `${contractKey} 无 route dispatcher`
    );
  }

  for (const entryName of DESKTOP_ONLY_CAPABILITIES) {
    const [namespace, method] = entryName.split('.');
    const removedRes = await statusPayload({ namespace, method, args: [] });
    assert(removedRes.response.statusCode === 410, `${entryName} 返回 410`);
    assert(removedRes.payload.code === 'WEB_BRIDGE_DESKTOP_ONLY', `${entryName} 返回 WEB_BRIDGE_DESKTOP_ONLY`);
    assert(/桌面端专属/.test(String(removedRes.payload.message || '')), `${entryName} 使用桌面专属提示文案`);
  }

  for (const removedEntry of removedProductEntries.values()) {
    const [namespace, method] = removedEntry.contractRef.split('.');
    const removedRes = await statusPayload({ namespace, method, args: [] });
    assert(removedRes.response.statusCode === 410, `${removedEntry.contractRef} 返回 410`);
    assert(removedRes.payload.code === 'WEB_BRIDGE_REMOVED', `${removedEntry.contractRef} 返回 WEB_BRIDGE_REMOVED`);
    assert(/下线/.test(String(removedRes.payload.message || '')), `${removedEntry.contractRef} 返显下线文案`);
  }

  if (bridgeContractMethods && bridgeContractMethods.tasks && typeof bridgeContractMethods.tasks === 'object') {
    const unknownRemovedMethod = '__testUnknownRemovedSource';
    const originalUnknownRemoved = bridgeContractMethods.tasks[unknownRemovedMethod];
    bridgeContractMethods.tasks[unknownRemovedMethod] = {
      status: 'removed',
      owner: 'web-runtime',
      workPackage: 'WP-A',
      source: 'legacy-or-unknown-source',
      transport: 'bridge',
      contractRef: `tasks.${unknownRemovedMethod}`,
      input: [],
      output: null,
      errors: ['WEB_BRIDGE_REMOVED'],
    };
    try {
      const unknownRemovedRes = await statusPayload({ namespace: 'tasks', method: unknownRemovedMethod, args: [] });
      assert(unknownRemovedRes.response.statusCode === 500, '未知 removed source 返回 500');
      assert(unknownRemovedRes.payload.code === 'BRIDGE_CONTRACT_MISMATCH', '未知 removed source 使用 BRIDGE_CONTRACT_MISMATCH');
      assert(Boolean(String(unknownRemovedRes.payload.message || '')), '未知 removed source 有明确错误文案');
    } finally {
      if (originalUnknownRemoved === undefined) {
        delete bridgeContractMethods.tasks[unknownRemovedMethod];
      } else {
        bridgeContractMethods.tasks[unknownRemovedMethod] = originalUnknownRemoved;
      }
    }
  }

  for (const badName of FORBIDDEN_PROTOTYPE_IDENTIFIERS) {
    const badResponse = await statusPayload({ namespace: 'tasks', method: badName, args: [] });
    assert(badResponse.response.statusCode === 400, `method ${badName} 被 prototype 防御拦截`);
    assert(badResponse.payload.code === 'INVALID_BRIDGE_IDENTIFIER', `method ${badName} 错误码为 INVALID_BRIDGE_IDENTIFIER`);

    const badNamespace = await statusPayload({ namespace: badName, method: 'getActiveTasks', args: [] });
    assert(badNamespace.response.statusCode === 400, `namespace ${badName} 被 prototype 防御拦截`);
  }

  let getArgsRes = await statusPayload({ namespace: 'tasks', method: 'getActiveTasks', args: { a: 1 } });
  assert(getArgsRes.response.statusCode === 400, 'args 非数组会返回 400');
  assert(getArgsRes.payload.code === 'INVALID_BRIDGE_ARGUMENTS', 'args 非数组错误码正确');

  let workspaceResolved = 0;
  const oldResolver = setWorkspaceContextResolver(() => {
    workspaceResolved += 1;
    throw new Error('workspace resolver should not be called for pending/removed paths');
  });

  try {
    const wsPendingRes = await statusPayload({ namespace: 'tasks', method: 'startBidSectionExtraction', args: [] });
    assert(wsPendingRes.response.statusCode === 501, 'pending 能力返回 501，且不触发 workspace');
    assert(workspaceResolved === 0, 'pending 能力未初始化 workspace');

    for (const method of ['saveFiles', 'updateState']) {
      const wsDuplicateCheckPendingRes = await statusPayload({ namespace: 'duplicateCheck', method, args: [{ file_path: '/outside/workspace.txt', content_path: '/outside/content.txt' }] });
      assert(wsDuplicateCheckPendingRes.response.statusCode === 501, `duplicateCheck.${method} 返回 501 且不触发 workspace`);
      assert(workspaceResolved === 0, `duplicateCheck.${method} 不初始化 workspace`);
    }

    for (const method of KB_PENDING_METHODS) {
      const wsKnowledgePendingRes = await statusPayload({ namespace: 'knowledgeBase', method, args: [] });
      assert(wsKnowledgePendingRes.response.statusCode === 501, `knowledgeBase.${method} 返回 501 且不触发 workspace`);
      assert(workspaceResolved === 0, `knowledgeBase.${method} 不初始化 workspace`);
    }

    for (const entryName of DESKTOP_ONLY_CAPABILITIES) {
      const [namespace, method] = entryName.split('.');
      const wsRemovedRes = await statusPayload({ namespace, method, args: [] });
      assert(wsRemovedRes.response.statusCode === 410, `${entryName} 返回 410，且不触发 workspace`);
      assert(workspaceResolved === 0, `${entryName} 不初始化 workspace`);
    }

    const wsRemovedRes = await statusPayload({ namespace: 'resources', method: 'list', args: [] });
    assert(wsRemovedRes.response.statusCode === 410, 'removed 能力返回 410，且不触发 workspace');
    assert(workspaceResolved === 0, 'removed 能力未初始化 workspace');
  } finally {
    if (typeof oldResolver === 'function') {
      setWorkspaceContextResolver(oldResolver);
    }
  }

  const unavailableResolver = setWorkspaceContextResolver(() => {
    const error = new Error('closing /private/workspace/path');
    error.code = 'WORKSPACE_UNAVAILABLE';
    error.state = 'closing';
    error.retryable = true;
    throw error;
  });
  try {
    const unavailableResult = await statusPayload({
      namespace: 'tasks',
      method: 'getActiveTasks',
      args: [],
    });
    assert(unavailableResult.response.statusCode === 503, 'workspace unavailable bridge 返回 503');
    assert(unavailableResult.payload.code === 'WORKSPACE_UNAVAILABLE', 'workspace unavailable bridge 保留错误码');
    assert(unavailableResult.payload.retryable === true, 'workspace unavailable bridge 标记可重试');
    assert(
      typeof unavailableResult.payload.message === 'string'
        && unavailableResult.payload.message.includes('稍后重试'),
      'workspace unavailable bridge 返回安全中文提示',
    );
    const unavailablePayload = JSON.stringify(unavailableResult.payload);
    assert(!unavailablePayload.includes('closing'), 'workspace unavailable bridge 不泄露 state');
    assert(!unavailablePayload.includes('/private/workspace/path'), 'workspace unavailable bridge 不泄露路径');
  } finally {
    setWorkspaceContextResolver(unavailableResolver);
  }

  const implementedRequiresWorkspace = await statusPayload({ namespace: 'tasks', method: 'getActiveTasks', args: [] });
  assert(implementedRequiresWorkspace.response.statusCode === 200, 'implemented 调用可正常返回');

  {
    const sessionA = await createSessionCookie(inject, 'legacy-a@example.com', 'LegacyA');
    const sessionB = await createSessionCookie(inject, 'legacy-b@example.com', 'LegacyB');

    const accountAInitial = await statusPayload({ namespace: 'config', method: 'load', args: [] }, sessionA);
    assert(accountAInitial.response.statusCode === 200, 'config.load_A 返回 200');
    assert(accountAInitial.payload.code === 'OK', 'config.load_A code 为 OK');
    const accountAClientId = accountAInitial.payload?.data?.analytics_client_id || '';
    assert(accountAClientId, 'config.load_A 返回 analytics_client_id');

    const legacyId = 'legacy-id-from-browser-side';
    const accountASave = await statusPayload({
      namespace: 'config',
      method: 'save',
      args: [{
        ...accountAInitial.payload?.data,
        analytics_client_id: legacyId,
      }],
    }, sessionA);
    const accountASaveData = accountASave.payload?.data || {};
    assert(accountASave.response.statusCode === 200, 'config.save_A 返回 200');
    assert(accountASaveData.success === true, 'config.save_A success 为 true');
    assert(accountASaveData.message === '配置已保存', 'config.save_A message 为配置已保存');
    assert(accountASaveData.config_path === undefined, 'config.save_A 不回传服务端路径');

    const accountALoadAfterSave = await statusPayload({ namespace: 'config', method: 'load', args: [] }, sessionA);
    const accountALoadedIdAfterSave = accountALoadAfterSave.payload?.data?.analytics_client_id || '';
    assert(accountALoadedIdAfterSave === accountAClientId, 'save legacy id 后 load_A 仍为原账号 analytics_client_id');
    assert(accountALoadedIdAfterSave !== legacyId, 'legacy id 未覆盖服务端 analytics_client_id');

    const accountBLoad = await statusPayload({ namespace: 'config', method: 'load', args: [] }, sessionB);
    const accountBClientId = accountBLoad.payload?.data?.analytics_client_id || '';
    assert(accountBLoad.response.statusCode === 200, 'config.load_B 返回 200');
    assert(accountBClientId && accountBClientId !== accountAClientId, '两个账号读取的 analytics_client_id 不同');
  }

  const menuApiText = collectStringLiterals(readSource('src/app/menuConfig.ts'));
  const routerText = collectStringLiterals(readSource('src/app/AppRouter.tsx'));
  const navigationText = collectStringLiterals(readSource('src/shared/types/navigation.ts'));
  const sidebarText = collectStringLiterals(readSource('src/components/Sidebar.tsx'));

  for (const removedId of REMOVED_MENU_SECTIONS) {
    assert(!menuApiText.has(removedId), `menuConfig 不再声明 ${removedId}`);
    assert(!routerText.has(removedId), `AppRouter 不再声明 ${removedId}`);
    assert(!navigationText.has(removedId), `navigation 不再声明 ${removedId}`);
    assert(!sidebarText.has(removedId), `Sidebar 不再声明 ${removedId}`);
  }

  for (const targetPath of DELETED_FEATURE_PATHS) {
    const absolutePath = path.join(__dirname, '..', targetPath);
    assert(!fs.existsSync(absolutePath), `已删除路径不存在：${targetPath}`);
  }

  console.log(`\n=== Web Contract 测试摘要 ===`);
  console.log(`Contract 版本：${contractVersion}`);
  console.log(`Bridge 叶子（AST）数量：${bridgeLeaves.size}`);
  console.log(`manifest 条目：${contractEntries.size}`);
  console.log(`manifest pending：${pendingEntries.length}`);
  console.log(`通过: ${passed.length}`);
  console.log(`失败: ${failed.length}`);
  failed.forEach((item) => {
    console.error(`  - ${item}`);
  });

  const isStrictPendingOnlyFailure = Boolean(
    strictMode
    && strictPendingGateMessage
    && failed.length === 1
    && failed.includes(strictPendingGateMessage)
  );

  return {
    failedCount: failed.length,
    isStrictPendingOnlyFailure,
    strictCleanupFailure: false,
  };
}

async function startServer() {
  await new Promise((resolve, reject) => {
    if (!server) {
      reject(new Error('server 未初始化'));
      return;
    }

    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });
  port = server.address().port;
}

async function closeServer() {
  if (!server) {
    return;
  }
  if (!server.listening) {
    return;
  }
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

(async () => {
  let tmpDataDir;
  let closeWorkspace;
  let contractVersion = 'unknown';
  let result = {
    failedCount: 0,
    isStrictPendingOnlyFailure: false,
    strictCleanupFailure: false,
  };

  try {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-contract-test-'));
    process.env.YIBIAO_DATA_DIR = tmpDataDir;
    process.env.CONFIG_ENCRYPTION_KEY = 'test-key';
    process.env.OAUTH_MODE = 'mock';
    process.env.SESSION_SECRET = 'dev-secret';

    const contractModule = require('../shared/bridgeContract.cjs');
    contractVersion = contractModule.version;
    const { allEntries: contractEntries, removedProductEntries } = flattenManifest();
    const workspaceContextModule = require('../server/workspace/workspaceContext.cjs');
    if (process.env.WEB_CONTRACT_SIMULATE_CLOSE_WARNING === '1') {
      const originalCreateWorkspaceContext = workspaceContextModule.createWorkspaceContext;
      workspaceContextModule.createWorkspaceContext = (...args) => {
        const workspaceContext = originalCreateWorkspaceContext(...args);
        const options = args[0] || {};
        if (options.workspaceId === 'contract-close-warning') {
          const originalClose = typeof workspaceContext.close === 'function' ? workspaceContext.close.bind(workspaceContext) : undefined;
          return {
            ...workspaceContext,
            async close() {
              try {
                if (originalClose) {
                  await originalClose();
                }
              } finally {
                throw new Error('contract-close-warning');
              }
            },
          };
        }
        return {
          ...workspaceContext,
          async close() {
            return workspaceContext.close();
          },
        };
      };
    }
    const bridgeContractRouter = require('../server/routes/bridge.cjs');
    const bridgeBindingMetadata = bridgeContractRouter.__contractBindingMetadata;
    const routeDispatchers = bridgeContractRouter.__contractDispatchers || {};
    const setWorkspaceContextResolver = bridgeContractRouter.__setWorkspaceContextResolver;
    const { getWorkspaceContext, closeAll } = require('../server/workspace/workspaceRegistry.cjs');
    const { createApp } = require('../server/app.cjs');
    const webBridgeRuntime = loadWebBridgeRuntimeForEventCheck();

    const app = createApp();
    server = http.createServer(app);
    closeWorkspace = closeAll;
    if (process.env.WEB_CONTRACT_SIMULATE_CLOSE_WARNING === '1') {
      getWorkspaceContext('contract-close-warning');
    }

    const inject = createRequest();
    await startServer();

    result = await runBridgeBehavior(inject, {
      contractEntries,
      removedProductEntries,
      bridgeContractMethods: contractModule.methods,
      bridgeBindingMetadata,
      routeDispatchers,
      getWorkspaceContext,
      setWorkspaceContextResolver,
      contractVersion,
      webBridgeRuntime,
    });
  } catch (error) {
    result.failedCount += 1;
    const errorMessage = error instanceof Error ? error.message : String(error);
    failed.push(`脚本执行异常：${errorMessage}`);
  } finally {
    try {
      await closeServer();
    } catch (error) {
      console.error('关闭服务器失败:', error instanceof Error ? error.message : error);
      result.failedCount = (result.failedCount || 0) + 1;
      failed.push('服务器关闭失败');
      result.strictCleanupFailure = true;
    }

    try {
      if (typeof closeWorkspace === 'function') {
        const warnCollector = collectWorkspaceCloseWarnings();
        try {
          await closeWorkspace();
        } finally {
          warnCollector.restore();
        }
        if (warnCollector.observed.length > 0) {
          result.strictCleanupFailure = true;
          result.failedCount = (result.failedCount || 0) + 1;
          failed.push('cleanup workspace 失败');
        }
      }
    } catch (error) {
      console.error('清理 workspace 失败:', error instanceof Error ? error.message : error);
      result.failedCount = (result.failedCount || 0) + 1;
      failed.push('cleanup workspace 失败');
      result.strictCleanupFailure = true;
    }

    try {
      if (tmpDataDir) {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      }
    } catch (error) {
      console.error('清理临时目录失败:', error instanceof Error ? error.message : error);
      result.failedCount = (result.failedCount || 0) + 1;
      failed.push('cleanup tmpDir 失败');
      result.strictCleanupFailure = true;
    }
  }

  if (result.failedCount > 0) {
    if (result.isStrictPendingOnlyFailure && !result.strictCleanupFailure) {
      console.log('CONTRACT_STRICT_GUARD=EXPECTED_PENDING_FAILURE');
    }
    process.exitCode = 1;
    return;
  }

  console.log('全部通过 ✅');
})();
