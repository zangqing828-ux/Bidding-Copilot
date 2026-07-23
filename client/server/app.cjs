// Express app 工厂：组装中间件、API 路由、静态文件托管和 SPA fallback。
const express = require('express');
const compression = require('compression');
const path = require('node:path');
const fs = require('node:fs');
const config = require('./config.cjs');
const healthRouter = require('./routes/health.cjs');
const runtimeConfigRouter = require('./routes/runtimeConfig.cjs');
const bridgeRouter = require('./routes/bridge.cjs');

function createApp() {
  const app = express();

  app.use(compression());
  app.use(express.json({ limit: config.bodyLimit }));

  // 简易访问日志，生产模式只记录方法和路径，不含敏感信息。
  app.use((req, _res, next) => {
    if (!config.isProduction || req.path.startsWith('/api/')) {
      console.log(`[web] ${req.method} ${req.path}`);
    }
    next();
  });

  // API 路由
  app.use('/api', healthRouter);
  app.use('/api', runtimeConfigRouter);
  app.use('/api', bridgeRouter);

  // 静态文件托管
  const distDir = config.distDir;
  const indexHtmlPath = path.join(distDir, 'index.html');

  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
  } else {
    console.warn(`[web] 静态资源目录不存在：${distDir}，请先执行 npm run build:web`);
  }

  // SPA fallback：非 /api 开头的 GET 一律返回 index.html
  app.get(/^(?!\/api\/).*/, (req, res, next) => {
    if (!fs.existsSync(indexHtmlPath)) {
      return res.status(503).send('应用尚未构建，请先执行 npm run build:web');
    }
    res.sendFile(indexHtmlPath);
  });

  // 统一错误处理：生产模式不返回 stack
  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    const payload = { code: 'INTERNAL_ERROR', message: '服务器内部错误' };
    if (!config.isProduction) {
      payload.message = err.message || String(err);
    }
    res.status(status).json(payload);
  });

  return app;
}

module.exports = { createApp };
