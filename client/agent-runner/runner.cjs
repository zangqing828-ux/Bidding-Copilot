const { createTokenManager } = require('../server/agent-sidecar/tokenService.cjs');
const { createSidecarCoordinator } = require('../server/agent-sidecar/sidecarCoordinator.cjs');
const { createRunnerApi, createRunnerHttpServer } = require('../server/agent-sidecar/runnerApi.cjs');
const { createSidecarExecutionService } = require('./executionService.cjs');
const { getRunnerPolicyEvidence } = require('./securityPolicy.cjs');

function requireSecret() {
  const secret = String(process.env.YIBIAO_SIDECAR_SECRET || '').trim();
  if (!secret || secret === 'change-me-before-production') {
    throw new Error('YIBIAO_SIDECAR_SECRET 必须由 Runner 部署注入');
  }
  return secret;
}

async function startRunner({ secret = requireSecret(), host = process.env.RUNNER_HOST || '0.0.0.0', port = Number(process.env.RUNNER_PORT || 7101) } = {}) {
  // Runner 只验证 Web 签发的签名，并在本进程维护 dispatch replay ledger；不依赖 Web 的 token 注册状态。
  const tokenManager = createTokenManager({ secret, statelessDispatch: true, statelessProxy: true });
  const executionService = createSidecarExecutionService();
  const coordinator = createSidecarCoordinator({ tokenManager, executionRunner: executionService });
  const api = createRunnerApi({ coordinator, tokenManager, policyEvidence: getRunnerPolicyEvidence() });
  const httpServer = createRunnerHttpServer({ api, host, port });
  await httpServer.start();
  return Object.freeze({
    coordinator,
    tokenManager,
    executionService,
    httpServer,
    async close() {
      await httpServer.close();
      await executionService.close();
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
