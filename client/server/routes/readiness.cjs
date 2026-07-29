// Readiness 检查：验证数据目录、身份库、租户库、静态资源和关键运行时可用性。
// Chromium/字体/Agent 工具链为镜像构建期固定的静态依赖，检查通过后缓存结果。
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config.cjs');

const router = express.Router();
const staticCheckCache = new Map();

// 非生产环境（本地开发/聚焦测试）缺少镜像静态依赖时降级为 warn，不阻断开发。
function failOrWarn(name, message) {
  return { name, status: config.isProduction ? 'fail' : 'warn', message };
}

function runCachedCheck(name, probe) {
  const cached = staticCheckCache.get(name);
  if (cached) return cached;
  const result = probe();
  if (result.status === 'ok') staticCheckCache.set(name, result);
  return result;
}

function checkChromium() {
  const candidates = [
    process.env.BIDMASTER_CHROMIUM_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  if (candidates.some((candidate) => fs.existsSync(candidate))) {
    return { name: 'chromium', status: 'ok' };
  }
  return failOrWarn('chromium', '未找到 Chromium，可通过 BIDMASTER_CHROMIUM_PATH 指定');
}

function checkCjkFonts() {
  // 与 Docker 镜像 fonts-noto-cjk 安装路径对应；本地环境允许 fontconfig 兜底。
  const fontDirs = ['/usr/share/fonts/opentype/noto', '/usr/share/fonts/truetype/noto'];
  for (const fontDir of fontDirs) {
    try {
      if (fs.readdirSync(fontDir).some((file) => /NotoS(ans|erif)CJK/i.test(file))) {
        return { name: 'cjk_fonts', status: 'ok' };
      }
    } catch {
      // 目录不存在时继续检查下一个候选
    }
  }
  try {
    const { execFileSync } = require('node:child_process');
    const output = execFileSync('fc-list', [':', 'family'], { encoding: 'utf8', timeout: 15000 });
    if (/Noto (Sans|Serif) CJK/.test(output)) {
      return { name: 'cjk_fonts', status: 'ok' };
    }
  } catch {
    // fc-list 不可用时按缺失处理
  }
  return failOrWarn('cjk_fonts', '未找到 Noto CJK 字体');
}

function checkAgentRuntime() {
  try {
    const { getRuntimeBinary } = require('../agent/webAgentService.cjs');
    const { createWebOpenCodeRunner } = require('../agent/webOpenCodeRunner.cjs');
    const runtimeBinary = getRuntimeBinary(process.env);
    const requiredTools = ['rg', 'fd', 'jq'];
    const hasBinary = fs.existsSync(runtimeBinary);
    const missingTools = requiredTools.filter((tool) => !['/usr/local/bin', '/usr/bin', '/bin']
      .some((root) => fs.existsSync(path.join(root, tool))));
    const runnerStatus = createWebOpenCodeRunner({ env: process.env }).selfCheck();
    if (hasBinary && missingTools.length === 0 && runnerStatus.available) {
      return { name: 'agent_runtime', status: 'ok' };
    }
    const missing = [
      ...missingTools,
      ...(runnerStatus.available ? [] : ['prlimit']),
    ];
    return failOrWarn('agent_runtime', hasBinary ? `缺少依赖：${missing.join(', ')}` : 'OpenCode binary 不存在');
  } catch (err) {
    return failOrWarn('agent_runtime', err?.message || '不可用');
  }
}

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

  // 3. 租户业务库：目录可写；DB 已初始化时必须可查询（首次启动前允许不存在）。
  try {
    const tenantWorkspaceRoot = path.join(dataDir, 'users', config.tenantId, 'workspace');
    fs.mkdirSync(tenantWorkspaceRoot, { recursive: true });
    fs.accessSync(tenantWorkspaceRoot, fs.constants.W_OK);
    const tenantDbPath = path.join(tenantWorkspaceRoot, 'yibiao.sqlite');
    if (fs.existsSync(tenantDbPath)) {
      const Database = require('better-sqlite3');
      const tenantDb = new Database(tenantDbPath, { readonly: true, fileMustExist: true });
      try {
        tenantDb.prepare('SELECT 1').get();
      } finally {
        tenantDb.close();
      }
    }
    checks.push({ name: 'tenant_db', status: 'ok' });
  } catch (err) {
    checks.push({ name: 'tenant_db', status: 'fail', message: err?.message || '不可用' });
  }

  // 4. 静态资源目录存在
  try {
    if (fs.existsSync(config.distDir)) {
      checks.push({ name: 'static_assets', status: 'ok' });
    } else {
      checks.push({ name: 'static_assets', status: 'warn', message: 'dist 目录不存在' });
    }
  } catch (err) {
    checks.push({ name: 'static_assets', status: 'fail', message: err?.message || '不可用' });
  }

  // 5. 镜像静态运行时依赖：Chromium、CJK 字体、OpenCode Agent 工具链。
  checks.push(runCachedCheck('chromium', checkChromium));
  checks.push(runCachedCheck('cjk_fonts', checkCjkFonts));
  checks.push(runCachedCheck('agent_runtime', checkAgentRuntime));

  const hasFail = checks.some((c) => c.status === 'fail');

  res.status(hasFail ? 503 : 200).json({
    status: hasFail ? 'not_ready' : 'ready',
    checks,
  });
});

module.exports = router;
