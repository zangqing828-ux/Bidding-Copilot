// Web 系统字体：只返回镜像内批准且实际安装的字体族，供导出模板字体选择。
const { execFile } = require('node:child_process');

// 批准字体族：与 Docker 镜像安装的 fonts-noto-cjk / fonts-noto-cjk-extra 对应。
const APPROVED_FONT_FAMILIES = [
  'Noto Sans CJK SC',
  'Noto Sans CJK TC',
  'Noto Sans CJK JP',
  'Noto Sans CJK KR',
  'Noto Serif CJK SC',
  'Noto Serif CJK TC',
  'Noto Serif CJK JP',
  'Noto Serif CJK KR',
];

function execFileUtf8(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15000,
      ...options,
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

// 通过 fontconfig 枚举已安装字体族；不可用时返回 null 触发批准清单回退。
async function detectInstalledFamilies() {
  try {
    const output = await execFileUtf8('fc-list', [':', 'family']);
    const families = new Set();
    for (const line of output.split(/\r?\n/)) {
      // fc-list family 行可能为 "Noto Sans CJK SC,Noto Sans CJK SC Regular" 形式。
      for (const part of line.split(',')) {
        const name = part.trim();
        if (name) families.add(name);
      }
    }
    return families;
  } catch {
    return null;
  }
}

function createSystemFontService() {
  let cache = null;

  async function list() {
    if (cache) return cache;
    const installed = await detectInstalledFamilies();
    if (!installed) {
      // fontconfig 不可用：镜像已保证批准字体安装，直接返回批准清单。
      cache = [...APPROVED_FONT_FAMILIES];
      return cache;
    }
    cache = APPROVED_FONT_FAMILIES.filter((family) => installed.has(family));
    return cache;
  }

  return { list };
}

module.exports = { createSystemFontService, APPROVED_FONT_FAMILIES };
