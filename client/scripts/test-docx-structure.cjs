// WR-05 高保真 DOCX 结构测试：纯 Node 调用 core builder，断言 ZIP 结构、样式、编号、关系与媒体。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert');
const AdmZip = require('adm-zip');
const { buildDocxResult } = require('../core/export/docxBuilder.cjs');

const passed = [];
const failed = [];

async function run(name, fn) {
  try {
    await fn();
    passed.push(name);
    console.log(`  PASS: ${name}`);
  } catch (error) {
    failed.push({ name, error });
    console.log(`  FAIL: ${name}\n    ${error.message}`);
  }
}

// 生成带 CRC 的合法 PNG（image-size 与 docx 均可解析），可指定宽高。
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng(width = 240, height = 120) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) raw[y * (width * 3 + 1)] = 0;
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function createFixtureEnvironment() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wr05-docx-'));
  const imagesDir = path.join(root, 'generated-images', 'technical-plan', 'illustrations', 'rev1');
  fs.mkdirSync(imagesDir, { recursive: true });
  const aiImagePath = path.join(imagesDir, 'ai-1.png');
  fs.writeFileSync(aiImagePath, makePng(320, 180));
  const mermaidPng = makePng(280, 160);

  const ports = {
    assetResolver: ({ host, relativePath }) => {
      if (host !== 'generated-images') return null;
      const baseDir = path.join(root, 'generated-images');
      const resolved = path.resolve(baseDir, relativePath);
      if (!resolved.startsWith(`${baseDir}${path.sep}`)) return null;
      return resolved;
    },
    mermaidRenderer: async () => ({ buffer: mermaidPng, type: 'png', width: 280, height: 160 }),
    getMermaidCacheEntry: (code) => ({ exists: false, hash: `h${String(code || '').length}`, code, assetUrl: '' }),
  };

  return { root, aiImagePath, ports };
}

function createHighFidelityOutline(assetUrl) {
  return [
    {
      id: '1',
      title: '总体方案',
      children: [
        {
          id: '1.1',
          title: '技术路线',
          content: [
            '本方案采用**分层架构**，确保系统可扩展。',
            '',
            '1. 接入层',
            '2. 服务层',
            '3. 数据层',
            '',
            '| 模块 | 职责 |',
            '| --- | --- |',
            '| 网关 | 流量入口 |',
            '| 编排 | 任务调度 |',
          ].join('\n'),
        },
        {
          id: '1.2',
          title: '流程图',
          content: '系统流程如下：\n\n```mermaid\nflowchart TD\n  A[开始] --> B[处理]\n  B --> C[结束]\n```',
        },
      ],
    },
    {
      id: '2',
      title: '配图说明',
      children: [
        {
          id: '2.1',
          title: 'AI 配图',
          content: `效果示意：\n\n![AI 配图](${assetUrl})`,
        },
      ],
    },
  ];
}

