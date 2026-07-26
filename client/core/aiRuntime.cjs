const { createAiRequestQueue } = require('./aiRequestQueue.cjs');
const { createTextTokenStatsStore } = require('./textTokenStatsStore.cjs');

const DEFAULT_TIMEOUTS = Object.freeze({
  text: 600000,
  listModels: 600000,
});
const MAX_ATTEMPTS = 3;
const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;
const RETRYABLE_STATUS_CODES = new Set([408, 429]);
const SAFE_ERROR_CODES = new Set([
  'AI_CONFIG_LOAD_FAILED',
  'AI_CONFIG_INVALID',
  'AI_HTTP_ERROR',
  'AI_INVALID_REQUEST',
  'AI_JSON_PARSE_ERROR',
  'AI_NETWORK_ERROR',
  'AI_REQUEST_FAILED',
  'AI_REQUEST_TIMEOUT',
  'AI_REQUEST_ABORTED',
  'AI_QUEUE_OVERLOADED',
  'AI_RESPONSE_INVALID',
  'AI_RESPONSE_PARSE_ERROR',
  'AI_ENDPOINT_NOT_ALLOWED',
  'WEB_CAPABILITY_PENDING',
]);
const CHAT_BODY_FIELDS = Object.freeze([
  'messages',
  'model',
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'response_format',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'seed',
  'stop',
  'presence_penalty',
  'frequency_penalty',
  'n',
  'user',
]);

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  const normalized = Math.floor(number);
  return normalized > 0 ? normalized : fallback;
}

function normalizeTimeouts(options) {
  const source = options && typeof options === 'object' ? options : {};
  const nested = source.timeouts && typeof source.timeouts === 'object' ? source.timeouts : {};
  return {
    text: normalizePositiveInteger(
      nested.text
        ?? nested.chat
        ?? nested.request
        ?? nested.requestMs
        ?? source.timeoutMs
        ?? source.timeout_ms
        ?? source.requestTimeoutMs,
      DEFAULT_TIMEOUTS.text,
    ),
    listModels: normalizePositiveInteger(
      nested.listModels ?? nested.models ?? source.listModelsTimeoutMs,
      DEFAULT_TIMEOUTS.listModels,
    ),
  };
}

function normalizeWorkspaceKey(workspaceKey) {
  const normalized = String(workspaceKey || '').trim();
  if (!normalized) {
    throw new Error('workspace/account key 不能为空');
  }
  return normalized;
}

function normalizeScopeId(scopeId) {
  return String(scopeId || '').trim();
}

function trimBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function appendEndpoint(baseUrl, endpoint) {
  const normalizedBaseUrl = trimBaseUrl(baseUrl);
  return normalizedBaseUrl ? `${normalizedBaseUrl}/${endpoint}` : '';
}

function normalizeEndpointHost(baseUrl) {
  const rawValue = String(baseUrl || '').trim();
  if (!rawValue) {
    return '';
  }

  try {
    const candidate = rawValue.includes('://') ? rawValue : `https://${rawValue}`;
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (normalizeText(value)) {
      return value;
    }
  }
  return '';
}

function isMaskedApiKey(value) {
  return /^\*{4}/.test(normalizeText(value));
}

function readTextModelConfig(source, fallbackProvider = '') {
  const config = source && typeof source === 'object' ? source : {};
  const provider = firstNonEmpty(config.text_model_provider, config.provider, fallbackProvider) || 'custom';
  const profiles = config.text_model_profiles && typeof config.text_model_profiles === 'object'
    ? config.text_model_profiles
    : {};
  const profile = profiles[provider] && typeof profiles[provider] === 'object' ? profiles[provider] : {};

  return {
    provider,
    apiKey: firstNonEmpty(config.api_key, config.apiKey, profile.api_key, profile.apiKey),
    baseUrl: firstNonEmpty(config.base_url, config.baseUrl, profile.base_url, profile.baseUrl),
    modelName: firstNonEmpty(config.model_name, config.modelName, profile.model_name, profile.modelName),
  };
}

