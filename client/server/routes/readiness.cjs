// Readiness 检查：J-Core 与 Agent Quality 分离，Sidecar 故障不拖垮 Web 主链路。
const express = require('express');
const fs = require('node:fs');
const crypto = require('node:crypto');
const config = require('../config.cjs');
const { createTokenManager, isDefaultSecret } = require('../agent-sidecar/tokenService.cjs');

const router = express.Router();

function isEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function isAgentQualityEnabled() {
  const value = process.env.AGENT_QUALITY_ENABLED === undefined
    ? process.env.AGENT_SIDECAR_ENABLED
    : process.env.AGENT_QUALITY_ENABLED;
  return isEnabled(value);
}

function normalizeSidecarUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new Error('Agent Sidecar URL 不可用');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Agent Sidecar URL 不可用');
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

async function checkAgentSidecar() {
  if (!isAgentQualityEnabled()) {
    return { name: 'agent_sidecar', status: 'disabled', feature: 'j-agent' };
  }

  try {
    const secret = String(process.env.YIBIAO_SIDECAR_SECRET || '').trim();
    if (isDefaultSecret(secret)) {
      return { name: 'agent_sidecar', status: 'blocked', code: 'AGENT_HANDSHAKE_FAILED', message: 'Sidecar secret 未通过非默认校验' };
    }
    const baseUrl = normalizeSidecarUrl(process.env.AGENT_SIDECAR_URL || 'http://agent-runner:7101');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    timer.unref?.();
    let response;
    try {
      response = await fetch(`${baseUrl}/internal/runner/v1/health`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      return { name: 'agent_sidecar', status: 'blocked', code: 'AGENT_SANDBOX_UNAVAILABLE', message: 'Sidecar health 返回异常' };
    }
    const body = await response.json();
    if (body?.protocol !== 'SidecarProtocolV1' || body?.ready !== true) {
      return { name: 'agent_sidecar', status: 'blocked', code: 'AGENT_SANDBOX_UNAVAILABLE', message: 'Sidecar 协议或状态不匹配' };
    }
    const challenge = crypto.randomUUID();
    const handshakeResponse = await fetch(`${baseUrl}/internal/runner/v1/handshake?challenge=${encodeURIComponent(challenge)}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    const handshake = await handshakeResponse.json();
    if (!handshakeResponse.ok || handshake?.ready !== true || !handshake?.handshake?.token || !handshake?.policy) {
      return { name: 'agent_sidecar', status: 'blocked', code: 'AGENT_HANDSHAKE_FAILED', message: 'Sidecar 签名握手或策略证据缺失' };
    }
    const verifier = createTokenManager({ secret });
    try {
      verifier.verifyHandshakeToken(handshake.handshake.token, {
        challenge,
        policyHash: handshake.policy.policyHash,
      });
    } finally {
      verifier.close();
    }
    const policy = handshake.policy;
    const policyValid = policy.network?.mode === 'internal-proxy-only'
      && policy.network?.publicNetwork === false
      && policy.network?.egress === 'deny'
      && policy.network?.metadataEndpoint === 'deny'
      && policy.tools?.bash === 'deny'
      && policy.tools?.webfetch === 'deny'
      && policy.tools?.websearch === 'deny'
      && policy.tools?.task === 'deny'
      && policy.tools?.skill === 'deny'
      && policy.seccomp?.defaultAction === 'SCMP_ACT_ERRNO'
      && policy.seccomp?.connect === 'agent-internal-network-only'
      && /^[a-f0-9]{64}$/i.test(String(policy.seccomp?.sha256 || ''));
    if (!policyValid || body.policyHash !== policy.policyHash || handshake.handshake.policyHash !== policy.policyHash) {
      return { name: 'agent_sidecar', status: 'blocked', code: 'AGENT_HANDSHAKE_FAILED', message: 'Sidecar 策略证据不满足内部 Proxy 隔离要求' };
    }
    return {
      name: 'agent_sidecar',
      status: 'ready',
      protocol: body.protocol,
      version: body.version,
      handshake: 'verified',
      policyHash: policy.policyHash,
      seccompPolicyHash: policy.seccomp.sha256,
    };
  } catch {
    return { name: 'agent_sidecar', status: 'blocked', code: 'AGENT_SANDBOX_UNAVAILABLE', message: 'Sidecar 暂不可达' };
  }
}

async function buildCoreChecks() {
  const checks = [];

  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.accessSync(config.dataDir, fs.constants.W_OK);
    checks.push({ name: 'data_dir', status: 'ok' });
  } catch {
    checks.push({ name: 'data_dir', status: 'fail', message: '数据目录不可写' });
  }

  try {
    const { getSystemDb } = require('../database/systemDatabase.cjs');
    const db = getSystemDb();
    db.prepare('SELECT COUNT(*) as count FROM accounts').get();
    checks.push({ name: 'system_db', status: 'ok' });
  } catch {
    checks.push({ name: 'system_db', status: 'fail', message: '系统数据库不可用' });
  }

  try {
    if (fs.existsSync(config.distDir)) {
      checks.push({ name: 'static_assets', status: 'ok' });
    } else {
      checks.push({ name: 'static_assets', status: 'warn', message: 'dist 目录不存在' });
    }
  } catch {
    checks.push({ name: 'static_assets', status: 'fail', message: '静态资源不可用' });
  }
  return checks;
}

function coreStatus(checks) {
  return checks.some((check) => check.status === 'fail') ? 'not_ready' : 'ready';
}

router.get('/readiness', async (_req, res) => {
  const checks = await buildCoreChecks();
  const agentQuality = await checkAgentSidecar();
  const status = coreStatus(checks);
  res.status(status === 'ready' ? 200 : 503).json({
    status,
    capabilities: {
      technical_plan_core: status === 'ready' ? 'ready' : 'blocked',
      agent_quality: agentQuality.status,
    },
    checks: [...checks, agentQuality],
  });
});

router.get('/readiness/agent-quality', async (_req, res) => {
  const agentQuality = await checkAgentSidecar();
  const ready = agentQuality.status === 'ready';
  const disabled = agentQuality.status === 'disabled';
  res.status(ready || disabled ? 200 : 503).json({
    status: agentQuality.status,
    capabilities: { agent_quality: agentQuality.status },
    checks: [agentQuality],
  });
});

// 保持 Express 默认导出，同时把测试和诊断 helper 作为 router 属性暴露。
router.isAgentQualityEnabled = isAgentQualityEnabled;
router.checkAgentSidecar = checkAgentSidecar;
router.normalizeSidecarUrl = normalizeSidecarUrl;
module.exports = router;
