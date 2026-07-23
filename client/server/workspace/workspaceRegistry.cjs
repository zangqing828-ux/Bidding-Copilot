// Workspace Registry：按 workspaceId 缓存 workspaceContext。
// 首次访问时初始化 SQLite + Stores，后续直接返回缓存。
const { createWorkspaceContext } = require('./workspaceContext.cjs');

const contexts = new Map();

function getDataDir() {
  const config = require('../config.cjs');
  return config.dataDir;
}

function getWorkspaceContext(workspaceId) {
  if (!workspaceId) {
    throw new Error('workspaceId is required');
  }

  let ctx = contexts.get(workspaceId);
  if (ctx) {
    return ctx;
  }

  ctx = createWorkspaceContext({ workspaceId, dataDir: getDataDir() });
  contexts.set(workspaceId, ctx);
  return ctx;
}

function closeWorkspaceContext(workspaceId) {
  const ctx = contexts.get(workspaceId);
  if (ctx) {
    ctx.close();
    contexts.delete(workspaceId);
  }
}

function closeAll() {
  for (const ctx of contexts.values()) {
    try {
      ctx.close();
    } catch (err) {
      console.warn('[workspace] 关闭 workspace 失败', err?.message || String(err));
    }
  }
  contexts.clear();
}

module.exports = { getWorkspaceContext, closeWorkspaceContext, closeAll };