async function main() {
  const env = createFixtureEnvironment();
  const assetUrl = 'yibiao-asset://generated-images/technical-plan/illustrations/rev1/ai-1.png';
  const payload = {
    project_name: '高保真导出测试',
    outline: createHighFidelityOutline(assetUrl),
    export_format: {
      body_text: { font: '宋体', size: '小四', line_spacing_multiple: 1.2 },
      page: { margin_top_cm: 2, margin_bottom_cm: 2, margin_left_cm: 2, margin_right_cm: 2, page_number: true },
    },
  };

  let result;
  await run('高保真 builder 在纯 Node 输出 Buffer', async () => {
    result = await buildDocxResult(payload, { warnings: [], ...env.ports });
    assert.ok(Buffer.isBuffer(result.buffer) && result.buffer.length > 0, '返回非空 Buffer');
    assert.ok(result.buffer.slice(0, 2).toString() === 'PK', 'Buffer 为 ZIP 容器');
    assert.ok(Array.isArray(result.warnings), '返回 warnings 数组');
    assert.ok(result.stats && typeof result.stats.leafCount === 'number', '返回结构统计');
  });

  let zip;
  await run('DOCX ZIP 结构包含核心部件', async () => {
    zip = new AdmZip(result.buffer);
    const names = zip.getEntries().map((entry) => entry.entryName);
    for (const required of ['[Content_Types].xml', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels']) {
      assert.ok(names.includes(required), `缺少 ${required}`);
    }
  });

  await run('document.xml 含表格、图片与标题文本', async () => {
    const documentXml = zip.readAsText('word/document.xml');
    assert.ok(documentXml.includes('<w:tbl>'), '包含表格');
    assert.ok(/<w:drawing>|<w:pict>/.test(documentXml), '包含图片绘制');
    assert.ok(documentXml.includes('技术路线'), '包含三级标题文本');
    assert.ok(documentXml.includes('分层架构'), '包含粗体正文');
  });

  await run('numbering.xml 定义编号抽象与实例', async () => {
    const numberingXml = zip.readAsText('word/numbering.xml');
    assert.ok(numberingXml.includes('<w:abstractNum'), '包含 abstractNum');
    assert.ok(numberingXml.includes('<w:num '), '包含 num 实例');
  });

  await run('媒体目录包含 Mermaid 与 AI 图片', async () => {
    const media = zip.getEntries().map((e) => e.entryName).filter((n) => n.startsWith('word/media/'));
    assert.ok(media.length >= 2, `至少两张媒体图片，实际 ${media.length}`);
    const rels = zip.readAsText('word/_rels/document.xml.rels');
    assert.ok(rels.includes('media/'), '关系文件指向媒体');
  });

  await run('AI 资产解析失败时降级为警告而非崩溃', async () => {
    const brokenPorts = { ...env.ports, assetResolver: () => null };
    const warnings = [];
    const degraded = await buildDocxResult(payload, { warnings, ...brokenPorts });
    assert.ok(Buffer.isBuffer(degraded.buffer) && degraded.buffer.length > 0, '仍输出 Buffer');
    assert.ok(warnings.length >= 1, '记录图片缺失警告');
  });

  await run('SSRF 防护：远程 http 图片缺省不发起请求并降级', async () => {
    let fetchCalled = false;
    const originalFetch = global.fetch;
    global.fetch = async () => { fetchCalled = true; return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }; };
    try {
      const ssrfOutline = [{ id: '9', title: '远程图', content: '![x](http://169.254.169.254/latest/meta-data/)' }];
      const warnings = [];
      const ssrfResult = await buildDocxResult({ project_name: 'ssrf', outline: ssrfOutline }, { warnings, ...env.ports });
      assert.ok(Buffer.isBuffer(ssrfResult.buffer) && ssrfResult.buffer.length > 0, '仍输出 Buffer');
      assert.strictEqual(fetchCalled, false, '未注入抓取器时不得发起服务端请求');
      assert.ok(warnings.length >= 1, '记录图片无法导出警告');
    } finally {
      global.fetch = originalFetch;
    }
  });

  await run('本地文件 baseDir 为根目录时仍能读取边界内图片', async () => {
    const localPngPath = path.join(env.root, 'local-absolute.png');
    fs.writeFileSync(localPngPath, makePng(64, 64));
    const localOutline = [{ id: '8', title: '本地图', content: `![](${localPngPath})` }];
    const warnings = [];
    // baseDir 固定为根目录 '/'，模拟 macOS Finder 启动时 cwd 为根的场景。
    const localResult = await buildDocxResult(
      { project_name: 'local', outline: localOutline, base_dir: path.parse(env.root).root },
      { warnings, ...env.ports },
    );
    const localZip = new AdmZip(localResult.buffer);
    const media = localZip.getEntries().map((e) => e.entryName).filter((n) => n.startsWith('word/media/'));
    assert.ok(media.length >= 1, '根目录 baseDir 下边界内本地图片应被嵌入');
  });

  await run('注入 remoteImageFetcher 时 http 图片经抓取嵌入', async () => {
    const remotePng = makePng(96, 96);
    let fetchedUrl = null;
    const fetcherPorts = { ...env.ports, remoteImageFetcher: async (url) => { fetchedUrl = url; return { buffer: remotePng, type: 'png' }; } };
    const remoteOutline = [{ id: '7', title: '远程图', content: '![remote](https://cdn.example.com/pic.png)' }];
    const warnings = [];
    const remoteResult = await buildDocxResult({ project_name: 'remote', outline: remoteOutline }, { warnings, ...fetcherPorts });
    assert.strictEqual(fetchedUrl, 'https://cdn.example.com/pic.png', '调用注入的抓取器');
    const remoteZip = new AdmZip(remoteResult.buffer);
    const media = remoteZip.getEntries().map((e) => e.entryName).filter((n) => n.startsWith('word/media/'));
    assert.ok(media.length >= 1, '注入抓取器后 http 图片应被嵌入');
  });

  await run('release guard：发布路径不得引用 simpleDocxBuilder', async () => {
    const clientDir = path.join(__dirname, '..');
    const scanDirs = ['server', 'core', 'electron'];
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
          walk(full);
        } else if (entry.name.endsWith('.cjs')) {
          const text = fs.readFileSync(full, 'utf8');
          if (/simpleDocxBuilder|buildSimpleDocxResult/.test(text)) offenders.push(path.relative(clientDir, full));
        }
      }
    };
    for (const dir of scanDirs) walk(path.join(clientDir, dir));
    assert.deepStrictEqual(offenders, [], `仍有文件引用 simpleDocxBuilder：${offenders.join(', ')}`);
    assert.ok(!fs.existsSync(path.join(clientDir, 'server', 'export', 'simpleDocxBuilder.cjs')), 'simpleDocxBuilder.cjs 已删除');
  });

  console.log(`\nDOCX 结构测试：${passed.length} 通过，${failed.length} 失败`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
