// Workspace 路径解析：纯函数，Electron 和 Web 共用。
// 不依赖 Electron app 对象，只接收 workspaceRoot 参数。
const path = require('node:path');

function resolveWorkspacePaths(workspaceRoot) {
  const technicalPlanDir = path.join(workspaceRoot, 'technical-plan');
  const generatedImagesDir = path.join(workspaceRoot, 'generated-images');
  const duplicateCheckDir = path.join(workspaceRoot, 'duplicate-check');
  const rejectionCheckDir = path.join(workspaceRoot, 'rejection-check');
  const importedImagesDir = path.join(workspaceRoot, 'imported-images');
  const knowledgeBaseDir = path.join(workspaceRoot, 'knowledge-base');
  const uploadsDir = path.join(workspaceRoot, 'uploads');
  const exportsDir = path.join(workspaceRoot, 'exports');

  return {
    workspaceRoot,
    databasePath: path.join(workspaceRoot, 'yibiao.sqlite'),
    technicalPlanDir,
    technicalPlanTenderMarkdownPath: path.join(technicalPlanDir, 'tender.md'),
    technicalPlanTenderOriginalMarkdownPath: path.join(technicalPlanDir, 'tender-original.md'),
    technicalPlanOriginalPlanMarkdownPath: path.join(technicalPlanDir, 'original-plan.md'),
    technicalPlanIllustrationsDir: path.join(technicalPlanDir, 'illustrations'),
    technicalPlanTenderSourceFilesDir: path.join(technicalPlanDir, 'tender-files'),
    technicalPlanOriginalOutlineRuntimePath: path.join(technicalPlanDir, 'original-outline-runtime.json'),
    technicalPlanGeneratedIllustrationsDir: path.join(generatedImagesDir, 'technical-plan', 'illustrations'),
    duplicateCheckDir,
    duplicateCheckContentDir: path.join(duplicateCheckDir, 'contents'),
    rejectionCheckDir,
    rejectionCheckBidsDir: path.join(rejectionCheckDir, 'bids'),
    rejectionCheckTendersDir: path.join(rejectionCheckDir, 'tenders'),
    rejectionCheckTenderMarkdownPath: path.join(rejectionCheckDir, 'tender.md'),
    generatedImagesDir,
    importedImagesDir,
    knowledgeBaseDir,
    uploadsDir,
    exportsDir,
  };
}

function getRejectionCheckDocumentMarkdownPath(paths, role, documentId) {
  if (role === 'bid') {
    const safeDocumentId = String(documentId || 'bid').replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(paths.rejectionCheckBidsDir, `${safeDocumentId}.md`);
  }
  const tenderDocumentId = String(documentId || '').trim();
  if (tenderDocumentId && tenderDocumentId !== 'tender') {
    const safeDocumentId = tenderDocumentId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(paths.rejectionCheckTendersDir, `${safeDocumentId}.md`);
  }
  return paths.rejectionCheckTenderMarkdownPath;
}

module.exports = { resolveWorkspacePaths, getRejectionCheckDocumentMarkdownPath };
