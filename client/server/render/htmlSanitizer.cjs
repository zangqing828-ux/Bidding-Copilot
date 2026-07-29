// HTML 配图渲染前的服务端净化：
// 标签/属性/样式 allowlist，删除脚本与事件处理器，阻断外部与本地文件资源引用。
// 渲染页面本身还会关闭 JavaScript 并拦截全部网络请求，这里是第一道边界。
const cheerio = require('cheerio');

const ALLOWED_TAGS = new Set([
  'html', 'head', 'body', 'meta', 'title', 'style',
  'div', 'span', 'p', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'strong', 'b', 'em', 'i', 'u', 's', 'small', 'sub', 'sup', 'mark', 'code', 'pre', 'blockquote',
  'br', 'hr', 'figure', 'figcaption', 'svg', 'g', 'path', 'rect', 'circle', 'ellipse',
  'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'marker', 'lineargradient', 'radialgradient', 'stop',
]);

// 白名单外的属性一律剥除；on* 事件与危险协议单独兜底。
const ALLOWED_ATTRIBUTES = new Set([
  'class', 'id', 'style', 'colspan', 'rowspan', 'span', 'title', 'lang', 'dir', 'charset',
  // SVG 绘图属性
  'width', 'height', 'viewbox', 'xmlns', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'points', 'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin',
  'opacity', 'fill-opacity', 'stroke-opacity', 'transform', 'text-anchor', 'dominant-baseline',
  'font-size', 'font-family', 'font-weight', 'offset', 'stop-color', 'stop-opacity',
  'gradientunits', 'gradienttransform', 'markerwidth', 'markerheight', 'refx', 'refy', 'orient',
]);

// style 中禁止的模式：外部资源、表达式和导入。
const BLOCKED_STYLE_PATTERN = /url\s*\(|@import|expression\s*\(|javascript:|behavior\s*:/i;

function sanitizeStyleValue(value) {
  const text = String(value || '');
  return BLOCKED_STYLE_PATTERN.test(text) ? '' : text;
}

function sanitizeStyleSheet(cssText) {
  // <style> 内容按行过滤外部引用；不做完整 CSS 解析，命中危险模式的整行剔除。
  return String(cssText || '')
    .split('\n')
    .filter((line) => !BLOCKED_STYLE_PATTERN.test(line))
    .join('\n');
}

// 净化 AI 生成的 HTML 文档，返回可安全渲染的完整 HTML。
function sanitizeIllustrationHtml(html) {
  const $ = cheerio.load(String(html || ''));

  $('*').each((_index, node) => {
    // cheerio 中 script/style 节点有专属 type，不能只处理 'tag'。
    if (!['tag', 'script', 'style'].includes(node.type)) return;
    const element = $(node);
    const tagName = String(node.tagName || '').toLowerCase();

    if (!ALLOWED_TAGS.has(tagName)) {
      // 非白名单标签整体移除（含 script/iframe/img/link/object 等）。
      element.remove();
      return;
    }

    for (const attribute of Object.keys(node.attribs || {})) {
      const name = attribute.toLowerCase();
      if (name.startsWith('on') || !ALLOWED_ATTRIBUTES.has(name)) {
        element.removeAttr(attribute);
        continue;
      }
      if (name === 'style') {
        const sanitized = sanitizeStyleValue(node.attribs[attribute]);
        if (sanitized) element.attr(attribute, sanitized);
        else element.removeAttr(attribute);
      }
    }
  });

  $('style').each((_index, node) => {
    const element = $(node);
    element.text(sanitizeStyleSheet(element.text()));
  });

  const body = $('body');
  if (!body.length || !String(body.html() || '').trim()) {
    throw new Error('HTML 图片内容为空或已被安全策略移除');
  }

  // 服务端完成 capture-root 包装，渲染页面无需执行任何脚本。
  if (!$('#yibiao-capture-root').length) {
    body.wrapInner('<div id="yibiao-capture-root"></div>');
  }

  return $.html();
}

module.exports = { sanitizeIllustrationHtml };
