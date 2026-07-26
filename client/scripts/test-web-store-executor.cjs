const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createSqliteDatabase } = require('../core/sqliteDatabase.cjs');
const { resolveWorkspacePaths } = require('../core/workspacePaths.cjs');
const {
  createWorkspaceStoreExecutor,
  _internals,
} = require('../server/workspace/storeBridgeExecutor.cjs');

const passed = [];
const failed = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function run(name, fn) {
  try {
    await fn();
    passed.push(name);
    console.log(`  PASS: ${name}`);
  } catch (error) {
    failed.push(`${name}: ${error.message}`);
    console.error(`  FAIL: ${name}`);
    console.error(error?.stack || error?.message || String(error));
  }
}

async function expectReject(fn, message) {
  let captured;
  try {
    await fn();
  } catch (error) {
    captured = error;
  }
  if (!captured) {
    throw new Error(`${message}（未拒绝）`);
  }
  return captured;
}

function requestJson(port, { method, url, headers = {}, payload }) {
  const body = payload === undefined
    ? ''
    : (typeof payload === 'string' ? payload : JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: url,
      headers: {
        ...headers,
        ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
      },
    }, (response) => {
      let responseBody = '';
      response.on('data', (chunk) => {
        responseBody += chunk;
      });
      response.on('end', () => {
        let parsed = responseBody;
        try {
          parsed = responseBody ? JSON.parse(responseBody) : null;
        } catch {
          // 非 JSON 响应保留原文。
        }
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body: parsed,
        });
      });
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

async function createSessionCookie(port) {
  const login = await requestJson(port, {
    method: 'GET',
    url: '/api/auth/login',
  });
  const loginCookies = Array.isArray(login.headers['set-cookie'])
    ? login.headers['set-cookie']
    : [login.headers['set-cookie']];
  const stateCookie = loginCookies.find((item) => item?.startsWith('yibiao_oauth_state='));
  const stateCookieValue = stateCookie?.match(/yibiao_oauth_state=([^;]+)/)?.[1] || '';
  const state = login.headers.location?.match(/state=([^&]+)/)?.[1] || '';
  const callback = await requestJson(port, {
    method: 'POST',
    url: '/api/auth/mock-callback',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `yibiao_oauth_state=${stateCookieValue}`,
    },
    payload: `email=worker%40test.com&name=WorkerTest&state=${state}`,
  });
  const callbackCookies = Array.isArray(callback.headers['set-cookie'])
    ? callback.headers['set-cookie']
    : [callback.headers['set-cookie']];
  const sessionCookie = callbackCookies.find((item) => item?.startsWith('yibiao_session='));
  const sessionValue = sessionCookie?.match(/yibiao_session=([^;]+)/)?.[1] || '';
  return `yibiao_session=${sessionValue}`;
}

