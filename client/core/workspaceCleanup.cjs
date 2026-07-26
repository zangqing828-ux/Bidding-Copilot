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

function lstatIfExists(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function inspectWorkspacePath(workspaceRoot, targetPath, { allowTargetSymlink = false } = {}) {
  const resolvedWorkspaceRoot = resolveWorkspaceRoot(workspaceRoot);
  if (!targetPath || typeof targetPath !== 'string') {
    return null;
  }

  const resolvedTargetPath = path.resolve(targetPath);
  if (
    resolvedTargetPath === resolvedWorkspaceRoot
    || !isPathInsideDirectory(resolvedWorkspaceRoot, resolvedTargetPath)
  ) {
    return null;
  }

  const workspaceRootStats = lstatIfExists(resolvedWorkspaceRoot);
  if (!workspaceRootStats) {
    return null;
  }

  let canonicalWorkspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync(resolvedWorkspaceRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  if (!fs.statSync(canonicalWorkspaceRoot).isDirectory()) {
    return null;
  }

  const relativeParts = path.relative(resolvedWorkspaceRoot, resolvedTargetPath)
    .split(path.sep)
    .filter(Boolean);
  let currentPath = resolvedWorkspaceRoot;
  let targetStats = null;

  for (let index = 0; index < relativeParts.length; index += 1) {
    currentPath = path.join(currentPath, relativeParts[index]);
    const currentStats = lstatIfExists(currentPath);
    if (!currentStats) {
      return null;
    }

    const isTarget = index === relativeParts.length - 1;
    if (currentStats.isSymbolicLink()) {
      if (!isTarget || !allowTargetSymlink) {
        return null;
      }
    } else if (!isTarget && !currentStats.isDirectory()) {
      return null;
    }

    if (isTarget) {
      targetStats = currentStats;
    }
  }

  let canonicalParentPath;
  try {
    canonicalParentPath = fs.realpathSync(path.dirname(resolvedTargetPath));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  if (!isPathInsideDirectory(canonicalWorkspaceRoot, canonicalParentPath)) {
    return null;
  }

  return {
    resolvedTargetPath,
    targetStats,
  };
}

function removeWorkspaceDirectory(workspaceRoot, targetPath) {
  const inspected = inspectWorkspacePath(workspaceRoot, targetPath, {
    allowTargetSymlink: true,
  });
  if (!inspected) {
    return false;
  }

  fs.rmSync(inspected.resolvedTargetPath, { recursive: true, force: true });
  return true;
}

function resolveReadableWorkspaceDirectory(workspaceRoot, targetPath) {
  const inspected = inspectWorkspacePath(workspaceRoot, targetPath);
  if (!inspected?.targetStats?.isDirectory()) {
    return null;
  }
  return inspected.resolvedTargetPath;
}

function normalizeImportedImageScope(scope) {
  return String(scope || '').trim().replace(/[^A-Za-z0-9._-]+/g, '_');
}

function deleteImportedImageBatches(workspaceRoot, scopePrefix) {
  const prefix = String(scopePrefix || '').trim();
  if (!prefix) return;

  const paths = resolveWorkspacePaths(resolveWorkspaceRoot(workspaceRoot));
  const baseDir = resolveReadableWorkspaceDirectory(workspaceRoot, paths.importedImagesDir);
  if (!baseDir) return;

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
  const baseDir = resolveReadableWorkspaceDirectory(workspaceRoot, paths.importedImagesDir);
  if (!baseDir) return;

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
