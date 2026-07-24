// Web 导出测试：验证导出 API 在 Web 端返回可解释的未实现错误。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const passed = [];
const failed = [];

function assert(condition, message) {
  if (condition) { passed.push(message); } else { failed.push(message); console.error(`  FAIL: ${message}`); }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-export-test-'));
process.env.YIBIAO_DATA_DIR = tmpDir;
process.env.CONFIG_ENCRYPTION_KEY = 'test-key';
process.env.OAUTH_MODE = 'mock';
process.env.SESSION_SECRET = 'dev-secret';

const { createApp } = require('../server/app.cjs');
const app = createApp();
const server = http.createServer(app);
let port = 0;

function startServer() {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
}

function httpRequest(method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const reqHeaders = { ...headers };
    if (payload && !reqHeaders['content-type']) reqHeaders['content-type'] = 'application/json';
    if (payload) reqHeaders['content-length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: reqHeaders }, (res) => {
      let data = ''; res.on('data', (c) => data += c); res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
}

async function runTests() {
  // 登录
  const loginRes = await httpRequest('GET', '/api/auth/login');
  if (!loginRes.headers || !loginRes.headers['set-cookie']) {
    console.error('登录失败：未收到 set-cookie，status=', loginRes.statusCode);
    process.exit(1);
  }
  const setCookies = loginRes.headers['set-cookie'];
  const loginCookies = Array.isArray(setCookies) ? setCookies : (setCookies ? [setCookies] : []);
  const stateCookie = loginCookies.find((c) => c.startsWith('yibiao_oauth_state='));
  const stateValue = new URL(loginRes.headers.location, 'http://localhost').searchParams.get('state');
  const stateCookieValue = stateCookie?.match(/yibiao_oauth_state=([^;]+)/)?.[1];
  const mockRes = await httpRequest('POST', '/api/auth/mock-callback', {
    'content-type': 'application/x-www-form-urlencoded', cookie: `yibiao_oauth_state=${stateCookieValue}`,
  }, `email=export@test.com&name=E&state=${stateValue}`);
  const setCookies2 = mockRes.headers['set-cookie'];
  const cookies = Array.isArray(setCookies2) ? setCookies2 : (setCookies2 ? [setCookies2] : []);
  const sessionMatch = cookies.find((c) => c.startsWith('yibiao_session='));
  const sessionCookie = sessionMatch?.match(/yibiao_session=([^;]+)/)?.[1];
  const cookieStr = `yibiao_session=${sessionCookie}`;

  // 1. export.exportWord → 501（需要 Chromium/LibreOffice，尚未实现）
  {
    const res = await httpRequest('POST', '/api/bridge', {
      'content-type': 'application/json', cookie: cookieStr,
    }, { namespace: 'export', method: 'exportWord', args: [{}] });
    assert(res.statusCode === 501, 'export.exportWord 返回 501（需要 Chromium/LibreOffice）');
    const body = JSON.parse(res.body);
    assert(body.code === 'WEB_CAPABILITY_PENDING', 'export.exportWord 返回 WEB_CAPABILITY_PENDING');
  }

  // 2. export.openFile → 501
  {
    const res = await httpRequest('POST', '/api/bridge', {
      'content-type': 'application/json', cookie: cookieStr,
    }, { namespace: 'export', method: 'openFile', args: ['/tmp/test.docx'] });
    assert(res.statusCode === 501, 'export.openFile 返回 501');
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  console.log(`\n=== Web Export 测试结果 ===`);
  console.log(`通过: ${passed.length}`);
  console.log(`失败: ${failed.length}`);
  if (failed.length > 0) { console.log('\n失败项:'); failed.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
  console.log('全部通过 ✅');
}

startServer().then(() => runTests()).catch((err) => { console.error('测试执行失败:', err); process.exit(1); }).finally(() => server.close());
