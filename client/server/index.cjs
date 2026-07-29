// Web 服务启动入口。
const config = require('./config.cjs');

const SHUTDOWN_TIMEOUT_MS = 30_000;

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
  beginDrainingFn = () => {
    const sseRouter = require('./routes/sse.cjs');
    return sseRouter.beginDraining();
  },
  beginAgentClosingFn = () => {
    const { getGlobalAgentCoordinator } = require('./agent/globalAgentCoordinator.cjs');
    return getGlobalAgentCoordinator().beginClosing();
  },
  closeAgentCoordinatorFn = () => {
    const { getGlobalAgentCoordinator } = require('./agent/globalAgentCoordinator.cjs');
    return getGlobalAgentCoordinator().close();
  },
  logger = console,
  exit = (code) => process.exit(code),
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
}) {
  let shuttingDown = false;
  let shutdownPromise = null;
  let forceExitTimer = null;
  let exitRequested = false;

  function requestExit(code) {
    if (exitRequested) {
      return;
    }
    exitRequested = true;
    if (forceExitTimer) {
      clearTimeout(forceExitTimer);
      forceExitTimer = null;
    }
    exit(code);
  }

  function closeServer() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      try {
        server.close(finish);
        server.closeAllConnections?.();
      } catch (error) {
        finish(error);
      }
    });
  }

  function gracefulShutdown(signal) {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    if (shuttingDown) {
      return shutdownPromise;
    }
    shuttingDown = true;
    logger.log(`[web] 收到 ${signal}，开始优雅关闭...`);

    forceExitTimer = setTimeout(() => {
      logger.warn('[web] 优雅关闭超时，强制退出');
      requestExit(1);
    }, timeoutMs);
    forceExitTimer.unref?.();

    shutdownPromise = (async () => {
      try {
        await beginDrainingFn();
        logger.log('[web] SSE 连接已进入 draining 并主动关闭');

        await beginAgentClosingFn();
        logger.log('[web] Agent 调度器已拒绝新任务并开始收敛');

        await closeServer();
        logger.log('[web] HTTP 服务已关闭');

        const closeResult = await closeAllFn();
        const failed = resolveFailedCount(closeResult);
        if (failed > 0) {
          logger.warn(`[web] workspace 关闭失败，失败数量: ${failed}`);
          requestExit(1);
          return;
        }

        logger.log('[web] workspace 连接已释放');

        await closeAgentCoordinatorFn();
        logger.log('[web] Agent 调度器已释放');
        requestExit(0);
      } catch (error) {
        logger.warn('[web] 关闭 workspace 失败', error?.message || String(error));
        requestExit(1);
      }
    })();

    return shutdownPromise;
  }

  return gracefulShutdown;
}

function startServer() {
  const { createApp } = require('./app.cjs');
  const app = createApp();
  const { closeAll } = require('./workspace/workspaceRegistry.cjs');
  const { getGlobalAgentCoordinator } = require('./agent/globalAgentCoordinator.cjs');
  const sseRouter = require('./routes/sse.cjs');
  sseRouter.resetDraining();
  const server = app.listen(config.port, config.host, () => {
    console.log(`[web] BidMaster Web 服务已启动：http://127.0.0.1:${config.port}（host=${config.host}）`);
    console.log(`[web] 版本 ${config.version}，环境 ${config.isProduction ? 'production' : 'development'}`);
  });

  // 优雅关闭：停止接收新连接，释放 workspace SQLite 连接。
  const gracefulShutdown = createGracefulShutdownHandler({
    server,
    closeAllFn: closeAll,
    beginDrainingFn: sseRouter.beginDraining,
    beginAgentClosingFn: () => getGlobalAgentCoordinator().beginClosing(),
    closeAgentCoordinatorFn: () => getGlobalAgentCoordinator().close(),
    logger: console,
    exit: (code) => process.exit(code),
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
  });

  process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
  process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });

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
