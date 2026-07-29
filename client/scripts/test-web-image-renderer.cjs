// WR-04 Web 图片渲染器测试：真实 Chromium 覆盖 Mermaid/HTML 的成功与拒绝路径。
const assert = require('node:assert/strict');
const { createWebImageRenderer, MAX_RENDER_HEIGHT } = require('../server/render/webImageRenderer.cjs');
const { sanitizeIllustrationHtml } = require('../server/render/htmlSanitizer.cjs');

const passed = [];
const failed = [];

async function run(name, fn) {
  try {
    await fn();
    passed.push(name);
    console.log(`  PASS: ${name}`);
  } catch (error) {
    failed.push(`${name}: ${error.message}`);
    console.error(`  FAIL: ${name}`);
    console.error(error?.stack || error?.message || String(error));
  }
}

function isPng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
}

async function main() {
  const renderer = createWebImageRenderer();

  try {
    await run('Mermaid 正常渲染输出有效 PNG', async () => {
      const result = await renderer.renderMermaidToPng('flowchart TD\n  A["开始"] --> B["巡检"]\n  B --> C["归档"]');
      assert.ok(isPng(result.buffer), '输出 PNG 签名有效');
      assert.ok(result.width >= 24 && result.height >= 24, `尺寸合理（${result.width}x${result.height}）`);
    });

    await run('Mermaid 语法错误被拒绝', async () => {
      await assert.rejects(
        () => renderer.renderMermaidToPng('flowchart TD\n  A["开始"] -->>> ???'),
        /Mermaid|渲染|Parse|error/i,
        '语法错误返回渲染错误',
      );
    });

    await run('Mermaid 超复杂度被拒绝', async () => {
      const lines = ['flowchart TD'];
      for (let index = 0; index < 130; index += 1) {
        lines.push(`  N${index}["节点${index}"] --> N${index + 1}["节点${index + 1}"]`);
      }
      await assert.rejects(
        () => renderer.renderMermaidToPng(lines.join('\n')),
        /节点数|行/,
        '复杂度超限被拒绝',
      );
    });

    await run('HTML 正常渲染输出有效 PNG', async () => {
      const result = await renderer.renderHtmlToPng(`<!DOCTYPE html>
<html><head><title>测试</title></head>
<body><div style="padding:40px;background:#f0f6ff"><h1>组织架构</h1><p>项目经理下设实施组与质检组。</p></div></body></html>`);
      assert.ok(isPng(result.buffer), '输出 PNG 签名有效');
      assert.ok(result.width >= 1240, `宽度按设计宽渲染（${result.width}）`);
    });

    await run('HTML 脚本与外链在净化阶段被剥除', async () => {
      const sanitized = sanitizeIllustrationHtml(`<!DOCTYPE html>
<html><head><script>fetch('http://127.0.0.1/steal')</script><link rel="stylesheet" href="http://evil.example/a.css"></head>
<body onload="alert(1)"><div style="background:url('http://evil.example/x.png')">正文<img src="http://evil.example/i.png"><iframe src="http://evil.example"></iframe></div></body></html>`);
      assert.ok(!/script|iframe|<img|<link|onload|evil\.example/i.test(sanitized), '脚本/外链/事件全部移除');
      assert.ok(sanitized.includes('yibiao-capture-root'), '保留捕获根节点');
    });

    await run('HTML 全部内容被安全策略移除时报错', async () => {
      assert.throws(
        () => sanitizeIllustrationHtml('<html><body><script>1</script></body></html>'),
        /安全策略|为空/,
      );
    });

    await run('HTML 超高页面被拒绝', async () => {
      await assert.rejects(
        () => renderer.renderHtmlToPng(`<html><body><div style="height:${MAX_RENDER_HEIGHT + 500}px;background:#eee">超高内容</div></body></html>`),
        /上限|超过/,
        '超高页面渲染被拒绝',
      );
    });

    await run('HTML 超宽页面被拒绝', async () => {
      await assert.rejects(
        () => renderer.renderHtmlToPng(`<html><body><div style="width:6000px;height:200px;background:#eee">超宽内容</div></body></html>`),
        /宽度|超过/,
        '超宽页面渲染被拒绝',
      );
    });

    await run('渲染器 close 后拒绝新任务', async () => {
      await renderer.close();
      await assert.rejects(
        () => renderer.renderMermaidToPng('flowchart TD\n  A --> B'),
        (error) => error?.code === 'IMAGE_RENDERER_CLOSED',
      );
    });
  } finally {
    await renderer.close().catch(() => {});
  }

  console.log(`\nWeb 图片渲染器测试：${passed.length} 通过，${failed.length} 失败`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
