// Web 导出合同边界：Word 生成后仅通过一次性下载令牌交付，openFile 仍是 desktop-only。
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
    throw new Error(`登录失败：未收到 set-cookie，status=${loginRes.statusCode}`);
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

  // 1. export.exportWord → 200，返回受当前账号约束的一次性下载令牌。
  {
    const res = await httpRequest('POST', '/api/bridge', {
      'content-type': 'application/json', cookie: cookieStr,
    }, { namespace: 'export', method: 'exportWord', args: [{ project_name: '测试投标文件', outline: [{ id: 'n1', title: '第一章', content: '测试内容', children: [] }] }] });
    assert(res.statusCode === 200, 'export.exportWord 返回 200');
    const body = JSON.parse(res.body);
    assert(body.data?.success === true, 'export.exportWord 生成 Word');
    assert(typeof body.data?.downloadUrl === 'string', 'export.exportWord 返回下载地址');
    assert(/^测试投标文件_.*\.docx$/.test(body.data?.fileName || ''), 'export.exportWord 返回浏览器文件名');
    const download = await httpRequest('GET', body.data.downloadUrl, { cookie: cookieStr });
    assert(download.statusCode === 200, '当前账号可下载生成的 Word');
    const secondDownload = await httpRequest('GET', body.data.downloadUrl, { cookie: cookieStr });
    assert(secondDownload.statusCode === 404, '下载令牌只能使用一次');
  }

  // 2. export.openFile → 410（desktop-only removed）
  {
    const res = await httpRequest('POST', '/api/bridge', {
      'content-type': 'application/json', cookie: cookieStr,
    }, { namespace: 'export', method: 'openFile', args: ['/tmp/test.docx'] });
    assert(res.statusCode === 410, 'export.openFile 返回 410');
    const body = JSON.parse(res.body);
    assert(body.code === 'WEB_BRIDGE_DESKTOP_ONLY', 'export.openFile 返回 WEB_BRIDGE_DESKTOP_ONLY');
  }
}

async function cleanup() {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }).catch((error) => {
    if (error?.code !== 'ERR_SERVER_NOT_RUNNING') console.error('关闭服务器失败:', error);
  });
  try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch (error) { console.error('清理测试目录失败:', error); }
}

function printSummary() {
  console.log(`\n=== Web Export 测试结果 ===`);
  console.log(`通过: ${passed.length}`);
  console.log(`失败: ${failed.length}`);
  if (failed.length > 0) { console.log('\n失败项:'); failed.forEach((f) => console.log(`  - ${f}`)); return; }
  console.log('全部通过 ✅');
}

async function main() {
  let startupError = null;
  try {
    await startServer();
    await runTests();
  } catch (error) {
    startupError = error;
    console.error('测试执行失败:', error);
    failed.push('测试流程异常中断');
  } finally {
    await cleanup();
    printSummary();
    if (startupError) process.exitCode = 1;
    if (failed.length > 0) process.exitCode = 1;
  }
}

main();