function readSavedTextModelConfigForProvider(source, provider) {
  const config = source && typeof source === 'object' ? source : {};
  const profiles = config.text_model_profiles && typeof config.text_model_profiles === 'object'
    ? config.text_model_profiles
    : {};
  const profile = profiles[provider] && typeof profiles[provider] === 'object'
    ? profiles[provider]
    : {};
  return readTextModelConfig({
    text_model_provider: provider,
    text_model_profiles: { [provider]: profile },
  }, provider);
}

function firstPlainNonEmpty(...values) {
  for (const value of values) {
    if (normalizeText(value) && !isMaskedApiKey(value)) {
      return value;
    }
  }
  return '';
}

function resolveImageModelConfig(savedConfig, override) {
  const savedActive = savedConfig?.image_model && typeof savedConfig.image_model === 'object'
    ? savedConfig.image_model
    : {};
  const selectedProvider = firstNonEmpty(
    override?.model_provider,
    override?.provider,
    override?.image_model?.provider,
    savedActive.provider,
  );
  const savedProfiles = savedConfig?.image_model_profiles && typeof savedConfig.image_model_profiles === 'object'
    ? savedConfig.image_model_profiles
    : {};
  const savedSelected = selectedProvider && savedProfiles[selectedProvider] && typeof savedProfiles[selectedProvider] === 'object'
    ? savedProfiles[selectedProvider]
    : {};
  const sameAsSavedProvider = selectedProvider === savedActive.provider;
  const savedFallback = {
    apiKey: firstNonEmpty(savedSelected.api_key, savedSelected.apiKey, sameAsSavedProvider ? savedActive.api_key : ''),
    baseUrl: firstNonEmpty(savedSelected.base_url, savedSelected.baseUrl, sameAsSavedProvider ? savedActive.base_url : ''),
    modelName: firstNonEmpty(savedSelected.model_name, savedSelected.modelName, sameAsSavedProvider ? savedActive.model_name : ''),
  };
  const overrideApiKeyValues = [
    override?.api_key,
    override?.apiKey,
    override?.image_model?.api_key,
    override?.image_model?.apiKey,
    override?.image_model_profiles?.[selectedProvider]?.api_key,
    override?.image_model_profiles?.[selectedProvider]?.apiKey,
  ];
  const plainOverrideApiKey = firstPlainNonEmpty(...overrideApiKeyValues);
  const anyOverrideApiKey = firstNonEmpty(...overrideApiKeyValues);

  return {
    provider: selectedProvider,
    apiKey: plainOverrideApiKey
      || (isMaskedApiKey(anyOverrideApiKey) ? savedFallback.apiKey : firstNonEmpty(anyOverrideApiKey, savedFallback.apiKey)),
    baseUrl: firstNonEmpty(
      override?.base_url,
      override?.baseUrl,
      override?.image_model?.base_url,
      override?.image_model?.baseUrl,
      savedFallback.baseUrl,
    ),
    modelName: firstNonEmpty(
      override?.model_name,
      override?.modelName,
      override?.image_model?.model_name,
      override?.image_model?.modelName,
      savedFallback.modelName,
    ),
  };
}

function resolveTextModelConfig(savedConfig, override) {
  const saved = readTextModelConfig(savedConfig);
  if (!override || typeof override !== 'object') {
    return saved;
  }

  const selectedProvider = firstNonEmpty(
    override.text_model_provider,
    override.provider,
    saved.provider,
  ) || saved.provider;
  const candidate = readTextModelConfig(override, selectedProvider);
  const savedSelected = readSavedTextModelConfigForProvider(savedConfig, selectedProvider);
  const sameAsSavedProvider = selectedProvider === saved.provider;
  const savedFallback = {
    apiKey: firstNonEmpty(savedSelected.apiKey, sameAsSavedProvider ? saved.apiKey : ''),
    baseUrl: firstNonEmpty(savedSelected.baseUrl, sameAsSavedProvider ? saved.baseUrl : ''),
    modelName: firstNonEmpty(savedSelected.modelName, sameAsSavedProvider ? saved.modelName : ''),
  };
  const overrideApiKeyValues = [
    override.api_key,
    override.apiKey,
    override.text_model_profiles?.[selectedProvider]?.api_key,
    override.text_model_profiles?.[selectedProvider]?.apiKey,
  ];
  const plainOverrideApiKey = firstPlainNonEmpty(...overrideApiKeyValues);
  const anyOverrideApiKey = firstNonEmpty(...overrideApiKeyValues);
  const apiKey = plainOverrideApiKey
    || (isMaskedApiKey(anyOverrideApiKey) ? savedFallback.apiKey : firstNonEmpty(anyOverrideApiKey, savedFallback.apiKey));

  return {
    provider: selectedProvider,
    apiKey,
    baseUrl: firstNonEmpty(candidate.baseUrl, savedFallback.baseUrl),
    modelName: firstNonEmpty(candidate.modelName, savedFallback.modelName),
  };
}

