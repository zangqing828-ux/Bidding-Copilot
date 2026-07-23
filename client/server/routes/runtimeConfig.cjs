// GET /api/runtime-config：只返回浏览器需要的公开配置，无需登录。
const express = require('express');
const config = require('../config.cjs');

const router = express.Router();

router.get('/runtime-config', (_req, res) => {
  res.json({
    appName: config.appName,
    platform: 'web',
    version: config.version,
  });
});

module.exports = router;
