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
}

const config = {
  port: Number(process.env.PORT || 3000),
  // mock 模式默认只监听本地，避免局域网误开放登录入口；mainquest 模式默认 0.0.0.0。
  host: process.env.HOST || (oauthMode === 'mock' ? '127.0.0.1' : '0.0.0.0'),
  isProduction,
  isHttps: publicBaseUrl.startsWith('https'),
  distDir: resolveDistDir(),
  version: pkg.version,
  appName: pkg.build?.productName || pkg.name,
  bodyLimit: '2mb',
  oauth,
  sessionSecret,
  publicBaseUrl,
  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS) || 7,
};

module.exports = config;
