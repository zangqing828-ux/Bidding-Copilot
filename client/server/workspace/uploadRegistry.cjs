// 账号内上传注册表。浏览器只持有 file ID，真实路径只在服务端解析。
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isWithin(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function createUploadError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}

function assertStoredPath(uploadsDir, storedName) {
  const rootPath = path.resolve(uploadsDir);
  const targetPath = path.resolve(rootPath, String(storedName || ''));
  if (!storedName || path.basename(storedName) !== storedName || !isWithin(rootPath, targetPath)) {
    throw createUploadError('UPLOAD_FILE_INVALID', '上传文件记录无效');
  }
  if (!fs.existsSync(targetPath)) throw createUploadError('UPLOAD_FILE_NOT_FOUND', '上传文件不存在或已清理');
  const canonicalRoot = fs.realpathSync.native(rootPath);
  const canonicalTarget = fs.realpathSync.native(targetPath);
  if (!isWithin(canonicalRoot, canonicalTarget)) throw createUploadError('UPLOAD_FILE_INVALID', '上传文件路径无效');
  const stat = fs.statSync(canonicalTarget);
  if (!stat.isFile()) throw createUploadError('UPLOAD_FILE_INVALID', '上传内容无效');
  return canonicalTarget;
}

function createUploadRegistry({ db, uploadsDir }) {
  if (!db || typeof db.prepare !== 'function') throw new Error('uploadRegistry 缺少数据库');
  if (!uploadsDir || typeof uploadsDir !== 'string') throw new Error('uploadRegistry 缺少 uploadsDir');

  fs.mkdirSync(uploadsDir, { recursive: true });
  const findByHash = db.prepare('SELECT * FROM upload_registry WHERE sha256 = ? AND size = ? AND status = \'ready\' ORDER BY created_at ASC LIMIT 1');
  const findById = db.prepare('SELECT * FROM upload_registry WHERE file_id = ? AND status = \'ready\'');
  const insert = db.prepare(`
    INSERT INTO upload_registry (file_id, stored_name, original_name, extension, mime_type, size, sha256, status, created_at, updated_at)
    VALUES (@file_id, @stored_name, @original_name, @extension, @mime_type, @size, @sha256, 'ready', @created_at, @updated_at)
  `);
  const touch = db.prepare('UPDATE upload_registry SET claimed_at = ?, claim_count = claim_count + 1, updated_at = ? WHERE file_id = ?');

  function toPublicRecord(row) {
    return {
      fileId: row.file_id,
      fileName: row.original_name,
      extension: row.extension,
      size: Number(row.size || 0),
      uploadedAt: row.created_at,
    };
  }

  function register({ fileId, storedName, originalName, mimeType, size }) {
    if (!FILE_ID_PATTERN.test(String(fileId || ''))) throw createUploadError('UPLOAD_FILE_INVALID', '上传文件标识无效');
    const filePath = assertStoredPath(uploadsDir, storedName);
    const normalizedSize = Number(size || 0);
    const stat = fs.statSync(filePath);
    if (!Number.isFinite(normalizedSize) || normalizedSize !== stat.size) throw createUploadError('UPLOAD_FILE_INVALID', '上传文件大小无效');
    const sha256 = hashFile(filePath);
    const existing = findByHash.get(sha256, stat.size);
    if (existing) {
      fs.rmSync(filePath, { force: true });
      return { record: toPublicRecord(existing), deduplicated: true };
    }
    const timestamp = new Date().toISOString();
    const row = {
      file_id: fileId,
      stored_name: storedName,
      original_name: String(originalName || '未命名文件').slice(0, 255),
      extension: path.extname(String(originalName || '')).toLowerCase(),
      mime_type: String(mimeType || '').slice(0, 255),
      size: stat.size,
      sha256,
      created_at: timestamp,
      updated_at: timestamp,
    };
    insert.run(row);
    return { record: toPublicRecord(row), deduplicated: false };
  }

  function resolve(fileId) {
    if (!FILE_ID_PATTERN.test(String(fileId || ''))) throw createUploadError('UPLOAD_FILE_ID_INVALID', '文件标识无效');
    const row = findById.get(fileId);
    if (!row) throw createUploadError('UPLOAD_FILE_NOT_FOUND', '文件不存在、已过期或无权访问');
    return { ...toPublicRecord(row), filePath: assertStoredPath(uploadsDir, row.stored_name), sha256: row.sha256 };
  }

  function resolveMany(fileIds, { min = 1, max = 10 } = {}) {
    if (!Array.isArray(fileIds) || fileIds.length < min || fileIds.length > max) {
      throw createUploadError('UPLOAD_FILE_ID_INVALID', '文件数量无效');
    }
    const uniqueIds = [...new Set(fileIds.map((id) => String(id || '')))];
    if (uniqueIds.length !== fileIds.length) throw createUploadError('UPLOAD_FILE_ID_INVALID', '文件列表包含重复项');
    return uniqueIds.map((fileId) => resolve(fileId));
  }

  function markClaimed(fileIds) {
    const timestamp = new Date().toISOString();
    for (const fileId of new Set(fileIds || [])) touch.run(timestamp, timestamp, fileId);
  }

  return { register, resolve, resolveMany, markClaimed };
}

module.exports = { FILE_ID_PATTERN, createUploadRegistry, createUploadError };
