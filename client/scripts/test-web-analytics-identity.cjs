const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAiFairCoordinator } = require('../core/aiFairCoordinator.cjs');
const { createAiRuntime } = require('../core/aiRuntime.cjs');
const { createEncryptedConfigStore, encrypt } = require('../server/config/encryptedConfigStore.cjs');

const passed = [];
const failed = [];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assert(condition, message) {
  if (condition) {
    passed.push(message);
    console.log(`  PASS: ${message}`);
  } else {
    failed.push(message);
    console.error(`  FAIL: ${message}`);
  }
}

function createResponse() {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [{ message: { content: 'analytics identity ok' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      };
    },
  };
}

async function main() {
  process.env.CONFIG_ENCRYPTION_KEY = 'analytics-identity-test-key';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-analytics-identity-'));
  const storeA = createEncryptedConfigStore({ configPath: path.join(tempDir, 'account-a.json') });
  const storeB = createEncryptedConfigStore({ configPath: path.join(tempDir, 'account-b.json') });

  try {
    const firstA = storeA.loadDecrypted();
    assert(UUID_PATTERN.test(firstA.analytics_client_id), '新账号 analytics_client_id 为 UUID');
    assert(firstA.analytics_created_at && !Number.isNaN(Date.parse(firstA.analytics_created_at)), '新账号 analytics_created_at 为 ISO 时间');

    const rawAfterFirstLoad = fs.readFileSync(path.join(tempDir, 'account-a.json'), 'utf8');
    assert(rawAfterFirstLoad.includes(firstA.analytics_client_id), '首次 load 将 analytics 身份持久化');

    const secondA = storeA.load();
    const thirdA = storeA.loadDecrypted();
    assert(secondA.analytics_client_id === firstA.analytics_client_id && thirdA.analytics_client_id === firstA.analytics_client_id, '重复 load 保持 analytics_client_id 稳定');
    assert(secondA.analytics_created_at === firstA.analytics_created_at && thirdA.analytics_created_at === firstA.analytics_created_at, '重复 load 保持 analytics_created_at 稳定');

    storeA.save({
      api_key: 'sk-analytics-identity-secret',
      base_url: 'https://api.example.test/v1',
      model_name: 'identity-test-model',
    });
    const afterSave = storeA.loadDecrypted();
    const rawAfterSave = fs.readFileSync(path.join(tempDir, 'account-a.json'), 'utf8');
    assert(afterSave.analytics_client_id === firstA.analytics_client_id && afterSave.analytics_created_at === firstA.analytics_created_at, 'save 不重置 analytics 身份');
    assert(!rawAfterSave.includes('sk-analytics-identity-secret') && rawAfterSave.includes('enc:v1:'), '身份补齐不损坏 API Key 加密字段');

    const legacyPath = path.join(tempDir, 'legacy-account.json');
    fs.writeFileSync(legacyPath, JSON.stringify({
      api_key: encrypt('sk-legacy-identity-secret'),
      model_name: 'legacy-model',
    }), 'utf8');
    const legacyStore = createEncryptedConfigStore({ configPath: legacyPath });
    const legacyConfig = legacyStore.loadDecrypted();
    const legacyRaw = fs.readFileSync(legacyPath, 'utf8');
    assert(UUID_PATTERN.test(legacyConfig.analytics_client_id) && legacyConfig.analytics_created_at, '旧配置缺身份时补齐匿名身份');
    assert(legacyConfig.api_key === 'sk-legacy-identity-secret' && legacyRaw.includes('enc:v1:') && !legacyRaw.includes('sk-legacy-identity-secret'), '旧配置补身份不损坏既有加密 Key');

    const firstB = storeB.loadDecrypted();
    assert(firstB.analytics_client_id !== firstA.analytics_client_id, '两个账号生成不同 analytics_client_id');
    assert(firstB.analytics_created_at && !Number.isNaN(Date.parse(firstB.analytics_created_at)), '第二个账号 analytics_created_at 有效');

    const payloads = [];
    const runtime = createAiRuntime({
      workspaceKey: 'analytics-identity-account-a',
      loadConfig: storeA.loadDecrypted,
      sharedCoordinator: createAiFairCoordinator(),
      fetch: async () => createResponse(),
      trackRequest(payload) {
        payloads.push(payload);
      },
      retryDelay: 0,
    });
    try {
      await runtime.chat({ messages: [{ role: 'user', content: 'identity test' }] });
    } finally {
      runtime.close();
    }
    const payload = payloads[0];
    assert(payload && UUID_PATTERN.test(payload.client_id), 'AI tracker payload 包含 Worker 必填 client_id');
    assert(payload && payload.client_created_at === firstA.analytics_created_at, 'AI tracker payload 包含 Worker 必填 client_created_at');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log(`\n=== Web Analytics identity 测试结果 ===`);
  console.log(`通过: ${passed.length}`);
  console.log(`失败: ${failed.length}`);
  if (failed.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