function closeHttpServer(server) {
  return new Promise((resolve, reject) => {
    if (!server?.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function main() {
  process.env.CONFIG_ENCRYPTION_KEY = 'store-executor-test-key';
  process.env.WEB_STORE_WORKER_COUNT = '2';

  await run('Worker 数量限制在 1-4，workspace 哈希保持稳定', async () => {
    assert(_internals.normalizeWorkerCount(0) >= 1, '非法数量回退到默认值');
    assert(_internals.normalizeWorkerCount(99) === 4, 'Worker 数量上限为 4');
    assert(_internals.normalizeWorkerCount(2.9) === 2, 'Worker 数量取整数');
    assert(
      _internals.hashWorkspaceId('account-a') === _internals.hashWorkspaceId('account-a'),
      '同一 workspace 的哈希稳定',
    );
  });

  await run('Web Store 在 Worker 中顺序执行，大文件读取不阻塞主事件循环', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-store-worker-'));
    const workspaceId = 'store-worker-account';
    const workspaceRoot = path.join(tempDir, 'users', workspaceId, 'workspace');
    const userDir = path.dirname(workspaceRoot);
    const paths = resolveWorkspacePaths(workspaceRoot);
    const configPath = path.join(userDir, 'config.enc.json');
    fs.mkdirSync(paths.technicalPlanDir, { recursive: true });

    const executor = createWorkspaceStoreExecutor({
      workspaceId,
      workspaceRoot,
      databasePath: paths.databasePath,
      configPath,
    });

    try {
      const initialState = await executor.execute('technicalPlanStore', 'loadTechnicalPlan', []);
      assert(initialState?.step === 'document-analysis', 'Worker 可初始化并读取技术方案 Store');

      const firstUpdate = executor.execute('technicalPlanStore', 'updateStep', ['bid-analysis']);
      const secondUpdate = executor.execute('technicalPlanStore', 'updateStep', ['outline-generation']);
      const [, secondState] = await Promise.all([firstUpdate, secondUpdate]);
      assert(secondState?.step === 'outline-generation', '同一 workspace 的 Store 调用按提交顺序执行');

      const sqliteDatabase = createSqliteDatabase({ databasePath: paths.databasePath });
      try {
        sqliteDatabase.db.prepare(`
          UPDATE technical_plan_meta
          SET tender_markdown_path = ?, tender_markdown_chars = ?, updated_at = ?
          WHERE id = 1
        `).run('technical-plan/tender.md', 32 * 1024 * 1024, new Date().toISOString());
      } finally {
        sqliteDatabase.close();
      }
      fs.mkdirSync(paths.technicalPlanDir, { recursive: true });
      fs.writeFileSync(
        paths.technicalPlanTenderMarkdownPath,
        Buffer.alloc(32 * 1024 * 1024, 97),
      );

      let timerFired = false;
      let operationCompletedBeforeTimer = false;
      const readPromise = executor
        .execute('technicalPlanStore', 'readTenderMarkdown', [])
        .then((markdown) => {
          if (!timerFired) {
            operationCompletedBeforeTimer = true;
          }
          return markdown;
        });
      assert(executor.getStatus().active === 1, 'Worker 执行期间计入 workspace 活跃状态');

      await new Promise((resolve) => {
        setTimeout(() => {
          timerFired = true;
          resolve();
        }, 0);
      });
      assert(!operationCompletedBeforeTimer, '大文件读取期间主事件循环仍可处理计时器');

      const markdown = await readPromise;
      assert(markdown.length === 32 * 1024 * 1024, 'Worker 返回完整 Markdown');
      assert(executor.getStatus().active === 0, 'Worker 完成后清除 workspace 活跃状态');
    } finally {
      await executor.close();
      await executor.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    const closedError = await expectReject(
      () => executor.execute('technicalPlanStore', 'loadTechnicalPlan', []),
      '关闭后的 executor 必须拒绝新调用',
    );
    assert(closedError.code === 'WORKSPACE_UNAVAILABLE', '关闭后返回稳定 workspace 错误码');
  });

  await run('真实 Bridge 读取大文件时 health 仍可先返回', async () => {
    const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-store-bridge-'));
    process.env.YIBIAO_DATA_DIR = tempDataDir;
    process.env.OAUTH_MODE = 'mock';
    process.env.SESSION_SECRET = 'store-worker-session-secret';

    const { createApp } = require('../server/app.cjs');
    const { closeAll } = require('../server/workspace/workspaceRegistry.cjs');
    const server = http.createServer(createApp());
    await new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', resolve);
      server.once('error', reject);
    });
    const port = server.address().port;

    try {
      const cookie = await createSessionCookie(port);
      const loadResponse = await requestJson(port, {
        method: 'POST',
        url: '/api/bridge',
        headers: {
          'content-type': 'application/json',
          cookie,
        },
        payload: {
          namespace: 'technicalPlan',
          method: 'loadState',
          args: [],
        },
      });
      assert(loadResponse.statusCode === 200, 'Bridge 可初始化账号 workspace');

      const usersDir = path.join(tempDataDir, 'users');
      const workspaceIds = fs.readdirSync(usersDir);
      assert(workspaceIds.length === 1, '测试账号只创建一个 workspace');
      const workspaceRoot = path.join(usersDir, workspaceIds[0], 'workspace');
      const paths = resolveWorkspacePaths(workspaceRoot);
      const sqliteDatabase = createSqliteDatabase({ databasePath: paths.databasePath });
      try {
        sqliteDatabase.db.prepare(`
          UPDATE technical_plan_meta
          SET tender_markdown_path = ?, tender_markdown_chars = ?, updated_at = ?
          WHERE id = 1
        `).run('technical-plan/tender.md', 32 * 1024 * 1024, new Date().toISOString());
      } finally {
        sqliteDatabase.close();
      }
      fs.mkdirSync(paths.technicalPlanDir, { recursive: true });
      fs.writeFileSync(
        paths.technicalPlanTenderMarkdownPath,
        Buffer.alloc(32 * 1024 * 1024, 98),
      );

      const bridgePromise = requestJson(port, {
        method: 'POST',
        url: '/api/bridge',
        headers: {
          'content-type': 'application/json',
          cookie,
        },
        payload: {
          namespace: 'technicalPlan',
          method: 'readTenderMarkdown',
          args: [],
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 1));
      const healthPromise = requestJson(port, {
        method: 'GET',
        url: '/api/health',
      });
      const firstCompleted = await Promise.race([
        bridgePromise.then(() => 'bridge'),
        healthPromise.then(() => 'health'),
      ]);
      assert(firstCompleted === 'health', '大文件读取期间 health 可先完成');
      const healthResponse = await healthPromise;
      assert(healthResponse.statusCode === 200, '大文件读取期间 health 返回 200');
      const bridgeResponse = await bridgePromise;
      assert(bridgeResponse.statusCode === 200, '大文件读取完成后 Bridge 返回 200');
      assert(bridgeResponse.body?.data?.length === 32 * 1024 * 1024, 'Bridge 返回完整 Markdown');
    } finally {
      await closeHttpServer(server);
      await closeAll();
      fs.rmSync(tempDataDir, { recursive: true, force: true });
    }
  });

  console.log('\n=== Web Store Executor 测试结果 ===');
  console.log(`通过: ${passed.length}`);
  console.log(`失败: ${failed.length}`);
  if (failed.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
