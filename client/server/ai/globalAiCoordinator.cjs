const { createAiFairCoordinator } = require('../../core/aiFairCoordinator.cjs');

const DEFAULT_GLOBAL_LIMITS = Object.freeze({
  text: 30,
  image: 6,
});

function normalizeLimit(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  const normalized = Math.floor(number);
  return normalized > 0 ? Math.min(normalized, fallback) : fallback;
}

function resolveGlobalAiLimits(options = {}) {
  const env = options.env || process.env;
  const configured = options.limits && typeof options.limits === 'object' ? options.limits : {};
  return {
    text: normalizeLimit(
      configured.text ?? env.WEB_AI_GLOBAL_TEXT_LIMIT,
      DEFAULT_GLOBAL_LIMITS.text,
    ),
    image: normalizeLimit(
      configured.image ?? env.WEB_AI_GLOBAL_IMAGE_LIMIT,
      DEFAULT_GLOBAL_LIMITS.image,
    ),
  };
}

function createGlobalAiCoordinator(options = {}) {
  const limits = resolveGlobalAiLimits(options);
  return createAiFairCoordinator({
    textLimit: limits.text,
    imageLimit: limits.image,
  });
}

let globalCoordinator = null;

function getGlobalAiCoordinator(options = {}) {
  if (!globalCoordinator) {
    globalCoordinator = createGlobalAiCoordinator(options);
  }
  return globalCoordinator;
}

function resetGlobalAiCoordinator() {
  const previous = globalCoordinator;
  globalCoordinator = null;
  if (previous && typeof previous.close === 'function') {
    previous.close();
  }
  return previous;
}

module.exports = {
  DEFAULT_GLOBAL_LIMITS,
  createGlobalAiCoordinator,
  getGlobalAiCoordinator,
  resetGlobalAiCoordinator,
  resolveGlobalAiLimits,
};
