const { createSidecarError, SIDE_CAR_ERROR_CODES } = require('../../shared/contracts/agent-sidecar/sidecarProtocolV1.cjs');

function createInternalAiChatHandler({ workspaceId, aiService, modelSnapshotResolver }) {
  if (!workspaceId || !aiService || typeof aiService.chatCompletionsRaw !== 'function') {
    throw new TypeError('Internal AI adapter 缺少 workspaceId 或 raw chat service');
  }
  if (typeof aiService.captureTextModelSnapshot !== 'function' && typeof modelSnapshotResolver !== 'function') {
    throw new TypeError('Internal AI adapter 缺少模型快照能力');
  }

  return async function handleChat(request, { executionId } = {}) {
    if (request?.stream === true) {
      throw createSidecarError('Agent streaming protocol 尚未开放', SIDE_CAR_ERROR_CODES.PROTOCOL_UNSUPPORTED, { statusCode: 501 });
    }
    const snapshot = Object.freeze(
      typeof modelSnapshotResolver === 'function'
        ? modelSnapshotResolver(executionId)
        : aiService.captureTextModelSnapshot(),
    );
    if (!snapshot?.modelName) {
      throw createSidecarError('Agent 模型快照不可用', 'AGENT_MODEL_SNAPSHOT_UNAVAILABLE', { statusCode: 503, retryable: true });
    }
    const queueScopeId = `${workspaceId}:${String(executionId || '').trim()}`;
    const scopedAi = typeof aiService.withQueueScope === 'function'
      ? aiService.withQueueScope(queueScopeId, { modelSnapshot: snapshot })
      : aiService;
    const body = {
      ...request,
      model: snapshot.modelName,
      stream: false,
    };
    delete body.executionId;
    delete body.messagesHash;
    return scopedAi.chatCompletionsRaw(body, { modelSnapshot: snapshot, queueScopeId });
  };
}

module.exports = { createInternalAiChatHandler };
