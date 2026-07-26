// 上传路由：multipart upload，文件落盘到 workspace uploads 目录。
// 文件名只用于展示，服务端用生成 ID 落盘。
const express = require('express');
const multer = require('multer');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
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
      file.uploadFileId = id;
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

function startsWith(buffer, signature) {
  return buffer.subarray(0, signature.length).equals(Buffer.from(signature));
}

function normalizeOriginalName(value) {
  const source = String(value || '');
  if (!/[\u0080-\u00ff]/.test(source)) return source;
  const decoded = Buffer.from(source, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? source : decoded;
}

function isTextContent(buffer) {
  if (!buffer.length) return true;
  let controlCount = 0;
  for (const byte of buffer) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) controlCount += 1;
  }
  return controlCount / buffer.length < 0.02;
}

async function validateUploadedFile(file) {
  const extension = path.extname(file.originalname || '').toLowerCase();
  const probe = await fs.readFile(file.path).then((buffer) => buffer.subarray(0, 8192));
  const isZip = startsWith(probe, [0x50, 0x4b, 0x03, 0x04]) || startsWith(probe, [0x50, 0x4b, 0x05, 0x06]);
  const isCompoundDocument = startsWith(probe, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const valid = extension === '.pdf'
    ? startsWith(probe, '%PDF-')
    : extension === '.docx' || extension === '.xlsx'
      ? isZip
      : extension === '.doc'
        ? isCompoundDocument
        : extension === '.txt' || extension === '.md'
          ? isTextContent(probe)
          : false;
  if (!valid) {
    const error = new Error('文件内容与扩展名不匹配');
    error.code = 'UPLOAD_FILE_CONTENT_INVALID';
    throw error;
  }
}

async function removeUploadedFiles(files) {
  await Promise.all((files || []).map((file) => fs.rm(file?.path || '', { force: true }).catch(() => undefined)));
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
    : error?.code === 'UPLOAD_FILE_CONTENT_INVALID'
      ? '文件内容与扩展名不匹配'
    : error?.message || '上传失败';
  return res.status(400).json({ code: error?.code || 'UPLOAD_ERROR', message });
}

async function registerUploadedFiles(req, files) {
  const ctx = getWorkspaceContext(req.workspaceId);
  try {
    for (const file of files) {
      await validateUploadedFile(file);
    }
    return ctx.uploadRegistry.registerMany(files.map((file) => ({
        fileId: file.uploadFileId,
        storedName: file.filename,
        originalName: normalizeOriginalName(file.originalname),
        mimeType: file.mimetype,
        size: file.size,
      })));
  } catch (error) {
    await removeUploadedFiles(files);
    throw error;
  }
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
}, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ code: 'UPLOAD_ERROR', message: '未收到文件' });
  }

  try {
    const [registered] = await registerUploadedFiles(req, [req.file]);
    res.json({ ...registered.record, deduplicated: registered.deduplicated });
  } catch (error) {
    sendUploadError(res, error);
  }
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
}, async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ code: 'UPLOAD_ERROR', message: '未收到文件' });
  }

  try {
    const registered = await registerUploadedFiles(req, req.files);
    res.json({ files: registered.map((item) => ({ ...item.record, deduplicated: item.deduplicated })) });
  } catch (error) {
    sendUploadError(res, error);
  }
});

module.exports = router;
