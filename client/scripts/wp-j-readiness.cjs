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
  const baseUrl = String(process.env.AGENT_SIDECAR_URL || 'http://agent-runner:7101').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  timer.unref?.();
  try {
    const response = await fetch(`${baseUrl}/internal/runner/v1/health`, { signal: controller.signal, headers: { accept: 'application/json' } });
    const body = await response.json();
    const ready = response.ok && body?.protocol === 'SidecarProtocolV1' && body?.ready === true;
    printResult({
      status: ready ? 'ready' : 'not_ready',
      checks: [{
        ...(ready
          ? { name: 'agent_sidecar', status: 'ok', protocol: body.protocol, version: body.version }
          : check('agent_sidecar', 'fail', 'Sidecar health 返回异常', {
            code: 'AGENT_SANDBOX_UNAVAILABLE',
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
  } finally {
    clearTimeout(timer);
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
