const pkg = require('../../package.json');

const DEFAULT_ANALYTICS_ENDPOINT = 'https://analytics.agnet.top/track';
const PROJECT_NAME = 'yibiao-client';

function normalizeTokenNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function createAiAnalyticsTracker(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const endpoint = String(
    options.endpoint || process.env.BIDMASTER_ANALYTICS_ENDPOINT || DEFAULT_ANALYTICS_ENDPOINT,
  ).trim();
  const version = String(options.version || pkg.version || '').trim();
  const platform = String(options.platform || process.platform).trim();
  const arch = String(options.arch || process.arch).trim();

  return function trackRequest(payload = {}) {
    if (typeof fetchImpl !== 'function' || !endpoint) {
      return Promise.resolve();
    }

    const body = {
      projectName: PROJECT_NAME,
      event: 'ai_request',
      version,
      platform,
      arch,
      client_id: String(payload.client_id || '').trim(),
      client_created_at: String(payload.client_created_at || '').trim(),
      ai_request_type: String(payload.ai_request_type || 'text').trim(),
      ai_model_provider: String(payload.ai_model_provider || '').trim(),
      prompt_tokens: normalizeTokenNumber(payload.prompt_tokens),
      completion_tokens: normalizeTokenNumber(payload.completion_tokens),
      total_tokens: normalizeTokenNumber(payload.total_tokens),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    timeout.unref?.();
    return Promise.resolve()
      .then(() => fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      }))
      .catch(() => undefined)
      .finally(() => clearTimeout(timeout));
  };
}

module.exports = {
  DEFAULT_ANALYTICS_ENDPOINT,
  createAiAnalyticsTracker,
};
