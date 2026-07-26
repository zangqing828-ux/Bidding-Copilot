// 下载路由：一次性下载 ID，映射到 workspace 内文件，不接受任意路径参数。
const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');

const router = express.Router();

// 下载 ID 存储：{ id → { workspaceId, filePath, fileName, createdAt } }
// 5 分钟过期。生产可换 Redis。
const downloadTokens = new Map();
const TOKEN_TTL_MS = 5 * 60 * 1000;

function createDownloadToken(workspaceId, filePath, fileName) {
  const id = crypto.randomUUID();
  const entry = { workspaceId, filePath, fileName, createdAt: Date.now() };
  downloadTokens.set(id, entry);
  setTimeout(() => downloadTokens.delete(id), TOKEN_TTL_MS);
  return id;
}

function consumeDownloadToken(id, workspaceId) {
  const entry = downloadTokens.get(id);
  if (!entry) return null;
  if (entry.workspaceId !== workspaceId) return null;
  if (Date.now() - entry.createdAt > TOKEN_TTL_MS) {
    downloadTokens.delete(id);
    return null;
  }
  downloadTokens.delete(id);
  return entry;
}

// GET /api/downloads/:id — 通过令牌下载文件。
router.get('/downloads/:id', (req, res) => {
  const { id } = req.params;
  const entry = consumeDownloadToken(id, req.workspaceId);
  if (!entry) {
    return res.status(404).type('text').send('下载链接无效或已过期');
  }

  if (!fs.existsSync(entry.filePath)) {
    return res.status(404).type('text').send('文件不存在');
  }

  res.download(entry.filePath, entry.fileName);
});

module.exports = router;
module.exports.createDownloadToken = createDownloadToken;
