// Web Auth 自动化测试：覆盖 state CSRF、XSS、Cookie、会话、401、退出、生产配置。
// 用 supertest 风格的 http 调用直接测 Express app，不启动真实端口。
// 运行：npm run test:web-auth（需要先 npm rebuild better-sqlite3 --runtime=node）
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createApp } = require('../server/app.cjs');

const app = createApp();

const passed = [];
const failed = [];

function assert(condition, message) {
  if (condition) {
    passed.push(message);
  } else {
    failed.push(message);
    console.error(`  FAIL: ${message}`);
  }
}

// 辅助：从 Set-Cookie 头提取 cookie 值
function extractCookie(setCookieHeader, name) {
  if (!setCookieHeader) return null;
  const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const c of cookies) {
    const match = c.match(new RegExp(`${name}=([^;]+)`));
    if (match) return match[1];
  }
  return null;
}

// 辅助：从 Set-Cookie 头提取所有属性
function getCookieAttrs(setCookieHeader, name) {
  if (!setCookieHeader) return '';
  const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const c of cookies) {
    if (c.startsWith(`${name}=`)) return c;
  }
  return '';
}

async function runTests() {
  // 测试 1：未登录访问业务 API → 401
  {
    const res = await app.inject({
      method: 'POST',
      url: '/api/bridge',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    assert(res.statusCode === 401, '未登录访问业务 API 返回 401');
  }

  // 测试 2：未登录访问 /api/auth/me → 401
  {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    assert(res.statusCode === 401, '未登录访问 /api/auth/me 返回 401');
  }

  // 测试 3：公开路由 /api/health → 200
  {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    assert(res.statusCode === 200, '/api/health 公开访问 200');
    const body = JSON.parse(res.body);
    assert(!JSON.stringify(body).includes('secret'), '/api/health 不含 secret');
    assert(!JSON.stringify(body).includes('path'), '/api/health 不含路径');
  }

  // 测试 4：公开路由 /api/runtime-config → 200
  {
    const res = await app.inject({ method: 'GET', url: '/api/runtime-config' });
    assert(res.statusCode === 200, '/api/runtime-config 公开访问 200');
  }

  // 测试 5：GET /api/auth/login 设置 state Cookie
  {
    const res = await app.inject({ method: 'GET', url: '/api/auth/login' });
    assert(res.statusCode === 302, '/api/auth/login 返回 302');
    const stateCookie = getCookieAttrs(res.headers['set-cookie'], 'yibiao_oauth_state');
    assert(stateCookie.includes('HttpOnly'), 'state Cookie 是 HttpOnly');
    assert(stateCookie.includes('SameSite=Lax'), 'state Cookie 是 SameSite=Lax');
    assert(res.headers.location.includes('state='), '重定向 URL 包含 state');
  }

  // 测试 6：mock-callback 无 state Cookie → 失败
  {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/mock-callback',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=t@t.com&name=T&state=fake',
    });
    assert(res.statusCode === 400, 'mock-callback 无 state Cookie 返回 400');
  }

  // 测试 7：完整 mock 登录流程（login → mock-callback 带 Cookie）
  let sessionCookie = null;
  {
    // Step 1: login 获取 state Cookie
    const loginRes = await app.inject({ method: 'GET', url: '/api/auth/login' });
    const stateCookie = extractCookie(loginRes.headers['set-cookie'], 'yibiao_oauth_state');
    const stateValue = new URL(loginRes.headers.location, 'http://localhost').searchParams.get('state');

    // Step 2: mock-callback 带 state Cookie
    const callbackRes = await app.inject({
      method: 'POST',
      url: '/api/auth/mock-callback',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `yibiao_oauth_state=${stateCookie}`,
      },
      payload: `email=t@t.com&name=T&state=${stateValue}`,
    });
    assert(callbackRes.statusCode === 302, 'mock 登录成功返回 302');
    sessionCookie = extractCookie(callbackRes.headers['set-cookie'], 'yibiao_session');
    assert(sessionCookie !== null, 'mock 登录设置 session Cookie');
    const sessionAttrs = getCookieAttrs(callbackRes.headers['set-cookie'], 'yibiao_session');
    assert(sessionAttrs.includes('HttpOnly'), 'session Cookie 是 HttpOnly');
    assert(sessionAttrs.includes('SameSite=Lax'), 'session Cookie 是 SameSite=Lax');
  }

  // 测试 8：已登录访问 /api/auth/me → 200 + 用户信息
  {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `yibiao_session=${sessionCookie}` },
    });
    assert(res.statusCode === 200, '已登录 /api/auth/me 返回 200');
    const body = JSON.parse(res.body);
    assert(body.name === 'T', '/api/auth/me 返回正确 name');
    assert(body.email === 't@t.com', '/api/auth/me 返回正确 email');
  }

  // 测试 9：已登录访问业务 API → 通过 auth 后进入契约校验（缺少必填参数 → 400）
  {
    const res = await app.inject({
      method: 'POST',
      url: '/api/bridge',
      headers: { 'content-type': 'application/json', cookie: `yibiao_session=${sessionCookie}` },
      payload: { namespace: 'ai', method: 'chat', args: [] },
    });
    assert(res.statusCode === 400, '已登录业务 API 通过 auth 后进入契约参数校验');
    const body = JSON.parse(res.body);
    assert(body.code === 'INVALID_BRIDGE_ARGUMENTS', '缺少必填参数返回 INVALID_BRIDGE_ARGUMENTS');
  }

  // 测试 10：退出登录
  {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: `yibiao_session=${sessionCookie}` },
    });
    assert(res.statusCode === 200, '退出返回 200');
    const body = JSON.parse(res.body);
    assert(body.success === true, '退出返回 success');

    // 退出后访问 me → 401
    const meRes = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `yibiao_session=${sessionCookie}` },
    });
    assert(meRes.statusCode === 401, '退出后 /api/auth/me 返回 401');
  }

  // 测试 11：callback error 参数不反射（XSS 防护）
  {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/callback?error=<script>alert(1)</script>',
    });
    assert(res.statusCode === 400, 'callback error 返回 400');
    assert(!res.body.includes('<script>'), 'callback error 不反射 XSS');
    assert(res.headers['content-type'].includes('text/plain'), 'callback error 返回纯文本');
  }

  // 测试 12：state 跨浏览器拦截（浏览器 B 用浏览器 A 的 state 但无 Cookie）
  {
    // 浏览器 A 发起 login
    const loginRes = await app.inject({ method: 'GET', url: '/api/auth/login' });
    const stateValue = new URL(loginRes.headers.location, 'http://localhost').searchParams.get('state');

    // 浏览器 B 尝试用 A 的 state 但不带 Cookie
    const callbackRes = await app.inject({
      method: 'POST',
      url: '/api/auth/mock-callback',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `email=attacker@attacker.com&name=Attacker&state=${stateValue}`,
    });
    assert(callbackRes.statusCode === 400, '跨浏览器 state 拦截：无 Cookie 返回 400');
  }

  // 测试 13：Cookie maxAge 与 sessionTtlDays 一致（代码检查，非运行时）
  {
    const authSource = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'routes', 'auth.cjs'), 'utf-8');
    assert(authSource.includes('config.sessionTtlDays * 24 * 60 * 60 * 1000'), 'Cookie maxAge 使用 config.sessionTtlDays');
  }

  // 测试 14：生产环境 OAuth 上游必须使用不含凭据、query、fragment 的 HTTPS URL。
  {
    const baseEnv = {
      ...process.env,
      NODE_ENV: 'production',
      OAUTH_MODE: 'mainquest',
      MAINQUEST_OAUTH_CLIENT_ID: 'test-client',
      MAINQUEST_OAUTH_CLIENT_SECRET: 'test-secret',
      MAINQUEST_OAUTH_REDIRECT_URI: 'https://web.example.test/api/auth/callback',
      PUBLIC_BASE_URL: 'https://web.example.test',
      SESSION_SECRET: 'test-session-secret',
      CONFIG_ENCRYPTION_KEY: 'test-encryption-key',
    };
    const runConfig = (authBaseUrl) => spawnSync(
      process.execPath,
      ['-e', "require('./server/config.cjs')"],
      { cwd: path.join(__dirname, '..'), env: { ...baseEnv, MAINQUEST_AUTH_BASE_URL: authBaseUrl }, encoding: 'utf8' },
    );
    assert(runConfig('http://auth.example.test').status === 1, '生产环境拒绝 HTTP OAuth 上游');
    assert(runConfig('https://user:pass@auth.example.test').status === 1, '生产环境拒绝带账号密码的 OAuth 上游');
    assert(runConfig('https://auth.example.test?tenant=unsafe').status === 1, '生产环境拒绝带 query 的 OAuth 上游');
    assert(runConfig('https://auth.example.test/base').status === 0, '生产环境接受合法 HTTPS OAuth 基地址');
  }

  // 汇总
  console.log(`\n=== Web Auth 测试结果 ===`);
  console.log(`通过: ${passed.length}`);
  console.log(`失败: ${failed.length}`);
  if (failed.length > 0) {
    console.log('\n失败项:');
    failed.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log('全部通过 ✅');
}

