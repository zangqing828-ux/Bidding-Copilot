const { createTokenManager } = require('./tokenService.cjs');
const { isDefaultSecret } = require('./tokenService.cjs');
const { createInternalAgentApi, createInternalAgentHttpServer } = require('./internalListener.cjs');
const { createInternalAiChatHandler } = require('./internalAiAdapter.cjs');

function createWebInternalAgentListener({
  workspaceId,
  aiService,
  tokenManager = null,
  secret = process.env.YIBIAO_SIDECAR_SECRET,
  host = process.env.AGENT_INTERNAL_HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
  port = Number(process.env.AGENT_INTERNAL_PORT || 0),
  autoStart = false,
} = {}) {
  if (!workspaceId || !aiService) throw new TypeError('Web internal listener 缺少 workspaceId 或 aiService');
  if (!tokenManager && isDefaultSecret(secret)) {
    throw new Error('Web internal listener 必须使用非默认 YIBIAO_SIDECAR_SECRET');
  }
  const ownsTokenManager = !tokenManager;
  const effectiveTokenManager = tokenManager || createTokenManager({ secret });
  const api = createInternalAgentApi({
    tokenManager: effectiveTokenManager,
    chatHandler: createInternalAiChatHandler({ workspaceId, aiService }),
  });
  const httpServer = createInternalAgentHttpServer({ api, host, port });
  let address = null;
  let started = false;
  let startPromise = null;
  let startError = null;
  const listener = {
    api,
    tokenManager: effectiveTokenManager,
    httpServer,
    get sidecarReady() {
      return started && !startError;
    },
    get startError() { return startError; },
    start() {
      if (startPromise) return startPromise;
      startPromise = Promise.resolve()
        .then(() => httpServer.start())
        .then((nextAddress) => {
          address = nextAddress;
          started = true;
          return address;
        })
        .catch((error) => {
          startError = error;
          throw error;
        });
      return startPromise;
    },
    get url() {
      const effectivePort = address?.port || (Number.isInteger(port) && port > 0 ? port : 0);
      if (!effectivePort) return '';
      const advertisedHost = process.env.AGENT_INTERNAL_ADVERTISED_HOST
        || (process.env.NODE_ENV === 'production' ? 'web' : address?.address || host);
      return `http://${advertisedHost}:${effectivePort}`;
    },
    async close() {
      await startPromise?.catch(() => undefined);
      await httpServer.close().catch((error) => {
        if (error?.code !== 'ERR_SERVER_NOT_RUNNING') throw error;
      });
      if (ownsTokenManager) effectiveTokenManager.close();
    },
  };
  if (autoStart) void listener.start().catch(() => undefined);
  return Object.freeze(listener);
}

module.exports = { createWebInternalAgentListener };