function resolveModelConfig(savedConfig, override) {
  if (override?.model_kind === 'image') {
    return resolveImageModelConfig(savedConfig, override);
  }
  return resolveTextModelConfig(savedConfig, override);
}

function createRuntimeError(message, code, options = {}) {
  const error = new Error(message);
  error.code = code;
  if (options.status) {
    error.status = options.status;
  }
  error.retryable = Boolean(options.retryable);
  return error;
}

function sanitizeRuntimeError(error, fallbackMessage = 'AI 请求失败') {
  if (error && SAFE_ERROR_CODES.has(error.code) && error.message && error instanceof Error) {
    return error;
  }
  if (error?.code === 'AI_REQUEST_ABORTED') {
    return error;
  }
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    return createRuntimeError('AI 请求超时', 'AI_REQUEST_TIMEOUT', { retryable: true });
  }
  return createRuntimeError(fallbackMessage, 'AI_NETWORK_ERROR', { retryable: true });
}

function isRetryableStatus(status) {
  const normalized = Number(status);
  return RETRYABLE_STATUS_CODES.has(normalized) || (normalized >= 500 && normalized <= 599);
}

function createHttpError(status) {
  const normalizedStatus = Number(status) || 0;
  return createRuntimeError(
    normalizedStatus ? `AI 上游请求失败（HTTP ${normalizedStatus}）` : 'AI 上游请求失败',
    'AI_HTTP_ERROR',
    { status: normalizedStatus, retryable: isRetryableStatus(normalizedStatus) },
  );
}

function isResponseOk(response) {
  if (!response || typeof response !== 'object') {
    return false;
  }
  if (response.ok === true) {
    return true;
  }
  const status = Number(response.status);
  return status >= 200 && status < 300;
}

function normalizeTokenNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function normalizeTokenUsage(usage) {
  const source = usage && typeof usage === 'object' ? usage : {};
  const promptTokens = normalizeTokenNumber(source.prompt_tokens ?? source.promptTokens ?? source.promptTokenCount);
  const completionTokens = normalizeTokenNumber(
    source.completion_tokens
    ?? source.completionTokens
    ?? source.completionTokenCount
    ?? source.candidatesTokenCount,
  );
  const totalTokens = normalizeTokenNumber(source.total_tokens ?? source.totalTokens ?? source.totalTokenCount)
    || promptTokens + completionTokens;
  const promptDetails = source.prompt_tokens_details
    || source.promptTokensDetails
    || source.input_token_details
    || source.inputTokenDetails
    || {};
  const cachedTokens = normalizeTokenNumber(
    source.cached_tokens
    ?? source.cachedTokens
    ?? source.prompt_cached_tokens
    ?? source.promptCachedTokens
    ?? promptDetails.cached_tokens
    ?? promptDetails.cachedTokens
    ?? promptDetails.cache_read
    ?? promptDetails.cacheRead,
  );

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    cached_tokens: cachedTokens,
  };
}

function buildChatBody(modelConfig, request) {
  const source = request && typeof request === 'object' ? request : {};
  const body = {};
  for (const field of CHAT_BODY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      body[field] = source[field];
    }
  }

  if (!body.model) {
    body.model = modelConfig.modelName;
  }
  if (!body.messages && Array.isArray(source.messages)) {
    body.messages = source.messages;
  }
  body.stream = false;

  if (!Array.isArray(body.messages)) {
    throw createRuntimeError('AI 请求缺少 messages', 'AI_INVALID_REQUEST');
  }
  if (!normalizeText(body.model)) {
    throw createRuntimeError('AI 请求缺少模型名称', 'AI_INVALID_REQUEST');
  }

  return body;
}

