// 上传限制中间件：检查文件扩展名和 MIME 类型。
const path = require('node:path');

const ALLOWED_EXTENSIONS = new Set(['.docx', '.doc', '.pdf', '.txt', '.md', '.xlsx']);
const MAX_FILE_COUNT = 10;

function checkFileExtension(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

function fileFilter(req, file, cb) {
  if (checkFileExtension(file.originalname)) {
    cb(null, true);
  } else {
    cb(new Error(`不支持的文件类型：${path.extname(file.originalname) || '未知'}`));
  }
}

module.exports = { fileFilter, ALLOWED_EXTENSIONS, MAX_FILE_COUNT };
