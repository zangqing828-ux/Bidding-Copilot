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

// 先创建独立工作区目录，避免影响本地真实数据。
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-contract-test-'));
process.env.YIBIAO_DATA_DIR = tmpDataDir;
process.env.CONFIG_ENCRYPTION_KEY = 'test-key';
process.env.OAUTH_MODE = 'mock';
process.env.SESSION_SECRET = 'dev-secret';

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

const contractModule = require('../shared/bridgeContract.cjs');
const contractVersion = contractModule.version;
const { allEntries: contractEntries, removedProductEntries } = flattenManifest();

const bridgeContractRouter = require('../server/routes/bridge.cjs');
const bridgeBindingMetadata = bridgeContractRouter.__contractBindingMetadata;
const routeDispatchers = bridgeContractRouter.__contractDispatchers || {};
const setWorkspaceContextResolver = bridgeContractRouter.__setWorkspaceContextResolver;

const { getWorkspaceContext, closeAll } = require('../server/workspace/workspaceRegistry.cjs');
const { createApp } = require('../server/app.cjs');
const app = createApp();
const server = http.createServer(app);
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

function parseLoginState(authLocation, setCookies) {
  const stateValue = authLocation?.match(/state=([^&]+)/)?.[1] || '';
  const loginCookies = Array.isArray(setCookies) ? setCookies : (setCookies ? [setCookies] : []);
  const stateCookie = loginCookies.find((item) => item.startsWith('yibiao_oauth_state='));
  const stateCookieValue = stateCookie?.match(/yibiao_oauth_state=([^;]+)/)?.[1] || '';
  return { stateValue, stateCookieValue };
}

async function createSessionCookie(inject) {
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
    payload: `email=contract@test.com&name=ContractTester&state=${stateValue}`,
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

function assertRemovedProductWhitelist() {
  assert(removedProductEntries.size === 3, `deleted-product 移除项为 3 项（当前 ${removedProductEntries.size}）`);

  for (const [entryKey, spec] of removedProductEntries.entries()) {
    assert(spec.status === 'removed', `${entryKey} removed 状态正确`);
    assert(spec.source === 'deleted-product', `${entryKey} source 为 deleted-product`);
  }
}

async function runBridgeBehavior(inject) {
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

    if (manifestKey === 'events.tasks.onTaskEvent') {
      assert(entry.status === 'implemented', 'events.tasks.onTaskEvent 为 implemented');
      assert(entry.transport === 'event', 'events.tasks.onTaskEvent transport 为 event');
    }

    if (['members.appName', 'members.platform', 'locals.openExternal', 'locals.database.getStatus'].includes(manifestKey)) {
      assert(entry.status === 'implemented', `${manifestKey} 实际应为 implemented`);
    }

    if (manifestKey === 'events.database.onStatus') {
      assert(entry.status === 'pending', 'events.database.onStatus 按待实现待定返回');
    }

    if (DESKTOP_ONLY_CAPABILITIES.includes(manifestKey)) {
      assert(entry.status === 'removed', `${manifestKey} 标记为 removed`);
      assert(entry.source === 'desktop-only', `${manifestKey} 标记 desktop-only`);
      assert(entry.owner === 'desktop', `${manifestKey} owner 为 desktop`);
      assert(entry.workPackage === 'WP-A', `${manifestKey} workPackage 为 WP-A`);
      assert(Array.isArray(entry.errors) && entry.errors.length === 1 && entry.errors[0] === 'WEB_BRIDGE_DESKTOP_ONLY', `${manifestKey} errors 包含 WEB_BRIDGE_DESKTOP_ONLY`);
    }
  }

  assertRemovedProductWhitelist();

  const bindingMetadata = flattenBindingMetadata(bridgeBindingMetadata);
  const bindingKeys = collectBindingDispatcherKeys(routeDispatchers);
  const implementedContractEntries = Array.from(contractMap.entries()).filter(([, entry]) => entry.status === 'implemented');

  const context = getWorkspaceContext('contract-test-context');
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

        const store = context.stores?.[binding.storeName];
        assert(Boolean(store), `${contractKey} 对应 Store 在真实 context 中存在`);
        assert(typeof store[binding.storeMethod] === 'function', `${contractKey} 对应 Store 方法存在`);
      }

      if (binding.type === 'direct') {
        assert(typeof binding.handler === 'function', `${contractKey} direct handler 已声明为函数`);
      }
    }
  } finally {
    if (context && context.close) {
      context.close();
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
  const statusPayload = async (body) => {
    const response = await inject({
      method: 'POST',
      url: '/api/bridge',
      headers: {
        'content-type': 'application/json',
        cookie: session,
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

  const pendingRes = await statusPayload({ namespace: 'technicalPlan', method: 'importTenderDocument', args: [] });
  assert(pendingRes.response.statusCode === 501, 'pending 方法返回 501');
  assert(pendingRes.payload.code === 'WEB_CAPABILITY_PENDING', 'pending 方法返回 WEB_CAPABILITY_PENDING');

  for (const entryName of DESKTOP_ONLY_CAPABILITIES) {
    if (entryName.startsWith('events.')) {
      continue;
    }
    const [namespace, method] = entryName.split('.');
    const removedRes = await statusPayload({ namespace, method, args: [] });
    assert(removedRes.response.statusCode === 410, `${entryName} 返回 410`);
    assert(removedRes.payload.code === 'WEB_BRIDGE_REMOVED', `${entryName} 返回 WEB_BRIDGE_REMOVED`);
  }

  for (const removedEntry of removedProductEntries.values()) {
    const [namespace, method] = removedEntry.contractRef.split('.');
    const removedRes = await statusPayload({ namespace, method, args: [] });
    assert(removedRes.response.statusCode === 410, `${removedEntry.contractRef} 返回 410`);
    assert(removedRes.payload.code === 'WEB_BRIDGE_REMOVED', `${removedEntry.contractRef} 返回 WEB_BRIDGE_REMOVED`);
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

    for (const entryName of DESKTOP_ONLY_CAPABILITIES) {
      if (entryName.startsWith('events.')) {
        continue;
      }
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

  const implementedRequiresWorkspace = await statusPayload({ namespace: 'tasks', method: 'getActiveTasks', args: [] });
  assert(implementedRequiresWorkspace.response.statusCode === 200, 'implemented 调用可正常返回');

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
  };
}

async function startServer() {
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });
  port = server.address().port;
}

async function closeServer() {
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
  const inject = createRequest();
  let result = { failedCount: 0, isStrictPendingOnlyFailure: false };
  await startServer();
  try {
    result = await runBridgeBehavior(inject);
  } finally {
    await closeServer();
    try {
      closeAll();
    } catch {}
    try {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    } catch {}
  }

  if (result.failedCount > 0) {
    if (result.isStrictPendingOnlyFailure) {
      console.log('CONTRACT_STRICT_GUARD=EXPECTED_PENDING_FAILURE');
    }
    process.exitCode = 1;
    return;
  }

  console.log('全部通过 ✅');
})();
