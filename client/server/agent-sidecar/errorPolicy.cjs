const REDACTED = '<redacted>';

function redactSidecarMessage(value, env = process.env) {
  let text = String(value || 'Sidecar request failed');
  const secrets = [
    env.YIBIAO_SIDECAR_SECRET,
    env.YIBIAO_AGENT_PROXY_TOKEN,
    env.YIBIAO_WEB_AGENT_PROXY_TOKEN,
    env.MAINQUEST_OAUTH_CLIENT_SECRET,
    env.SESSION_SECRET,
    env.CONFIG_ENCRYPTION_KEY,
  ].filter((secret) => String(secret || '').length >= 4);
  for (const secret of secrets) text = text.split(String(secret)).join(REDACTED);
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`);
  text = text.replace(/(token|secret|password|api[_-]?key|clientSecret)\s*[:=]\s*([^,\s}\]]+)/gi, `$1=${REDACTED}`);
  text = text.replace(/(?:\/Users|\/home|\/root|\/tmp|\/data|\/var\/lib|\/opt)\/[^\s"']+/g, '<path>');
  return text.replace(/[\r\n]+/g, ' ').slice(0, 240);
}

function toStableSidecarError(error, { fallbackCode = 'SIDE_CAR_INTERNAL_ERROR', statusCode = 500 } = {}) {
  return {
    code: String(error?.code || fallbackCode),
    message: redactSidecarMessage(error?.message || 'Sidecar request failed'),
    retryable: Boolean(error?.retryable),
    statusCode: Number(error?.statusCode) || statusCode,
  };
}

module.exports = { REDACTED, redactSidecarMessage, toStableSidecarError };
