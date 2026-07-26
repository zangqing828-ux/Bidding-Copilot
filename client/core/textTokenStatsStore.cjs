function normalizeTokenNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function normalizeCachedTokenNumber(source) {
  const promptDetails = source.prompt_tokens_details
    || source.promptTokensDetails
    || source.input_token_details
    || source.inputTokenDetails
    || {};
  return normalizeTokenNumber(
    source.cached_tokens
    ?? source.cachedTokens
    ?? source.prompt_cached_tokens
    ?? source.promptCachedTokens
    ?? source.prompt_cache_hit_tokens
    ?? source.promptCacheHitTokens
    ?? source.cache_read_input_tokens
    ?? source.cacheReadInputTokens
    ?? source.cached_content_token_count
    ?? source.cachedContentTokenCount
    ?? promptDetails.cached_tokens
    ?? promptDetails.cachedTokens
    ?? promptDetails.cache_read
    ?? promptDetails.cacheRead
    ?? promptDetails.cache_read_input_tokens
    ?? promptDetails.cacheReadInputTokens,
  );
}

function normalizeTokenUsage(usage) {
  const source = usage || {};
  const promptTokens = normalizeTokenNumber(source.prompt_tokens ?? source.promptTokens ?? source.promptTokenCount);
  const completionTokens = normalizeTokenNumber(
    source.completion_tokens
    ?? source.completionTokens
    ?? source.completionTokenCount
    ?? source.candidatesTokenCount,
  );
  const totalTokens = normalizeTokenNumber(source.total_tokens ?? source.totalTokens ?? source.totalTokenCount)
    || promptTokens + completionTokens;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    cached_tokens: normalizeCachedTokenNumber(source),
  };
}

function createEmptyTextTokenStats() {
  return {
    request_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cached_tokens: 0,
  };
}

function createTextTokenStatsStore() {
  let closed = false;
  let textTokenStats = createEmptyTextTokenStats();
  const listeners = new Set();

  function snapshot() {
    const inputTokens = normalizeTokenNumber(textTokenStats.input_tokens);
    const cachedTokens = normalizeTokenNumber(textTokenStats.cached_tokens);
    return {
      request_count: normalizeTokenNumber(textTokenStats.request_count),
      input_tokens: inputTokens,
      output_tokens: normalizeTokenNumber(textTokenStats.output_tokens),
      total_tokens: normalizeTokenNumber(textTokenStats.total_tokens),
      cached_tokens: cachedTokens,
      cache_ratio: inputTokens > 0 ? cachedTokens / inputTokens : 0,
    };
  }

  function notify() {
    if (closed) {
      return;
    }
    const current = snapshot();
    listeners.forEach((listener) => {
      try {
        listener(current);
      } catch {
        // 统计监听器异常不能影响 token 统计主流程。
      }
    });
  }

  function record(usage) {
    if (closed) {
      return;
    }

    const tokenUsage = normalizeTokenUsage(usage);
    textTokenStats = {
      request_count: textTokenStats.request_count + 1,
      input_tokens: textTokenStats.input_tokens + tokenUsage.prompt_tokens,
      output_tokens: textTokenStats.output_tokens + tokenUsage.completion_tokens,
      total_tokens: textTokenStats.total_tokens + tokenUsage.total_tokens,
      cached_tokens: textTokenStats.cached_tokens + tokenUsage.cached_tokens,
    };
    notify();
  }

  function reset() {
    textTokenStats = createEmptyTextTokenStats();
    notify();
    return snapshot();
  }

  function subscribe(listener) {
    if (typeof listener !== 'function' || closed) {
      return () => undefined;
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function close() {
    if (closed) {
      return;
    }
    closed = true;
    listeners.clear();
  }

  return {
    snapshot,
    record,
    reset,
    subscribe,
    close,
  };
}

module.exports = {
  createTextTokenStatsStore,
};
