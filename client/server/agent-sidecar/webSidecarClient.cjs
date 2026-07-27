const crypto = require('node:crypto');
const {
  SIDE_CAR_ERROR_CODES,
  buildRunnerCreatePath,
  buildRunnerCancelPath,
  buildRunnerStatusPath,
  normalizeExecutionEnvelope,
  createSidecarError,
} = require('../../shared/contracts/agent-sidecar/sidecarProtocolV1.cjs');

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function normalizeRunnerUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw createSidecarError('Agent Runner URL 不可用', 'AGENT_SANDBOX_UNAVAILABLE', { statusCode: 503, retryable: true });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw createSidecarError('Agent Runner URL 不可用', 'AGENT_SANDBOX_UNAVAILABLE', { statusCode: 503, retryable: true });
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

function sidecarErrorFromResponse(status, body) {
  const code = String(body?.error?.code || (status === 503 ? 'AGENT_SANDBOX_UNAVAILABLE' : SIDE_CAR_ERROR_CODES.INTERNAL));
  const error = createSidecarError(
    code === 'AGENT_SANDBOX_UNAVAILABLE' ? 'Agent Sidecar 暂不可用' : `Agent Sidecar 请求失败：${code}`,
    code,
    { statusCode: status, retryable: Boolean(body?.error?.retryable) || status === 429 || status >= 500 },
  );
  if (body?.error?.retryAfterSeconds) error.retryAfterSeconds = Number(body.error.retryAfterSeconds);
  return error;
}

