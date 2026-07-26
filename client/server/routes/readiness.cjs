// Readiness 检查：验证数据目录、系统库和关键运行时可用性。
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config.cjs');

const router = express.Router();

router.get('/readiness', (_req, res) => {
  const checks = [];

  // 1. 数据目录可写
  const dataDir = config.dataDir;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.accessSync(dataDir, fs.constants.W_OK);
    checks.push({ name: 'data_dir', status: 'ok' });
  } catch (err) {
    checks.push({ name: 'data_dir', status: 'fail', message: err?.message || '不可写' });
  }

  // 2. 系统身份库可用
  try {
    const { getSystemDb } = require('../database/systemDatabase.cjs');
    const db = getSystemDb();
    db.prepare('SELECT COUNT(*) as count FROM accounts').get();
    checks.push({ name: 'system_db', status: 'ok' });
  } catch (err) {
    checks.push({ name: 'system_db', status: 'fail', message: err?.message || '不可用' });
  }

  // 3. 静态资源目录存在
  try {
    if (fs.existsSync(config.distDir)) {
      checks.push({ name: 'static_assets', status: 'ok' });
    } else {
      checks.push({ name: 'static_assets', status: 'warn', message: 'dist 目录不存在' });
    }
  } catch (err) {
    checks.push({ name: 'static_assets', status: 'fail', message: err?.message || '不可用' });
  }

  // 4. Web Agent Runtime 依赖。生产镜像由 Dockerfile 在构建阶段固定安装。
  try {
    const { getRuntimeBinary } = require('../agent/webAgentService.cjs');
    const runtimeBinary = getRuntimeBinary(process.env);
    const requiredTools = ['rg', 'fd', 'jq'];
    const hasBinary = fs.existsSync(runtimeBinary);
    const missingTools = requiredTools.filter((tool) => !['/usr/local/bin', '/usr/bin', '/bin']
      .some((root) => fs.existsSync(path.join(root, tool))));
    if (hasBinary && missingTools.length === 0) {
      checks.push({ name: 'agent_runtime', status: 'ok' });
    } else {
      checks.push({ name: 'agent_runtime', status: 'fail', message: hasBinary ? `缺少工具：${missingTools.join(', ')}` : 'OpenCode binary 不存在' });
    }
  } catch (err) {
    checks.push({ name: 'agent_runtime', status: 'fail', message: err?.message || '不可用' });
  }

  const allOk = checks.every((c) => c.status === 'ok' || c.status === 'warn');
  const hasFail = checks.some((c) => c.status === 'fail');

  res.status(hasFail ? 503 : 200).json({
    status: hasFail ? 'not_ready' : 'ready',
    checks,
  });
});

module.exports = router;
