const {
  AGENT_RUNTIME_ID,
  AGENT_RUNTIME_IDS,
  getDefaultAgentRuntimeId,
  normalizeAgentRuntimeId,
} = require('../../../core/agentRuntimeIds.cjs');

const runtimeById = new Map([
  [AGENT_RUNTIME_ID.OPENCODE, {
    displayName: 'OpenCode Agent',
    description: '使用现有常驻 OpenCode Server 智能体链路。',
    createRuntime(options) {
      const { createOpenCodeRuntimeService } = require('../opencode/opencodeRuntimeService.cjs');
      return createOpenCodeRuntimeService(options);
    },
  }],
  [AGENT_RUNTIME_ID.PI, {
    displayName: 'Pi Agent',
    description: '使用内嵌 Pi SDK 智能体链路。',
    createRuntime(options) {
      const { createPiRuntimeService } = require('../pi/piRuntimeService.cjs');
      return createPiRuntimeService(options);
    },
  }],
]);

if (!AGENT_RUNTIME_IDS.every((id) => runtimeById.has(id))) {
  throw new Error('智能体运行时注册表缺少完整实现映射');
}

const defaultRuntimeId = getDefaultAgentRuntimeId();

if (!runtimeById.has(defaultRuntimeId)) {
  throw new Error('智能体运行时注册表缺少默认实现');
}

// 返回可安全发送给 Renderer 的运行时元数据。
function listAgentRuntimeDescriptors() {
  return AGENT_RUNTIME_IDS.map((id) => {
    const definition = runtimeById.get(id);
    return {
      id,
      display_name: definition.displayName,
      description: definition.description,
      is_default: id === defaultRuntimeId,
    };
  });
}

function getAgentRuntimeDefinition(runtimeId) {
  const normalizedId = normalizeAgentRuntimeId(runtimeId);
  const definition = runtimeById.get(normalizedId);
  return {
    id: normalizedId,
    displayName: definition.displayName,
    description: definition.description,
    isDefault: normalizedId === defaultRuntimeId,
    createRuntime: definition.createRuntime,
  };
}

function createAgentRuntime(runtimeId, options) {
  const definition = getAgentRuntimeDefinition(runtimeId);
  return definition.createRuntime({
    ...options,
    runtime: {
      id: definition.id,
      displayName: definition.displayName,
      description: definition.description,
    },
  });
}

module.exports = {
  createAgentRuntime,
  getAgentRuntimeDefinition,
  getDefaultAgentRuntimeId,
  listAgentRuntimeDescriptors,
  normalizeAgentRuntimeId,
};