function extractMessageContent(message) {
  if (typeof message?.content === 'string') {
    return message.content;
  }
  if (Array.isArray(message?.content)) {
    return message.content
      .map((part) => (typeof part === 'string' ? part : part?.text || part?.content || ''))
      .join('');
  }
  return '';
}

function extractBalancedJsonCandidates(content) {
  const text = String(content || '');
  const candidates = [];

  for (let start = 0; start < text.length; start += 1) {
    const firstChar = text[start];
    if (firstChar !== '{' && firstChar !== '[') {
      continue;
    }

    const stack = [firstChar];
    let inString = false;
    let escaped = false;
    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{' || char === '[') {
        stack.push(char);
        continue;
      }
      if (char !== '}' && char !== ']') {
        continue;
      }

      const expectedOpen = char === '}' ? '{' : '[';
      if (stack[stack.length - 1] !== expectedOpen) {
        break;
      }
      stack.pop();
      if (!stack.length) {
        candidates.push(text.slice(start, index + 1).trim());
        start = index;
        break;
      }
    }
  }

  return candidates;
}

function extractFencedJsonCandidates(content) {
  const blocks = [];
  const normalized = String(content || '').trim();
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match = fenceRegex.exec(normalized);
  while (match) {
    const block = String(match[1] || '').trim();
    if (block) {
      blocks.push(block);
    }
    match = fenceRegex.exec(normalized);
  }
  return blocks;
}

function parseJsonResponseContent(content) {
  const normalized = String(content || '').replace(/^\uFEFF/, '').trim();
  const candidates = [
    normalized,
    ...extractFencedJsonCandidates(normalized),
    ...extractBalancedJsonCandidates(normalized),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // 继续尝试下一种安全候选内容。
    }
  }

  throw createRuntimeError('AI 返回内容无法解析为 JSON', 'AI_JSON_PARSE_ERROR');
}

function applyJsonRequestContract(request, parsed) {
  const source = request && typeof request === 'object' ? request : {};
  try {
    const normalized = typeof source.normalizer === 'function' ? source.normalizer(parsed) : parsed;
    if (typeof source.validator === 'function') {
      source.validator(normalized);
    }
    return normalized;
  } catch {
    throw createRuntimeError('AI 返回内容未通过 JSON 校验', 'AI_JSON_PARSE_ERROR');
  }
}

function createDefaultFetch() {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('当前运行环境缺少 fetch');
  }
  return globalThis.fetch.bind(globalThis);
}

function waitForRetry(delay) {
  const normalizedDelay = Number(delay);
  if (!Number.isFinite(normalizedDelay) || normalizedDelay <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, Math.floor(normalizedDelay)));
}

function createRetryWaiter(retryDelay) {
  return async (attempt, error) => {
    if (typeof retryDelay === 'function') {
      try {
        await retryDelay(attempt, error);
      } catch {
        // 延迟注入器失败时直接进入下一次尝试。
      }
      return;
    }

    if (retryDelay !== undefined) {
      await waitForRetry(retryDelay);
      return;
    }

    await waitForRetry(250 * (2 ** Math.max(0, attempt - 1)));
  };
}

function createRequestControl(timeoutMs, externalSignal) {
  const controller = new AbortController();
  let timedOut = false;
  let aborted = false;
  let rejectControl;
  const controlPromise = new Promise((_resolve, reject) => {
    rejectControl = reject;
  });
  const abortWithError = (error) => {
    controller.abort();
    rejectControl(error);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    abortWithError(createRuntimeError('AI 请求超时', 'AI_REQUEST_TIMEOUT', { retryable: true }));
  }, timeoutMs);
  timer.unref?.();
  const onAbort = () => {
    aborted = true;
    abortWithError(createRuntimeError('AI 请求已取消', 'AI_REQUEST_ABORTED'));
  };
  if (externalSignal) {
    if (externalSignal.aborted) {
      onAbort();
    } else {
      externalSignal.addEventListener('abort', onAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    race: (promise) => Promise.race([Promise.resolve(promise), controlPromise]),
    finish() {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onAbort);
    },
    getError(error) {
      if (timedOut) {
        return createRuntimeError('AI 请求超时', 'AI_REQUEST_TIMEOUT', { retryable: true });
      }
      if (aborted) {
        return createRuntimeError('AI 请求已取消', 'AI_REQUEST_ABORTED');
      }
      return error;
    },
  };
}

