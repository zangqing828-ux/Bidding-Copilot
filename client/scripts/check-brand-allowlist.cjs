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

// 旧品牌 / 旧仓库 / 旧域名 / 推广 token（git grep 用）。
const TOKEN_PATTERN = 'yibiao|易标|openbidkit|FB208|yibiao\\.pro|agnet\\.top|s\\.markup\\.com\\.cn|trendshift|deepwiki|star-history|afdian';

// 逐 token 提取：把每个旧标识解析为「完整单元」（而非裸关键词），供逐 token 校验。
// 顺序敏感：更具体的复合形式（yibiao-client / yibiao-section-* / window.yibiao …）排在裸 yibiao 之前。
const TOKEN_RES = [
  /yibiao-client/gi,
  /yibiao-(section|illustration)[\w-]*/gi,
  /yibiao-capture-root/gi,
  /yibiao\.sqlite/gi,
  /yibiao\.pro/gi,
  /window\\?\.yibiao(?:Client)?/gi,
  /yibiaoClient/gi,
  /YibiaoBridge/g,
  /yibiao\?/g,
  /yibiao:/g,
  /yibiao[_-][\w-]*/gi,
  /com\.yibiao\.openbidkit/gi,
  /yibiao/gi,
  /openbidkit/gi,
  /易标[\u4e00-\u9fa5]*/g,
  /FB208/g,
  /analytics\.agnet\.top/gi,
  /agnet\.top/gi,
  /s\.markup\.com\.cn/gi,
  /trendshift/gi,
  /deepwiki/gi,
  /star-history/gi,
  /afdian/gi,
];

// 精确 allowlist（子串匹配）：一行内每个旧标识单元都必须被某条规则覆盖，否则判违规。
// 逐 token 校验可阻断「批准标识 + 违禁 token 同行」绕过（如 window.yibiao 行夹带 wiki.agnet.top）。
const ALLOWLIST = [
  // Renderer<->bridge ABI（window.yibiao / YibiaoBridge / yibiaoClient / mock 注入键），WR-06B 批准保留
  /window\\?\.yibiao|YibiaoBridge|yibiaoClient|yibiao\?|yibiao:/i,
  // 租户 SQLite 文件协议，首发不夹带数据库改名
  /yibiao\.sqlite/i,
  // 服务端图片渲染内部 DOM 锚点，非用户/运维可见
  /yibiao-capture-root/i,
  // 正文内容标记协议（已保存于用户正文，迁移属 WP-5）
  /yibiao-(section|illustration)/i,
  // Analytics 数据主键与统计端点（Cloudflare 资源实体，G6 Gate 前保留）
  /yibiao-client|analytics\.agnet\.top/i,
  // Analytics license 服务对历史桌面版的身份与 Secret 双读兼容（G7 Gate 前保留）
  /com\.yibiao\.openbidkit|易标投标工具箱|YIBIAO_LICENSE_/i,
];

function extractTokens(line) {
  const tokens = [];
  let work = line;
  // 顺序敏感：复合标识先匹配，并把已消费区间替换为占位符，避免裸 yibiao 重复匹配子串。
  for (const re of TOKEN_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(work)) !== null) {
      tokens.push(m[0]);
      work = work.slice(0, m.index) + '\u0000'.repeat(m[0].length) + work.slice(m.index + m[0].length);
      re.lastIndex = m.index + m[0].length;
    }
  }
  return tokens;
}

function gitGrep() {
  try {
    return execFileSync(
      'git',
      ['grep', '-I', '-n', '-i', '-E', TOKEN_PATTERN, '--', ...ACTIVE_PATHS],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    ).split('\n').filter(Boolean)
      // 扫描脚本自身的 token 定义与 allowlist 正则不算品牌残留。
      .filter((line) => !line.startsWith('client/scripts/check-brand-allowlist.cjs:'));
  } catch (err) {
    if (err.status === 1) return []; // 无匹配
    throw err;
  }
}

const violations = gitGrep().filter((line) => {
  const uncovered = extractTokens(line).filter((token) => !ALLOWLIST.some((re) => re.test(token)));
  return uncovered.length > 0;
});

if (violations.length > 0) {
  console.error(`[check-brand-allowlist] 发现 ${violations.length} 处 allowlist 之外的旧品牌残留：`);
  for (const line of violations) console.error(`  ${line}`);
  process.exit(1);
}

console.log('[check-brand-allowlist] 活跃面扫描通过：旧品牌 token 全部在批准的 allowlist 内。');