function createWebSidecarAgentAdapter({
  workspaceId,
  workspaceGeneration,
  tokenManager,
  internalApi,
  runnerUrl = process.env.AGENT_SIDECAR_URL || 'http://agent-runner:7101',
  agentListenerUrl = process.env.AGENT_INTERNAL_URL || '',
  fetchImpl = globalThis.fetch,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  now = () => Date.now(),
} = {}) {
  if (!workspaceId || !Number.isInteger(workspaceGeneration) || workspaceGeneration <= 0) {
    throw new TypeError('Web Sidecar adapter 缺少 workspace 身份');
  }
  if (!tokenManager || typeof tokenManager.issueDispatchToken !== 'function') {
    throw new TypeError('Web Sidecar adapter 需要 Web token issuer');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('Web Sidecar adapter 需要 fetch');
  const baseUrl = normalizeRunnerUrl(runnerUrl);
  const active = new Map();
  let closing = false;

  async function request(path, { method = 'GET', token, body, signal } = {}) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      signal,
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (!response.ok) throw sidecarErrorFromResponse(response.status, payload);
    return payload;
  }

  async function issueProxyTokens(envelope) {
    if (internalApi && typeof internalApi.issueExecutionTokens === 'function') {
      return internalApi.issueExecutionTokens(envelope);
    }
    if (!tokenManager.issueProxyToken) {
      throw createSidecarError('Web internal listener 未提供 token issuer', 'AGENT_PROXY_UNAVAILABLE', { statusCode: 503, retryable: true });
    }
    const issue = (method, path, maxCalls) => tokenManager.issueProxyToken({
      workspaceId: envelope.workspaceId,
      workspaceGeneration: envelope.workspaceGeneration,
      executionId: envelope.executionId,
      taskSpecId: envelope.taskSpecId,
      manifestHash: envelope.manifestHash,
      method,
      path,
      maxCalls,
    });
    return {
      proxyToken: issue('POST', '/internal/agent/v1/chat/completions', envelope.proxyMaxCalls || 16),
      capabilityToken: issue('GET', `/internal/agent/v1/executions/${encodeURIComponent(envelope.executionId)}/capability`, 16),
      cancelToken: issue('DELETE', buildRunnerCancelPath(envelope.executionId), 8),
      statusToken: issue('GET', buildRunnerStatusPath(envelope.executionId), 16),
    };
  }

  async function run({
    taskSpec,
    executionId = crypto.randomUUID(),
    runId,
    input = {},
    prompt = '',
    modelSnapshot,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    inputFiles = {},
  } = {}) {
    if (closing) throw createSidecarError('Web Sidecar adapter 正在关闭', 'AGENT_CLOSING', { statusCode: 503, retryable: true });
    const taskSpecId = String(taskSpec?.id || 'agent-task').trim();
    const effectiveExecutionId = String(executionId || '').trim() || crypto.randomUUID();
    const modelName = String(modelSnapshot?.modelName || 'default').trim();
    const manifestHash = sha256({ taskSpecId, taskSpecVersion: taskSpec?.version || 1, input, runId: runId || '' });
    const rawEnvelope = {
      executionId: effectiveExecutionId,
      workspaceId,
      workspaceGeneration,
      taskSpecId,
      manifestHash,
      input,
      requestModel: modelName,
      resultFileName: 'result.json',
      resultMaxBytes: Math.min(Number(taskSpec?.limits?.maxOutputBytes) || 4 * 1024 * 1024, 4 * 1024 * 1024),
      proxyMaxCalls: Math.min(Number(taskSpec?.limits?.maxModelCalls) || 16, 128),
      callback: { event: 'agent.execution.completed', retries: 2 },
      expiresAt: now() + Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS) + 60_000,
      agentListenerUrl,
      inputFiles: { ...inputFiles, 'input/task-spec.json': JSON.stringify({ id: taskSpecId, version: taskSpec?.version || 1 }) },
      prompt: String(prompt || `读取 input/ 中的输入，执行 ${taskSpecId}，将严格符合 Task Spec 的 JSON 结果写入 result.json。`),
    };
    const envelope = normalizeExecutionEnvelope(rawEnvelope);
    const proxyTokens = await issueProxyTokens(envelope);
    const { inputChecksum: _inputChecksum, inputSizeBytes: _inputSizeBytes, ...wireEnvelope } = envelope;
    const requestEnvelope = { ...wireEnvelope, ...proxyTokens };
    const dispatchToken = tokenManager.issueDispatchToken({
      workspaceId,
      workspaceGeneration,
      executionId: effectiveExecutionId,
      taskSpecId,
      manifestHash,
    });
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(createSidecarError('Agent Sidecar 执行超时', 'AGENT_TIMEOUT', { statusCode: 504, retryable: true })), Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS));
    timer.unref?.();
    const abort = () => timeoutController.abort(signal?.reason || createSidecarError('Agent Sidecar 执行已取消', 'AGENT_CANCELLED', { statusCode: 499, retryable: true }));
    if (signal?.aborted) abort();
    else signal?.addEventListener?.('abort', abort, { once: true });
    const runRecord = { executionId: effectiveExecutionId, cancelToken: proxyTokens.cancelToken, statusToken: proxyTokens.statusToken, controller: timeoutController };
    active.set(effectiveExecutionId, runRecord);
    try {
      const created = await request(buildRunnerCreatePath(), { method: 'POST', token: dispatchToken, body: requestEnvelope, signal: timeoutController.signal });
      while (true) {
        const status = await request(buildRunnerStatusPath(effectiveExecutionId), { token: created.statusToken || proxyTokens.statusToken, signal: timeoutController.signal });
        if (status.status === 'succeeded') {
          const result = status.result || {};
          return {
            output: result.result || result.output || result,
            outputSha256: result.outputSha256 || status.resultHash || sha256(result),
            diagnostics: result.diagnostics,
          };
        }
        if (status.status === 'failed') {
          const failure = status.failure || {};
          throw createSidecarError(`Agent Sidecar execution 失败：${failure.code || 'AGENT_RUNTIME_FAILED'}${failure.message ? `（${failure.message}）` : ''}`, failure.code || 'AGENT_RUNTIME_FAILED', { statusCode: 502, retryable: failure.retryable === true });
        }
        if (status.status === 'cancelled') throw createSidecarError('Agent Sidecar execution 已取消', 'AGENT_CANCELLED', { statusCode: 499, retryable: true });
        await new Promise((resolve, reject) => {
          const waitTimer = setTimeout(resolve, pollIntervalMs);
          waitTimer.unref?.();
          timeoutController.signal.addEventListener('abort', () => { clearTimeout(waitTimer); reject(timeoutController.signal.reason); }, { once: true });
        });
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
      active.delete(effectiveExecutionId);
    }
  }

  async function runTask(payload = {}, options = {}) {
    const taskId = String(payload.task_id || crypto.randomUUID()).trim();
    const result = await run({
      executionId: taskId,
      taskSpec: { id: 'agent.task', version: 1, limits: { maxOutputBytes: 4 * 1024 * 1024, maxModelCalls: 16 } },
      input: { title: payload.title || '', task: payload.task || payload.prompt || '' },
      inputFiles: Object.fromEntries((Array.isArray(payload.files) ? payload.files : []).map((item) => [item.path, item.content || ''])),
      prompt: `${String(payload.task || payload.prompt || '').trim()}\n\n只允许读取 input/，只允许使用 read/glob/grep/write；禁止 bash、联网、task、skill。最终 JSON 必须写入 result.json。`,
      timeoutMs: payload.timeout_ms,
      signal: options.signal,
    });
    return {
      success: true,
      runtime_id: 'opencode-sidecar',
      task_id: taskId,
      output_file: 'result.json',
      output_content: JSON.stringify(result.output),
      output_sha256: result.outputSha256,
      diagnostics: result.diagnostics || {},
    };
  }

  async function cancel(executionId, reason = 'user-cancel') {
    const record = active.get(executionId);
    if (!record) return false;
    record.controller.abort(createSidecarError('Agent Sidecar execution 已取消', 'AGENT_CANCELLED', { statusCode: 499, retryable: true }));
    try {
      await request(buildRunnerCancelPath(executionId), { method: 'DELETE', token: record.cancelToken, body: { reason } });
    } catch {}
    return true;
  }

  async function selfCheck() {
    try {
      const body = await request('/internal/runner/v1/health');
      return { success: body.ready === true, runtime_id: 'opencode-sidecar', status: body.ready ? 'normal' : 'error', detail_text: body.ready ? 'Sidecar Runner 就绪' : 'Sidecar Runner 不可用' };
    } catch (error) {
      return { success: false, runtime_id: 'opencode-sidecar', status: 'error', detail_text: error.code || 'AGENT_SANDBOX_UNAVAILABLE' };
    }
  }

  async function close() {
    closing = true;
    await Promise.allSettled(Array.from(active.keys()).map((executionId) => cancel(executionId, 'shutdown')));
  }

  function getStatus() {
    return {
      runtime_id: 'opencode-sidecar',
      phase: active.size ? 'running' : 'idle',
      healthy: !closing,
      queued_count: 0,
      active_task: active.size ? { execution_id: Array.from(active.keys())[0] } : null,
    };
  }

  return Object.freeze({
    run,
    runTask,
    selfCheck,
    listRuntimes: () => [{ id: 'opencode-sidecar', display_name: 'OpenCode Agent Sidecar', is_default: true }],
    bindSelectedRuntime: () => ({ runtimeId: 'opencode-sidecar', runTask, getStatus }),
    getStatus,
    getActivitySnapshot: () => ({ reserved: 0, admitting: 0, active: active.size, queued: 0, cleanup: 0 }),
    cancelWorkspace: (reason) => { void Promise.all(Array.from(active.keys()).map((executionId) => cancel(executionId, reason || 'workspace-close'))); return active.size; },
    close,
  });
}

module.exports = {
  DEFAULT_POLL_INTERVAL_MS,
  createWebSidecarAgentAdapter,
  normalizeRunnerUrl,
  sha256,
};
