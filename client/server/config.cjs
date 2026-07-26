// Web 服务端配置：从环境变量读取运行参数，不写入密钥，不泄露绝对路径。
const path = require('node:path');

const pkg = require('../package.json');

function resolveDistDir() {
  const env = process.env.YIBIAO_WEB_DIST_DIR;
  if (env) {
    return path.resolve(__dirname, '..', env);
  }
  return path.resolve(__dirname, '..', 'dist');
}

function resolveDataDir() {
  const env = process.env.YIBIAO_DATA_DIR;
  if (env) {
    return path.resolve(env);
  }
  return path.resolve(__dirname, '..', 'data');
}

const isProduction = process.env.NODE_ENV === 'production';
const oauthMode = process.env.OAUTH_MODE || 'mock';

// 生产环境禁止 mock 模式，防止运维遗漏配置导致认证被绕过。
if (isProduction && oauthMode !== 'mainquest') {
  console.error('[config] 生产环境必须设置 OAUTH_MODE=mainquest，当前为 ' + oauthMode);
  process.exit(1);
}

const oauth = {
  mode: oauthMode,
  baseUrl: process.env.MAINQUEST_AUTH_BASE_URL || '',
  clientId: process.env.MAINQUEST_OAUTH_CLIENT_ID || '',
  clientSecret: process.env.MAINQUEST_OAUTH_CLIENT_SECRET || '',
  redirectUri: process.env.MAINQUEST_OAUTH_REDIRECT_URI || '',
};

const sessionSecret = process.env.SESSION_SECRET || '';
const publicBaseUrl = process.env.PUBLIC_BASE_URL || 'http://localhost:3000';
const trustedProxyHops = Number(process.env.TRUST_PROXY_HOPS || 1);
const WEB_AI_DEFAULT_TEXT_LIMIT = 30;
const WEB_AI_DEFAULT_IMAGE_LIMIT = 6;

function normalizeWebAiLimit(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  const normalized = Math.floor(number);
  return normalized > 0 ? Math.min(normalized, fallback) : fallback;
}

const webAiGlobalTextLimit = normalizeWebAiLimit(
  process.env.WEB_AI_GLOBAL_TEXT_LIMIT,
  WEB_AI_DEFAULT_TEXT_LIMIT,
);
const webAiGlobalImageLimit = normalizeWebAiLimit(
  process.env.WEB_AI_GLOBAL_IMAGE_LIMIT,
  WEB_AI_DEFAULT_IMAGE_LIMIT,
);

// mainquest 模式启动时校验必需配置，错误信息只列配置名。
if (oauthMode === 'mainquest') {
  const missing = [];
  if (!oauth.baseUrl) missing.push('MAINQUEST_AUTH_BASE_URL');
  if (!oauth.clientId) missing.push('MAINQUEST_OAUTH_CLIENT_ID');
  if (!oauth.clientSecret) missing.push('MAINQUEST_OAUTH_CLIENT_SECRET');
  if (!oauth.redirectUri) missing.push('MAINQUEST_OAUTH_REDIRECT_URI');
  if (!sessionSecret) missing.push('SESSION_SECRET');
  if (!process.env.PUBLIC_BASE_URL) missing.push('PUBLIC_BASE_URL');
  if (missing.length) {
    console.error(`[config] MainQuest OAuth 模式缺少必需配置：${missing.join(', ')}`);
    process.exit(1);
  }
  // 生产 mainquest 模式强制 HTTPS，防止 Cookie secure 属性失效。
  if (isProduction && !publicBaseUrl.startsWith('https')) {
    console.error('[config] 生产环境 PUBLIC_BASE_URL 必须使用 HTTPS');
    process.exit(1);
  }
  const expectedCallback = `${publicBaseUrl.replace(/\/+$/, '')}/api/auth/callback`;
  if (oauth.redirectUri !== expectedCallback) {
    console.error('[config] MAINQUEST_OAUTH_REDIRECT_URI 必须等于 PUBLIC_BASE_URL/api/auth/callback');
    process.exit(1);
  }
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 1 || trustedProxyHops > 3) {
    console.error('[config] TRUST_PROXY_HOPS 必须为 1 到 3 的整数');
    process.exit(1);
  }
}

// 加密配置主密钥：生产环境必须设置，开发环境可选（缺失时加密操作会抛错）。
if (isProduction && !process.env.CONFIG_ENCRYPTION_KEY) {
  console.error('[config] 生产环境必须设置 CONFIG_ENCRYPTION_KEY');
  process.exit(1);
}

const config = {
  port: Number(process.env.PORT || 3000),
  // mock 模式默认只监听本地，避免局域网误开放登录入口；mainquest 模式默认 0.0.0.0。
  host: process.env.HOST || (oauthMode === 'mock' ? '127.0.0.1' : '0.0.0.0'),
  isProduction,
  isHttps: publicBaseUrl.startsWith('https'),
  distDir: resolveDistDir(),
  dataDir: resolveDataDir(),
  version: pkg.version,
  appName: pkg.build?.productName || pkg.name,
  bodyLimit: '2mb',
  oauth,
  sessionSecret,
  publicBaseUrl,
  trustedProxyHops,
  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS) || 7,
  configEncryptionKey: process.env.CONFIG_ENCRYPTION_KEY || '',
  uploadMaxSize: Number(process.env.UPLOAD_MAX_SIZE_MB) || 50,
  webAiGlobalTextLimit,
  webAiGlobalImageLimit,
};

module.exports = config;
