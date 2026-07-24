// Web 文件流测试：上传限制、下载路径穿越防护。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const passed = [];
const failed = [];

function assert(condition, message) {
  if (condition) { passed.push(message); } else { failed.push(message); console.error(`  FAIL: ${message}`); }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-files-test-'));
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
  const setCookies = loginRes.headers['set-cookie'];
  const loginCookies = Array.isArray(setCookies) ? setCookies : (setCookies ? [setCookies] : []);
  const stateCookie = loginCookies.find((c) => c.startsWith('yibiao_oauth_state='));
  const stateValue = new URL(loginRes.headers.location, 'http://localhost').searchParams.get('state');
  const stateCookieValue = stateCookie?.match(/yibiao_oauth_state=([^;]+)/)?.[1];

  const mockRes = await httpRequest('POST', '/api/auth/mock-callback', {
    'content-type': 'application/x-www-form-urlencoded', cookie: `yibiao_oauth_state=${stateCookieValue}`,
  }, `email=files@test.com&name=F&state=${stateValue}`);
  const cookies = Array.isArray(mockRes.headers['set-cookie']) ? mockRes.headers['set-cookie'] : [mockRes.headers['set-cookie']];
  const sessionMatch = cookies.find((c) => c.startsWith('yibiao_session='));
  const sessionCookie = sessionMatch?.match(/yibiao_session=([^;]+)/)?.[1];
  const cookieStr = `yibiao_session=${sessionCookie}`;

  // 1. 上传 .exe 文件 → 被拒
  {
    const boundary = '----testboundary';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.exe"\r\nContent-Type: application/octet-stream\r\n\r\nfake\r\n--${boundary}--\r\n`;
    const res = await httpRequest('POST', '/api/uploads', {
      'content-type': `multipart/form-data; boundary=${boundary}`, cookie: cookieStr,
    }, body);
    assert(res.statusCode === 400, '上传 .exe 文件被拒（400）');
  }

  // 2. 下载路径穿越 → 被拒
  {
    const res = await httpRequest('POST', '/api/downloads', {
      'content-type': 'application/json', cookie: cookieStr,
    }, { filePath: '/etc/passwd', fileName: 'passwd' });
    assert(res.statusCode === 403, '下载 /etc/passwd 被拒（403 路径越界）');
  }

  // 3. 下载同前缀兄弟目录 → 被拒
  {
    const res = await httpRequest('POST', '/api/downloads', {
      'content-type': 'application/json', cookie: cookieStr,
    }, { filePath: `${tmpDir}/users-other/secret`, fileName: 'secret' });
    assert(res.statusCode === 403, '下载兄弟目录被拒（403 路径越界）');
  }

  // 4. 未登录上传 → 401
  {
    const res = await httpRequest('POST', '/api/uploads', {}, null);
    assert(res.statusCode === 401, '未登录上传返回 401');
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  console.log(`\n=== Web Files 测试结果 ===`);
  console.log(`通过: ${passed.length}`);
  console.log(`失败: ${failed.length}`);
  if (failed.length > 0) { console.log('\n失败项:'); failed.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
  console.log('全部通过 ✅');
}

startServer().then(() => runTests()).catch((err) => { console.error('测试执行失败:', err); process.exit(1); }).finally(() => server.close());
