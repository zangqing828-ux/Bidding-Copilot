const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

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
    mode: 'internal-proxy-only',
    allowedNetworks: Object.freeze(['agent-internal']),
    allowedDestination: 'web-internal-listener',
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
  if (policy.network?.mode !== 'internal-proxy-only' || policy.network?.allowedDestination !== 'web-internal-listener') return false;
  if (policy.process?.noNewPrivileges !== true || !policy.process.capDrop?.includes('ALL')) return false;
  if (!String(policy.process?.seccompProfile || '').endsWith('agent-runner.json')) return false;
  return Number.isInteger(policy.limits?.pids) && policy.limits.pids > 0
    && Number.isInteger(policy.limits?.memoryBytes) && policy.limits.memoryBytes > 0
    && Number.isInteger(policy.limits?.inputBytes) && policy.limits.inputBytes > 0
    && Number.isInteger(policy.limits?.resultBytes) && policy.limits.resultBytes > 0;
}

function resolveSeccompProfile(env = process.env) {
  const candidates = [
    env.AGENT_SECCOMP_PROFILE,
    path.resolve(__dirname, '../..', 'docker/agent-runner/seccomp/agent-runner.json'),
    '/opt/agent-assets/seccomp/agent-runner.json',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function getRunnerPolicyEvidence({ env = process.env } = {}) {
  const seccompProfile = resolveSeccompProfile(env);
  let seccomp = { defaultAction: 'missing', sha256: '' };
  try {
    const source = fs.readFileSync(seccompProfile);
    const parsed = JSON.parse(source.toString('utf8'));
    const names = parsed.syscalls.flatMap((entry) => entry.names || []);
    if (parsed.defaultAction !== 'SCMP_ACT_ERRNO' || !names.includes('connect')) {
      throw new Error('seccomp policy 不满足内部 Proxy 连接要求');
    }
    seccomp = {
      defaultAction: parsed.defaultAction,
      connect: 'agent-internal-network-only',
      sha256: crypto.createHash('sha256').update(source).digest('hex'),
    };
  } catch (error) {
    seccomp = { defaultAction: 'invalid', sha256: '', errorCode: error.code || 'AGENT_SECCOMP_POLICY_INVALID' };
  }
  const evidence = {
    policyVersion: 'j3-runner-policy-v1',
    network: {
      mode: RUNNER_SECURITY_POLICY.network.mode,
      publicNetwork: RUNNER_SECURITY_POLICY.network.publicNetwork,
      egress: RUNNER_SECURITY_POLICY.network.egress,
      allowedNetwork: RUNNER_SECURITY_POLICY.network.allowedNetworks[0],
      allowedDestination: RUNNER_SECURITY_POLICY.network.allowedDestination,
      metadataEndpoint: RUNNER_SECURITY_POLICY.network.metadataEndpoint,
    },
    tools: {
      read: 'allow(input/**)',
      glob: 'allow(input/**)',
      grep: 'allow(input/**)',
      write: 'allow(result.json)',
      bash: 'deny',
      webfetch: 'deny',
      websearch: 'deny',
      task: 'deny',
      skill: 'deny',
    },
    seccomp: {
      profile: seccompProfile,
      defaultAction: seccomp.defaultAction,
      connect: seccomp.connect || 'deny',
      sha256: seccomp.sha256,
    },
    limits: RUNNER_SECURITY_POLICY.limits,
  };
  const policyHash = crypto.createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
  return Object.freeze({ ...evidence, policyHash });
}

module.exports = {
  RUNNER_SECURITY_POLICY,
  validateRunnerSecurityPolicy,
  resolveSeccompProfile,
  getRunnerPolicyEvidence,
};
