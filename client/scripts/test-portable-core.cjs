// Portable Core 聚焦测试：路径解析、数据库、模板 CRUD、配置归一化、兼容 wrapper、静态禁用依赖。
const fs = require('node:fs');
const Module = require('node:module');
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
const { createWorkspaceContext } = require('../server/workspace/workspaceContext.cjs');
const webServices = require('../server/workspace/webServices.cjs');

const passed = [];
const failed = [];
const activeDatabases = new Set();
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
  let thrownError;
  try {
    fn();
  } catch (error) {
    thrownError = error;
  }
  assert(Boolean(thrownError), message);
  return thrownError;
}

function trackDir(dir) {
  activeTmpDirs.push(dir);
  return dir;
}

function trackDb(dbContext) {
  activeDatabases.add(dbContext);
  return dbContext;
}

function untrackDb(dbContext) {
  activeDatabases.delete(dbContext);
}

function closeTrackedDb(dbContext) {
  if (!dbContext) return;
  if (dbContext.db?.open) {
    dbContext.close();
  }
  untrackDb(dbContext);
}

function closeAllDatabases() {
  for (const dbContext of activeDatabases) {
    if (!dbContext.db?.open) continue;
    try {
      dbContext.close();
    } catch (error) {
      assert(false, `清理: 数据库关闭失败：${error.message || String(error)}`);
    }
  }
  activeDatabases.clear();
}

function removeTmpDirs() {
  for (let i = activeTmpDirs.length - 1; i >= 0; i -= 1) {
    const tmpDir = activeTmpDirs[i];
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (error) {
      assert(false, `清理: 临时目录删除失败：${error.message || String(error)}`);
    }
    assert(!fs.existsSync(tmpDir), `清理: 临时目录已删除 ${path.basename(tmpDir)}`);
  }
  activeTmpDirs.length = 0;
}

function listCjsFilesRecursively(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return listCjsFilesRecursively(entryPath);
      }
      return entry.isFile() && entry.name.endsWith('.cjs') ? [entryPath] : [];
    })
    .sort();
}

