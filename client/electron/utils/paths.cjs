const path = require('node:path');
const { resolveWorkspacePaths, getRejectionCheckDocumentMarkdownPath: getRejectionCheckDocumentMarkdownPathFromPaths } = require('../../shared/workspacePaths.cjs');

function getUserDataPath(app) {
  return app.getPath('userData');
}

function getConfigFilePath(app) {
  return path.join(getUserDataPath(app), 'user_config.json');
}

function getLicenseFilePath(app) {
  return path.join(getUserDataPath(app), 'license.json');
}

function getGpuStartupProbePath(app) {
  return path.join(getUserDataPath(app), 'gpu_startup_probe.json');
}

function getWorkspaceDir(app) {
  return path.join(getUserDataPath(app), 'workspace');
}

// 缓存 workspace paths，避免每次调用都重新计算。
let cachedWorkspacePaths = null;
let cachedWorkspaceRoot = null;

function getWorkspacePaths(app) {
  const workspaceRoot = getWorkspaceDir(app);
  if (cachedWorkspaceRoot !== workspaceRoot) {
    cachedWorkspaceRoot = workspaceRoot;
    cachedWorkspacePaths = resolveWorkspacePaths(workspaceRoot);
  }
  return cachedWorkspacePaths;
}

function getWorkspaceDatabasePath(app) {
  return getWorkspacePaths(app).databasePath;
}

function getTechnicalPlanDir(app) {
  return getWorkspacePaths(app).technicalPlanDir;
}

function getTechnicalPlanTenderMarkdownPath(app) {
  return getWorkspacePaths(app).technicalPlanTenderMarkdownPath;
}

function getTechnicalPlanOriginalPlanMarkdownPath(app) {
  return getWorkspacePaths(app).technicalPlanOriginalPlanMarkdownPath;
}

function getTechnicalPlanIllustrationsDir(app) {
  return getWorkspacePaths(app).technicalPlanIllustrationsDir;
}

function getTechnicalPlanGeneratedIllustrationsDir(app) {
  return getWorkspacePaths(app).technicalPlanGeneratedIllustrationsDir;
}

function getDuplicateCheckDir(app) {
  return getWorkspacePaths(app).duplicateCheckDir;
}

function getDuplicateCheckContentDir(app) {
  return getWorkspacePaths(app).duplicateCheckContentDir;
}

function getRejectionCheckDir(app) {
  return getWorkspacePaths(app).rejectionCheckDir;
}

function getRejectionCheckDocumentMarkdownPath(app, role, documentId) {
  return getRejectionCheckDocumentMarkdownPathFromPaths(getWorkspacePaths(app), role, documentId);
}

function getGeneratedImagesDir(app) {
  return getWorkspacePaths(app).generatedImagesDir;
}

function getImportedImagesDir(app) {
  return getWorkspacePaths(app).importedImagesDir;
}

function getKnowledgeBaseDir(app) {
  return getWorkspacePaths(app).knowledgeBaseDir;
}

function getAiLogsDir(app) {
  return path.join(getUserDataPath(app), 'logs', 'ai');
}

function getDeveloperLogsDir(app, moduleName) {
  return path.join(getUserDataPath(app), 'logs', String(moduleName || 'app'));
}

function getTechnicalPlanLogsDir(app) {
  return getDeveloperLogsDir(app, 'technical-plan');
}

function getAgentRuntimeDir(app) {
  return path.join(getUserDataPath(app), 'agent-runtime');
}

function getAgentCacheDir(app) {
  return path.join(getUserDataPath(app), 'agent-cache');
}

function getPlatformArchKey() {
  return `${process.platform}-${process.arch}`;
}

function getBundledOpencodeBinaryPath(app) {
  if (process.env.YIBIAO_OPENCODE_BIN) {
    return process.env.YIBIAO_OPENCODE_BIN;
  }

  const binaryName = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  const platformArch = getPlatformArchKey();

  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'opencode', platformArch, binaryName);
  }

  return path.join(__dirname, '..', '..', 'vendor', 'opencode', platformArch, binaryName);
}

function getBundledAgentToolsBinDir(app) {
  if (process.env.YIBIAO_OPENCODE_TOOLS_BIN_DIR) {
    return process.env.YIBIAO_OPENCODE_TOOLS_BIN_DIR;
  }

  const platformArch = getPlatformArchKey();
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'opencode-tools', platformArch, 'bin');
  }

  return path.join(__dirname, '..', '..', 'vendor', 'opencode-tools', platformArch, 'bin');
}

module.exports = {
  getAgentCacheDir,
  getAgentRuntimeDir,
  getAiLogsDir,
  getBundledOpencodeBinaryPath,
  getBundledAgentToolsBinDir,
  getDeveloperLogsDir,
  getDuplicateCheckContentDir,
  getDuplicateCheckDir,
  getConfigFilePath,
  getGpuStartupProbePath,
  getGeneratedImagesDir,
  getImportedImagesDir,
  getKnowledgeBaseDir,
  getLicenseFilePath,
  getRejectionCheckDir,
  getRejectionCheckDocumentMarkdownPath,
  getTechnicalPlanDir,
  getTechnicalPlanGeneratedIllustrationsDir,
  getTechnicalPlanIllustrationsDir,
  getTechnicalPlanLogsDir,
  getTechnicalPlanOriginalPlanMarkdownPath,
  getTechnicalPlanTenderMarkdownPath,
  getWorkspaceDir,
  getWorkspaceDatabasePath,
  getWorkspacePaths,
  getUserDataPath,
};
