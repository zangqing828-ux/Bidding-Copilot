const RUNNER_SECURITY_POLICY = Object.freeze({
  user: Object.freeze({ uid: 10001, gid: 10001 }),
  filesystem: Object.freeze({
    rootReadOnly: true,
    inputReadOnly: true,
    outputWritable: true,
    tmpfsBytes: 64 * 1024 * 1024,
  }),
  network: Object.freeze({
    publicNetwork: false,
    egress: 'deny',
    allowedNetworks: Object.freeze(['agent-internal']),
    metadataEndpoint: 'deny',
  }),
  process: Object.freeze({
    noNewPrivileges: true,
    capDrop: Object.freeze(['ALL']),
    seccompProfile: 'docker/agent-runner/seccomp/agent-runner.json',
  }),
  limits: Object.freeze({
    pids: 128,
    cpu: 1,
    memoryBytes: 768 * 1024 * 1024,
    inputBytes: 32 * 1024 * 1024,
    resultBytes: 4 * 1024 * 1024,
    outputFiles: 32,
  }),
});

function validateRunnerSecurityPolicy(policy = RUNNER_SECURITY_POLICY) {
  if (policy?.user?.uid !== 10001 || policy?.user?.gid !== 10001) return false;
  if (policy.filesystem?.rootReadOnly !== true || policy.filesystem?.inputReadOnly !== true || policy.filesystem?.outputWritable !== true) return false;
  if (policy.network?.publicNetwork !== false || policy.network?.egress !== 'deny' || policy.network?.metadataEndpoint !== 'deny') return false;
  if (policy.process?.noNewPrivileges !== true || !policy.process.capDrop?.includes('ALL')) return false;
  if (!String(policy.process?.seccompProfile || '').endsWith('agent-runner.json')) return false;
  return Number.isInteger(policy.limits?.pids) && policy.limits.pids > 0
    && Number.isInteger(policy.limits?.memoryBytes) && policy.limits.memoryBytes > 0
    && Number.isInteger(policy.limits?.inputBytes) && policy.limits.inputBytes > 0
    && Number.isInteger(policy.limits?.resultBytes) && policy.limits.resultBytes > 0;
}

module.exports = {
  RUNNER_SECURITY_POLICY,
  validateRunnerSecurityPolicy,
};
