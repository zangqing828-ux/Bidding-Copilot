const { DEFAULT_LIMITS, createAgentCoordinator } = require('./agentCoordinator.cjs');

function normalizeLimit(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), fallback);
}

function resolveGlobalAgentLimits(options = {}) {
  const env = options.env || process.env;
  const configured = options.limits && typeof options.limits === 'object' ? options.limits : {};
  return {
    globalActive: normalizeLimit(configured.globalActive ?? env.WEB_AGENT_GLOBAL_ACTIVE_LIMIT, DEFAULT_LIMITS.globalActive),
    globalQueued: normalizeLimit(configured.globalQueued ?? env.WEB_AGENT_GLOBAL_QUEUE_LIMIT, DEFAULT_LIMITS.globalQueued),
    workspaceActive: DEFAULT_LIMITS.workspaceActive,
    workspaceQueued: normalizeLimit(configured.workspaceQueued ?? env.WEB_AGENT_WORKSPACE_QUEUE_LIMIT, DEFAULT_LIMITS.workspaceQueued),
    retryAfterSeconds: DEFAULT_LIMITS.retryAfterSeconds,
  };
}

function createGlobalAgentCoordinator(options = {}) {
  return createAgentCoordinator({ limits: resolveGlobalAgentLimits(options) });
}

let globalCoordinator = null;

function getGlobalAgentCoordinator(options = {}) {
  if (!globalCoordinator) {
    globalCoordinator = createGlobalAgentCoordinator(options);
  }
  return globalCoordinator;
}

function resetGlobalAgentCoordinator() {
  const previous = globalCoordinator;
  globalCoordinator = null;
  if (previous) {
    previous.beginClosing();
  }
  return previous;
}

module.exports = {
  createGlobalAgentCoordinator,
  getGlobalAgentCoordinator,
  resetGlobalAgentCoordinator,
  resolveGlobalAgentLimits,
};
