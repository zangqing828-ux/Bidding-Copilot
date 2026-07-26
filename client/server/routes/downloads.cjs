// 下载路由：一次性下载 ID，映射到 workspace 内文件，不接受任意路径参数。
const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');

const router = express.Router();

// 下载 ID 存储：{ id → { workspaceId, filePath, fileName, createdAt } }
// 5 分钟过期。生产可换 Redis。
const downloadTokens = new Map();
const TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_WORKSPACE_DOWNLOADS = 10;

function removeFile(filePath) {
  if (!filePath) return;
  fs.rm(filePath, { force: true }, () => {});
}

function createDownloadToken(workspaceId, filePath, fileName) {
  const workspaceEntries = [...downloadTokens.entries()]
    .filter(([, entry]) => entry.workspaceId === workspaceId)
    .sort((left, right) => left[1].createdAt - right[1].createdAt);
  while (workspaceEntries.length >= MAX_WORKSPACE_DOWNLOADS) {
    const [expiredId, expiredEntry] = workspaceEntries.shift();
    downloadTokens.delete(expiredId);
    removeFile(expiredEntry.filePath);
  }
  const id = crypto.randomUUID();
  const entry = { workspaceId, filePath, fileName, createdAt: Date.now() };
  downloadTokens.set(id, entry);
  const timer = setTimeout(() => {
    const expired = downloadTokens.get(id);
    if (!expired) return;
    downloadTokens.delete(id);
    removeFile(expired.filePath);
  }, TOKEN_TTL_MS);
  timer.unref?.();
  return id;
}

function consumeDownloadToken(id, workspaceId) {
  const entry = downloadTokens.get(id);
  if (!entry) return null;
  if (entry.workspaceId !== workspaceId) return null;
  if (Date.now() - entry.createdAt > TOKEN_TTL_MS) {
    downloadTokens.delete(id);
    removeFile(entry.filePath);
    return null;
  }
  downloadTokens.delete(id);
  return entry;
}

function revokeWorkspaceDownloads(workspaceId) {
  for (const [id, entry] of downloadTokens.entries()) {
    if (entry.workspaceId !== workspaceId) continue;
    downloadTokens.delete(id);
    removeFile(entry.filePath);
  }
}

// GET /api/downloads/:id — 通过令牌下载文件。
router.get('/downloads/:id', (req, res, next) => {
  const { id } = req.params;
  const entry = consumeDownloadToken(id, req.workspaceId);
  if (!entry) {
    return res.status(404).type('text').send('下载链接无效或已过期');
  }

  if (!fs.existsSync(entry.filePath)) {
    return res.status(404).type('text').send('文件不存在');
  }

  res.download(entry.filePath, entry.fileName, (error) => {
    removeFile(entry.filePath);
    if (error) next(error);
  });
});

module.exports = router;
module.exports.createDownloadToken = createDownloadToken;
module.exports.revokeWorkspaceDownloads = revokeWorkspaceDownloads;
