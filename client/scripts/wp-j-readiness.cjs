const { check, printResult } = require('./wp-j-ops-utils.cjs');

function enabled() {
  const value = process.env.AGENT_QUALITY_ENABLED === undefined
    ? process.env.AGENT_SIDECAR_ENABLED
    : process.env.AGENT_QUALITY_ENABLED;
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

async function main() {
  if (!enabled()) {
    printResult({ status: 'disabled', checks: [{ name: 'agent_sidecar', status: 'disabled', feature: 'j-agent' }] });
    return;
  }
  try {
    const readinessRouter = require('../server/routes/readiness.cjs');
    const result = await readinessRouter.checkAgentSidecar();
    const ready = result.status === 'ready';
    printResult({
      status: ready ? 'ready' : 'not_ready',
      checks: [{
        ...(ready
          ? { ...result, status: 'ok' }
          : check('agent_sidecar', 'fail', result.message || 'Sidecar readiness 返回异常', {
            code: result.code || 'AGENT_SANDBOX_UNAVAILABLE',
            component: 'agent-sidecar',
            run_id: 'wp-j-readiness',
            retryable: true,
            action: '检查 Runner health、Compose profile 和 Sidecar secret',
            docs: 'docs/runbooks/wp-j-agent-sidecar.md',
          })),
      }],
    });
    if (!ready) process.exitCode = 1;
  } catch (error) {
    printResult({
      status: 'not_ready',
      checks: [check('agent_sidecar', 'fail', error?.message || 'Sidecar 暂不可达', {
        code: 'AGENT_SANDBOX_UNAVAILABLE',
        component: 'agent-sidecar',
        run_id: 'wp-j-readiness',
        retryable: true,
        action: '检查 Runner health、Compose profile 和 Sidecar secret',
        docs: 'docs/runbooks/wp-j-agent-sidecar.md',
      })],
    });
    process.exitCode = 1;
  }
}

main().catch((error) => {
  printResult({
    status: 'not_ready',
    checks: [check('agent_sidecar', 'fail', error?.message || 'readiness failed', {
      code: 'AGENT_SANDBOX_UNAVAILABLE',
      component: 'agent-sidecar',
      run_id: 'wp-j-readiness',
      retryable: true,
      action: '检查 Runner health、Compose profile 和 Sidecar secret',
      docs: 'docs/runbooks/wp-j-agent-sidecar.md',
    })],
  });
  process.exitCode = 1;
});
