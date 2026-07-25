// Web 服务启动入口。
const config = require('./config.cjs');

const SHUTDOWN_TIMEOUT_MS = 10_000;

function resolveFailedCount(closeResult) {
  if (!closeResult || typeof closeResult !== 'object') {
    return 0;
  }
  const failed = Number(closeResult.failed);
  return Number.isNaN(failed) || failed < 0 ? 0 : Math.trunc(failed);
}

function createGracefulShutdownHandler({
  server,
  closeAllFn = () => {
    const { closeAll: defaultCloseAll } = require('./workspace/workspaceRegistry.cjs');
    return defaultCloseAll();
  },
  logger = console,
  exit = (code) => process.exit(code),
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
}) {
  let shuttingDown = false;

  function gracefulShutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.log(`[web] 收到 ${signal}，开始优雅关闭...`);

    const forceExitTimer = setTimeout(() => {
      logger.warn('[web] 优雅关闭超时，强制退出');
      exit(1);
    }, timeoutMs);
    forceExitTimer.unref?.();

    server.close(() => {
      clearTimeout(forceExitTimer);

      logger.log('[web] HTTP 服务已关闭');
      try {
        const closeResult = closeAllFn();
        const failed = resolveFailedCount(closeResult);
        if (failed > 0) {
          logger.warn(`[web] workspace 关闭失败，失败数量: ${failed}`);
          exit(1);
          return;
        }
        logger.log('[web] workspace 连接已释放');
        exit(0);
      } catch (error) {
        logger.warn('[web] 关闭 workspace 失败', error?.message || String(error));
        exit(1);
      }
    });
  }

  return gracefulShutdown;
}

function startServer() {
  const { createApp } = require('./app.cjs');
  const app = createApp();
  const { closeAll } = require('./workspace/workspaceRegistry.cjs');
  const server = app.listen(config.port, config.host, () => {
    console.log(`[web] 易标 Web 服务已启动：http://127.0.0.1:${config.port}（host=${config.host}）`);
    console.log(`[web] 版本 ${config.version}，环境 ${config.isProduction ? 'production' : 'development'}`);
  });

  // 优雅关闭：停止接收新连接，释放 workspace SQLite 连接。
  const gracefulShutdown = createGracefulShutdownHandler({
    server,
    closeAllFn: closeAll,
    logger: console,
    exit: (code) => process.exit(code),
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
  });

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  startServer,
  createGracefulShutdownHandler,
  SHUTDOWN_TIMEOUT_MS,
};
