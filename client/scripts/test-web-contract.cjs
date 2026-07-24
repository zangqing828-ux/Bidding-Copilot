// Web Bridge Contract 测试：校验 client/src/shared/api/webBridge.ts 与 manifest 的双向一致性，并验证失败码边界。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const passed = [];
const failed = [];
const strictMode = process.argv.includes('--strict') || process.env.CONTRACT_STRICT === '1';
const ALLOWED_STATUSES = new Set(['implemented', 'pending', 'removed']);
const FORBIDDEN_IDENTIFIERS = new Set(['__proto__', 'constructor', 'prototype', 'toString']);

const contract = require('../shared/bridgeContract.cjs');
const { methods: contractMethods } = contract;

const { createApp } = require('../server/app.cjs');
const app = createApp();

let injectImpl;
let server = null;

function assert(condition, message) {
  if (condition) {
    passed.push(message);
  } else {
    failed.push(message);
    console.error(`  FAIL: ${message}`);
  }
}

function parseBridgeMethods() {
  const bridgeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'api', 'webBridge.ts'), 'utf-8');
  const callRegex = /bridgeMethod\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g;
  const methods = new Map();
  for (const match of bridgeSource.matchAll(callRegex)) {
    const namespace = match[1];
    const method = match[2];
    const key = `${namespace}.${method}`;
    methods.set(key, { namespace, method });
  }
  return methods;
}

function normalizeErrorPayload(payloadText) {
  try {
    return JSON.parse(payloadText);
  } catch {
    return {};
  }
}

function flattenManifest() {
  const map = new Map();
  const removedProducts = [];
  for (const [namespace, methods] of Object.entries(contractMethods || {})) {
    for (const [method, spec] of Object.entries(methods || {})) {
      const key = `${namespace}.${method}`;
      const status = spec?.status;
      const owner = spec?.owner;
      const workPackage = spec?.workPackage;
      map.set(key, {
        namespace,
        method,
        status,
        owner,
        workPackage,
        source: spec?.source || 'webBridge',
      });
      if ((spec?.source || 'webBridge') === 'deleted-product') {
        removedProducts.push({ namespace, method, owner, workPackage, status });
      }
    }
  }
  return { map, removedProducts };
}

function createTestRequest() {
  try {
    const supertest = require('supertest');
    const req = supertest(app);
    return async ({ method, url, headers = {}, payload }) => {
      let r = req[method.toLowerCase()](url);
      for (const [key, value] of Object.entries(headers)) {
        r = r.set(key, value);
      }
      if (payload !== undefined) {
        r = r.send(payload);
      }
      const res = await r;
      return { statusCode: res.status, headers: res.headers, body: typeof res.text === 'string' ? res.text : JSON.stringify(res.body) };
    };
  } catch (err) {
    if (!server) server = http.createServer(app);
    return (reqOptions) => new Promise((resolve, reject) => {
      if (!server.listening) {
        return reject(new Error('HTTP server not started'));
      }
      const { method, url, headers = {}, payload } = reqOptions;
      const payloadText = payload !== undefined
        ? (typeof payload === 'string' ? payload : JSON.stringify(payload))
        : null;
      const requestHeaders = { ...headers };
      if (payloadText && !requestHeaders['content-type']) requestHeaders['content-type'] = 'application/json';
      if (payloadText) requestHeaders['content-length'] = Buffer.byteLength(payloadText);
      const req = http.request({
        method,
        path: url,
        host: '127.0.0.1',
        port: server.address().port,
        headers: requestHeaders,
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, headers: res.headers, body });
        });
      });
      req.on('error', reject);
      if (payloadText) req.write(payloadText);
      req.end();
    });
  }
}

function getSessionCookieFromResponse(loginRes) {
  const stateMatch = loginRes.headers.location?.match(/state=([^&]+)/);
  const stateValue = stateMatch ? stateMatch[1] : '';
  const setCookies = loginRes.headers['set-cookie'];
  const loginCookies = Array.isArray(setCookies) ? setCookies : (setCookies ? [setCookies] : []);
  const stateCookie = loginCookies.find((c) => c.startsWith('yibiao_oauth_state='));
  const cookieValue = stateCookie?.match(/yibiao_oauth_state=([^;]+)/)?.[1];
  return { stateValue, stateCookieValue: cookieValue };
}

