// Web Workspace 自动化测试：覆盖数据隔离、加密配置、路径穿越、上传。
// 运行：npm run test:web-workspace（需要先 npm rebuild better-sqlite3 --runtime=node）
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { resolveWorkspacePaths } = require('../shared/workspacePaths.cjs');
const { encrypt, decrypt, maskKey, createEncryptedConfigStore } = require('../server/config/encryptedConfigStore.cjs');

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
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-test-'));
process.env.YIBIAO_DATA_DIR = tmpDir;
process.env.CONFIG_ENCRYPTION_KEY = 'test-encryption-key-for-testing';

async function runTests() {
  // 测试 1：resolveWorkspacePaths 返回完整路径
  {
    const paths = resolveWorkspacePaths('/tmp/fake-workspace');
    assert(paths.technicalPlanDir === path.join('/tmp/fake-workspace', 'technical-plan'), 'resolveWorkspacePaths: technicalPlanDir');
    assert(paths.databasePath === path.join('/tmp/fake-workspace', 'yibiao.sqlite'), 'resolveWorkspacePaths: databasePath');
    assert(paths.uploadsDir === path.join('/tmp/fake-workspace', 'uploads'), 'resolveWorkspacePaths: uploadsDir');
  }

  // 测试 2：AES-256-GCM 加密解密
  {
    const plaintext = 'sk-test-api-key-12345';
    const encrypted = encrypt(plaintext);
    assert(encrypted !== plaintext, '加密后不等于明文');
    assert(encrypted.startsWith('enc:v1:'), '加密结果有 enc:v1: 前缀');
    const decrypted = decrypt(encrypted);
    assert(decrypted === plaintext, '解密结果等于原明文');
  }

  // 测试 3：错误主密钥解密失败
  {
    const plaintext = 'sk-test-api-key-67890';
    const encrypted = encrypt(plaintext);
    process.env.CONFIG_ENCRYPTION_KEY = 'wrong-key';
    let failed = false;
    try {
      decrypt(encrypted);
    } catch {
      failed = true;
    }
    assert(failed, '错误主密钥解密抛错');
    process.env.CONFIG_ENCRYPTION_KEY = 'test-encryption-key-for-testing';
  }

  // 测试 4：maskKey 脱敏
  {
    assert(maskKey('sk-1234567890abcdef') === '****cdef', 'maskKey: 末尾4字符');
    assert(maskKey('ab') === '****', 'maskKey: 短 key 全掩');
    assert(maskKey(null) === null, 'maskKey: null 返回 null');
  }

  // 测试 5：加密配置 Store 读写
  {
    const configPath = path.join(tmpDir, 'test-config.enc.json');
    const store = createEncryptedConfigStore({ configPath });

    // 保存配置（含 API Key）
    const saveResult = store.save({ api_key: 'sk-secret-key-12345', model_name: 'gpt-4' });
    assert(saveResult?.success === true, '加密配置 save 返回 success');
    assert(saveResult?.message === '配置已保存', '加密配置 save message 正确');
    assert(saveResult?.config_path === undefined, 'Web 配置 save 不回传服务端路径');

    const baselineClientId = store.loadDecrypted().analytics_client_id;
    const legacyId = 'legacy-web-save-test-id';
    const legacySaveResult = store.save({
      ...store.load(),
      analytics_client_id: legacyId,
    });
    const afterLegacySave = store.loadDecrypted();
    assert(legacySaveResult?.success === true, 'legacy id 覆盖尝试 save 仍返回 success');
    assert(afterLegacySave.analytics_client_id === baselineClientId, 'server 端 identity 不被 legacy id 覆盖');
    assert(afterLegacySave.analytics_client_id !== legacyId, 'legacy id 未写入文件');

    // load 返回脱敏
    const masked = store.load();
    assert(masked.api_key === '****2345', '加密配置 load 返回脱敏 Key');
    assert(masked.model_name === 'gpt-4', '加密配置 load 返回非敏感字段');

    // loadDecrypted 返回明文
    const decrypted = store.loadDecrypted();
    assert(decrypted.api_key === 'sk-secret-key-12345', '加密配置 loadDecrypted 返回明文 Key');

    // 确认落盘文件不含明文
    const rawFile = fs.readFileSync(configPath, 'utf-8');
    assert(!rawFile.includes('sk-secret-key-12345'), '配置文件不含 API Key 明文');
    assert(rawFile.includes('enc:v1:'), '配置文件含加密标记');
  }

  // 测试 6：两个 workspace 隔离
  {
    const { createWorkspaceContext } = require('../server/workspace/workspaceContext.cjs');
    const ctx1 = createWorkspaceContext({ workspaceId: 'ws-test-1', dataDir: tmpDir });
    const ctx2 = createWorkspaceContext({ workspaceId: 'ws-test-2', dataDir: tmpDir });

    assert(ctx1.workspaceId !== ctx2.workspaceId, '两个 workspace 有不同 ID');
    assert(ctx1.workspaceRoot !== ctx2.workspaceRoot, '两个 workspace 有不同 root');
    assert(ctx1.db !== ctx2.db, '两个 workspace 有不同 db 实例');
    assert(ctx1.paths.databasePath !== ctx2.paths.databasePath, '两个 workspace 有不同 SQLite 路径');

    // ctx1 的 config 不影响 ctx2
    ctx1.configStore.save({ api_key: 'sk-ws1-key' });
    const ctx2Config = ctx2.configStore.load();
    assert(ctx2Config.api_key !== '****ws1-key', 'workspace 2 不含 workspace 1 的 Key');

    await ctx1.close();
    await ctx2.close();
  }

  // 测试 7：同一 workspaceId 重新获取保持数据
  {
    const { getWorkspaceContext, closeAll } = require('../server/workspace/workspaceRegistry.cjs');
    const ctx1 = getWorkspaceContext('ws-persist-test');
    ctx1.configStore.save({ api_key: 'sk-persist-key' });
    await closeAll();

    // 重新获取同一个 workspace
    const ctx2 = getWorkspaceContext('ws-persist-test');
    const config = ctx2.configStore.loadDecrypted();
    assert(config.api_key === 'sk-persist-key', '同一 workspace 重新获取后数据仍在');
    await closeAll();
  }

  // 测试 8：bridge dispatcher config.load 返回脱敏
  {
    const { getWorkspaceContext, closeAll } = require('../server/workspace/workspaceRegistry.cjs');
    const ctx = getWorkspaceContext('ws-bridge-test');
    ctx.configStore.save({ api_key: 'sk-bridge-secret-key' });

    // 模拟 bridge dispatcher 调用
    const result = ctx.configStore.load();
    assert(result.api_key === '****-key', 'bridge config.load 返回脱敏');
    assert(!JSON.stringify(result).includes('sk-bridge-secret-key'), 'bridge config.load 不含明文');

    await closeAll();
  }

  // 清理
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }

  // 汇总
  console.log(`\n=== Web Workspace 测试结果 ===`);
  console.log(`通过: ${passed.length}`);
  console.log(`失败: ${failed.length}`);
  if (failed.length > 0) {
    console.log('\n失败项:');
    failed.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log('全部通过 ✅');
}

runTests().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
