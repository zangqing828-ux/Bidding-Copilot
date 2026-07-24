// Portable Core 聚焦测试：路径解析、数据库、模板 CRUD、配置归一化、兼容 wrapper、静态禁用依赖。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const coreWorkspacePaths = require('../core/workspacePaths.cjs');
const coreSqlite = require('../core/sqliteDatabase.cjs');
const coreTemplateStore = require('../core/templateStore.cjs');
const coreConfigStore = require('../core/configStore.cjs');
const coreAgentRuntimeIds = require('../core/agentRuntimeIds.cjs');

const sharedWorkspacePaths = require('../shared/workspacePaths.cjs');
const electronSqlite = require('../electron/services/sqliteDatabase.cjs');
const electronTemplateStore = require('../electron/services/templateStore.cjs');
const electronConfigStore = require('../electron/services/configStore.cjs');
const electronAgentRuntimeRegistry = require('../electron/services/agent/agentRuntimeRegistry.cjs');

const passed = [];
const failed = [];
const activeDatabases = [];
const activeTmpDirs = [];

function assert(condition, message) {
  if (condition) {
    passed.push(message);
    return;
  }
  failed.push(message);
  console.error(`  FAIL: ${message}`);
}

function expectThrow(fn, message) {
  let thrown = false;
  try {
    fn();
  } catch (error) {
    thrown = true;
  }
  assert(thrown, message);
}

function trackDir(dir) {
  activeTmpDirs.push(dir);
  return dir;
}

function trackDb(dbContext) {
  activeDatabases.push(dbContext);
  return dbContext;
}

function closeAllDatabases() {
  activeDatabases.forEach((dbContext) => {
    try {
      dbContext.close();
    } catch {
      // 忽略清理异常
    }
  });
  activeDatabases.length = 0;
}

function removeTmpDirs() {
  for (let i = activeTmpDirs.length - 1; i >= 0; i -= 1) {
    try {
      fs.rmSync(activeTmpDirs[i], { recursive: true, force: true });
    } catch {
      // 忽略清理异常
    }
  }
  activeTmpDirs.length = 0;
}

