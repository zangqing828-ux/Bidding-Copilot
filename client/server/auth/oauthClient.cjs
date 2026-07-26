// OAuth client：封装 MainQuest Auth 的 authorize/token/me 调用。
// mock 模式下返回模拟数据，不调用外部服务。
const config = require('../config.cjs');
const OAUTH_REQUEST_TIMEOUT_MS = 10_000;

async function requestOAuth(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OAUTH_REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('MainQuest OAuth 请求超时');
    throw new Error('MainQuest OAuth 请求失败');
  } finally {
    clearTimeout(timer);
  }
}

function isMockMode() {
  return config.oauth.mode === 'mock';
}

function oauthEndpoint(pathname) {
  return new URL(String(pathname || '').replace(/^\/+/, ''), `${config.oauth.baseUrl}/`).toString();
}

// 构造 authorize URL（mock 模式返回 mock 登录页地址）。
function getAuthorizeUrl(state) {
  if (isMockMode()) {
    return `/api/auth/mock-login?state=${encodeURIComponent(state)}`;
  }

  const params = new URLSearchParams({
    client_id: config.oauth.clientId,
    redirect_uri: config.oauth.redirectUri,
    response_type: 'code',
    state,
  });

  const url = new URL(oauthEndpoint('oauth/authorize'));
  url.search = params.toString();
  return url.toString();
}

// 交换授权码（mock 模式直接用 code 作为 email）。
async function exchangeCode(code, redirectUri) {
  if (isMockMode()) {
    // mock 模式：code 格式为 mock:<email>:<name>，由 mock-callback 构造。
    return { accessToken: `mock-token-${Date.now()}`, code };
  }

  const response = await requestOAuth(oauthEndpoint('oauth/token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      client_id: config.oauth.clientId,
      client_secret: config.oauth.clientSecret,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    throw new Error(`OAuth token 交换失败：HTTP ${response.status}`);
  }

  const data = await response.json();
  return { accessToken: data.access_token, code };
}

// 获取用户信息（mock 模式从 code 解析）。
async function getUserInfo(accessToken, mockPayload) {
  if (isMockMode()) {
    // mock 模式：用户信息从 mock-callback 传入的 payload 获取。
    return {
      id: mockPayload.email,
      email: mockPayload.email,
      name: mockPayload.name,
      companyName: mockPayload.companyName || null,
    };
  }

  const response = await requestOAuth(oauthEndpoint('oauth/me'), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`OAuth /me 获取失败：HTTP ${response.status}`);
  }

  const data = await response.json();
  return {
    id: data.id,
    email: data.email,
    name: data.name,
    companyName: data.companyName || null,
  };
}

module.exports = { getAuthorizeUrl, exchangeCode, getUserInfo, isMockMode, requestOAuth, OAUTH_REQUEST_TIMEOUT_MS };
