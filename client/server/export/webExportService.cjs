const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createDownloadToken } = require('../routes/downloads.cjs');
const { buildSimpleDocxResult } = require('./simpleDocxBuilder.cjs');

function safeFileName(value) {
  return String(value || '投标技术文件').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100) || '投标技术文件';
}

function createWebExportService({ workspaceId, workspaceRoot }) {
  const exportsDir = path.join(workspaceRoot, 'exports');
  return {
    async exportWord(payload = {}) {
      if (!Array.isArray(payload.outline) || payload.outline.length === 0) {
        const error = new Error('没有可导出的目录内容');
        error.code = 'INVALID_BRIDGE_ARGUMENTS';
        throw error;
      }
      fs.mkdirSync(exportsDir, { recursive: true, mode: 0o700 });
      const result = await buildSimpleDocxResult(payload);
      const fileName = `${safeFileName(payload.project_name)}_${new Date().toISOString().replace(/[:.]/g, '-')}.docx`;
      const filePath = path.join(exportsDir, `${crypto.randomUUID()}.docx`);
      fs.writeFileSync(filePath, result.buffer, { mode: 0o600 });
      const downloadId = createDownloadToken(workspaceId, filePath, fileName);
      return {
        success: true,
        message: result.warnings.length ? `Word 已生成，含 ${result.warnings.length} 条图片警告。` : 'Word 已生成，可开始下载。',
        warnings: result.warnings,
        download_id: downloadId,
        download_url: `/api/downloads/${downloadId}`,
      };
    },
    close() {},
  };
}

module.exports = { createWebExportService };
