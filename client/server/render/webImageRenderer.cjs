// Web 环境图片渲染器：playwright-core 驱动 Chromium，无 Electron 依赖。
// 单例 Browser + 每次渲染独立 BrowserContext；关闭路径释放全部资源。
// Mermaid 页面只允许注入本地 mermaid 脚本；HTML 页面禁用 JavaScript；两者均阻断全部网络请求。
const fs = require('node:fs');
const { sanitizeIllustrationHtml } = require('./htmlSanitizer.cjs');

/** Mermaid 本地渲染参考宽度（约 A4 正文可用宽），与 Electron 渲染保持一致 */
const WORD_FRIENDLY_RENDER_WIDTH = 680;
/** HTML 配图设计宽度，与生成 Prompt 一致 */
const HTML_DESIGN_WIDTH = 1240;
const MERMAID_RENDER_TIMEOUT_MS = 30000;
const HTML_RENDER_TIMEOUT_MS = 120000;
const MAX_RENDER_HEIGHT = 12000;
const MAX_RENDER_WIDTH = 4000;
const MAX_MERMAID_NODES = 120;
const MAX_MERMAID_LINES = 200;
const LAYOUT_SETTLE_MS = 120;
const LAYOUT_POLL_MS = 100;

function createRenderError(message, code = 'IMAGE_RENDER_FAILED') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function resolveChromiumExecutable(env = process.env) {
  const candidates = [
    env.YIBIAO_CHROMIUM_PATH,
    env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  throw createRenderError('未找到可用的 Chromium，可通过 YIBIAO_CHROMIUM_PATH 指定', 'CHROMIUM_NOT_FOUND');
}

function resolveMermaidBrowserScript() {
  return require.resolve('mermaid/dist/mermaid.min.js');
}

// Mermaid 复杂度限制：节点数与行数超限直接拒绝，防止渲染资源被拖垮。
function assertMermaidComplexity(code) {
  const normalized = String(code || '').trim();
  const lines = normalized.split('\n').filter((line) => line.trim());
  if (lines.length > MAX_MERMAID_LINES) {
    throw createRenderError(`Mermaid 代码超过 ${MAX_MERMAID_LINES} 行限制`);
  }
  const nodeIds = new Set();
  for (const line of lines) {
    for (const match of line.matchAll(/\b([A-Za-z][\w-]*)\s*(?:\[|\(|\{|-->|---|==>)/g)) {
      nodeIds.add(match[1]);
    }
  }
  if (nodeIds.size > MAX_MERMAID_NODES) {
    throw createRenderError(`Mermaid 节点数超过 ${MAX_MERMAID_NODES} 个限制`);
  }
}

function throwIfPaused(options, fallbackMessage = '转图已暂停') {
  if (options?.isPauseRequested?.()) {
    throw options.createPauseError?.() || new Error(fallbackMessage);
  }
}

async function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(createRenderError(message, 'IMAGE_RENDER_TIMEOUT')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Mermaid 渲染页面：脚本经 addScriptTag 注入本地文件，文档本身不含外部引用。
function buildMermaidDocument() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body { margin: 0; padding: 0; background: #ffffff; width: fit-content; height: fit-content; overflow: hidden; }
    #yibiao-capture-root { display: inline-block; margin: 0; padding: 8px; background: #ffffff; width: fit-content; height: fit-content; min-width: 1px; min-height: 1px; line-height: 0; }
    #yibiao-capture-root svg { display: block; }
  </style>
</head>
<body>
  <div id="yibiao-capture-root"></div>
</body>
</html>`;
}

// 在页面上下文执行 Mermaid 渲染并回写 SVG 尺寸（字符串形式供 evaluate 使用，避免打包干扰）。
async function runMermaidInPage(page, args) {
  return page.evaluate(async ({ code, maxWidth }) => {
    try {
      window.mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' });
      const id = 'mermaid-' + Date.now();
      const { svg } = await window.mermaid.render(id, code);
      const root = document.getElementById('yibiao-capture-root');
      root.innerHTML = svg;
      const svgEl = root.querySelector('svg');
      if (svgEl) {
        const parseSize = (value) => {
          const n = parseFloat(String(value || '').replace('px', '').trim());
          return Number.isFinite(n) && n > 0 ? n : 0;
        };
        let w = parseSize(svgEl.getAttribute('width'));
        let h = parseSize(svgEl.getAttribute('height'));
        if (!w || !h) {
          const vb = String(svgEl.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
          if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) { w = vb[2]; h = vb[3]; }
        }
        if (!w || !h) {
          try { const box = svgEl.getBBox(); if (box && box.width > 0 && box.height > 0) { w = box.width; h = box.height; } } catch {}
        }
        if (w > 0 && h > 0) {
          const scale = w > maxWidth ? (maxWidth / w) : 1;
          const outW = Math.max(1, Math.round(w * scale));
          const outH = Math.max(1, Math.round(h * scale));
          svgEl.setAttribute('width', String(outW));
          svgEl.setAttribute('height', String(outH));
          svgEl.style.width = outW + 'px';
          svgEl.style.height = outH + 'px';
          svgEl.style.maxWidth = 'none';
        }
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error || 'Mermaid 渲染失败') };
    }
  }, args);
}

function measureCaptureRoot(page) {
  return page.evaluate(() => {
    const target = document.getElementById('yibiao-capture-root') || document.body;
    if (!target) return { ready: false, width: 0, height: 0 };
    const fontsReady = !document.fonts || document.fonts.status === 'loaded' || document.fonts.status === 'idle';
    const rect = target.getBoundingClientRect();
    const width = Math.ceil(Math.max(rect.width, target.scrollWidth || 0, 1));
    const height = Math.ceil(Math.max(rect.height, target.scrollHeight || 0, 1));
    return { ready: fontsReady && width > 0 && height > 0, width, height };
  });
}

async function waitForStableLayout(page, timeoutMs, options = {}) {
  const started = Date.now();
  let stableSince = 0;
  let lastKey = '';
  while (Date.now() - started < timeoutMs) {
    throwIfPaused(options);
    const metrics = await measureCaptureRoot(page);
    if (metrics?.ready && metrics.width > 0 && metrics.height > 0) {
      const key = `${metrics.width}x${metrics.height}`;
      if (key !== lastKey) {
        lastKey = key;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= LAYOUT_SETTLE_MS) {
        return metrics;
      }
    } else {
      lastKey = '';
      stableSince = 0;
    }
    await delay(LAYOUT_POLL_MS);
  }
  throw createRenderError('等待页面布局稳定超时', 'IMAGE_RENDER_TIMEOUT');
}

function createWebImageRenderer({ executablePath, env = process.env } = {}) {
  let browserPromise = null;
  let closed = false;

  async function launchBrowser() {
    const { chromium } = require('playwright-core');
    const resolvedExecutable = executablePath || resolveChromiumExecutable(env);
    return chromium.launch({
      executablePath: resolvedExecutable,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
    });
  }

  // 单例 Browser 懒启动；启动失败后允许下次重试。
  function getBrowser() {
    if (closed) return Promise.reject(createRenderError('图片渲染器已关闭', 'IMAGE_RENDERER_CLOSED'));
    if (!browserPromise) {
      browserPromise = launchBrowser();
      browserPromise.catch(() => {
        browserPromise = null;
      });
    }
    return browserPromise;
  }

  // 每次渲染独立 BrowserContext，全量拦截网络请求。
  async function withRenderContext({ javaScriptEnabled, viewport }, task) {
    const browser = await getBrowser();
    const context = await browser.newContext({
      javaScriptEnabled,
      viewport,
      deviceScaleFactor: 1,
    });
    try {
      await context.route('**/*', (route) => route.abort('blockedbyclient'));
      const page = await context.newPage();
      return await task(page);
    } finally {
      await context.close().catch(() => {});
    }
  }

  async function captureRoot(page, metrics) {
    const width = Math.max(1, Math.ceil(metrics.width));
    const height = Math.max(1, Math.ceil(metrics.height));
    if (height > MAX_RENDER_HEIGHT) {
      throw createRenderError(`渲染内容高度 ${height}px 超过 ${MAX_RENDER_HEIGHT}px 上限，已拒绝转图`);
    }
    if (width > MAX_RENDER_WIDTH) {
      throw createRenderError(`渲染内容宽度 ${width}px 超过 ${MAX_RENDER_WIDTH}px 上限，已拒绝转图`);
    }
    const buffer = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width, height },
    });
    if (!buffer?.length) throw createRenderError('页面截图失败：未返回图像数据');
    return { buffer, width, height };
  }

  // 本地渲染 Mermaid 为 PNG；语法/复杂度不符直接拒绝。
  async function renderMermaidToPng(code, options = {}) {
    throwIfPaused(options, 'Mermaid 转图已暂停');
    const normalized = String(code || '').trim();
    if (!normalized) throw createRenderError('Mermaid 代码为空');
    assertMermaidComplexity(normalized);
    const scriptPath = resolveMermaidBrowserScript();
    return withTimeout(withRenderContext({
      javaScriptEnabled: true,
      viewport: { width: WORD_FRIENDLY_RENDER_WIDTH, height: 1200 },
    }, async (page) => {
      await page.setContent(buildMermaidDocument(), { waitUntil: 'domcontentloaded' });
      await page.addScriptTag({ path: scriptPath });
      throwIfPaused(options, 'Mermaid 转图已暂停');
      const result = await runMermaidInPage(page, {
        code: normalized,
        maxWidth: WORD_FRIENDLY_RENDER_WIDTH - 16,
      });
      if (!result?.ok) throw createRenderError(result?.error || 'Mermaid 渲染失败');
      const metrics = await waitForStableLayout(page, MERMAID_RENDER_TIMEOUT_MS, options);
      if (metrics.width < 24 || metrics.height < 24) {
        throw createRenderError(`Mermaid 内容尺寸异常（${metrics.width}x${metrics.height}），可能未正确渲染`);
      }
      return captureRoot(page, {
        width: Math.min(WORD_FRIENDLY_RENDER_WIDTH, metrics.width),
        height: metrics.height,
      });
    }), MERMAID_RENDER_TIMEOUT_MS, 'Mermaid 渲染超时');
  }

  // 本地将 HTML 净化后按设计宽度截取为 PNG；页面禁用 JavaScript。
  async function renderHtmlToPng(html, options = {}) {
    throwIfPaused(options, 'HTML 转图已暂停');
    const sanitized = sanitizeIllustrationHtml(html);
    const documentHtml = sanitized.replace(
      /<head([^>]*)>/i,
      `<head$1><style>
html, body { margin: 0 !important; padding: 0 !important; background: #ffffff !important; width: ${HTML_DESIGN_WIDTH}px !important; min-width: ${HTML_DESIGN_WIDTH}px !important; overflow-x: visible !important; box-sizing: border-box !important; }
*, *::before, *::after { box-sizing: border-box; }
#yibiao-capture-root { display: block; width: ${HTML_DESIGN_WIDTH}px; min-width: ${HTML_DESIGN_WIDTH}px; margin: 0; padding: 0; background: #ffffff; overflow: visible; }
svg { max-width: 100%; height: auto; }
</style>`,
    );
    return withTimeout(withRenderContext({
      javaScriptEnabled: false,
      viewport: { width: HTML_DESIGN_WIDTH, height: 900 },
    }, async (page) => {
      await page.setContent(documentHtml, { waitUntil: 'domcontentloaded' });
      throwIfPaused(options, 'HTML 转图已暂停');
      const metrics = await waitForStableLayout(page, HTML_RENDER_TIMEOUT_MS, options);
      return captureRoot(page, {
        width: Math.max(HTML_DESIGN_WIDTH, metrics.width),
        height: metrics.height,
      });
    }), HTML_RENDER_TIMEOUT_MS, 'HTML 渲染超时');
  }

  async function close() {
    closed = true;
    const pending = browserPromise;
    browserPromise = null;
    if (!pending) return;
    try {
      const browser = await pending;
      await browser.close();
    } catch {
      // 浏览器可能已退出
    }
  }

  return {
    renderMermaidToPng,
    renderHtmlToPng,
    close,
    wordFriendlyRenderWidth: WORD_FRIENDLY_RENDER_WIDTH,
    htmlDesignWidth: HTML_DESIGN_WIDTH,
  };
}

module.exports = {
  HTML_DESIGN_WIDTH,
  WORD_FRIENDLY_RENDER_WIDTH,
  MAX_RENDER_HEIGHT,
  createWebImageRenderer,
  resolveChromiumExecutable,
};
