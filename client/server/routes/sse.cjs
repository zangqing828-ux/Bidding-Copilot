// SSE 事件端点：GET /api/tasks/events
// 连接时从 req.workspaceId 获取 taskService，调 subscribeCallback。
// callback 收到事件时 res.write SSE data。连接关闭时 unsubscribe。
// subscribeCallback 自动重放当前 activeTasks 快照，支持页面刷新恢复。
const express = require('express');
const { getWorkspaceContext } = require('../workspace/workspaceRegistry.cjs');

const router = express.Router();

router.get('/tasks/events', (req, res) => {
  const workspaceId = req.workspaceId;
  let ctx;
  try {
    ctx = getWorkspaceContext(workspaceId);
  } catch {
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

  // 订阅 taskService 事件
  const unsubscribe = ctx.taskService.subscribeCallback((event) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // 连接已断开，忽略写入错误
    }
  });

  // 心跳，防止代理超时断开
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      // 忽略
    }
  }, 30000);

  // 客户端断开时清理
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

module.exports = router;