async function loginWithMock(inject) {
  const loginRes = await inject({ method: 'GET', url: '/api/auth/login' });
  if (loginRes.statusCode !== 302) {
    throw new Error('mock login 失败：未返回 302');
  }
  const { stateValue, stateCookieValue } = getSessionCookieFromResponse(loginRes);
  const callbackRes = await inject({
    method: 'POST',
    url: '/api/auth/mock-callback',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `yibiao_oauth_state=${stateCookieValue}`,
    },
    payload: `email=contract@test.com&name=ContractTester&state=${stateValue}`,
  });
  if (callbackRes.statusCode !== 302) {
    throw new Error('mock callback 失败');
  }
  const setCookies = callbackRes.headers['set-cookie'];
  const loginCookies = Array.isArray(setCookies) ? setCookies : (setCookies ? [setCookies] : []);
  const sessionCookie = loginCookies.find((c) => c.startsWith('yibiao_session='));
  const sessionCookieValue = sessionCookie?.match(/yibiao_session=([^;]+)/)?.[1];
  if (!sessionCookieValue) {
    throw new Error('mock login 失败：未拿到 session cookie');
  }
  return `yibiao_session=${sessionCookieValue}`;
}

function makeBridgePayload(namespace, method, args = []) {
  return { namespace, method, args };
}

async function assertResponse(inject, status, code, message, namespace, method, args = []) {
  const sessionCookie = await currentSessionCookiePromise;
  const response = await inject({
    method: 'POST',
    url: '/api/bridge',
    headers: {
      'content-type': 'application/json',
      cookie: sessionCookie,
    },
    payload: makeBridgePayload(namespace, method, args),
  });
  const body = normalizeErrorPayload(response.body);
  assert(response.statusCode === status, `${message}（状态码 ${status}）`);
  assert(!code || body.code === code, `${message}（响应码 ${code}）`);
  return response;
}

let currentSessionCookiePromise;

