// 资产路由：GET /api/assets/generated-images/*
// 将 yibiao-asset://generated-images/<rel> 映射到当前账号 workspace 的 generated-images 目录，
// 只服务当前登录账号自己的资产，做严格路径边界校验。
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const { getWorkspaceContext } = require('../workspace/workspaceRegistry.cjs');

const router = express.Router();

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// /api/assets/generated-images/<相对路径> — 仅读取当前账号 workspace 内批准的图片资产。
router.get(/^\/assets\/generated-images\/(.+)$/, (req, res) => {
  let ctx;
  try {
    ctx = getWorkspaceContext(req.workspaceId);
  } catch (error) {
    if (error?.code === 'WORKSPACE_UNAVAILABLE') {
      return res.status(503).type('text').send('工作区暂时不可用');
    }
    return res.status(500).type('text').send('工作区初始化失败');
  }

  const generatedImagesDir = ctx?.paths?.generatedImagesDir;
  if (!generatedImagesDir) {
    return res.status(404).type('text').send('资产目录不可用');
  }

  // 畸形 URL 编码统一按无效路径处理，避免 URIError 冒泡为 500。
  let relative;
  try {
    relative = decodeURIComponent(req.params[0] || '').replace(/\\/g, '/');
  } catch {
    return res.status(400).type('text').send('资产路径无效');
  }
  if (!relative || relative.includes('..') || relative.includes('\0') || path.isAbsolute(relative)) {
    return res.status(400).type('text').send('资产路径无效');
  }

  const baseDir = path.resolve(generatedImagesDir);
  const resolvedPath = path.resolve(baseDir, relative);
  if (resolvedPath !== baseDir && !resolvedPath.startsWith(`${baseDir}${path.sep}`)) {
    return res.status(400).type('text').send('资产路径越界');
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  const mimeType = MIME_BY_EXT[ext];
  if (!mimeType || !fs.existsSync(resolvedPath)) {
    return res.status(404).type('text').send('资产不存在');
  }

  res.type(mimeType);
  res.setHeader('Cache-Control', 'private, max-age=300');
  fs.createReadStream(resolvedPath).on('error', () => {
    if (!res.headersSent) res.status(500).end();
  }).pipe(res);
});

module.exports = router;
