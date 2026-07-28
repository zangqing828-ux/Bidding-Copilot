// Express app 工厂：组装中间件、API 路由、静态文件托管和 SPA fallback。
const express = require('express');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const path = require('node:path');
const fs = require('node:fs');
const config = require('./config.cjs');
const healthRouter = require('./routes/health.cjs');
const runtimeConfigRouter = require('./routes/runtimeConfig.cjs');
const bridgeRouter = require('./routes/bridge.cjs');
const authRouter = require('./routes/auth.cjs');
const uploadsRouter = require('./routes/uploads.cjs');
const downloadsRouter = require('./routes/downloads.cjs');
const assetsRouter = require('./routes/assets.cjs');
const sseRouter = require('./routes/sse.cjs');
const readinessRouter = require('./routes/readiness.cjs');
const { requireAuth } = require('./middleware/requireAuth.cjs');

// 公开路由前缀：不需要登录即可访问。
const PUBLIC_API_PREFIXES = ['/api/health', '/api/runtime-config', '/api/readiness', '/api/auth/login', '/api/auth/callback', '/api/auth/mock-login', '/api/auth/mock-callback'];

function isPublicApi(pathname) {
  return PUBLIC_API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix + '/'));
}

function createApp() {
  const app = express();

  // trust proxy：生产环境在反向代理后正确获取客户端 IP 和协议
  app.set('trust proxy', config.isProduction ? config.trustedProxyHops : false);

  app.use(compression());
  app.use(express.json({ limit: config.bodyLimit }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser(config.sessionSecret));

  // 简易访问日志，生产模式只记录方法和路径，不含敏感信息。
  app.use((req, _res, next) => {
    if (!config.isProduction || req.path.startsWith('/api/')) {
      console.log(`[web] ${req.method} ${req.path}`);
    }
    next();
  });

  // 公开 API 路由（无需登录）
  app.use('/api', healthRouter);
  app.use('/api', runtimeConfigRouter);
  app.use('/api', readinessRouter);
  app.use('/api', authRouter);

  // 接口保护：非公开 /api 路由需要登录
  app.use('/api', (req, res, next) => {
    if (isPublicApi(req.path)) {
      return next();
    }
    return requireAuth(req, res, () => {
      if (sseRouter.isDraining()) {
        return res.status(503).json({
          code: 'SERVER_DRAINING',
          message: '服务正在关闭，请稍后重试',
          retryable: true,
        });
      }
      return next();
    });
  });

  // 受保护的业务 API 路由
  app.use('/api', bridgeRouter);
  app.use('/api', uploadsRouter);
  app.use('/api', downloadsRouter);
  app.use('/api', assetsRouter);
  app.use('/api', sseRouter);

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
