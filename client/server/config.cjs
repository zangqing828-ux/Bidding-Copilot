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

const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  isProduction: process.env.NODE_ENV === 'production',
  distDir: resolveDistDir(),
  version: pkg.version,
  appName: pkg.build?.productName || pkg.name,
  bodyLimit: '2mb',
};

module.exports = config;
