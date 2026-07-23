// Web 服务启动入口。
const config = require('./config.cjs');
const { createApp } = require('./app.cjs');

function startServer() {
  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    console.log(`[web] 易标 Web 服务已启动：http://127.0.0.1:${config.port}（host=${config.host}）`);
    console.log(`[web] 版本 ${config.version}，环境 ${config.isProduction ? 'production' : 'development'}`);
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer };
