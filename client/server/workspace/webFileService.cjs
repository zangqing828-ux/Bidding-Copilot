// Web 文件适配器：所有业务导入只从 upload registry 解析 file ID。
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseDocumentInWorker } = require('./documentParseExecutor.cjs');

function createId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function createWebFileService({ uploadRegistry, configStore }) {
  if (!uploadRegistry) throw new Error('Web 文件服务缺少 uploadRegistry');
  if (!configStore || typeof configStore.loadDecrypted !== 'function') throw new Error('Web 文件服务缺少 configStore');

  async function parseFiles(fileIds, options = {}) {
    const uploads = uploadRegistry.resolveMany(fileIds, { min: options.min || 1, max: options.max || 10 });
    const config = configStore.loadDecrypted();
    const results = [];
    const errors = [];
    for (const upload of uploads) {
      try {
        const parsed = await parseDocumentInWorker(upload.filePath, config, {
          timeoutMs: options.timeoutMs,
          signal: options.signal,
        });
        if (!parsed.markdown) throw new Error('解析结果为空');
        results.push({
          id: upload.fileId,
          file_id: upload.fileId,
          file_name: upload.fileName,
          file_path: upload.filePath,
          extension: upload.extension,
          size: upload.size,
          modified_at: upload.uploadedAt,
          file_content: parsed.markdown,
          parser_label: parsed.parserLabel,
          fallback_to_local: parsed.fallbackToLocal,
        });
      } catch (error) {
        errors.push({ file_id: upload.fileId, file_name: upload.fileName, message: error?.message || '文件解析失败' });
      }
    }
    if (results.length) uploadRegistry.markClaimed(results.map((item) => item.file_id));
    return { uploads, documents: results, errors };
  }

  async function importDocument({ fileIds, multiple = false } = {}, options = {}) {
    const { documents, errors } = await parseFiles(fileIds, { min: 1, max: multiple ? 10 : 1, signal: options.signal });
    if (!documents.length) return { success: false, message: errors[0]?.message || '文件解析失败', errors };
    const first = documents[0];
    return {
      success: true,
      message: errors.length ? `已导入 ${documents.length} 个文件，${errors.length} 个文件解析失败` : '文件已导入',
      ...first,
      documents,
      errors,
      fallbackToLocal: documents.some((item) => item.fallback_to_local),
    };
  }

  async function importTechnicalPlanDocument(label, { fileIds, multiple = false } = {}, options = {}) {
    const result = await importDocument({ fileIds, multiple }, options);
    if (!result.success) return result;
    return { ...result, message: `${label || '文件'}已导入` };
  }

  return {
    importDocument,
    importTechnicalPlanDocument,
    parseFiles,
  };
}

module.exports = { createWebFileService };
