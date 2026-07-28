// 单租户认证契约测试：多个 MainQuest 身份共享业务租户，session 保持独立。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bidmaster-single-tenant-'));
process.env.YIBIAO_DATA_DIR = tmpDir;
process.env.CONFIG_ENCRYPTION_KEY = 'single-tenant-test-key';
process.env.BIDMASTER_TENANT_ID = 'tenant-test';
process.env.OAUTH_MODE = 'mock';
process.env.SESSION_SECRET = 'single-tenant-session-secret';

const config = require('../server/config.cjs');
const { upsertAccount } = require('../server/auth/accountStore.cjs');
const {
  SESSION_COOKIE_NAME,
  createSession,
} = require('../server/auth/sessionStore.cjs');
const { requireAuth } = require('../server/middleware/requireAuth.cjs');
const {
  createWorkspaceRegistry,
} = require('../server/workspace/workspaceRegistry.cjs');
const { getSystemDb } = require('../server/database/systemDatabase.cjs');

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

function runRequireAuth(sessionId) {
  const req = { cookies: { [SESSION_COOKIE_NAME]: sessionId } };
  const response = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
  let nextCalled = false;
  requireAuth(req, response, () => {
    nextCalled = true;
  });
  return { req, response, nextCalled };
}

async function runTests() {
  assert(config.tenantId === 'tenant-test', '配置读取固定 tenant ID');

  const alice = upsertAccount({
    mqSubject: 'mq-alice',
    email: 'alice@example.test',
    name: 'Alice',
    companyName: 'MainQuest',
  });
  const bob = upsertAccount({
    mqSubject: 'mq-bob',
    email: 'bob@example.test',
    name: 'Bob',
    companyName: 'MainQuest',
  });

  assert(alice.id !== bob.id, '两个 MainQuest 身份保留独立账号记录');
  assert(alice.workspaceId === config.tenantId, '账号 A 绑定部署级租户');
  assert(bob.workspaceId === config.tenantId, '账号 B 绑定部署级租户');

  getSystemDb().prepare(`
    INSERT INTO accounts (id, mq_subject, email, name, workspace_id)
    VALUES ('legacy-account', 'mq-legacy', 'legacy@example.test', 'Legacy', 'old-random-workspace')
  `).run();
  const legacy = upsertAccount({
    mqSubject: 'mq-legacy',
    email: 'legacy@example.test',
    name: 'Legacy',
    companyName: null,
  });
  const legacyStored = getSystemDb()
    .prepare('SELECT workspace_id FROM accounts WHERE id = ?')
    .get(legacy.id);
  assert(legacy.workspaceId === config.tenantId, '旧账号登录后返回部署级租户');
  assert(legacyStored.workspace_id === config.tenantId, '旧随机 workspace 标识收敛到部署级租户');

  const storedWorkspaceIds = getSystemDb()
    .prepare('SELECT DISTINCT workspace_id FROM accounts ORDER BY workspace_id')
    .all()
    .map((row) => row.workspace_id);
  assert(
    storedWorkspaceIds.length === 1 && storedWorkspaceIds[0] === config.tenantId,
    '账号表只保留一个业务租户标识',
  );

  const aliceSession = createSession(alice);
  const bobSession = createSession(bob);
  assert(aliceSession.sessionId !== bobSession.sessionId, '两个用户 session 保持独立');

  const aliceRequest = runRequireAuth(aliceSession.sessionId);
  const bobRequest = runRequireAuth(bobSession.sessionId);
  assert(aliceRequest.nextCalled && bobRequest.nextCalled, '两个有效 session 均通过认证');
  assert(
    aliceRequest.req.account.id !== bobRequest.req.account.id,
    '认证上下文保留各自账号身份',
  );
  assert(
    aliceRequest.req.workspaceId === bobRequest.req.workspaceId
      && aliceRequest.req.workspaceId === config.tenantId,
    '认证请求共享同一业务 workspace 兼容标识',
  );
  assert(
    Boolean(config.tenantId)
      && aliceRequest.req.tenantId === bobRequest.req.tenantId
      && aliceRequest.req.tenantId === config.tenantId,
    '认证请求共享同一 TenantContext 标识',
  );

  let contextCreateCount = 0;
  const registry = createWorkspaceRegistry({
    dataDir: tmpDir,
    createContext({ workspaceId }) {
      contextCreateCount += 1;
      return {
        workspaceId,
        close: async () => {},
        getActivitySnapshot: () => ({ active: false, unknown: false }),
      };
    },
  });
  const aliceContext = registry.getWorkspaceContext(aliceRequest.req.workspaceId);
  const bobContext = registry.getWorkspaceContext(bobRequest.req.workspaceId);
  assert(aliceContext === bobContext, '两个用户解析到同一个运行时上下文');
  assert(contextCreateCount === 1, '运行时只创建一次租户上下文');
  await registry.closeAll();

  const invalidConfig = spawnSync(
    process.execPath,
    ['-e', "require('./server/config.cjs')"],
    {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        BIDMASTER_TENANT_ID: '../escape',
      },
      encoding: 'utf8',
    },
  );
  assert(invalidConfig.status === 1, '拒绝可造成路径越界的 tenant ID');
  assert(
    invalidConfig.stderr.includes('BIDMASTER_TENANT_ID'),
    '非法 tenant ID 错误只暴露配置项名称',
  );

  console.log('\n=== Web 单租户认证测试结果 ===');
  console.log(`通过: ${passed.length}`);
  console.log(`失败: ${failed.length}`);
  if (failed.length > 0) {
    process.exitCode = 1;
  } else {
    console.log('全部通过 ✅');
  }
}

runTests()
  .catch((error) => {
    console.error('测试执行失败:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
