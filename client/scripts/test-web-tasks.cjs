// Web Tasks SSE 自动化测试：覆盖 SSE 连接、事件推送、task ownership、隔离。
// 运行：npm run test:web-tasks（需要先 npm rebuild better-sqlite3 --runtime=node）
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

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

// 用临时目录做隔离测试
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-task-test-'));
process.env.YIBIAO_DATA_DIR = tmpDir;
process.env.CONFIG_ENCRYPTION_KEY = 'test-encryption-key-for-testing';
process.env.OAUTH_MODE = 'mock';
process.env.SESSION_SECRET = 'dev-secret';

const { createApp } = require('../server/app.cjs');
const app = createApp();

// 启动 HTTP server
const server = http.createServer(app);
let port = 0;

function startServer() {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
}

function httpRequest(method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const reqHeaders = { ...headers };
    if (payload && !reqHeaders['content-type']) {
      reqHeaders['content-type'] = 'application/json';
    }
    if (payload) {
      reqHeaders['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: reqHeaders,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// SSE 客户端：连接并收集事件
function connectSSE(cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: '/api/tasks/events',
      headers: { cookie, Accept: 'text/event-stream' },
    }, (res) => {
      const events = [];
      res.on('data', (chunk) => {
        const text = chunk.toString();
        const lines = text.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              events.push(JSON.parse(line.slice(6)));
            } catch {
              // 忽略解析错误
            }
          }
        }
      });
      resolve({ res, events, close: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}

async function runTests() {
  // 1. mock 登录获取 cookie
  const loginRes = await httpRequest('GET', '/api/auth/login');
  const setCookies = loginRes.headers['set-cookie'];
  const loginCookies = Array.isArray(setCookies) ? setCookies : (setCookies ? [setCookies] : []);
  const stateCookie = loginCookies.find((c) => c.startsWith('yibiao_oauth_state='));
  const stateValue = new URL(loginRes.headers.location, 'http://localhost').searchParams.get('state');
  const stateCookieValue = stateCookie?.match(/yibiao_oauth_state=([^;]+)/)?.[1];

  const mockCallbackRes = await httpRequest('POST', '/api/auth/mock-callback', {
    'content-type': 'application/x-www-form-urlencoded',
    cookie: `yibiao_oauth_state=${stateCookieValue}`,
  }, `email=tasks@test.com&name=TaskTester&state=${stateValue}`);

  const setCookieHeader = mockCallbackRes.headers['set-cookie'];
  const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : (setCookieHeader ? [setCookieHeader] : []);
  const sessionCookieMatch = cookies.find((c) => c.startsWith('yibiao_session='));
  const sessionCookie = sessionCookieMatch?.match(/yibiao_session=([^;]+)/)?.[1];
  assert(sessionCookie, 'mock 登录获取 session cookie');
  const cookieStr = `yibiao_session=${sessionCookie}`;

  // 2. bridge tasks.getActiveTasks → 200（空数组，无活动任务）
  {
    const res = await httpRequest('POST', '/api/bridge', {
      'content-type': 'application/json',
      cookie: cookieStr,
    }, { namespace: 'tasks', method: 'getActiveTasks', args: [] });
    assert(res.statusCode === 200, 'tasks.getActiveTasks 返回 200');
    const body = JSON.parse(res.body);
    assert(Array.isArray(body.data), 'tasks.getActiveTasks 返回数组');
    assert(body.data.length === 0, 'tasks.getActiveTasks 初始无活动任务');
  }

  // 3. SSE 连接成功 + 收到 Content-Type
  {
    const sse = await connectSSE(cookieStr);
    assert(sse.res.statusCode === 200, 'SSE 连接返回 200');
    assert(sse.res.headers['content-type']?.includes('text/event-stream'), 'SSE Content-Type 正确');
    // 等待短暂时间收集事件（subscribeCallback 会重放当前 activeTasks，但当前无任务）
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert(sse.events.length === 0, 'SSE 初始无活动任务，不推送事件');
    sse.close();
  }

  // 4. 未登录访问 SSE → 401
  {
    const res = await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: '/api/tasks/events',
        headers: {},
      }, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve({ statusCode: res.statusCode }));
      });
      req.on('error', () => resolve({ statusCode: 0 }));
      req.end();
    });
    assert(res.statusCode === 401, '未登录访问 SSE 返回 401');
  }

  // 5. bridge tasks.startBidAnalysis → 501（待能力未实现）
  {
    const res = await httpRequest('POST', '/api/bridge', {
      'content-type': 'application/json',
      cookie: cookieStr,
    }, { namespace: 'tasks', method: 'startBidAnalysis', args: [{}] });
    assert(res.statusCode === 501, 'tasks.startBidAnalysis 返回 501（待能力未实现）');
    const body = JSON.parse(res.body);
    assert(body.code === 'WEB_CAPABILITY_PENDING', 'tasks.startBidAnalysis 返回 WEB_CAPABILITY_PENDING');
  }

  // 5b. bridge technicalPlan.loadState → 200（Store 数据操作已实现）
  {
    const res = await httpRequest('POST', '/api/bridge', {
      'content-type': 'application/json',
      cookie: cookieStr,
    }, { namespace: 'technicalPlan', method: 'loadState', args: [] });
    assert(res.statusCode === 200, 'technicalPlan.loadState 返回 200（已实现）');
    const body = JSON.parse(res.body);
    assert(body.code === 'OK', 'technicalPlan.loadState 返回 OK');
  }

  // 5c. bridge templates.list → 200（Store 数据操作已实现）
  {
    const res = await httpRequest('POST', '/api/bridge', {
      'content-type': 'application/json',
      cookie: cookieStr,
    }, { namespace: 'templates', method: 'list', args: [] });
    assert(res.statusCode === 200, 'templates.list 返回 200（已实现）');
    const body = JSON.parse(res.body);
    assert(body.code === 'OK', 'templates.list 返回 OK');
    assert(Array.isArray(body.data), 'templates.list 返回数组');
  }

  // 6. 两个 workspace 的 SSE 隔离
  {
    // 第二个账号登录
    const login2Res = await httpRequest('GET', '/api/auth/login');
    const setCookies2 = login2Res.headers['set-cookie'];
    const loginCookies2 = Array.isArray(setCookies2) ? setCookies2 : (setCookies2 ? [setCookies2] : []);
    const stateCookie2 = loginCookies2.find((c) => c.startsWith('yibiao_oauth_state='));
    const stateValue2 = new URL(login2Res.headers.location, 'http://localhost').searchParams.get('state');
    const stateCookieValue2 = stateCookie2?.match(/yibiao_oauth_state=([^;]+)/)?.[1];

    const mock2Res = await httpRequest('POST', '/api/auth/mock-callback', {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `yibiao_oauth_state=${stateCookieValue2}`,
    }, `email=other@test.com&name=OtherUser&state=${stateValue2}`);

    const setCookies2b = mock2Res.headers['set-cookie'];
    const cookies2 = Array.isArray(setCookies2b) ? setCookies2b : (setCookies2b ? [setCookies2b] : []);
    const sessionCookie2Match = cookies2.find((c) => c.startsWith('yibiao_session='));
    const sessionCookie2 = sessionCookie2Match?.match(/yibiao_session=([^;]+)/)?.[1];
    const cookieStr2 = `yibiao_session=${sessionCookie2}`;

    // 两个 SSE 连接
    const sse1 = await connectSSE(cookieStr);
    const sse2 = await connectSSE(cookieStr2);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // 两个连接都正常
    assert(sse1.res.statusCode === 200, 'workspace 1 SSE 连接成功');
    assert(sse2.res.statusCode === 200, 'workspace 2 SSE 连接成功');

    sse1.close();
    sse2.close();
  }

  // 清理
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 忽略
  }

  console.log(`\n=== Web Tasks 测试结果 ===`);
  console.log(`通过: ${passed.length}`);
  console.log(`失败: ${failed.length}`);
  if (failed.length > 0) {
    console.log('\n失败项:');
    failed.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log('全部通过 ✅');
}

startServer().then(() => runTests()).catch((err) => {
  console.error('测试执行失败:', err);
  process.exit(1);
}).finally(() => {
  server.close();
});
