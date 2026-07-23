// GET /api/health：返回进程存活、版本和运行时长，不含密钥与路径。
const express = require('express');
const config = require('../config.cjs');

const router = express.Router();

const startedAt = Date.now();

router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: config.version,
    pid: process.pid,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
  });
});

module.exports = router;