function assertCoreHasNoElectronDependencies() {
  const coreFiles = [
    'core/workspacePaths.cjs',
    'core/sqliteDatabase.cjs',
    'core/templateStore.cjs',
    'core/configStore.cjs',
    'core/agentRuntimeIds.cjs',
  ];

  const forbiddenPatterns = [
    /\brequire\(\s*['"]electron/,
    /from\s+['"]electron/,
    /app\.getPath/,
    /BrowserWindow/,
    /\bdialog\b/,
    /\bshell\b/,
  ];

  coreFiles.forEach((relativePath) => {
    const filePath = path.join(__dirname, '..', relativePath);
    const source = fs.readFileSync(filePath, 'utf-8');
    const hit = forbiddenPatterns.find((pattern) => pattern.test(source));
    assert(!hit, `core/${relativePath} 不包含静态 Electron/主进程运行时依赖`);
  });
}

function runRuntimeIdConsistencyChecks() {
  const coreIdEnum = coreAgentRuntimeIds.AGENT_RUNTIME_ID;
  const coreIds = coreAgentRuntimeIds.AGENT_RUNTIME_IDS;
  const coreDefault = coreAgentRuntimeIds.getDefaultAgentRuntimeId();
  const registryDefault = electronAgentRuntimeRegistry.getDefaultAgentRuntimeId();
  const descriptors = electronAgentRuntimeRegistry.listAgentRuntimeDescriptors();
  assert(Object.isFrozen(coreIdEnum), 'runtimeId: core AGENT_RUNTIME_ID 枚举对象不可变');
  assert(coreIdEnum.OPENCODE === 'opencode', 'runtimeId: core 枚举定义 OPENCODE');
  assert(coreIdEnum.PI === 'pi', 'runtimeId: core 枚举定义 PI');
  assert(Array.isArray(coreIds), 'runtimeId: core 公开 AGENT_RUNTIME_IDS');
  assert(Object.isFrozen(coreIds), 'runtimeId: core AGENT_RUNTIME_IDS 数组不可变');
  expectThrow(() => coreIds.push('other-runtime'), 'runtimeId: core AGENT_RUNTIME_IDS 禁止追加值');
  assert(
    coreIds.length === 2 && coreIds[0] === coreIdEnum.OPENCODE && coreIds[1] === coreIdEnum.PI,
    'runtimeId: core AGENT_RUNTIME_IDS 来自枚举对象值',
  );
  assert(Array.isArray(descriptors), 'runtimeId: registry 可返回运行时描述列表');
  assert(coreIds.length === descriptors.length, 'runtimeId: core 允许值与 registry 描述数量一致');
  assert(coreDefault === registryDefault, 'runtimeId: core 默认值与 registry 默认值一致');
  assert(coreDefault === coreIdEnum.OPENCODE, 'runtimeId: core 默认值为 AGENT_RUNTIME_ID.OPENCODE');
  assert(coreAgentRuntimeIds.DEFAULT_AGENT_RUNTIME_ID === coreIdEnum.OPENCODE, 'runtimeId: core 默认常量为 AGENT_RUNTIME_ID.OPENCODE');
  assert(coreIds.includes(coreDefault), 'runtimeId: core 默认值在允许值列表内');

  for (const id of coreIds) {
    const coreNormalized = coreAgentRuntimeIds.normalizeAgentRuntimeId(id);
    const registryNormalized = electronAgentRuntimeRegistry.normalizeAgentRuntimeId(id);
    const definition = electronAgentRuntimeRegistry.getAgentRuntimeDefinition(id);
    assert(coreNormalized === id, `runtimeId: core normalize(${id}) 透传已允许值`);
    assert(registryNormalized === id, `runtimeId: registry normalize(${id}) 透传已允许值`);
    assert(definition?.id === id, `runtimeId: registry getAgentRuntimeDefinition(${id}) 返回匹配定义`);
    assert(typeof definition?.displayName === 'string' && definition.displayName.length > 0, `runtimeId: registry 定义 ${id} 包含 displayName`);
    assert(typeof definition?.description === 'string' && definition.description.length > 0, `runtimeId: registry 定义 ${id} 包含 description`);
    assert(definition?.isDefault === (id === coreDefault), `runtimeId: registry 定义 ${id} 的 isDefault 正确`);
    assert(typeof definition?.createRuntime === 'function', `runtimeId: registry 定义 ${id} 包含 createRuntime 函数`);
  }

  assert(coreIds.includes(descriptors.find((item) => item.is_default)?.id), 'runtimeId: registry 默认描述存在且在允许值内');
  assert(coreDefault === (descriptors.find((item) => item.is_default) || {}).id, 'runtimeId: registry 默认描述与 core 默认值一致');

  expectThrow(
    () => coreAgentRuntimeIds.normalizeAgentRuntimeId('not-exist-runtime'),
    'runtimeId: core 对非法值报错',
  );
  expectThrow(
    () => electronAgentRuntimeRegistry.normalizeAgentRuntimeId('not-exist-runtime'),
    'runtimeId: registry 对非法值报错',
  );
  assert(coreAgentRuntimeIds.normalizeAgentRuntimeId('  ') === coreDefault, 'runtimeId: core 空字符串回退到默认值');
  assert(electronAgentRuntimeRegistry.normalizeAgentRuntimeId('  ') === registryDefault, 'runtimeId: registry 空字符串回退到默认值');
}

function runPackagingAssertions() {
  const packageJsonPath = path.join(__dirname, '../package.json');
  const dockerfilePath = path.join(__dirname, '../../Dockerfile');
  const packageConfig = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  const files = packageConfig?.build?.files || [];
  assert(Array.isArray(files), '打包: package.json.build.files 是数组');
  assert(files.includes('core/**/*'), '打包: package build.files 包含 core/**/*');
  assert(files.includes('shared/**/*'), '打包: package build.files 包含 shared/**/*');

  const dockerfileSource = fs.readFileSync(dockerfilePath, 'utf-8');
  assert(dockerfileSource.includes('COPY client/core/ ./client/core/'), '打包: Dockerfile 运行时复制 client/core');
}

function run() {
  const tmpDir = trackDir(fs.mkdtempSync(path.join(os.tmpdir(), 'bidding-portable-core-')));

  try {
    // 1. workspace paths
    const workspaceRoot = path.join(tmpDir, 'ws-a');
    const paths = coreWorkspacePaths.resolveWorkspacePaths(workspaceRoot);
    assert(paths.technicalPlanDir === path.join(workspaceRoot, 'technical-plan'), '核心 workspacePaths: technicalPlanDir');
    assert(paths.databasePath === path.join(workspaceRoot, 'yibiao.sqlite'), '核心 workspacePaths: databasePath');
    assert(paths.uploadsDir === path.join(workspaceRoot, 'uploads'), '核心 workspacePaths: uploadsDir');
    assert(paths.knowledgeBaseDir === path.join(workspaceRoot, 'knowledge-base'), '核心 workspacePaths: knowledgeBaseDir');
    const rejPath = coreWorkspacePaths.getRejectionCheckDocumentMarkdownPath(paths, 'bid', 'bid-abc');
    assert(rejPath.endsWith('rejection-check/bids/bid-abc.md'), '核心 workspacePaths: rejection 文档路径生成');

    const compatibilityPaths = sharedWorkspacePaths.resolveWorkspacePaths(workspaceRoot);
    assert(compatibilityPaths.databasePath === paths.databasePath, '兼容 wrapper shared/workspacePaths: 路径签名一致');

    // 2. SQLite 生命周期（core）
    let coreDbContext;
    try {
      const sqliteRoot = path.join(tmpDir, 'sqlite');
      coreDbContext = trackDb(coreSqlite.createSqliteDatabase({ workspaceRoot: sqliteRoot, onStatus: () => {} }));
      assert(typeof coreDbContext.db.open === 'boolean', 'SQLite 初始化: db 实例可用');
      assert(coreDbContext.path === path.join(sqliteRoot, 'yibiao.sqlite'), 'SQLite 初始化: databasePath 自动按 workspaceRoot 解析');

      assert(typeof coreDbContext.schemaVersion === 'number' && coreDbContext.schemaVersion > 0, 'SQLite 初始化: schemaVersion 可读取');
      assert(coreDbContext.schemaVersion === coreSqlite.schemaVersion, 'SQLite 初始化: schemaVersion 与 core 导出一致');

      const table = coreDbContext.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='export_templates'")
        .get();
      assert(Boolean(table && table.name === 'export_templates'), 'SQLite 建库: export_templates 表已创建');

      const templateStore = coreTemplateStore.createTemplateStore({ db: coreDbContext.db });
      const template = templateStore.createTemplate({ template_name: 'base', page: {} });
      assert(template.template_name === 'base', 'template CRUD: createTemplate 返回模板名');
      assert(template.template_id && typeof template.template_id === 'string', 'template CRUD: createTemplate 返回 template_id');

      const sameTemplate = templateStore.getTemplate(template.template_id);
      assert(sameTemplate?.template_name === 'base', 'template CRUD: getTemplate 可读取');

      const updated = templateStore.updateTemplate(template.template_id, { template_name: 'updated', page: {} });
      assert(updated.template_name === 'updated', 'template CRUD: updateTemplate 可更新');

      const beforeDelete = templateStore.listTemplates();
      assert(beforeDelete.length === 1 && beforeDelete[0].template_name === 'updated', 'template CRUD: listTemplates 可读取 1 项');

      const deleted = templateStore.deleteTemplate(template.template_id);
      assert(deleted.success, 'template CRUD: deleteTemplate success=true');

      const afterDelete = templateStore.listTemplates();
      assert(afterDelete.length === 0, 'template CRUD: delete 后列表为空');
    } finally {
      if (coreDbContext) {
        coreDbContext.close();
      }
    }

    // 3. Electron wrapper 导出与 schemaVersion 兼容
    let sqliteWrapperContext;
    try {
      let beforeQuitFn;
      const app = {
        getPath: (name) => {
          if (name === 'userData') {
            return path.join(tmpDir, 'wrapper-userdata');
          }
          return '';
        },
        once(event, fn) {
          if (event === 'before-quit') {
            beforeQuitFn = fn;
          }
        },
      };

      sqliteWrapperContext = trackDb(electronSqlite.createSqliteDatabase(app, { workspaceRoot: path.join(tmpDir, 'compat'), onStatus: () => {} }));
      assert(typeof electronSqlite.schemaVersion === 'number', '兼容 wrapper sqliteDatabase: 导出 schemaVersion');
      assert(electronSqlite.schemaVersion === coreSqlite.schemaVersion, '兼容 wrapper sqliteDatabase: schemaVersion 与 core 一致');
      assert(fs.existsSync(sqliteWrapperContext.path), '兼容 wrapper sqliteDatabase: 通过 workspaceRoot 解析到 databasePath');

      const secondDb = trackDb(electronSqlite.createSqliteDatabase(app, { workspaceRoot: path.join(tmpDir, 'compat-2'), onStatus: () => {} }));
      const electronTemplate = electronTemplateStore.createTemplateStore({ db: secondDb.db });
      const t = electronTemplate.createTemplate({ template_name: 'compat', page: {} });
      assert(typeof t.template_id === 'string', '兼容 wrapper templateStore: createTemplate 可用');
      electronTemplate.deleteTemplate(t.template_id);
      assert(typeof beforeQuitFn === 'function', '兼容 wrapper sqliteDatabase: 注册 before-quit 回调');
      assert(sqliteWrapperContext.db.open, '兼容 wrapper sqliteDatabase: db 打开状态');
      sqliteWrapperContext.close();
      assert(!sqliteWrapperContext.db.open, '兼容 wrapper sqliteDatabase: close 后 db 关闭');
      assert(typeof secondDb.db.open === 'boolean', '兼容 wrapper sqliteDatabase: 另一个实例可创建');
      secondDb.close();
      if (beforeQuitFn) beforeQuitFn();
      assert(!secondDb.db.open, '兼容 wrapper sqliteDatabase: before-quit 回调触发后可正常关闭');

      const configPath = path.join(tmpDir, 'wrapper-userdata', 'user_config.json');
      const userConfigStore = electronConfigStore.createConfigStore(app);
      const saved = userConfigStore.save({ api_key: 'compat-key' });
      assert(saved && saved.success, '兼容 wrapper configStore: save() 成功');
      const masked = userConfigStore.load();
      assert(masked.api_key === 'compat-key', '兼容 wrapper configStore: createConfigStore.load() 可直接返回文本密钥');
      assert(fs.existsSync(configPath), '兼容 wrapper configStore: 配置文件落盘');
    } finally {
      if (sqliteWrapperContext) {
        sqliteWrapperContext.close();
      }
    }

    // 4. 配置归一化
    const coreConfigPath = path.join(tmpDir, 'core-config.json');
    const coreConfigStoreInstance = coreConfigStore.createConfigStore({ configPath: coreConfigPath });
    const c0 = coreConfigStoreInstance.load();
    assert(c0.text_model_provider === 'jinlong', 'config core store: createConfigStore 显式 configPath 构造成功');

    const c1 = coreConfigStore.normalizeConfig({
      text_model_provider: 'custom',
      api_key: 'custom-key',
      model_name: 'gpt-4',
    });
    assert(c1.text_model_provider === 'custom', 'config normalize: 自定义 provider 保留');
    assert(c1.text_model_profiles.custom.api_key === 'custom-key', 'config normalize: 自定义 API key 归一化');

    const c2 = coreConfigStore.normalizeConfig({
      text_model_provider: 'unknown-provider',
      image_model: { provider: 'google-ai-studio' },
    });
    assert(c2.text_model_provider === 'custom', 'config normalize: 非法 provider 回退为 custom');
    assert(c2.image_model.provider === 'google-ai-studio', 'config normalize: image provider 可接受 google-ai-studio');

    // 5. runtime ID 单源一致性
    runRuntimeIdConsistencyChecks();

    // 6. 打包断言
    runPackagingAssertions();

    // 7. 静态依赖禁用检查
    assertCoreHasNoElectronDependencies();
  } finally {
    closeAllDatabases();
    removeTmpDirs();
  }

  console.log(`\n=== Portable Core 测试结果 ===`);
  console.log(`通过: ${passed.length}`);
  console.log(`失败: ${failed.length}`);

  if (failed.length > 0) {
    console.log('\n失败项:');
    failed.forEach((message) => {
      console.log(`  - ${message}`);
    });
    process.exit(1);
  }

  console.log('全部通过 ✅');
}

try {
  run();
} catch (error) {
  failed.push(`脚本异常: ${error.message}`);
  closeAllDatabases();
  removeTmpDirs();
  console.log(`\n=== Portable Core 测试结果 ===`);
  console.log(`通过: ${passed.length}`);
  console.log(`失败: ${failed.length}`);
  failed.forEach((message) => {
    console.log(`  - ${message}`);
  });
  process.exit(1);
}