// 轻量 inject helper：用 Node http 模块直接调 Express app，不启动端口。
// 优先用 supertest（如果有），否则用内置 http 模块。
let injectImpl;
let server = null;
try {
  const supertest = require('supertest');
  const req = supertest(app);
  injectImpl = (opts) => {
    let r = req[opts.method.toLowerCase()](opts.url);
    if (opts.headers) {
      for (const [k, v] of Object.entries(opts.headers)) {
        r = r.set(k, v);
      }
    }
    if (opts.payload !== undefined) {
      r = r.send(opts.payload);
    }
    return r.then((res) => ({
      statusCode: res.status,
      headers: res.headers,
      body: typeof res.text === 'string' ? res.text : JSON.stringify(res.body),
    }));
  };
} catch {
  server = http.createServer(app);
  injectImpl = (opts) => {
    return new Promise((resolve, reject) => {
      const payload = opts.payload !== undefined
        ? (typeof opts.payload === 'string' ? opts.payload : JSON.stringify(opts.payload))
        : null;
      const headers = { ...opts.headers };
      if (payload !== null && !headers['content-type']) {
        headers['content-type'] = 'application/json';
      }
      if (payload !== null) {
        headers['content-length'] = Buffer.byteLength(payload);
      }
      const port = server.address()?.port || 0;
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: opts.method,
          path: opts.url,
          headers,
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body,
          }));
        }
      );
      req.on('error', reject);
      if (payload !== null) req.write(payload);
      req.end();
    });
  };
}

app.inject = injectImpl;

if (server) {
  server.listen(0, () => {
    runTests().catch((err) => {
      console.error('测试执行失败:', err);
      process.exit(1);
    }).finally(() => server.close());
  });
} else {
  runTests().catch((err) => {
    console.error('测试执行失败:', err);
    process.exit(1);
  });
}
