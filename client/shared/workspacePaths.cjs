// 兼容层：保持 legacy API 与调用路径不变。
// 运行时无关实现已迁移到 client/core。

const coreWorkspacePaths = require('../core/workspacePaths.cjs');

const { resolveWorkspacePaths, getRejectionCheckDocumentMarkdownPath } = coreWorkspacePaths;

module.exports = {
  resolveWorkspacePaths,
  getRejectionCheckDocumentMarkdownPath,
};
