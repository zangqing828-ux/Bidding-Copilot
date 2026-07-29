#!/usr/bin/env node
// WR-06B 品牌活跃面扫描：活跃代码/文档中旧品牌 token 必须命中精确 allowlist，否则失败。
// 用法：node scripts/check-brand-allowlist.cjs（在 client/ 下执行，扫描仓库根的活跃面）
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');

// 活跃面：用户可见、运维可见与首发运行时相关文件。
const ACTIVE_PATHS = [
  'client/src', 'client/server', 'client/core', 'client/shared', 'client/scripts',
  'client/e2e', 'client/index.html', 'client/package.json', 'client/playwright.config.cjs',
  'client/vite.config.ts', 'client/开发说明.md',
  'Dockerfile', 'docker-compose.yml', '.env.example', '.github',
  'docs', 'README.md', 'README.en.md', 'SECURITY.md', 'CONTRIBUTING.md',
  'analytics/worker/src', 'analytics/dashboard/public',
];

// 旧品牌 / 旧仓库 / 旧域名 / 推广 token。
const TOKEN_PATTERN = 'yibiao|易标|openbidkit|FB208|yibiao\\.pro|agnet\\.top|s\\.markup\\.com\\.cn|trendshift|deepwiki|star-history|afdian';

// 精确 allowlist：兼容协议与资源实体，每项都有保留原因。
const ALLOWLIST = [
  // Renderer<->bridge ABI（window.yibiao / YibiaoBridge / yibiaoClient），WR-06B 批准保留；
  // 兼容契约测试中的正则转义写法 window\.yibiao 与 mock 注入的 yibiao 对象键。
  /window\\?\.yibiao|YibiaoBridge|yibiaoClient|yibiao\?:/,
  /^client\/scripts\/test-analytics-legacy-migration\.cjs:\d+:\s*yibiao: \{/,
  // 租户 SQLite 文件协议，首发不夹带数据库改名
  /yibiao\.sqlite/,
  // 服务端图片渲染内部 DOM 锚点，非用户/运维可见
  /yibiao-capture-root/,
  // 正文内容标记协议（已保存于用户正文，迁移属 WP-5）
  /yibiao-(section|illustration)/,
  // Analytics 数据主键与统计端点（Cloudflare 资源实体，G6 Gate 前保留）
  /yibiao-client|analytics\.agnet\.top/,
  // Analytics license 服务对历史桌面版的身份与 Secret 双读兼容（G7 Gate 前保留）
  /^analytics\/worker\/src\/(routes\/license|services\/licenseCrypto)\.js:\d+:.*(com\.yibiao\.openbidkit|易标投标工具箱|YIBIAO_LICENSE_)/,
];

function gitGrep() {
  try {
    return execFileSync(
      'git',
      ['grep', '-I', '-n', '-i', '-E', TOKEN_PATTERN, '--', ...ACTIVE_PATHS],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    ).split('\n').filter(Boolean);
  } catch (err) {
    if (err.status === 1) return []; // 无匹配
    throw err;
  }
}

const violations = gitGrep().filter((line) => !ALLOWLIST.some((re) => re.test(line)));

if (violations.length > 0) {
  console.error(`[check-brand-allowlist] 发现 ${violations.length} 处 allowlist 之外的旧品牌残留：`);
  for (const line of violations) console.error(`  ${line}`);
  process.exit(1);
}

console.log('[check-brand-allowlist] 活跃面扫描通过：旧品牌 token 全部在批准的 allowlist 内。');
