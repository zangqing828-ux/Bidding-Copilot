const AGENT_RUNTIME_IDS = ['opencode', 'pi'];
const AGENT_RUNTIME_ID = 'opencode';
const DEFAULT_AGENT_RUNTIME_ID = AGENT_RUNTIME_ID;

function getDefaultAgentRuntimeId() {
  return DEFAULT_AGENT_RUNTIME_ID;
}

function normalizeAgentRuntimeId(value) {
  const runtimeId = String(value || '').trim() || DEFAULT_AGENT_RUNTIME_ID;
  if (!AGENT_RUNTIME_IDS.includes(runtimeId)) {
    throw new Error(`未知的智能体运行时：${runtimeId}`);
  }
  return runtimeId;
}

module.exports = {
  AGENT_RUNTIME_IDS,
  AGENT_RUNTIME_ID,
  DEFAULT_AGENT_RUNTIME_ID,
  getDefaultAgentRuntimeId,
  normalizeAgentRuntimeId,
};
