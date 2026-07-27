const { check, runDoctor, printResult } = require('./wp-j-ops-utils.cjs');

async function main() {
  const doctor = runDoctor();
  const enabledValue = process.env.AGENT_QUALITY_ENABLED === undefined
    ? process.env.AGENT_SIDECAR_ENABLED
    : process.env.AGENT_QUALITY_ENABLED;
  const sidecarEnabled = ['1', 'true', 'yes', 'on'].includes(String(enabledValue || '').trim().toLowerCase());
  const readiness = { status: sidecarEnabled ? 'pending' : 'disabled', checks: [] };
  if (sidecarEnabled) {
    const { execFile } = require('node:child_process');
    const { promisify } = require('node:util');
    const run = promisify(execFile);
    try {
      const result = await run(process.execPath, [require.resolve('./wp-j-readiness.cjs')], { cwd: process.cwd(), env: process.env, maxBuffer: 128 * 1024 });
      Object.assign(readiness, JSON.parse(result.stdout));
    } catch (error) {
      try {
        Object.assign(readiness, JSON.parse(error.stdout || '{}'));
      } catch {
        readiness.status = 'not_ready';
        readiness.checks = [check('agent_sidecar', 'fail', 'Sidecar readiness 命令失败', {
          code: 'AGENT_SANDBOX_UNAVAILABLE',
          component: 'agent-sidecar',
          run_id: 'wp-j-diagnose',
          retryable: true,
          action: '检查 Runner health、Compose profile 和 Sidecar secret',
          docs: 'docs/runbooks/wp-j-agent-sidecar.md',
        })];
      }
    }
  }
  const failed = doctor.status === 'fail' || readiness.status === 'not_ready';
  printResult({ status: failed ? 'fail' : (doctor.status === 'warn' ? 'warn' : 'ok'), doctor, readiness });
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  printResult({
    status: 'fail',
    checks: [check('diagnose', 'fail', error?.message || 'diagnose failed', {
      code: 'WP_J_DIAGNOSE_FAILED',
      component: 'wp-j-operations',
      run_id: 'wp-j-diagnose',
      retryable: true,
      action: '重新执行 npm run wp-j:diagnose 并检查上游组件状态',
      docs: 'docs/runbooks/wp-j-agent-sidecar.md',
    })],
  });
  process.exitCode = 1;
});
