const fs = require('node:fs');
const path = require('node:path');
const { resolveWorkspacePaths } = require('./workspacePaths.cjs');

const MERMAID_CACHE_DIR_NAME = 'mermaid-cache';

function resolveWorkspaceRoot(workspaceRoot) {
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    throw new Error('workspaceRoot 必须为非空字符串');
  }
  return path.resolve(workspaceRoot);
}

function isPathInsideDirectory(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function removeWorkspaceDirectory(workspaceRoot, targetPath) {
  const resolvedWorkspaceRoot = resolveWorkspaceRoot(workspaceRoot);
  if (!targetPath || typeof targetPath !== 'string') {
    return false;
  }
  const resolvedTargetPath = path.resolve(targetPath);
  if (
    resolvedTargetPath === resolvedWorkspaceRoot
    || !isPathInsideDirectory(resolvedWorkspaceRoot, resolvedTargetPath)
  ) {
    return false;
  }

  fs.rmSync(resolvedTargetPath, { recursive: true, force: true });
  return true;
}

function normalizeImportedImageScope(scope) {
  return String(scope || '').trim().replace(/[^A-Za-z0-9._-]+/g, '_');
}

function deleteImportedImageBatches(workspaceRoot, scopePrefix) {
  const prefix = String(scopePrefix || '').trim();
  if (!prefix) return;

  const paths = resolveWorkspacePaths(resolveWorkspaceRoot(workspaceRoot));
  const baseDir = path.resolve(paths.importedImagesDir);
  if (!fs.existsSync(baseDir)) return;

  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name !== prefix && !entry.name.startsWith(`${prefix}-`)) continue;
    removeWorkspaceDirectory(workspaceRoot, path.join(baseDir, entry.name));
  }
}

function deleteImportedImageBatchesForExactScope(workspaceRoot, scope) {
  const safeScope = normalizeImportedImageScope(scope);
  if (!safeScope) return;

  const paths = resolveWorkspacePaths(resolveWorkspaceRoot(workspaceRoot));
  const baseDir = path.resolve(paths.importedImagesDir);
  if (!fs.existsSync(baseDir)) return;

  const exactBatchPattern = new RegExp(`^${safeScope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{10,}-[0-9a-f]{8}$`, 'i');
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!exactBatchPattern.test(entry.name)) continue;
    removeWorkspaceDirectory(workspaceRoot, path.join(baseDir, entry.name));
  }
}

function clearMermaidCache(workspaceRoot) {
  const paths = resolveWorkspacePaths(resolveWorkspaceRoot(workspaceRoot));
  removeWorkspaceDirectory(
    workspaceRoot,
    path.join(paths.generatedImagesDir, MERMAID_CACHE_DIR_NAME),
  );
}

module.exports = {
  clearMermaidCache,
  deleteImportedImageBatches,
  deleteImportedImageBatchesForExactScope,
  removeWorkspaceDirectory,
};
