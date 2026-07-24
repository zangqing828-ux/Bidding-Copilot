// Web 服务启动入口。
const config = require('./config.cjs');
const { createApp } = require('./app.cjs');
const { closeAll } = require('./workspace/workspaceRegistry.cjs');

function startServer() {
  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    console.log(`[web] 易标 Web 服务已启动：http://127.0.0.1:${config.port}（host=${config.host}）`);
    console.log(`[web] 版本 ${config.version}，环境 ${config.isProduction ? 'production' : 'development'}`);
  });

  // 优雅关闭：停止接收新连接，释放 workspace SQLite 连接。
  let shuttingDown = false;
  function gracefulShutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[web] 收到 ${signal}，开始优雅关闭...`);

    server.close(() => {
      console.log('[web] HTTP 服务已关闭');
      try {
        closeAll();
        console.log('[web] workspace 连接已释放');
      } catch (err) {
        console.warn('[web] 关闭 workspace 失败', err?.message || String(err));
      }
      process.exit(0);
    });

    // 超时强制退出
    const forceExitTimer = setTimeout(() => {
      console.warn('[web] 优雅关闭超时，强制退出');
      process.exit(1);
    }, 10000);
    forceExitTimer.unref();
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer };
