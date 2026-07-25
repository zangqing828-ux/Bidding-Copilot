// Web 文件流测试：上传限制、下载入口与认证校验。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const passed = [];
const failed = [];

function assert(condition, message) {
  if (condition) {
    passed.push(message);
    return;
  }

  failed.push(message);
  console.error(`  FAIL: ${message}`);
}

function parseJson(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

let tmpDir;
let port = 0;
let server = null;

function startServer() {
  return new Promise((resolve, reject) => {
    if (!server) {
      reject(new Error('server 未初始化'));
      return;
    }

    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
    server.once('error', reject);
  });
}

function closeServer() {
  return new Promise((resolve, reject) => {
    if (!server || !server.listening) {
      resolve();
      return;
    }

    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function httpRequest(method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const reqHeaders = { ...headers };
    if (payload && !reqHeaders['content-type']) reqHeaders['content-type'] = 'application/json';
    if (payload) reqHeaders['content-length'] = Buffer.byteLength(payload);

    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: reqHeaders }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
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
    'content-type': 'application/x-www-form-urlencoded',
    cookie: `yibiao_oauth_state=${stateCookieValue}`,
  }, `email=files@test.com&name=F&state=${stateValue}`);
  const cookies = Array.isArray(mockRes.headers['set-cookie']) ? mockRes.headers['set-cookie'] : [mockRes.headers['set-cookie']];
  const sessionMatch = cookies.find((c) => c.startsWith('yibiao_session='));
  const sessionCookie = sessionMatch?.match(/yibiao_session=([^;]+)/)?.[1];
  const cookieStr = `yibiao_session=${sessionCookie}`;

  // 1. 上传 .exe 文件 → 被拒
  {
    const boundary = '----testboundary';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"test.exe\"\r\nContent-Type: application/octet-stream\r\n\r\nfake\r\n--${boundary}--\r\n`;
    const res = await httpRequest('POST', '/api/uploads', {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      cookie: cookieStr,
    }, body);
    assert(res.statusCode === 400, '上传 .exe 文件被拒（400）');
    const parsed = typeof res.body === 'string' ? parseJson(res.body) : null;
    assert(parsed?.code === 'UPLOAD_ERROR', '上传 .exe 返回 code=UPLOAD_ERROR');
    assert(typeof parsed?.message === 'string' && parsed.message.includes('不支持的文件类型：.exe'), '上传 .exe 错误提示包含 不支持的文件类型：.exe');
  }

  // 2. 认证用户 POST /api/downloads → 404（不再提供任意路径入口）
  {
    const res = await httpRequest('POST', '/api/downloads', {
      'content-type': 'application/json',
      cookie: cookieStr,
    }, { filePath: '/etc/passwd', fileName: 'passwd' });
    assert(res.statusCode === 404, 'POST /api/downloads 返回 404');
  }

  // 3. 未登录上传 → 401
  {
    const res = await httpRequest('POST', '/api/uploads', {}, null);
    assert(res.statusCode === 401, '未登录上传返回 401');
  }

  console.log(`\n=== Web Files 测试结果 ===`);
  console.log(`通过: ${passed.length}`);
  console.log(`失败: ${failed.length}`);
  if (failed.length > 0) {
    console.log('\n失败项:');
    failed.forEach((f) => console.log(`  - ${f}`));
    return false;
  }

  console.log('全部通过 ✅');
  return true;
}

(async () => {
  let testPassed = false;
  let closeWorkspace;

  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-files-test-'));
    process.env.YIBIAO_DATA_DIR = tmpDir;
    process.env.CONFIG_ENCRYPTION_KEY = 'test-key';
    process.env.OAUTH_MODE = 'mock';
    process.env.SESSION_SECRET = 'dev-secret';

    ({ closeAll: closeWorkspace } = require('../server/workspace/workspaceRegistry.cjs'));
    const { createApp } = require('../server/app.cjs');
    const app = createApp();
    server = http.createServer(app);

    await startServer();
    testPassed = await runTests();
  } catch (error) {
    failed.push(`测试执行异常: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try {
      await closeServer();
    } catch (error) {
      console.error('关闭服务异常:', error instanceof Error ? error.message : error);
      failed.push(`关闭服务异常: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      if (typeof closeWorkspace === 'function') {
        await closeWorkspace();
      }
    } catch (error) {
      console.error('清理 workspace 失败:', error instanceof Error ? error.message : error);
      failed.push(`清理 workspace 失败: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      if (tmpDir) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch (error) {
      console.error('清理临时目录失败:', error instanceof Error ? error.message : error);
      failed.push(`清理临时目录失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!testPassed || failed.length > 0) {
    process.exitCode = 1;
    return;
  }

  process.exitCode = 0;
})();
