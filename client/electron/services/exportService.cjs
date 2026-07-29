const fs = require('node:fs');
const path = require('node:path');
let electron = {};
try { electron = require('electron'); } catch {}
const { app, dialog, nativeImage } = electron;
const { createDeveloperLogger } = require('../utils/developerLog.cjs');
const { getMermaidCacheEntry, saveMermaidCacheImage } = require('../utils/mermaidCache.cjs');
const { getGeneratedImagesDir, getImportedImagesDir } = require('../utils/paths.cjs');
const { getLocalImageRenderService } = require('./localImageRenderService.cjs');
const {
  buildDocxResult,
  countOutlineStats,
  countOutlineContentMetrics,
  sanitizeFilename,
  formatExportTimestamp,
  reportProgress,
  compactLogError,
  loadDeveloperConfig,
} = require('../../core/export/docxBuilder.cjs');

// 桌面端 WebP→PNG：使用原生图像接口解码后重编码为 PNG。
function electronImageNormalizer(buffer) {
  const image = nativeImage?.createFromBuffer ? nativeImage.createFromBuffer(buffer) : null;
  if (!image || image.isEmpty()) {
    return null;
  }
  return { buffer: image.toPNG(), type: 'png' };
}

// 桌面端 yibiao-asset:// 解析：限定在用户数据目录下的生成图/导入图根目录，并做路径边界校验。
function createElectronAssetResolver() {
  return ({ host, relativePath }) => {
    if (!app?.getPath) return null;
    const assetRoots = {
      'generated-images': getGeneratedImagesDir(app),
      'imported-images': getImportedImagesDir(app),
    };
    const rootDir = assetRoots[host];
    if (!rootDir || !relativePath) return null;

    const baseDir = path.resolve(rootDir);
    const resolvedPath = path.resolve(baseDir, relativePath);
    if (resolvedPath !== baseDir && !resolvedPath.startsWith(`${baseDir}${path.sep}`)) {
      return null;
    }
    return resolvedPath;
  };
}

// 桌面端导出端口：注入原生图片归一化、资产解析与 Mermaid 本地渲染/缓存。
function createElectronExportPorts() {
  return {
    imageNormalizer: electronImageNormalizer,
    assetResolver: createElectronAssetResolver(),
    mermaidRenderer: (code) => getLocalImageRenderService().renderMermaidToPng(code),
    getMermaidCacheEntry: (code) => getMermaidCacheEntry(app, code),
    saveMermaidCacheImage: (hash, buffer) => saveMermaidCacheImage(app, hash, buffer),
  };
}

function createExportService({ configStore } = {}) {
  const ports = createElectronExportPorts();
  return {
    async exportWord(payload = {}, onProgress) {
      const stats = countOutlineStats(Array.isArray(payload.outline) ? payload.outline : []);
      const developerLogger = createDeveloperLogger({
        app,
        config: loadDeveloperConfig(configStore),
        moduleName: 'export',
        name: 'word-export',
        meta: {
          project_name: sanitizeFilename(payload.project_name || '投标技术文件'),
          stats,
        },
      });
      developerLogger.write('export.word.started', {
        project_name: sanitizeFilename(payload.project_name || '投标技术文件'),
        stats,
        content_metrics: countOutlineContentMetrics(Array.isArray(payload.outline) ? payload.outline : []),
      });
      if (!Array.isArray(payload.outline) || !payload.outline.length) {
        const error = new Error('没有可导出的目录内容');
        developerLogger.write('export.word.error', { error: compactLogError(error) });
        throw error;
      }

      const progressContext = { onProgress, warnings: [], stats };
      reportProgress(progressContext, 2, stats.mermaidCount
        ? `检测到 ${stats.mermaidCount} 张 Mermaid 图，导出时会转换为 Word 图片。`
        : '正在准备 Word 导出。');
      const defaultFilename = `${sanitizeFilename(payload.project_name || '标书文档')}_${formatExportTimestamp()}.docx`;
      const defaultDir = app?.getPath ? app.getPath('downloads') : process.env.USERPROFILE || process.cwd();
      const result = await dialog.showSaveDialog({
        title: '导出 Word 文档',
        defaultPath: path.join(defaultDir, defaultFilename),
        filters: [{ name: 'Word 文档', extensions: ['docx'] }],
      });

      if (result.canceled || !result.filePath) {
        reportProgress(progressContext, 0, '已取消导出。', { phase: 'canceled' });
        developerLogger.write('export.word.canceled', { stats });
        return { success: false, canceled: true, message: '已取消导出' };
      }

      try {
        const warnings = [];
        const buildResult = await buildDocxResult(payload, { onProgress, warnings, developerLogger, ...ports });
        reportProgress({ onProgress, warnings: buildResult.warnings, stats: buildResult.stats }, 96, '正在写入 Word 文件。');
        developerLogger.write('export.word.write.started', {
          output_file_name: path.basename(result.filePath),
          output_extension: path.extname(result.filePath).toLowerCase(),
          buffer_bytes: buildResult.buffer.length,
        });
        fs.writeFileSync(result.filePath, buildResult.buffer);
        const message = buildResult.warnings.length
          ? `Word 已导出，但有 ${buildResult.warnings.length} 处图片未能插入，请打开文档核对。`
          : 'Word 已导出，请打开文档核对图片、表格和版式。';
        reportProgress({ onProgress, warnings: buildResult.warnings, stats: buildResult.stats }, 100, message, { phase: 'success' });
        developerLogger.write('export.word.completed', {
          output_file_name: path.basename(result.filePath),
          output_extension: path.extname(result.filePath).toLowerCase(),
          buffer_bytes: buildResult.buffer.length,
          warning_count: buildResult.warnings.length,
          stats: buildResult.stats,
        });
        return { success: true, path: result.filePath, message, warnings: buildResult.warnings };
      } catch (error) {
        developerLogger.write('export.word.error', {
          output_file_name: path.basename(result.filePath),
          output_extension: path.extname(result.filePath).toLowerCase(),
          error: compactLogError(error),
        });
        throw error;
      }
    },
  };
}

module.exports = {
  createExportService,
  createElectronExportPorts,
  buildDocxResult,
};
