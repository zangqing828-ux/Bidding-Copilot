// Portable Core 聚焦测试：路径解析、数据库、模板 CRUD、配置归一化、兼容 wrapper、静态禁用依赖。
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const { spawnSync } = require('node:child_process');

const coreWorkspacePaths = require('../core/workspacePaths.cjs');
const coreSqlite = require('../core/sqliteDatabase.cjs');
const coreTemplateStore = require('../core/templateStore.cjs');
const coreConfigStore = require('../core/configStore.cjs');
const coreAgentRuntimeIds = require('../core/agentRuntimeIds.cjs');
const coreTechnicalPlanStore = require('../core/stores/technicalPlanStore.cjs');
const coreKnowledgeBaseStore = require('../core/stores/knowledgeBaseStore.cjs');
const coreDuplicateCheckStore = require('../core/stores/duplicateCheckStore.cjs');
const coreRejectionCheckStore = require('../core/stores/rejectionCheckStore.cjs');
const coreWorkspaceCleanup = require('../core/workspaceCleanup.cjs');

const sharedWorkspacePaths = require('../shared/workspacePaths.cjs');
const electronSqlite = require('../electron/services/sqliteDatabase.cjs');
const electronTemplateStore = require('../electron/services/templateStore.cjs');
const electronConfigStore = require('../electron/services/configStore.cjs');
const electronAgentRuntimeRegistry = require('../electron/services/agent/agentRuntimeRegistry.cjs');
const electronTechnicalPlanStore = require('../electron/services/technicalPlanStore.cjs');
const electronKnowledgeBaseStore = require('../electron/services/knowledgeBaseStore.cjs');
const electronDuplicateCheckStore = require('../electron/services/duplicateCheckStore.cjs');
const electronRejectionCheckStore = require('../electron/services/rejectionCheckStore.cjs');
const { createWorkspaceContext } = require('../server/workspace/workspaceContext.cjs');
const webServices = require('../server/workspace/webServices.cjs');

const passed = [];
const failed = [];
const skipped = [];
const activeDatabases = new Set();
const activeTmpDirs = [];
const CLIENT_DIR = path.join(__dirname, '..');
const CORE_DIR = path.join(CLIENT_DIR, 'core');
const ELECTRON_DIR = path.join(CLIENT_DIR, 'electron');

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