function getContentLength(response) {
  const raw = response?.headers?.get?.('content-length')
    ?? response?.headers?.['content-length']
    ?? response?.headers?.['Content-Length'];
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // 取消响应体失败不影响主错误返回。
  }
}

function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw createRuntimeError('AI 上游响应格式无效', 'AI_RESPONSE_PARSE_ERROR');
  }
}

async function readJsonResponse(response, requestControl) {
  const contentLength = getContentLength(response);
  if (contentLength !== null && contentLength > MAX_JSON_RESPONSE_BYTES) {
    await cancelResponseBody(response);
    throw createRuntimeError('AI 上游响应过大', 'AI_RESPONSE_PARSE_ERROR');
  }

  if (response?.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await requestControl.race(reader.read());
        if (done) {
          break;
        }
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > MAX_JSON_RESPONSE_BYTES) {
          await reader.cancel();
          throw createRuntimeError('AI 上游响应过大', 'AI_RESPONSE_PARSE_ERROR');
        }
        chunks.push(chunk);
      }
      return parseJsonText(Buffer.concat(chunks, total).toString('utf8'));
    } catch (error) {
      await cancelResponseBody(response);
      throw error;
    }
  }

  if (typeof response?.json === 'function') {
    try {
      return await requestControl.race(response.json());
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw createRuntimeError('AI 上游响应格式无效', 'AI_RESPONSE_PARSE_ERROR');
      }
      throw error;
    }
  }
  const text = typeof response?.text === 'function' ? await requestControl.race(response.text()) : '';
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_RESPONSE_BYTES) {
    throw createRuntimeError('AI 上游响应过大', 'AI_RESPONSE_PARSE_ERROR');
  }
  return parseJsonText(text);
}

