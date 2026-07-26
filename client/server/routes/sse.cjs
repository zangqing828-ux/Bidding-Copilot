// SSE 事件端点：GET /api/tasks/events
// 连接时从 req.workspaceId 获取 taskEvents，调 subscribe。
// callback 收到事件时 res.write SSE data。连接关闭时 unsubscribe。
// taskEvents.subscribe 自动重放当前 activeTasks 快照，支持页面刷新恢复。
const express = require('express');
const { acquireWorkspaceContext } = require('../workspace/workspaceRegistry.cjs');

function createSseConnectionRegistry() {
  const connections = new Set();
  let draining = false;

  return {
    isDraining: () => draining,
    resetDraining: () => {
      draining = false;
    },
    register(connection) {
      connections.add(connection);
      return () => connections.delete(connection);
    },
    beginDraining() {
      draining = true;
      for (const connection of [...connections]) {
        connection.close();
      }
    },
    size: () => connections.size,
  };
}

function createSseRouter({
  acquireWorkspaceContextFn = acquireWorkspaceContext,
  connectionRegistry = createSseConnectionRegistry(),
} = {}) {
  const router = express.Router();

  router.get('/tasks/events', (req, res) => {
    if (connectionRegistry.isDraining()) {
      return res.status(503).json({
        code: 'SERVER_DRAINING',
        message: '服务正在关闭，请稍后重试',
        retryable: true,
      });
    }

  const workspaceId = req.workspaceId;
  let lease;
  let ctx;
  try {
    lease = acquireWorkspaceContextFn(workspaceId);
    ctx = lease.context;
  } catch (error) {
    if (error?.code === 'WORKSPACE_UNAVAILABLE') {
      return res.status(503).json({
        code: 'WORKSPACE_UNAVAILABLE',
        message: '工作区暂时不可用，请稍后重试',
        retryable: true,
      });
    }
    return res.status(500).json({ code: 'WORKSPACE_ERROR', message: '工作区初始化失败' });
  }

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Nginx 反代时不缓冲
  });
  res.write('\n');

  // 订阅 taskEvents 事件
  let unsubscribe = () => {};
  try {
    unsubscribe = ctx.taskEvents.subscribe((event) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // 连接已断开，忽略写入错误
      }
    });
  } catch {
    lease.release();
    return res.end();
  }

  // 心跳，防止代理超时断开
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      // 忽略
    }
  }, 30000);

  // 客户端断开或服务进入 draining 时清理。release 与 cleanup 均保持幂等。
  let cleaned = false;
  let unregister = () => {};
  const cleanup = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    clearInterval(heartbeat);
    try {
      unsubscribe();
    } catch (error) {
      console.warn('SSE: 断开连接时取消任务事件订阅失败', error?.message || error);
    }
    lease.release();
    unregister();
  };
  unregister = connectionRegistry.register({
    close() {
      cleanup();
      if (!res.writableEnded) {
        res.end();
      }
    },
  });
  req.on('close', cleanup);
  res.on('close', cleanup);
  });

  router.isDraining = connectionRegistry.isDraining;
  router.resetDraining = connectionRegistry.resetDraining;
  router.beginDraining = connectionRegistry.beginDraining;
  router.connectionCount = connectionRegistry.size;
  return router;
}

const router = createSseRouter();

module.exports = router;
module.exports.createSseRouter = createSseRouter;
module.exports.createSseConnectionRegistry = createSseConnectionRegistry;
