const { createTokenManager } = require('../server/agent-sidecar/tokenService.cjs');
const { createSidecarCoordinator } = require('../server/agent-sidecar/sidecarCoordinator.cjs');
const { createRunnerApi, createRunnerHttpServer } = require('../server/agent-sidecar/runnerApi.cjs');

function requireSecret() {
  const secret = String(process.env.YIBIAO_SIDECAR_SECRET || '').trim();
  if (!secret || secret === 'change-me-before-production') {
    throw new Error('YIBIAO_SIDECAR_SECRET 必须由 Runner 部署注入');
  }
  return secret;
}

async function startRunner({ secret = requireSecret(), host = process.env.RUNNER_HOST || '0.0.0.0', port = Number(process.env.RUNNER_PORT || 7101) } = {}) {
  const tokenManager = createTokenManager({ secret });
  const coordinator = createSidecarCoordinator({ tokenManager });
  const api = createRunnerApi({ coordinator });
  const httpServer = createRunnerHttpServer({ api, host, port });
  await httpServer.start();
  return Object.freeze({
    coordinator,
    tokenManager,
    httpServer,
    async close() {
      await httpServer.close();
      coordinator.close('runner stopped');
      tokenManager.close();
    },
  });
}

if (require.main === module) {
  startRunner().then((runtime) => {
    const close = () => runtime.close().then(() => process.exit(0)).catch(() => process.exit(1));
    process.once('SIGTERM', close);
    process.once('SIGINT', close);
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}

module.exports = { startRunner };