function createAiRuntime(options = {}) {
  const workspaceKey = normalizeWorkspaceKey(options.workspaceKey);
  const loadConfig = options.loadConfig;
  if (typeof loadConfig !== 'function') {
    throw new Error('createAiRuntime 需要 loadConfig 函数');
  }

  const sharedCoordinator = options.sharedCoordinator || options.coordinator;
  if (!sharedCoordinator || typeof sharedCoordinator.enqueue !== 'function') {
    throw new Error('createAiRuntime 需要共享 AI coordinator');
  }

  const fetchImpl = options.fetch || createDefaultFetch();
  if (typeof fetchImpl !== 'function') {
    throw new Error('createAiRuntime 的 fetch 必须为函数');
  }

  const queue = createAiRequestQueue({
    coordinator: sharedCoordinator,
    workspaceKey,
    textLimit: 10,
    imageLimit: 2,
  });
  const textTokenStats = createTextTokenStatsStore();
  const timeouts = normalizeTimeouts(options);
  const waitBeforeRetry = createRetryWaiter(options.retryDelay ?? options.retryDelayMs);
  const trackRequest = typeof options.trackRequest === 'function' ? options.trackRequest : null;
  const endpointPolicy = options.endpointPolicy;
  const version = normalizeText(options.version);
  const platform = normalizeText(options.platform) || process.platform;
  const arch = normalizeText(options.arch) || process.arch;
  let closePromise = null;
  let endpointPolicyClosePromise = null;

  function getScopeId(request, fallbackScopeId) {
    return normalizeScopeId(
      request?.queueScopeId
      || request?.queue_scope_id
      || fallbackScopeId,
    );
  }

  function loadConfigSafely() {
    try {
      return loadConfig() || {};
    } catch {
      throw createRuntimeError('AI 配置读取失败', 'AI_CONFIG_LOAD_FAILED');
    }
  }

  function buildAnalyticsPayload(modelConfig, config, usage) {
    const tokenUsage = normalizeTokenUsage(usage);
    return {
      ai_request_type: 'text',
      ai_model_provider: normalizeText(modelConfig.provider),
      prompt_tokens: tokenUsage.prompt_tokens,
      completion_tokens: tokenUsage.completion_tokens,
      total_tokens: tokenUsage.total_tokens,
      version,
      platform,
      arch,
      client_id: normalizeText(config?.analytics_client_id),
      client_created_at: normalizeText(config?.analytics_created_at),
    };
  }

  function trackSafely(modelConfig, config, usage) {
    if (!trackRequest) {
      return;
    }
    const payload = buildAnalyticsPayload(modelConfig, config, usage);
    try {
      void Promise.resolve(trackRequest(payload)).catch(() => undefined);
    } catch {
      // 统计上报失败不能影响 AI 请求。
    }
  }

  function extractEndpointRequestOptions(policyResult) {
    if (policyResult === true || policyResult === undefined || policyResult === null) {
      return {};
    }
    if (policyResult === false || typeof policyResult !== 'object') {
      throw createRuntimeError('AI 上游地址不允许', 'AI_ENDPOINT_NOT_ALLOWED');
    }
    if (policyResult.requestOptions && typeof policyResult.requestOptions === 'object') {
      return policyResult.requestOptions;
    }
    if (Object.prototype.hasOwnProperty.call(policyResult, 'dispatcher') && policyResult.dispatcher) {
      return { dispatcher: policyResult.dispatcher };
    }
    return {};
  }

  async function resolveEndpointRequestOptions(url, operation) {
    if (!endpointPolicy) {
      return {};
    }

    const validate = typeof endpointPolicy === 'function'
      ? endpointPolicy
      : endpointPolicy && (endpointPolicy.assertAllowed || endpointPolicy.validate);
    if (typeof validate !== 'function') {
      throw createRuntimeError('AI 上游地址校验失败', 'AI_ENDPOINT_NOT_ALLOWED');
    }

    try {
      const result = await validate.call(endpointPolicy, url, { operation });
      return extractEndpointRequestOptions(result);
    } catch {
      // endpoint policy 的底层异常可能包含 URL、DNS 信息或实现细节，统一收敛为安全错误。
      throw createRuntimeError('AI 上游地址不允许', 'AI_ENDPOINT_NOT_ALLOWED');
    }
  }

  function closeEndpointPolicy() {
    if (!endpointPolicy || typeof endpointPolicy.close !== 'function') {
      return Promise.resolve();
    }

    if (endpointPolicyClosePromise) {
      return endpointPolicyClosePromise;
    }

    const attempt = Promise.resolve().then(() => endpointPolicy.close());
    endpointPolicyClosePromise = attempt;
    void attempt.then(
      () => undefined,
      () => {
        if (endpointPolicyClosePromise === attempt) {
          endpointPolicyClosePromise = null;
        }
      },
    );
    return attempt;
  }

  async function runWithRetry(operation, timeoutMs, executionOptions = {}) {
    let lastError = null;
    const deadlineAt = Date.now() + timeoutMs;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) {
          throw createRuntimeError('AI 请求超时', 'AI_REQUEST_TIMEOUT', { retryable: true });
        }
        return await operation({
          timeoutMs: remainingMs,
          signal: executionOptions.signal,
        });
      } catch (error) {
        lastError = sanitizeRuntimeError(error);
        if (!lastError.retryable || attempt >= MAX_ATTEMPTS) {
          throw lastError;
        }
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) {
          throw createRuntimeError('AI 请求超时', 'AI_REQUEST_TIMEOUT', { retryable: true });
        }
        const retryControl = createRequestControl(remainingMs, executionOptions.signal);
        try {
          await retryControl.race(waitBeforeRetry(attempt, lastError));
        } catch (retryError) {
          throw sanitizeRuntimeError(retryControl.getError(retryError));
        } finally {
          retryControl.finish();
        }
      }
    }
    throw lastError || createRuntimeError('AI 请求失败', 'AI_REQUEST_FAILED');
  }

  async function requestJsonBody(url, requestOptions, timeoutMs, operation, executionOptions = {}) {
    const requestControl = createRequestControl(timeoutMs, executionOptions.signal);
    try {
      const endpointRequestOptions = await requestControl.race(
        resolveEndpointRequestOptions(url, operation),
      );
      const response = await requestControl.race(Promise.resolve().then(() => fetchImpl(url, {
        ...endpointRequestOptions,
        ...requestOptions,
        redirect: 'manual',
        signal: requestControl.signal,
      })));
      if (!isResponseOk(response)) {
        await cancelResponseBody(response);
        throw createHttpError(response?.status);
      }
      return await readJsonResponse(response, requestControl);
    } catch (error) {
      const controlledError = requestControl.getError(error);
      if (controlledError?.code === 'AI_REQUEST_TIMEOUT' || controlledError?.code === 'AI_REQUEST_ABORTED') {
        throw controlledError;
      }
      if (controlledError?.code === 'AI_RESPONSE_PARSE_ERROR' || controlledError?.code === 'AI_HTTP_ERROR') {
        throw controlledError;
      }
      throw sanitizeRuntimeError(controlledError, 'AI 上游响应格式无效');
    } finally {
      requestControl.finish();
    }
  }

  function requireModelConfig(config, override, { requireModelName = true } = {}) {
    const modelConfig = resolveModelConfig(config, override);
    const modelLabel = override?.model_kind === 'image' ? '生图模型' : '文本模型';
    if (!normalizeText(modelConfig.apiKey) || isMaskedApiKey(modelConfig.apiKey)) {
      throw createRuntimeError(`请先配置${modelLabel} API Key`, 'AI_CONFIG_INVALID');
    }
    if (!trimBaseUrl(modelConfig.baseUrl)) {
      throw createRuntimeError(`请先配置${modelLabel} Base URL`, 'AI_CONFIG_INVALID');
    }
    if (requireModelName && !normalizeText(modelConfig.modelName)) {
      throw createRuntimeError(`请先配置${modelLabel}名称`, 'AI_CONFIG_INVALID');
    }
    return modelConfig;
  }

  async function executeChat(request, executionOptions = {}) {
    const config = loadConfigSafely();
    const modelConfig = requireModelConfig(config);
    const body = buildChatBody(modelConfig, request);
    const url = appendEndpoint(modelConfig.baseUrl, 'chat/completions');
    const requestOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${modelConfig.apiKey}`,
      },
      body: JSON.stringify(body),
    };
    let tracked = false;

    try {
      const responseData = await runWithRetry(
        ({ timeoutMs, signal }) => requestJsonBody(url, requestOptions, timeoutMs, 'chat', { signal }),
        timeouts.text,
        executionOptions,
      );
      const usage = normalizeTokenUsage(responseData?.usage);
      textTokenStats.record(usage);
      trackSafely(modelConfig, config, usage);
      tracked = true;

      const content = extractMessageContent(responseData?.choices?.[0]?.message);
      if (!content) {
        throw createRuntimeError('AI 响应缺少文本内容', 'AI_RESPONSE_INVALID');
      }
      return content;
    } catch (error) {
      if (!tracked) {
        trackSafely(modelConfig, config, undefined);
      }
      throw sanitizeRuntimeError(error);
    }
  }

  async function executeListModels(configOverride, executionOptions = {}) {
    let config;
    try {
      config = loadConfigSafely();
    } catch {
      return {
        success: false,
        message: 'AI 配置读取失败',
        models: [],
      };
    }
    let modelConfig;
    try {
      modelConfig = requireModelConfig(config, configOverride, { requireModelName: false });
    } catch (error) {
      return {
        success: false,
        message: error.message,
        models: [],
      };
    }

    try {
      const data = await runWithRetry(
        ({ timeoutMs, signal }) => requestJsonBody(
          appendEndpoint(modelConfig.baseUrl, 'models'),
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${modelConfig.apiKey}`,
            },
          },
          timeoutMs,
          'listModels',
          { signal },
        ),
        timeouts.listModels,
        executionOptions,
      );
      const source = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
      const models = source
        .map((item) => (typeof item === 'string' ? item : item?.id || item?.name || ''))
        .filter(Boolean);
      return {
        success: true,
        message: '模型列表已更新',
        models,
      };
    } catch (error) {
      return {
        success: false,
        message: sanitizeRuntimeError(error, '获取模型列表失败').message,
        models: [],
      };
    }
  }

  function enqueueText(request, runner, scopeId, executionOptions = {}) {
    return queue.enqueue('text', runner, {
      scopeId: getScopeId(request, scopeId),
      signal: executionOptions.signal,
    });
  }

  const service = {
    chat(request, executionOptions = {}) {
      return enqueueText(request, (signal) => executeChat(request, { ...executionOptions, signal }), undefined, executionOptions);
    },

    async requestJson(request, executionOptions = {}) {
      const source = request && typeof request === 'object' ? request : {};
      const content = await service.chat({
        ...source,
        response_format: source.response_format || { type: 'json_object' },
      }, executionOptions);
      return applyJsonRequestContract(source, parseJsonResponseContent(content));
    },

    async collectJsonResponse(request, executionOptions = {}) {
      return service.requestJson(request, executionOptions);
    },

    parseJsonResponseContent(request, content) {
      return applyJsonRequestContract(request, parseJsonResponseContent(content));
    },

    listModels(configOverride, executionOptions = {}) {
      return enqueueText(
        configOverride,
        (signal) => executeListModels(configOverride, { ...executionOptions, signal }),
        undefined,
        executionOptions,
      );
    },

    generateImage() {
      return Promise.reject(createRuntimeError('Web 端生图能力将在后续包提供', 'WEB_CAPABILITY_PENDING'));
    },

    testImageModel() {
      return Promise.reject(createRuntimeError('Web 端生图模型测试将在后续包提供', 'WEB_CAPABILITY_PENDING'));
    },

    pauseQueueScope(scopeId) {
      return queue.pauseScope(scopeId);
    },

    resumeQueueScope(scopeId) {
      queue.resumeScope(scopeId);
    },

    getTextQueueStatus() {
      return queue.getStatus().text;
    },

    getImageQueueStatus() {
      return queue.getStatus().image;
    },

    getTextTokenStats() {
      return textTokenStats.snapshot();
    },

    reset() {
      return textTokenStats.reset();
    },

    resetTextTokenStats() {
      return service.reset();
    },

    onChanged(listener) {
      return textTokenStats.subscribe(listener);
    },

    onTextTokenStatsChanged(listener) {
      return service.onChanged(listener);
    },

    withQueueScope(scopeId) {
      const normalizedScopeId = normalizeScopeId(scopeId);
      return {
        ...service,
        chat(request, executionOptions = {}) {
          return service.chat({ ...(request || {}), queueScopeId: getScopeId(request, normalizedScopeId) || normalizedScopeId }, executionOptions);
        },
        requestJson(request) {
          return service.requestJson({ ...(request || {}), queueScopeId: getScopeId(request, normalizedScopeId) || normalizedScopeId });
        },
        collectJsonResponse(request) {
          return service.collectJsonResponse({ ...(request || {}), queueScopeId: getScopeId(request, normalizedScopeId) || normalizedScopeId });
        },
        listModels(configOverride) {
          return service.listModels({ ...(configOverride || {}), queueScopeId: normalizedScopeId });
        },
        generateImage(request) {
          return service.generateImage(request);
        },
        testImageModel(config) {
          return service.testImageModel(config);
        },
      };
    },

    close() {
      if (closePromise) {
        return closePromise;
      }

      const attempt = (async () => {
        const errors = [];

        try {
          await closeEndpointPolicy();
        } catch (error) {
          errors.push(error);
        }

        try {
          queue.close();
        } catch (error) {
          errors.push(error);
        }

        try {
          textTokenStats.close();
        } catch (error) {
          errors.push(error);
        }

        if (errors.length > 1) {
          throw new AggregateError(errors, `aiRuntime.close: 关闭失败 ${errors.length} 处`, { cause: errors[0] });
        }
        if (errors.length === 1) {
          throw errors[0];
        }
      })();

      closePromise = attempt;
      void attempt.catch(() => {
        if (closePromise === attempt) {
          closePromise = null;
        }
      });
      return attempt;
    },
  };

  return service;
}

module.exports = {
  createAiRuntime,
  parseJsonResponseContent,
  normalizeEndpointHost,
  resolveImageModelConfig,
  resolveTextModelConfig,
};