function skip(message) {
  skipped.push(message);
  console.log(`  SKIP: ${message}`);
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

function isPathUnderDirectory(targetPath, directory) {
  const normalizedDirectory = `${path.resolve(directory)}${path.sep}`;
  const normalizedTarget = path.resolve(targetPath);
  return normalizedTarget.startsWith(normalizedDirectory);
}

function scanRequireCalls(filePath, source) {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const calls = [];

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === 'require') {
        const callText = source.slice(node.getStart(), node.getEnd());
        const argNode = node.arguments[0];
        const hasSingleArg = node.arguments.length === 1;
        const argText = argNode ? source.slice(argNode.getStart(), argNode.getEnd()) : '';
        const literalArg = hasSingleArg && (ts.isStringLiteral(argNode) || ts.isNoSubstitutionTemplateLiteral(argNode))
          ? argNode.text
          : null;

        calls.push({
          file: filePath,
          expression: literalArg,
          raw: callText,
          argText,
          computed: !hasSingleArg || literalArg === null,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return calls;
}

function resolveLocalDependency(currentFilePath, request) {
  const resolved = require.resolve(request, { paths: [path.dirname(currentFilePath)] });
  return resolved;
}

function collectReachableCoreDeps(seedFiles, reasonPrefix = '依赖图扫描') {
  const todo = [...new Set(seedFiles.map((entry) => path.resolve(entry)))];
  const visited = new Set();
  const seedSet = new Set(todo);
  while (todo.length > 0) {
    const filePath = todo.pop();
    if (visited.has(filePath)) {
      continue;
    }
    visited.add(filePath);

    assert(
      !filePath || path.extname(filePath) === '.cjs' || path.extname(filePath) === '.js',
      `${reasonPrefix}: 忽略非 CJS/JS 文件 ${path.relative(CLIENT_DIR, filePath)}`,
    );

    assert(
      seedSet.has(filePath) || isPathUnderDirectory(filePath, CLIENT_DIR),
      `${reasonPrefix}: 扫描路径必须在 client 下，当前 ${path.relative(CLIENT_DIR, filePath)}`,
    );

    assert(
      !isPathUnderDirectory(filePath, ELECTRON_DIR),
      `${reasonPrefix}: 禁止依赖进入 client/electron，命中 ${path.relative(CLIENT_DIR, filePath)}`,
    );

    const source = fs.readFileSync(filePath, 'utf-8');
    const calls = scanRequireCalls(filePath, source);
    calls.forEach((call) => {
      if (call.computed) {
        throw new Error(`${reasonPrefix}: 非字面量 require 调用 ${call.raw} 在 ${path.relative(CLIENT_DIR, call.file)}`);
      }

      const literalArg = call.expression;
      if (literalArg === 'electron' || literalArg === 'node:electron' || literalArg.startsWith('electron/')) {
        throw new Error(`${reasonPrefix}: 禁止直接 require(${literalArg}) 在 ${path.relative(CLIENT_DIR, filePath)}`);
      }

      if (literalArg.startsWith('./') || literalArg.startsWith('../') || path.isAbsolute(literalArg)) {
        let resolved;
        try {
          resolved = resolveLocalDependency(filePath, literalArg);
        } catch (error) {
          throw new Error(`${reasonPrefix}: require(${literalArg}) 无法解析 (${path.relative(CLIENT_DIR, filePath)})`);
        }

        if (isPathUnderDirectory(resolved, ELECTRON_DIR)) {
          throw new Error(`依赖图扫描: local 依赖进入 electron 目录 ${path.relative(CLIENT_DIR, filePath)} -> ${path.relative(CLIENT_DIR, resolved)}`);
        }

        if (isPathUnderDirectory(resolved, CLIENT_DIR) && (path.extname(resolved) === '.cjs' || path.extname(resolved) === '.js')) {
          if (!visited.has(resolved)) {
            todo.push(resolved);
          }
        }
      }
    });
  }
  return [...visited];
}

function runChildProcessCoreIsolationCheck(coreFiles) {
  const script = `
    const path = require('node:path');
    const Module = require('node:module');

    const clientDir = path.join(process.cwd(), 'client');
    const electronDir = path.join(clientDir, 'electron');
    const entries = JSON.parse(process.env.PORTABLE_CORE_FILES || '[]');
    const originalLoad = Module._load;

    function fail(message) {
      console.error(message);
      process.exit(2);
    }

    Module._load = function rejectElectronInChild(request, parent, isMain) {
      if (request === 'electron' || request === 'node:electron' || request.startsWith('electron/')) {
        fail(\`子进程模块隔离: 禁止 require(\${request})\`);
      }
      const resolved = Module._resolveFilename(request, parent, isMain);
      if (typeof resolved === 'string' && resolved.startsWith(\`\${electronDir}\${path.sep}\`)) {
        fail(\`子进程模块隔离: 禁止加载 electron 目录模块 \${resolved}\`);
      }
      return originalLoad.apply(this, [request, parent, isMain]);
    };

    try {
      for (const entryPath of entries) {
        require(entryPath);
      }
      process.exit(0);
    } catch (error) {
      fail(\`子进程模块隔离: \${error && error.message ? error.message : String(error)}\`);
    } finally {
      Module._load = originalLoad;
    }
  `;

  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(CLIENT_DIR, '..'),
    env: {
      ...process.env,
      PORTABLE_CORE_FILES: JSON.stringify(coreFiles.map((item) => path.resolve(item))),
    },
    encoding: 'utf8',
    timeout: 120000,
  });

  if (child.status !== 0) {
    const details = [child.stdout, child.stderr].filter(Boolean).join('\n');
    assert(
      false,
      `子进程模块隔离: core 入口加载失败 -> ${details || `exitCode=${child.status}`}`,
    );
  }
}

function assertCoreHasNoElectronDependencies() {
  const coreFiles = listCjsFilesRecursively(CORE_DIR);
  const workspaceRuntimeFactoryPath = path.join(CLIENT_DIR, 'server', 'workspace', 'workspaceRuntimeFactory.cjs');

  const forbiddenPatterns = [
    /\brequire\(\s*['"]electron/,
    /from\s+['"]electron/,
    /app\.getPath/,
    /BrowserWindow/,
    /\bdialog\b/,
    /\bshell\b/,
  ];

  coreFiles.forEach((filePath) => {
    const relativePath = path.relative(CLIENT_DIR, filePath);
    const source = fs.readFileSync(filePath, 'utf-8');
    const hit = forbiddenPatterns.find((pattern) => pattern.test(source));
    assert(!hit, `${relativePath} 不包含静态 Electron/主进程运行时依赖`);
  });

  collectReachableCoreDeps(coreFiles, '依赖图扫描');
  collectReachableCoreDeps([workspaceRuntimeFactoryPath], 'Web runtime factory 依赖图扫描');
  runChildProcessCoreIsolationCheck([...coreFiles, workspaceRuntimeFactoryPath]);

  const fixtureDir = trackDir(fs.mkdtempSync(path.join(CLIENT_DIR, 'tmp-portable-core-fixture-')));

  const reachableFixturePath = path.join(fixtureDir, 'reachable-require-entry.cjs');
  const reachableFixtureDep = path.join(fixtureDir, 'reachable-require-dep.cjs');
  const computedFixturePath = path.join(fixtureDir, 'computed-require-entry.cjs');
  const computedFixtureDep = path.join(fixtureDir, 'computed-require-helper.cjs');

  fs.writeFileSync(reachableFixtureDep, 'module.exports = {};\n');
  fs.writeFileSync(reachableFixturePath, `// 注释里的 require('electron') 不应触发静态扫描\nconst ignore = "require('electron')";\nrequire('./reachable-require-dep.cjs');\nmodule.exports = ignore;\n`);
  fs.writeFileSync(computedFixtureDep, "module.exports = require(['elec', 'tron'].join(''));\n");
  fs.writeFileSync(computedFixturePath, "require('./computed-require-helper.cjs');\n");

  const reachableDeps = collectReachableCoreDeps([reachableFixturePath], '依赖图扫描');
  assert(
    reachableDeps.some((candidate) => path.basename(candidate) === path.basename(reachableFixtureDep)),
    '依赖图扫描: 递归 require 工作于合法字面量依赖',
  );

  let dynamicFailureMessage;
  try {
    collectReachableCoreDeps([computedFixturePath], '依赖图扫描');
  } catch (error) {
    dynamicFailureMessage = error && error.message ? error.message : String(error);
  }
  assert(
    Boolean(dynamicFailureMessage),
    "依赖图扫描: 计算型 require(['elec', 'tron'].join('')) 应被拒绝",
  );
  assert(
    dynamicFailureMessage.includes('非字面量 require'),
    '依赖图扫描: 计算型 require 失败原因应为非字面量',
  );
}

function assertLegacyStoreWrappersAreThin() {
  const wrappers = [
    ['technicalPlanStore.cjs', 'technicalPlanStore.cjs'],
    ['knowledgeBaseStore.cjs', 'knowledgeBaseStore.cjs'],
    ['duplicateCheckStore.cjs', 'duplicateCheckStore.cjs'],
    ['rejectionCheckStore.cjs', 'rejectionCheckStore.cjs'],
  ];

  for (const [wrapperName, coreName] of wrappers) {
    const wrapperPath = path.join(CLIENT_DIR, 'electron', 'services', wrapperName);
    const source = fs.readFileSync(wrapperPath, 'utf-8');
    const nonEmptyLines = source.split(/\r?\n/).filter((line) => line.trim()).length;
    assert(nonEmptyLines <= 12, `Store compatibility wrapper: ${wrapperName} 保持薄入口`);
    assert(
      source.includes(`../../core/stores/${coreName}`),
      `Store compatibility wrapper: ${wrapperName} 直连权威 core 实现`,
    );
    assert(source.includes('getWorkspaceDir'), `Store compatibility wrapper: ${wrapperName} 仅适配 legacy app 路径`);
    assert(!source.includes('db.prepare'), `Store compatibility wrapper: ${wrapperName} 不包含业务 SQL`);
    assert(!source.includes("require('node:fs')"), `Store compatibility wrapper: ${wrapperName} 不包含文件业务实现`);
  }
}

function runWorkspaceCleanupChecks(tmpDir) {
  const workspaceRoot = path.join(tmpDir, 'cleanup-workspace');
  const paths = coreWorkspacePaths.resolveWorkspacePaths(workspaceRoot);
  const importedScope = path.join(paths.importedImagesDir, 'technical-plan');
  const importedBatch = path.join(paths.importedImagesDir, 'technical-plan-1700000000000-deadbeef');
  const importedSibling = path.join(paths.importedImagesDir, 'other-scope');
  const exactBatch = path.join(paths.importedImagesDir, 'rejection-check-bid-1700000000000-deadbeef');
  const mermaidCache = path.join(paths.generatedImagesDir, 'mermaid-cache');
  const insideTarget = path.join(workspaceRoot, 'cleanup-target');
  const outsideTarget = path.join(tmpDir, 'cleanup-outside');

  for (const dir of [
    importedScope,
    importedBatch,
    importedSibling,
    exactBatch,
    mermaidCache,
    insideTarget,
    outsideTarget,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  coreWorkspaceCleanup.deleteImportedImageBatches(workspaceRoot, 'technical-plan');
  assert(!fs.existsSync(importedScope), 'workspace cleanup: 删除 workspace 内精确 imported image scope');
  assert(!fs.existsSync(importedBatch), 'workspace cleanup: 删除 workspace 内 imported image batch');
  assert(fs.existsSync(importedSibling), 'workspace cleanup: 保留不匹配 imported image scope');

  coreWorkspaceCleanup.deleteImportedImageBatchesForExactScope(workspaceRoot, 'rejection-check-bid');
  assert(!fs.existsSync(exactBatch), 'workspace cleanup: exact scope 仅删除匹配批次');

  coreWorkspaceCleanup.clearMermaidCache(workspaceRoot);
  assert(!fs.existsSync(mermaidCache), 'workspace cleanup: Mermaid cache 按 workspaceRoot 删除');

  assert(
    coreWorkspaceCleanup.removeWorkspaceDirectory(workspaceRoot, insideTarget) === true,
    'workspace cleanup: 允许删除 workspace 内目标',
  );
  assert(!fs.existsSync(insideTarget), 'workspace cleanup: workspace 内目标已删除');
  assert(
    coreWorkspaceCleanup.removeWorkspaceDirectory(workspaceRoot, outsideTarget) === false,
    'workspace cleanup: 拒绝删除 workspace 外目标',
  );
  assert(fs.existsSync(outsideTarget), 'workspace cleanup: workspace 外目标保持存在');
  assert(
    coreWorkspaceCleanup.removeWorkspaceDirectory(workspaceRoot, workspaceRoot) === false,
    'workspace cleanup: 禁止删除 workspaceRoot 本身',
  );

  const missingWorkspaceRoot = path.join(tmpDir, 'cleanup-missing-workspace');
  coreWorkspaceCleanup.clearMermaidCache(missingWorkspaceRoot);
  coreWorkspaceCleanup.deleteImportedImageBatches(missingWorkspaceRoot, 'technical-plan');
  coreWorkspaceCleanup.deleteImportedImageBatchesForExactScope(missingWorkspaceRoot, 'rejection-check-bid');
  assert(
    coreWorkspaceCleanup.removeWorkspaceDirectory(missingWorkspaceRoot, path.join(missingWorkspaceRoot, 'target')) === false,
    'workspace cleanup: 不存在的路径保持幂等 no-op',
  );
  assert(!fs.existsSync(missingWorkspaceRoot), 'workspace cleanup: no-op 不创建 workspace 目录');

  const symlinkProbeTarget = path.join(tmpDir, 'cleanup-symlink-probe-target');
  const symlinkProbeLink = path.join(tmpDir, 'cleanup-symlink-probe-link');
  fs.mkdirSync(symlinkProbeTarget, { recursive: true });
  try {
    fs.symlinkSync(symlinkProbeTarget, symlinkProbeLink, 'dir');
    fs.rmSync(symlinkProbeLink, { recursive: true, force: true });
  } catch (error) {
    if (['EACCES', 'EPERM', 'ENOSYS', 'ENOTSUP'].includes(error?.code)) {
      skip(`workspace cleanup symlink 边界用例：当前平台不支持目录 symlink (${error.code})`);
      return;
    }
    throw error;
  }

  const generatedWorkspaceRoot = path.join(tmpDir, 'cleanup-generated-symlink-workspace');
  const generatedPaths = coreWorkspacePaths.resolveWorkspacePaths(generatedWorkspaceRoot);
  const outsideGeneratedImages = path.join(tmpDir, 'cleanup-outside-generated-images');
  const outsideMermaidCache = path.join(outsideGeneratedImages, 'mermaid-cache');
  const outsideMermaidSentinel = path.join(outsideMermaidCache, 'sentinel.txt');
  fs.mkdirSync(generatedWorkspaceRoot, { recursive: true });
  fs.mkdirSync(outsideMermaidCache, { recursive: true });
  fs.writeFileSync(outsideMermaidSentinel, 'keep', 'utf-8');
  fs.symlinkSync(outsideGeneratedImages, generatedPaths.generatedImagesDir, 'dir');

  coreWorkspaceCleanup.clearMermaidCache(generatedWorkspaceRoot);
  assert(fs.lstatSync(generatedPaths.generatedImagesDir).isSymbolicLink(), 'workspace cleanup: generated-images 中间 symlink 保持存在');
  assert(fs.existsSync(outsideMermaidCache), 'workspace cleanup: generated-images symlink 外部 Mermaid 目录保留');
  assert(fs.readFileSync(outsideMermaidSentinel, 'utf-8') === 'keep', 'workspace cleanup: generated-images symlink 外部 sentinel 保留');

  const importedWorkspaceRoot = path.join(tmpDir, 'cleanup-imported-symlink-workspace');
  const importedPaths = coreWorkspacePaths.resolveWorkspacePaths(importedWorkspaceRoot);
  const outsideImportedImages = path.join(tmpDir, 'cleanup-outside-imported-images');
  const outsidePrefixBatch = path.join(outsideImportedImages, 'technical-plan-1700000000000-deadbeef');
  const outsideExactBatch = path.join(outsideImportedImages, 'rejection-check-bid-1700000000000-deadbeef');
  const outsideImportedSentinel = path.join(outsideImportedImages, 'sentinel.txt');
  fs.mkdirSync(importedWorkspaceRoot, { recursive: true });
  fs.mkdirSync(outsidePrefixBatch, { recursive: true });
  fs.mkdirSync(outsideExactBatch, { recursive: true });
  fs.writeFileSync(outsideImportedSentinel, 'keep', 'utf-8');
  fs.symlinkSync(outsideImportedImages, importedPaths.importedImagesDir, 'dir');

  coreWorkspaceCleanup.deleteImportedImageBatches(importedWorkspaceRoot, 'technical-plan');
  coreWorkspaceCleanup.deleteImportedImageBatchesForExactScope(importedWorkspaceRoot, 'rejection-check-bid');
  assert(fs.lstatSync(importedPaths.importedImagesDir).isSymbolicLink(), 'workspace cleanup: imported-images 中间 symlink 保持存在');
  assert(fs.existsSync(outsidePrefixBatch), 'workspace cleanup: imported-images symlink 外部前缀批次保留');
  assert(fs.existsSync(outsideExactBatch), 'workspace cleanup: imported-images symlink 外部 exact 批次保留');
  assert(fs.readFileSync(outsideImportedSentinel, 'utf-8') === 'keep', 'workspace cleanup: imported-images symlink 外部 sentinel 保留');

  const targetLinkWorkspaceRoot = path.join(tmpDir, 'cleanup-target-link-workspace');
  const outsideTargetDirectory = path.join(tmpDir, 'cleanup-target-link-outside');
  const outsideTargetSentinel = path.join(outsideTargetDirectory, 'sentinel.txt');
  const targetLink = path.join(targetLinkWorkspaceRoot, 'target-link');
  fs.mkdirSync(targetLinkWorkspaceRoot, { recursive: true });
  fs.mkdirSync(outsideTargetDirectory, { recursive: true });
  fs.writeFileSync(outsideTargetSentinel, 'keep', 'utf-8');
  fs.symlinkSync(outsideTargetDirectory, targetLink, 'dir');

  assert(
    coreWorkspaceCleanup.removeWorkspaceDirectory(targetLinkWorkspaceRoot, targetLink) === true,
    'workspace cleanup: 目标本身为 symlink 时允许删除链接',
  );
  assert(!fs.existsSync(targetLink), 'workspace cleanup: 目标 symlink 已删除');
  assert(fs.existsSync(outsideTargetDirectory), 'workspace cleanup: 目标 symlink 的外部目录保留');
  assert(fs.readFileSync(outsideTargetSentinel, 'utf-8') === 'keep', 'workspace cleanup: 目标 symlink 的外部 sentinel 保留');

  const canonicalWorkspaceRoot = path.join(tmpDir, 'cleanup-canonical-workspace');
  const linkedWorkspaceRoot = path.join(tmpDir, 'cleanup-linked-workspace');
  const linkedInsideTarget = path.join(linkedWorkspaceRoot, 'inside-target');
  fs.mkdirSync(path.join(canonicalWorkspaceRoot, 'inside-target'), { recursive: true });
  fs.symlinkSync(canonicalWorkspaceRoot, linkedWorkspaceRoot, 'dir');
  assert(
    coreWorkspaceCleanup.removeWorkspaceDirectory(linkedWorkspaceRoot, linkedInsideTarget) === true,
    'workspace cleanup: workspaceRoot 自身为 symlink 时使用 canonical root',
  );
  assert(!fs.existsSync(path.join(canonicalWorkspaceRoot, 'inside-target')), 'workspace cleanup: canonical workspace 内目标已删除');
}

function runPortableStoreChecks(tmpDir) {
  let coreStoreDatabase;
  try {
    const workspaceRoot = path.join(tmpDir, 'core-store-workspace');
    coreStoreDatabase = trackDb(coreSqlite.createSqliteDatabase({ workspaceRoot }));
    const technicalPlanStore = coreTechnicalPlanStore.createTechnicalPlanStore({
      db: coreStoreDatabase.db,
      workspaceRoot,
    });
    const knowledgeBaseStore = coreKnowledgeBaseStore.createKnowledgeBaseStore({
      db: coreStoreDatabase.db,
      workspaceRoot,
    });
    const duplicateCheckStore = coreDuplicateCheckStore.createDuplicateCheckStore({
      db: coreStoreDatabase.db,
      workspaceRoot,
    });
    const rejectionCheckStore = coreRejectionCheckStore.createRejectionCheckStore({
      db: coreStoreDatabase.db,
      workspaceRoot,
      technicalPlanStore,
    });

    assert(technicalPlanStore.loadTechnicalPlan().step === 'document-analysis', 'core Store smoke: technical plan load');
    assert(technicalPlanStore.updateStep('bid-analysis').step === 'bid-analysis', 'core Store smoke: technical plan 轻量更新');

    assert(Array.isArray(knowledgeBaseStore.list().folders), 'core Store smoke: knowledge base load');
    const folder = knowledgeBaseStore.createFolder('portable-folder');
    assert(knowledgeBaseStore.list().folders.some((item) => item.id === folder.id), 'core Store smoke: knowledge base 轻量更新');

    assert(duplicateCheckStore.loadDuplicateCheck().step === 'upload', 'core Store smoke: duplicate check load');
    const duplicateState = duplicateCheckStore.saveUiState({ step: 'analysis', activeAnalysisTab: 'metadata' });
    assert(duplicateState && typeof duplicateState === 'object', 'core Store smoke: duplicate check 轻量更新');

    assert(rejectionCheckStore.loadRejectionCheck().step === 'documents', 'core Store smoke: rejection check load');
    const rejectionState = rejectionCheckStore.saveUiState({ step: 'results', activeCheckResultTab: 'rejection' });
    assert(rejectionState && typeof rejectionState === 'object', 'core Store smoke: rejection check 轻量更新');
  } finally {
    const db = coreStoreDatabase?.db;
    closeTrackedDb(coreStoreDatabase);
    assert(!db || !db.open, 'core Store smoke: SQLite 已关闭');
  }

  let compatibilityDatabase;
  try {
    const userDataDir = path.join(tmpDir, 'legacy-store-userdata');
    const workspaceRoot = path.join(userDataDir, 'workspace');
    const fakeApp = {
      getPath(name) {
        return name === 'userData' ? userDataDir : '';
      },
    };
    compatibilityDatabase = trackDb(coreSqlite.createSqliteDatabase({ workspaceRoot }));

    const technicalCore = coreTechnicalPlanStore.createTechnicalPlanStore({
      db: compatibilityDatabase.db,
      workspaceRoot,
    });
    const technicalWrapper = electronTechnicalPlanStore.createTechnicalPlanStore({
      app: fakeApp,
      db: compatibilityDatabase.db,
    });
    const knowledgeCore = coreKnowledgeBaseStore.createKnowledgeBaseStore({
      db: compatibilityDatabase.db,
      workspaceRoot,
    });
    const knowledgeWrapper = electronKnowledgeBaseStore.createKnowledgeBaseStore({
      app: fakeApp,
      db: compatibilityDatabase.db,
    });
    const duplicateCore = coreDuplicateCheckStore.createDuplicateCheckStore({
      db: compatibilityDatabase.db,
      workspaceRoot,
    });
    const duplicateWrapper = electronDuplicateCheckStore.createDuplicateCheckStore({
      app: fakeApp,
      db: compatibilityDatabase.db,
    });
    const rejectionCore = coreRejectionCheckStore.createRejectionCheckStore({
      db: compatibilityDatabase.db,
      workspaceRoot,
      technicalPlanStore: technicalCore,
    });
    const rejectionWrapper = electronRejectionCheckStore.createRejectionCheckStore({
      app: fakeApp,
      db: compatibilityDatabase.db,
      technicalPlanStore: technicalWrapper,
    });

    technicalWrapper.updateStep('outline-generation');
    assert(technicalCore.loadTechnicalPlan().step === 'outline-generation', 'Store compatibility: technical wrapper 与 core 共用 schema');
    technicalWrapper.saveOriginalOutlineRuntime({ source: 'compat-wrapper' });
    assert(
      technicalCore.readOriginalOutlineRuntime()?.source === 'compat-wrapper',
      'Store compatibility: technical wrapper 与 core 共用 workspace 文件',
    );

    const compatFolder = knowledgeWrapper.createFolder('compat-folder');
    assert(knowledgeCore.list().folders.some((item) => item.id === compatFolder.id), 'Store compatibility: knowledge wrapper 与 core 交叉读取');

    duplicateWrapper.saveUiState({ step: 'analysis', activeAnalysisTab: 'content' });
    assert(duplicateCore.loadDuplicateCheck().activeAnalysisTab === 'content', 'Store compatibility: duplicate wrapper 与 core 交叉读取');

    rejectionWrapper.saveUiState({ step: 'results', activeCheckResultTab: 'typo' });
    assert(rejectionCore.loadRejectionCheck().activeCheckResultTab === 'typo', 'Store compatibility: rejection wrapper 与 core 交叉读取');

    const paths = coreWorkspacePaths.resolveWorkspacePaths(workspaceRoot);
    assert(fs.existsSync(paths.technicalPlanOriginalOutlineRuntimePath), 'legacy fake app: technical store 解析到 userData/workspace');
    assert(fs.existsSync(paths.knowledgeBaseDir), 'legacy fake app: knowledge store 解析到 userData/workspace');
    assert(fs.existsSync(paths.duplicateCheckDir), 'legacy fake app: duplicate store 解析到 userData/workspace');
    assert(fs.existsSync(paths.rejectionCheckDir), 'legacy fake app: rejection store 解析到 userData/workspace');
  } finally {
    const db = compatibilityDatabase?.db;
    closeTrackedDb(compatibilityDatabase);
    assert(!db || !db.open, 'Store compatibility: SQLite 已关闭');
  }
}

function withFreshModuleOverrides(modulePath, overrides, callback) {
  const resolvedModulePath = require.resolve(modulePath);
  const originalLoad = Module._load;
  const overrideByRequest = new Map();
  const overrideByResolved = new Map();

  for (const [key, value] of overrides.entries()) {
    overrideByRequest.set(key, value);
    try {
      const resolved = Module._resolveFilename(key, {
        id: resolvedModulePath,
        filename: resolvedModulePath,
        paths: Module._nodeModulePaths(path.dirname(resolvedModulePath)),
      });
      if (resolved && typeof resolved === 'string') {
        overrideByResolved.set(path.resolve(resolved), value);
      }
    } catch {
      // keep request-only mapping
    }
  }
  let freshModule;

  delete require.cache[resolvedModulePath];
  try {
    Module._load = function loadWithOverrides(request, parent, isMain) {
      if (overrideByRequest.has(request)) {
        return overrideByRequest.get(request);
      }
      const resolvedRequest = Module._resolveFilename(request, parent, isMain);
      const normalizedResolvedRequest = path.resolve(resolvedRequest);
      if (overrideByResolved.has(resolvedRequest) || overrideByResolved.has(normalizedResolvedRequest)) {
        return overrideByResolved.get(overrideByResolved.has(resolvedRequest) ? resolvedRequest : normalizedResolvedRequest);
      }
      return originalLoad.apply(this, arguments);
    };
    freshModule = require(resolvedModulePath);
    try {
      return callback(freshModule);
    } finally {
      Module._load = originalLoad;
      delete require.cache[resolvedModulePath];
    }
  } finally {
    Module._load = originalLoad;
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
      createWebTaskServiceStub() {
        throw expectedError;
      },
      createWebAgentServiceStub() {
        return {
          ...webServices.createWebAgentServiceStub(),
          close() {
            agentClosed = true;
          },
        };
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
    const pragmaError = withFreshModuleOverrides(
      '../core/sqliteDatabase.cjs',
      new Map([
        ['better-sqlite3', FailingDatabase],
      ]),
      ({ createSqliteDatabase }) => expectThrow(
        () => createSqliteDatabase({
          databasePath: path.join(tmpDir, 'failing-sqlite', 'yibiao.sqlite'),
          onStatus: () => {},
        }),
        'SQLite 初始化失败: pragma 异常向上抛出',
      ),
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

    // 4. Portable Store、兼容 wrapper 与工作区清理边界
    assertLegacyStoreWrappersAreThin();
    runWorkspaceCleanupChecks(tmpDir);
    runPortableStoreChecks(tmpDir);

    // 5. 配置归一化
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

    // 6. Web workspace 路径与装配失败回滚
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

    // 7. runtime ID 单源一致性
    runRuntimeIdConsistencyChecks();

    // 8. 打包断言
    runPackagingAssertions();

    // 9. 递归静态依赖与实际模块加载隔离
    assertCoreHasNoElectronDependencies();
  } finally {
    closeAllDatabases();
    removeTmpDirs();
  }

  console.log(`\n=== Portable Core 测试结果 ===`);
  console.log(`通过: ${passed.length}`);
  console.log(`失败: ${failed.length}`);
  console.log(`跳过: ${skipped.length}`);
  skipped.forEach((message) => {
    console.log(`  - ${message}`);
  });

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
  console.log(`跳过: ${skipped.length}`);
  skipped.forEach((message) => {
    console.log(`  - ${message}`);
  });
  failed.forEach((message) => {
    console.log(`  - ${message}`);
  });
  process.exit(1);
}
