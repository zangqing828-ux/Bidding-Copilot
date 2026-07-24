// 下载路由：一次性下载 ID，映射到 workspace 内文件，不接受任意路径参数。
const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { getWorkspaceContext } = require('../workspace/workspaceRegistry.cjs');

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

// POST /api/downloads — 创建下载令牌（服务端内部或 bridge dispatcher 调用）。
router.post('/downloads', (req, res) => {
  const { filePath, fileName } = req.body || {};
  if (!filePath) {
    return res.status(400).json({ code: 'DOWNLOAD_ERROR', message: '缺少文件路径' });
  }

  const ctx = getWorkspaceContext(req.workspaceId);
  // 安全校验：文件必须在 workspace 内，用 path.relative 避免 startsWith 前缀混淆。
  const resolved = path.resolve(filePath);
  const workspaceRoot = path.resolve(ctx.workspaceRoot);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return res.status(403).json({ code: 'DOWNLOAD_ERROR', message: '文件路径越界' });
  }

  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ code: 'DOWNLOAD_ERROR', message: '文件不存在' });
  }

  const id = createDownloadToken(req.workspaceId, resolved, fileName || path.basename(resolved));
  res.json({ downloadId: id });
});

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
