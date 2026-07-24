const AGENT_RUNTIME_ID = Object.freeze({
  OPENCODE: 'opencode',
  PI: 'pi',
});
const AGENT_RUNTIME_IDS = Object.freeze(Object.values(AGENT_RUNTIME_ID));
const DEFAULT_AGENT_RUNTIME_ID = AGENT_RUNTIME_ID.OPENCODE;

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
