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

function multipartFile(fieldName, fileName, contentType, content, boundary = '----testboundary') {
  return {
    boundary,
    body: `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n${content}\r\n--${boundary}--\r\n`,
  };
}

function multipartFiles(files, boundary = '----testmultiboundary') {
  const parts = files.map(({ fileName, contentType, content }) => (
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n${content}\r\n`
  ));
  return { boundary, body: `${parts.join('')}--${boundary}--\r\n` };
}

async function loginMock(email, name) {
  const loginRes = await httpRequest('GET', '/api/auth/login');
  const setCookies = loginRes.headers['set-cookie'];
  const loginCookies = Array.isArray(setCookies) ? setCookies : (setCookies ? [setCookies] : []);
  const stateCookie = loginCookies.find((cookie) => cookie.startsWith('yibiao_oauth_state='));
  const stateValue = new URL(loginRes.headers.location, 'http://localhost').searchParams.get('state');
  const stateCookieValue = stateCookie?.match(/yibiao_oauth_state=([^;]+)/)?.[1];
  const mockRes = await httpRequest('POST', '/api/auth/mock-callback', {
    'content-type': 'application/x-www-form-urlencoded',
    cookie: `yibiao_oauth_state=${stateCookieValue}`,
  }, `email=${encodeURIComponent(email)}&name=${encodeURIComponent(name)}&state=${encodeURIComponent(stateValue)}`);
  const cookies = Array.isArray(mockRes.headers['set-cookie']) ? mockRes.headers['set-cookie'] : [mockRes.headers['set-cookie']];
  const sessionMatch = cookies.find((cookie) => cookie.startsWith('yibiao_session='));
  const sessionCookie = sessionMatch?.match(/yibiao_session=([^;]+)/)?.[1];
  return `yibiao_session=${sessionCookie}`;
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

  let uploadedFileId = '';
  let bidFileId = '';

  // 0. 有效文本上传进入账号内 registry，file ID 不包含真实路径。
  {
    const { boundary, body } = multipartFile('file', '招标文件.txt', 'text/plain', '第一章 招标范围');
    const res = await httpRequest('POST', '/api/uploads', {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      cookie: cookieStr,
    }, body);
    const parsed = parseJson(res.body);
    uploadedFileId = parsed?.fileId || '';
    assert(res.statusCode === 200, '有效文本上传返回 200');
    assert(/^[0-9a-f-]{36}$/i.test(uploadedFileId), '上传仅返回 UUID file ID');
    assert(parsed?.fileName === '招标文件.txt', '上传保留原始展示文件名');
    assert(!JSON.stringify(parsed).includes('workspace'), '上传响应不泄露 workspace 路径');
  }

  // 0a. 同内容重复上传复用 registry 记录，避免重复占用存储。
  {
    const { boundary, body } = multipartFile('file', '重复招标文件.txt', 'text/plain', '第一章 招标范围', '----duplicatecontent');
    const res = await httpRequest('POST', '/api/uploads', {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      cookie: cookieStr,
    }, body);
    const parsed = parseJson(res.body);
    assert(res.statusCode === 200, '重复上传返回 200');
    assert(parsed?.fileId === uploadedFileId && parsed?.deduplicated === true, '重复上传复用既有 file ID');
  }

  // 0b. 伪扩展名在落盘后立即清理并拒绝。
  {
    const { boundary, body } = multipartFile('file', '伪装.pdf', 'application/pdf', 'plain text', '----fakepdf');
    const res = await httpRequest('POST', '/api/uploads', {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      cookie: cookieStr,
    }, body);
    const parsed = parseJson(res.body);
    assert(res.statusCode === 400, '伪 PDF 上传被拒（400）');
    assert(parsed?.code === 'UPLOAD_FILE_CONTENT_INVALID', '伪 PDF 返回内容校验错误码');
  }

  // 0c. 技术方案只接受 file ID，导入后可由 Store 恢复。
  {
    const res = await httpRequest('POST', '/api/bridge', { cookie: cookieStr }, {
      namespace: 'technicalPlan',
      method: 'importTenderDocument',
      args: [[uploadedFileId]],
    });
    const parsed = parseJson(res.body);
    assert(res.statusCode === 200, '技术方案通过 file ID 导入成功');
    assert(parsed?.data?.success === true, '技术方案导入返回成功状态');
    assert(parsed?.data?.state?.tenderFile?.fileName === '招标文件.txt', '技术方案 Store 保存上传文件结果');
  }

  // 0d. 其余三个业务入口复用同一个账号 registry，不接收浏览器路径。
  {
    const { boundary, body } = multipartFile('file', '投标文件.txt', 'text/plain', '第二章 投标响应', '----bidfile');
    const uploadRes = await httpRequest('POST', '/api/uploads', {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      cookie: cookieStr,
    }, body);
    bidFileId = parseJson(uploadRes.body)?.fileId || '';
    assert(uploadRes.statusCode === 200 && /^[0-9a-f-]{36}$/i.test(bidFileId), '投标文件取得独立 file ID');

    const duplicateRes = await httpRequest('POST', '/api/bridge', { cookie: cookieStr }, {
      namespace: 'duplicateCheck',
      method: 'saveFiles',
      args: [{ tenderFileIds: [uploadedFileId], bidFileIds: [bidFileId], step: 'upload', activeAnalysisTab: 'metadata' }],
    });
    const duplicate = parseJson(duplicateRes.body);
    assert(duplicateRes.statusCode === 200, '查重文件通过 file ID 保存成功');
    assert(duplicate?.data?.tenderFiles?.length === 1 && duplicate?.data?.bidFiles?.length === 1, '查重 Store 只保存当前账号文件');
    const duplicatePayload = JSON.stringify(duplicate?.data || {});
    assert(!duplicatePayload.includes(tmpDir) && !duplicatePayload.includes('/uploads/'), '查重状态不返回服务器绝对路径');
    assert(duplicatePayload.includes(`upload:${uploadedFileId}`), '查重状态仅保留不可解析的上传引用');

    const rejectionTenderRes = await httpRequest('POST', '/api/bridge', { cookie: cookieStr }, {
      namespace: 'rejectionCheck',
      method: 'importDocument',
      args: ['tender', [uploadedFileId]],
    });
    const rejectionTender = parseJson(rejectionTenderRes.body);
    assert(rejectionTenderRes.statusCode === 200 && rejectionTender?.data?.success === true, '废标检查招标文件通过 file ID 导入成功');

    const rejectionBidRes = await httpRequest('POST', '/api/bridge', { cookie: cookieStr }, {
      namespace: 'rejectionCheck',
      method: 'importDocument',
      args: ['bid', [bidFileId]],
    });
    const rejectionBid = parseJson(rejectionBidRes.body);
    assert(rejectionBidRes.statusCode === 200 && rejectionBid?.data?.state?.bidDocuments?.length === 1, '废标检查投标文件通过 file ID 导入成功');

    const folderRes = await httpRequest('POST', '/api/bridge', { cookie: cookieStr }, {
      namespace: 'knowledgeBase',
      method: 'createFolder',
      args: ['测试知识库'],
    });
    const folder = parseJson(folderRes.body)?.data;
    assert(folderRes.statusCode === 200 && typeof folder?.id === 'string', '知识库文件夹创建成功');
    const knowledgeUploadRes = await httpRequest('POST', '/api/bridge', { cookie: cookieStr }, {
      namespace: 'knowledgeBase',
      method: 'uploadDocuments',
      args: [folder?.id, [uploadedFileId]],
    });
    const knowledgeUpload = parseJson(knowledgeUploadRes.body);
    assert(knowledgeUploadRes.statusCode === 200 && knowledgeUpload?.data?.success === true, '知识库通过 file ID 导入成功');
    const knowledgeListRes = await httpRequest('POST', '/api/bridge', { cookie: cookieStr }, {
      namespace: 'knowledgeBase',
      method: 'list',
      args: [],
    });
    const knowledgeList = parseJson(knowledgeListRes.body);
    assert(knowledgeList?.data?.documents?.length === 1, '知识库导入后可从 Store 恢复');
  }

  // 0f. 多文件批次任一文件不合法时，Registry 与物理文件一起回滚。
  {
    const { getSystemDb } = require('../server/database/systemDatabase.cjs');
    const { getWorkspaceContext } = require('../server/workspace/workspaceRegistry.cjs');
    const account = getSystemDb().prepare('SELECT workspace_id FROM accounts WHERE email = ?').get('files@test.com');
    const context = getWorkspaceContext(account.workspace_id);
    const beforeCount = context.db.prepare("SELECT COUNT(*) AS count FROM upload_registry WHERE original_name = '事务合法文件.txt' AND status = 'ready'").get().count;
    const { boundary, body } = multipartFiles([
      { fileName: '事务合法文件.txt', contentType: 'text/plain', content: '事务回滚后的合法内容' },
      { fileName: '事务伪装文件.pdf', contentType: 'application/pdf', content: 'plain text' },
    ]);
    const failedBatch = await httpRequest('POST', '/api/uploads/multiple', {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      cookie: cookieStr,
    }, body);
    assert(failedBatch.statusCode === 400, '合法加非法文件批次整体失败');
    const afterCount = context.db.prepare("SELECT COUNT(*) AS count FROM upload_registry WHERE original_name = '事务合法文件.txt' AND status = 'ready'").get().count;
    assert(afterCount === beforeCount, '失败批次不留下 ready Registry 记录');

    const retry = multipartFile('file', '事务合法文件.txt', 'text/plain', '事务回滚后的合法内容', '----transactionretry');
    const retryRes = await httpRequest('POST', '/api/uploads', {
      'content-type': `multipart/form-data; boundary=${retry.boundary}`,
      cookie: cookieStr,
    }, retry.body);
    const retryPayload = parseJson(retryRes.body);
    assert(retryRes.statusCode === 200 && retryPayload?.deduplicated === false, '失败后重新上传合法文件可正常注册');
    assert(context.uploadRegistry.resolve(retryPayload.fileId).fileName === '事务合法文件.txt', '重新上传的 file ID 可正常解析');
  }

  // 0e. 另一账号无法借用 file ID，也不能提交路径替代 file ID。
  {
    const otherCookie = await loginMock('files-other@test.com', 'F2');
    const crossAccountRes = await httpRequest('POST', '/api/bridge', { cookie: otherCookie }, {
      namespace: 'technicalPlan',
      method: 'importTenderDocument',
      args: [[uploadedFileId]],
    });
    const crossAccount = parseJson(crossAccountRes.body);
    assert(crossAccountRes.statusCode === 400, '另一账号无法导入对方 file ID');
    assert(crossAccount?.code === 'UPLOAD_FILE_NOT_FOUND', '跨账号 file ID 不暴露归属信息');

    const pathIdRes = await httpRequest('POST', '/api/bridge', { cookie: cookieStr }, {
      namespace: 'technicalPlan',
      method: 'importTenderDocument',
      args: [['/etc/passwd']],
    });
    const pathId = parseJson(pathIdRes.body);
    assert(pathIdRes.statusCode === 400, '绝对路径不能作为 file ID 导入');
    assert(pathId?.code === 'UPLOAD_FILE_ID_INVALID', '路径冒充 file ID 被拒绝');
  }

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

  // 4. workspace 正在关闭时上传返回可重试 503，且不泄露内部状态
  {
    const { getSystemDb } = require('../server/database/systemDatabase.cjs');
    const {
      closeWorkspaceContext,
      getWorkspaceContext,
    } = require('../server/workspace/workspaceRegistry.cjs');
    const account = getSystemDb()
      .prepare('SELECT workspace_id FROM accounts WHERE email = ?')
      .get('files@test.com');
    const workspaceId = account.workspace_id;
    const context = getWorkspaceContext(workspaceId);
    const originalClose = context.close.bind(context);
    let resolveClose;
    const closeGate = new Promise((resolve) => {
      resolveClose = resolve;
    });
    context.close = async () => {
      await closeGate;
      await originalClose();
    };
    const closePromise = closeWorkspaceContext(workspaceId, { force: true });

    try {
      const boundary = '----workspaceclosing';
      const body = `--${boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"test.txt\"\r\nContent-Type: text/plain\r\n\r\nsafe\r\n--${boundary}--\r\n`;
      const res = await httpRequest('POST', '/api/uploads', {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        cookie: cookieStr,
      }, body);
      const parsed = parseJson(res.body);
      assert(res.statusCode === 503, 'workspace closing 时上传返回 503');
      assert(parsed?.code === 'WORKSPACE_UNAVAILABLE', 'workspace closing 时上传保留错误码');
      assert(parsed?.retryable === true, 'workspace closing 时上传标记可重试');
      assert(typeof parsed?.message === 'string' && parsed.message.includes('稍后重试'), 'workspace closing 时上传返回安全中文提示');
      const payload = JSON.stringify(parsed);
      assert(!payload.includes('closing'), 'workspace closing 时上传不泄露 state');
      assert(!payload.includes(workspaceId), 'workspace closing 时上传不泄露 workspaceId');
    } finally {
      resolveClose();
      await closePromise;
    }
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