function assertCoreHasNoElectronDependencies() {
  const clientDir = path.join(__dirname, '..');
  const coreDir = path.join(clientDir, 'core');
  const electronDir = path.join(clientDir, 'electron');
  const coreFiles = listCjsFilesRecursively(coreDir);

  const forbiddenPatterns = [
    /\brequire\(\s*['"]electron/,
    /from\s+['"]electron/,
    /app\.getPath/,
    /BrowserWindow/,
    /\bdialog\b/,
    /\bshell\b/,
  ];

  coreFiles.forEach((filePath) => {
    const relativePath = path.relative(clientDir, filePath);
    const source = fs.readFileSync(filePath, 'utf-8');
    const hit = forbiddenPatterns.find((pattern) => pattern.test(source));
    assert(!hit, `${relativePath} 不包含静态 Electron/主进程运行时依赖`);
  });

  const originalLoad = Module._load;
  Module._load = function rejectElectronFromCore(request, parent, isMain) {
    if (request === 'electron' || request === 'node:electron' || request.startsWith('electron/')) {
      const error = new Error(`core 禁止加载 Electron 模块：${request}`);
      error.code = 'PORTABLE_CORE_ELECTRON_DEPENDENCY';
      throw error;
    }

    const resolved = Module._resolveFilename(request, parent, isMain);
    if (typeof resolved === 'string' && resolved.startsWith(`${electronDir}${path.sep}`)) {
      const error = new Error(`core 禁止加载 Electron 目录：${resolved}`);
      error.code = 'PORTABLE_CORE_ELECTRON_DEPENDENCY';
      throw error;
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    let dynamicRequireBlocked = false;
    try {
      require(['elec', 'tron'].join(''));
    } catch (error) {
      dynamicRequireBlocked = error.code === 'PORTABLE_CORE_ELECTRON_DEPENDENCY';
    }
    assert(dynamicRequireBlocked, 'core 模块隔离: 动态拼接 require("electron") 被拒绝');

    coreFiles.forEach((filePath) => {
      delete require.cache[require.resolve(filePath)];
      try {
        require(filePath);
        assert(true, `core 模块隔离: ${path.relative(clientDir, filePath)} 可在禁用 Electron 时加载`);
      } catch (error) {
        assert(false, `core 模块隔离: ${path.relative(clientDir, filePath)} 加载失败：${error.message || String(error)}`);
      }
    });
  } finally {
    Module._load = originalLoad;
  }
  assert(Module._load === originalLoad, 'core 模块隔离: Module._load hook 已恢复');
}

function withFreshModuleOverrides(modulePath, overrides, callback) {
  const resolvedModulePath = require.resolve(modulePath);
  const originalLoad = Module._load;
  let freshModule;

  delete require.cache[resolvedModulePath];
  try {
    Module._load = function loadWithOverrides(request, parent, isMain) {
      const resolvedRequest = Module._resolveFilename(request, parent, isMain);
      if (overrides.has(resolvedRequest)) {
        return overrides.get(resolvedRequest);
      }
      return originalLoad.apply(this, arguments);
    };
    freshModule = require(resolvedModulePath);
  } finally {
    Module._load = originalLoad;
  }

  try {
    return callback(freshModule);
  } finally {
    delete require.cache[resolvedModulePath];
  }
}

function runWorkspaceRollbackCheck(tmpDir) {
  const expectedError = new Error('受控 taskService 装配失败');
  let rollbackDb;
  let agentClosed = false;
  let caughtError;

  const overrides = new Map([
    [require.resolve('../core/sqliteDatabase.cjs'), {
      ...coreSqlite,
      createSqliteDatabase(options) {
        rollbackDb = trackDb(coreSqlite.createSqliteDatabase(options));
        return rollbackDb;
      },
    }],
    [require.resolve('../server/workspace/webServices.cjs'), {
      ...webServices,
      createWebAgentServiceStub() {
        return {
          close() {
            agentClosed = true;
          },
        };
      },
    }],
    [require.resolve('../electron/services/taskService.cjs'), {
      createTaskService() {
        throw expectedError;
      },
    }],
  ]);

  withFreshModuleOverrides(
    '../server/workspace/workspaceContext.cjs',
    overrides,
    ({ createWorkspaceContext: createFailingWorkspaceContext }) => {
      try {
        createFailingWorkspaceContext({
          workspaceId: 'rollback-user',
          dataDir: path.join(tmpDir, 'web-rollback'),
        });
      } catch (error) {
        caughtError = error;
      }
    },
  );

  assert(caughtError === expectedError, 'Web workspace 回滚: 原始装配异常原样重抛');
  assert(agentClosed, 'Web workspace 回滚: 已创建 agentService 被关闭');
  assert(rollbackDb && !rollbackDb.db.open, 'Web workspace 回滚: SQLite 连接被关闭');
  if (rollbackDb && !rollbackDb.db.open) {
    untrackDb(rollbackDb);
  }
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
    expectThrow(
      () => coreConfigStore.createConfigStore({}),
      'config core store: 缺少 configPath 时抛错',
    );
    expectThrow(
      () => coreSqlite.createSqliteDatabase({}),
      'SQLite core: 缺少 databasePath/workspaceRoot 时抛错',
    );

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
      closeTrackedDb(coreDbContext);
    }

    const expectedPragmaError = new Error('受控 pragma 初始化失败');
    let failedDb;
    class FailingDatabase {
      constructor() {
        this.open = true;
        failedDb = this;
      }

      pragma() {
        throw expectedPragmaError;
      }

      close() {
        this.open = false;
      }
    }
    const pragmaError = expectThrow(
      () => coreSqlite.createSqliteDatabase({
        databasePath: path.join(tmpDir, 'failing-sqlite', 'yibiao.sqlite'),
        DatabaseClass: FailingDatabase,
      }),
      'SQLite 初始化失败: pragma 异常向上抛出',
    );
    assert(pragmaError === expectedPragmaError, 'SQLite 初始化失败: 原始异常对象保持不变');
    assert(failedDb && !failedDb.open, 'SQLite 初始化失败: 已打开连接被关闭');

    // 3. Electron wrapper 导出、路径与 before-quit 兼容
    let sqliteWrapperContext;
    let defaultSqliteWrapperContext;
    try {
      const beforeQuitFns = [];
      const userDataDir = path.join(tmpDir, 'wrapper-userdata');
      const app = {
        getPath: (name) => {
          if (name === 'userData') {
            return userDataDir;
          }
          return '';
        },
        once(event, fn) {
          if (event === 'before-quit') {
            beforeQuitFns.push(fn);
          }
        },
      };

      sqliteWrapperContext = trackDb(electronSqlite.createSqliteDatabase(app, { workspaceRoot: path.join(tmpDir, 'compat'), onStatus: () => {} }));
      assert(typeof electronSqlite.schemaVersion === 'number', '兼容 wrapper sqliteDatabase: 导出 schemaVersion');
      assert(electronSqlite.schemaVersion === coreSqlite.schemaVersion, '兼容 wrapper sqliteDatabase: schemaVersion 与 core 一致');
      assert(fs.existsSync(sqliteWrapperContext.path), '兼容 wrapper sqliteDatabase: 通过 workspaceRoot 解析到 databasePath');

      defaultSqliteWrapperContext = trackDb(electronSqlite.createSqliteDatabase(app, { onStatus: () => {} }));
      assert(
        defaultSqliteWrapperContext.path === path.join(userDataDir, 'workspace', 'yibiao.sqlite'),
        '兼容 wrapper sqliteDatabase: 无显式路径时仅使用 app userData/workspace',
      );
      const electronTemplate = electronTemplateStore.createTemplateStore({ db: defaultSqliteWrapperContext.db });
      const t = electronTemplate.createTemplate({ template_name: 'compat', page: {} });
      assert(typeof t.template_id === 'string', '兼容 wrapper templateStore: createTemplate 可用');
      electronTemplate.deleteTemplate(t.template_id);
      assert(beforeQuitFns.length === 2, '兼容 wrapper sqliteDatabase: 每个实例注册 before-quit 回调');
      assert(sqliteWrapperContext.db.open, '兼容 wrapper sqliteDatabase: 第一个 DB 保持打开');
      assert(defaultSqliteWrapperContext.db.open, '兼容 wrapper sqliteDatabase: 第二个 DB 保持打开');
      beforeQuitFns.forEach((callback) => callback());
      assert(!sqliteWrapperContext.db.open, '兼容 wrapper sqliteDatabase: before-quit 关闭第一个 DB');
      assert(!defaultSqliteWrapperContext.db.open, '兼容 wrapper sqliteDatabase: before-quit 关闭第二个 DB');
      untrackDb(sqliteWrapperContext);
      untrackDb(defaultSqliteWrapperContext);

      const configPath = path.join(userDataDir, 'user_config.json');
      const userConfigStore = electronConfigStore.createConfigStore(app);
      const saved = userConfigStore.save({ api_key: 'compat-key' });
      assert(saved && saved.success, '兼容 wrapper configStore: save() 成功');
      const masked = userConfigStore.load();
      assert(masked.api_key === 'compat-key', '兼容 wrapper configStore: createConfigStore.load() 可直接返回文本密钥');
      assert(fs.existsSync(configPath), '兼容 wrapper configStore: 无显式路径时仅落 app userData/user_config.json');
    } finally {
      closeTrackedDb(sqliteWrapperContext);
      closeTrackedDb(defaultSqliteWrapperContext);
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

    // 5. Web workspace 路径与装配失败回滚
    let webContext;
    try {
      const workspaceId = 'portable-user';
      const webDataDir = path.join(tmpDir, 'web-data');
      const expectedUserDir = path.join(webDataDir, 'users', workspaceId);
      const expectedWorkspaceRoot = path.join(expectedUserDir, 'workspace');
      const expectedDatabasePath = path.join(expectedWorkspaceRoot, 'yibiao.sqlite');
      const expectedConfigPath = path.join(expectedUserDir, 'config.enc.json');

      webContext = createWorkspaceContext({ workspaceId, dataDir: webDataDir });
      trackDb(webContext.sqliteDatabase);
      assert(webContext.workspaceRoot === expectedWorkspaceRoot, 'Web workspace: workspaceRoot 精确对应当前 workspaceId');
      assert(webContext.sqliteDatabase.path === expectedDatabasePath, 'Web workspace: SQLite 精确落当前 workspaceId 目录');
      webContext.configStore.save({ developer_mode: false });
      assert(fs.existsSync(expectedConfigPath), 'Web workspace: config 精确落当前 workspaceId 目录');
    } finally {
      if (webContext) {
        webContext.close();
        untrackDb(webContext.sqliteDatabase);
      }
    }
    runWorkspaceRollbackCheck(tmpDir);

    // 6. runtime ID 单源一致性
    runRuntimeIdConsistencyChecks();

    // 7. 打包断言
    runPackagingAssertions();

    // 8. 递归静态依赖与实际模块加载隔离
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
