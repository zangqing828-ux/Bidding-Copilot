// Web 文件适配器：所有业务导入只从 upload registry 解析 file ID。
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseDocumentWithConfig } = require('../../core/documentParser.cjs');

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
        const parsed = await parseDocumentWithConfig(upload.filePath, config, { timeoutMs: options.timeoutMs });
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

  async function importDocument({ fileIds, multiple = false } = {}) {
    const { documents, errors } = await parseFiles(fileIds, { min: 1, max: multiple ? 10 : 1 });
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

  async function importTechnicalPlanDocument(label, { fileIds, multiple = false } = {}) {
    const result = await importDocument({ fileIds, multiple });
    if (!result.success) return result;
    return { ...result, message: `${label || '文件'}已导入` };
  }

  async function importRejectionCheckDocument(role, { fileIds } = {}) {
    const result = await importDocument({ fileIds, multiple: role === 'bid' });
    return result;
  }

  function resolveDuplicateCheckFiles(fileIds) {
    const uploads = uploadRegistry.resolveMany(fileIds, { min: 1, max: 10 });
    uploadRegistry.markClaimed(uploads.map((item) => item.fileId));
    return uploads.map((item) => ({
      id: item.fileId,
      file_id: item.fileId,
      file_name: item.fileName,
      file_path: item.filePath,
      extension: item.extension,
      size: item.size,
      modified_at: item.uploadedAt,
    }));
  }

  async function uploadKnowledgeBaseDocuments({ folderId, fileIds, knowledgeBaseStore }) {
    const folder = knowledgeBaseStore.list().folders.find((item) => item.id === folderId);
    if (!folder) throw new Error('请先选择知识库文件夹');
    const { documents, errors } = await parseFiles(fileIds, { min: 1, max: 10 });
    const created = [];
    for (const documentInput of documents) {
      const documentId = createId('doc');
      const documentDir = path.join('folders', folderId, 'documents', documentId).replace(/\\/g, '/');
      const sourcePath = path.join(documentDir, `source${documentInput.extension || ''}`).replace(/\\/g, '/');
      const markdownPath = path.join(documentDir, 'content.md').replace(/\\/g, '/');
      const sourceFilePath = knowledgeBaseStore.resolvePath(sourcePath);
      const markdownFilePath = knowledgeBaseStore.resolvePath(markdownPath);
      try {
        copyFile(documentInput.file_path, sourceFilePath);
        fs.mkdirSync(path.dirname(markdownFilePath), { recursive: true });
        fs.writeFileSync(markdownFilePath, `${documentInput.file_content}\n`, 'utf-8');
        const timestamp = new Date().toISOString();
        created.push(knowledgeBaseStore.createDocument({
          id: documentId,
          folder_id: folderId,
          file_name: documentInput.file_name,
          document_dir: documentDir,
          source_path: sourcePath,
          markdown_path: markdownPath,
          source_extension: documentInput.extension,
          status: 'ready_for_matching',
          progress: 100,
          message: '文档已导入，等待智能处理',
          parser_label: documentInput.parser_label,
          created_at: timestamp,
          updated_at: timestamp,
        }));
      } catch (error) {
        errors.push({ file_id: documentInput.file_id, file_name: documentInput.file_name, message: error?.message || '知识库文档保存失败' });
        fs.rmSync(knowledgeBaseStore.resolvePath(documentDir), { recursive: true, force: true });
      }
    }
    return {
      success: Boolean(created.length),
      message: created.length
        ? (errors.length ? `已导入 ${created.length} 个文档，${errors.length} 个文件失败` : `已导入 ${created.length} 个文档`)
        : (errors[0]?.message || '知识库文档导入失败'),
      documents: created,
      errors,
    };
  }

  return {
    importDocument,
    importTechnicalPlanDocument,
    importRejectionCheckDocument,
    parseFiles,
    resolveDuplicateCheckFiles,
    uploadKnowledgeBaseDocuments,
  };
}

module.exports = { createWebFileService };