async function runTests(inject) {
  const { map: manifestMap, removedProducts } = flattenManifest();
  const sourceMethods = parseBridgeMethods();
  for (const [key, { namespace, method }] of sourceMethods) {
    const manifest = manifestMap.get(key);
    assert(Boolean(manifest), `manifest 覆盖 webBridge.ts 方法：${key}`);
    assert(ALLOWED_STATUSES.has(manifest?.status), `manifest 状态合法：${key}`);
    assert(typeof manifest?.owner === 'string' && manifest.owner.length > 0, `manifest owner 已设置：${key}`);
    assert(typeof manifest?.workPackage === 'string' && manifest.workPackage.length > 0, `manifest workPackage 已设置：${key}`);
  }
  for (const [key, entry] of manifestMap.entries()) {
    const fromSource = sourceMethods.has(key);
    if (!fromSource) {
      const isRemovedProduct = removedProducts.some((it) => `${it.namespace}.${it.method}` === key);
      assert(isRemovedProduct, `manifest 非 webBridge 方法仅允许删除能力占位：${key}`);
      if (isRemovedProduct) {
        assert(entry.status === 'removed', `manifest 删除能力状态为 removed：${key}`);
      }
    }
    if (fromSource && entry.status === 'removed') {
      assert(false, `webBridge 方法不得标记为 removed：${key}`);
    }
  }

  const pendingEntries = Array.from(manifestMap.values()).filter((entry) => entry.status === 'pending');
  if (pendingEntries.length > 0) {
    console.log(`\n发现 pending 能力（默认允许）：${pendingEntries.length} 条`);
    pendingEntries.forEach((entry) => {
      console.log(`  - ${entry.namespace}.${entry.method}`);
    });
  }
  if (strictMode) {
    assert(pendingEntries.length === 0, 'strict 模式不允许 pending');
  } else {
    assert(true, 'strict 模式未开启，允许 pending 存在');
  }

  currentSessionCookiePromise = loginWithMock(inject);

  // unknown 能力：4xx 且不泄漏细节
  const unknownRes = await assertResponse(
    inject,
    400,
    'WEB_BRIDGE_UNKNOWN',
    '未知 namespace/method 返回 400',
    'ghost',
    'not_exist',
    []
  );
  const unknownPayload = normalizeErrorPayload(unknownRes.body);
  assert(!/technical|not implemented|尚未/.test(String(unknownPayload.message || '')), '未知能力错误不泄漏实现细节');

  // prototype 入口阻断
  for (const bad of FORBIDDEN_IDENTIFIERS) {
    const badRes = await inject({
      method: 'POST',
      url: '/api/bridge',
      headers: { 'content-type': 'application/json', cookie: await currentSessionCookiePromise },
      payload: makeBridgePayload('tasks', bad, []),
    });
    assert(badRes.statusCode === 400, `method 为 ${bad} 的请求被拒绝`);
    const badPayload = normalizeErrorPayload(badRes.body);
    assert(badPayload.code === 'INVALID_BRIDGE_IDENTIFIER', `method 为 ${bad} 的请求返回 INVALID_BRIDGE_IDENTIFIER`);
  }
  {
    const badRes = await inject({
      method: 'POST',
      url: '/api/bridge',
      headers: { 'content-type': 'application/json', cookie: await currentSessionCookiePromise },
      payload: makeBridgePayload('__proto__', 'get', []),
    });
    assert(badRes.statusCode === 400, 'namespace __proto__ 被拒绝');
    const badPayload = normalizeErrorPayload(badRes.body);
    assert(badPayload.code === 'INVALID_BRIDGE_IDENTIFIER', 'namespace __proto__ 返回 INVALID_BRIDGE_IDENTIFIER');
  }

  // args 非数组被拒绝
  const argsRes = await inject({
    method: 'POST',
    url: '/api/bridge',
    headers: { 'content-type': 'application/json', cookie: await currentSessionCookiePromise },
    payload: makeBridgePayload('tasks', 'getActiveTasks', { a: 1 }),
  });
  const argsPayload = normalizeErrorPayload(argsRes.body);
  assert(argsRes.statusCode === 400, 'args 非数组返回 400');
  assert(argsPayload.code === 'INVALID_BRIDGE_ARGUMENTS', 'args 非数组返回 INVALID_BRIDGE_ARGUMENTS');

  // removed 入口静态守卫
  for (const removed of removedProducts) {
    const removedRes = await inject({
      method: 'POST',
      url: '/api/bridge',
      headers: { 'content-type': 'application/json', cookie: await currentSessionCookiePromise },
      payload: makeBridgePayload(removed.namespace, removed.method, []),
    });
    const removedPayload = normalizeErrorPayload(removedRes.body);
    assert(removedRes.statusCode === 410, `删除能力 ${removed.namespace}.${removed.method} 返回 410`);
    assert(removedPayload.code === 'WEB_BRIDGE_REMOVED', `删除能力 ${removed.namespace}.${removed.method} 返回 WEB_BRIDGE_REMOVED`);
  }

  // 典型已实现 + 待实现行为
  await assertResponse(inject, 200, 'OK', 'implemented: tasks.getActiveTasks 返回 200', 'tasks', 'getActiveTasks', []);
  await assertResponse(inject, 200, 'OK', 'implemented: technicalPlan.loadState 返回 200', 'technicalPlan', 'loadState', []);
  await assertResponse(inject, 501, 'WEB_CAPABILITY_PENDING', 'pending: technicalPlan.importTenderDocument 返回 501', 'technicalPlan', 'importTenderDocument', []);

  console.log(`\n=== Web Bridge Contract 测试结果 ===`);
  console.log(`通过: ${passed.length}`);
  console.log(`失败: ${failed.length}`);
  if (failed.length > 0) {
    console.log('\n失败项:');
    failed.forEach((item) => console.log(`  - ${item}`));
    process.exit(1);
  }
  console.log('全部通过 ✅');
}

async function startServerAndRun() {
  const inject = createTestRequest();
  if (server) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  }
  try {
    await runTests(inject);
  } finally {
    if (server && server.listening) {
      server.close();
    }
  }
}

startServerAndRun().catch((error) => {
  console.error('测试执行失败:', error);
  if (server && server.listening) {
    server.close();
  }
  process.exit(1);
});
