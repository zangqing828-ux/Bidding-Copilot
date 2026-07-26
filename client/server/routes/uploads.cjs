// 上传路由：multipart upload，文件落盘到 workspace uploads 目录。
// 文件名只用于展示，服务端用生成 ID 落盘。
const express = require('express');
const multer = require('multer');
const crypto = require('node:crypto');
const path = require('node:path');
const config = require('../config.cjs');
const { getWorkspaceContext } = require('../workspace/workspaceRegistry.cjs');
const { fileFilter, MAX_FILE_COUNT } = require('../middleware/uploadLimits.cjs');

const router = express.Router();

function createUploadMiddleware() {
  const storage = multer.diskStorage({
    destination: (req, _file, cb) => {
      try {
        const ctx = getWorkspaceContext(req.workspaceId);
        cb(null, ctx.paths.uploadsDir);
      } catch (error) {
        cb(error);
      }
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const id = crypto.randomUUID();
      cb(null, `${id}${ext}`);
    },
  });

  return multer({
    storage,
    fileFilter,
    limits: {
      fileSize: config.uploadMaxSize * 1024 * 1024,
      files: MAX_FILE_COUNT,
    },
  });
}

function sendUploadError(res, error) {
  if (error?.code === 'WORKSPACE_UNAVAILABLE') {
    return res.status(503).json({
      code: 'WORKSPACE_UNAVAILABLE',
      message: '工作区暂时不可用，请稍后重试',
      retryable: true,
    });
  }

  const message = error?.code === 'LIMIT_FILE_SIZE'
    ? `文件大小超过限制（${config.uploadMaxSize}MB）`
    : error?.message || '上传失败';
  return res.status(400).json({ code: 'UPLOAD_ERROR', message });
}

// POST /api/uploads — 单文件上传，返回 fileId 和 fileName。
router.post('/uploads', (req, res, next) => {
  const upload = createUploadMiddleware();
  upload.single('file')(req, res, (err) => {
    if (err) {
      return sendUploadError(res, err);
    }
    next();
  });
}, (req, res) => {
  if (!req.file) {
    return res.status(400).json({ code: 'UPLOAD_ERROR', message: '未收到文件' });
  }

  res.json({
    fileId: req.file.filename,
    fileName: req.file.originalname,
    size: req.file.size,
  });
});

// POST /api/uploads/multiple — 多文件上传。
router.post('/uploads/multiple', (req, res, next) => {
  const upload = createUploadMiddleware();
  upload.array('files', MAX_FILE_COUNT)(req, res, (err) => {
    if (err) {
      return sendUploadError(res, err);
    }
    next();
  });
}, (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ code: 'UPLOAD_ERROR', message: '未收到文件' });
  }

  res.json({
    files: req.files.map((f) => ({
      fileId: f.filename,
      fileName: f.originalname,
      size: f.size,
    })),
  });
});

module.exports = router;
