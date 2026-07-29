const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createDownloadToken, revokeWorkspaceDownloads } = require('../routes/downloads.cjs');
const { buildDocxResult } = require('../../core/export/docxBuilder.cjs');

function safeFileName(value) {
  return String(value || '投标技术文件').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100) || '投标技术文件';
}

// Web 资产解析：只允许 generated-images / imported-images 两个 host，且必须落在当前 tenant 目录内。
function createWebAssetResolver(paths) {
  const roots = {
    'generated-images': paths.generatedImagesDir,
    'imported-images': paths.importedImagesDir,
  };
  return ({ host, relativePath }) => {
    const rootDir = roots[host];
    if (!rootDir || !relativePath) return null;
    const baseDir = path.resolve(rootDir);
    const resolvedPath = path.resolve(baseDir, relativePath);
    if (resolvedPath !== baseDir && !resolvedPath.startsWith(`${baseDir}${path.sep}`)) {
      return null;
    }
    return resolvedPath;
  };
}

// Web 导出端口：资产解析限定 tenant 边界，Mermaid 复用 Linux 渲染器。
function createWebExportPorts({ paths, imageRenderer }) {
  return {
    assetResolver: createWebAssetResolver(paths),
    mermaidRenderer: imageRenderer
      ? (code) => imageRenderer.renderMermaidToPng(code)
      : undefined,
  };
}

function createWebExportService({ workspaceId, workspaceRoot, paths, technicalPlanStore, imageRenderer }) {
  const exportsDir = paths?.exportsDir || path.join(workspaceRoot, 'exports');
  const ports = createWebExportPorts({ paths: paths || {}, imageRenderer });
  return {
    async exportWord(payload = {}) {
      // 以 Store 中最新 outlineData.outline[*].content 为权威来源，缺省时回退请求体。
      const storeState = technicalPlanStore ? technicalPlanStore.loadTechnicalPlan() : null;
      const outline = storeState?.outlineData?.outline?.length
        ? storeState.outlineData.outline
        : payload.outline;
      const projectName = payload.project_name || storeState?.outlineData?.project_name || '投标技术文件';

      if (!Array.isArray(outline) || outline.length === 0) {
        const error = new Error('没有可导出的目录内容');
        error.code = 'INVALID_BRIDGE_ARGUMENTS';
        throw error;
      }

      fs.mkdirSync(exportsDir, { recursive: true, mode: 0o700 });
      const warnings = [];
      const result = await buildDocxResult(
        { ...payload, project_name: projectName, outline },
        { warnings, ...ports },
      );
      const fileName = `${safeFileName(projectName)}_${new Date().toISOString().replace(/[:.]/g, '-')}.docx`;
      const filePath = path.join(exportsDir, `${crypto.randomUUID()}.docx`);
      fs.writeFileSync(filePath, result.buffer, { mode: 0o600 });
      const downloadId = createDownloadToken(workspaceId, filePath, fileName);
      return {
        success: true,
        message: warnings.length ? `Word 已生成，含 ${warnings.length} 条图片警告。` : 'Word 已生成，可开始下载。',
        warnings,
        downloadUrl: `/api/downloads/${downloadId}`,
        fileName,
      };
    },
    close() {
      revokeWorkspaceDownloads(workspaceId);
      if (fs.existsSync(exportsDir)) {
        fs.rmSync(exportsDir, { recursive: true, force: true });
      }
    },
  };
}

module.exports = { createWebExportService };
