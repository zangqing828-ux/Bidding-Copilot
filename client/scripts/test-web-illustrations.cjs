// WR-04 Web 图片端口测试：Mermaid 校验、HTML/AI 落盘为 asset URL、重跑清理、URL 下载 SSRF 防护。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSqliteDatabase } = require('../core/sqliteDatabase.cjs');
const { createTechnicalPlanStore } = require('../core/stores/technicalPlanStore.cjs');
const { createWebIllustrationPorts } = require('../server/render/webIllustrationPorts.cjs');
const { createAiRuntime } = require('../core/aiRuntime.cjs');
const { createAiFairCoordinator } = require('../core/aiFairCoordinator.cjs');

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

const PNG_BUFFER = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

// 每次调用返回有效 PNG 的桩渲染器。
function createStubRenderer(overrides = {}) {
  return {
    async renderMermaidToPng() { return { buffer: PNG_BUFFER, width: 200, height: 120 }; },
    async renderHtmlToPng() { return { buffer: PNG_BUFFER, width: 1240, height: 600 }; },
    ...overrides,
  };
}

function createStubAiService({ imageBuffer } = {}) {
  return {
    async collectJsonResponse({ normalizer, validator }) {
      const value = { code: 'flowchart TD\n  A["开始"] --> B["结束"]' };
      const normalized = normalizer ? normalizer(value) : value;
      if (validator) validator(normalized);
      return normalized;
    },
    async chat() {
      return '<!DOCTYPE html><html><head></head><body><div style="padding:20px">组织架构</div></body></html>';
    },
    async generateImage() {
      return { success: true, buffer: imageBuffer || PNG_BUFFER, mime_type: 'image/png' };
    },
  };
}

function createHarness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-wr04-illu-'));
  const sqliteDatabase = createSqliteDatabase({ databasePath: path.join(tmpDir, 'yibiao.sqlite') });
  const technicalPlanStore = createTechnicalPlanStore({ db: sqliteDatabase.db, workspaceRoot: tmpDir });
  technicalPlanStore.loadTechnicalPlan();
  return {
    tmpDir,
    technicalPlanStore,
    close() {
      sqliteDatabase.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function buildExecution(kind, imageType) {
  return {
    planItem: { item_id: '1.1', kind, image_type: imageType, title: '测试配图', section_ids: ['1.1'], generation: {} },
    contexts: [],
    reference: '## 1.1 概述小节\n\n项目实施分三个阶段推进。',
  };
}

// 构造仅含签名与 IHDR 头的 PNG，image-size 只读头部字段即可解析尺寸。
function pngWithDimensions(width, height) {
  const signature = Buffer.from('89504e470d0a1a0a', 'hex');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(13, 0);
  const type = Buffer.from('IHDR');
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 6;
  return Buffer.concat([signature, length, type, data, Buffer.alloc(4)]);
}

function readerFromChunks(chunks) {
  let index = 0;
  return {
    getReader() {
      return {
        async read() {
          if (index >= chunks.length) return { done: true, value: undefined };
          const value = chunks[index];
          index += 1;
          return { done: false, value };
        },
        async cancel() { index = chunks.length; },
      };
    },
    async cancel() { index = chunks.length; },
  };
}

function mockResponse({ json, buffer, chunks, contentType, contentLength }) {
  const payload = json !== undefined ? Buffer.from(JSON.stringify(json)) : (buffer || Buffer.alloc(0));
  const bodyChunks = chunks || [payload];
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        const key = String(name || '').toLowerCase();
        if (key === 'content-type') return contentType || (json !== undefined ? 'application/json' : 'image/png');
        if (key === 'content-length') return contentLength !== undefined ? String(contentLength) : null;
        return null;
      },
    },
    body: readerFromChunks(bodyChunks),
    async arrayBuffer() { return payload; },
  };
}

// 构造直连 aiRuntime 的 harness：mock fetch 逐次返回排队的响应。
function createImageRuntimeHarness(responses, { imageModel, captureRequest } = {}) {
  const coordinator = createAiFairCoordinator();
  let call = 0;
  const runtime = createAiRuntime({
    workspaceKey: 'wr04-image-test',
    sharedCoordinator: coordinator,
    loadConfig: () => ({
      image_model: imageModel || {
        provider: 'custom',
        api_key: 'test-image-key',
        base_url: 'https://img.example.com/v1',
        model_name: 'test-image-model',
        status: 'available',
      },
    }),
    fetch: async (url, options) => {
      if (typeof captureRequest === 'function') captureRequest(url, options);
      const next = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return typeof next === 'function' ? next() : next;
    },
    retryDelay: 1,
  });
  return { runtime, close: () => runtime.close() };
}

async function main() {
  await run('Mermaid 端口生成并校验后返回代码', async () => {
    const ports = createWebIllustrationPorts({ renderer: createStubRenderer() });
    const result = await ports.generateMermaidIllustration(createStubAiService(), buildExecution('mermaid', 'process'));
    assert.ok(result.code.startsWith('flowchart'), '返回可渲染 Mermaid 代码');
    assert.equal(typeof result.attempts, 'number', '返回修复轮次');
  });

  await run('HTML 端口渲染后落盘并返回 asset URL', async () => {
    const harness = createHarness();
    try {
      const ports = createWebIllustrationPorts({ renderer: createStubRenderer() });
      const execution = buildExecution('html', '组织架构图');
      const result = await ports.generateHtmlIllustration({
        aiService: createStubAiService(),
        execution,
        plan: { revision: 'rev-1' },
        workspaceStore: harness.technicalPlanStore,
      });
      assert.match(result.asset_url, /^yibiao-asset:\/\/generated-images\/technical-plan\/illustrations\//, '返回 asset URL');
      assert.ok(result.source_path, 'HTML 源文件已落盘');
    } finally {
      harness.close();
    }
  });

  await run('AI 端口把生图 buffer 落盘为 asset URL', async () => {
    const harness = createHarness();
    try {
      const ports = createWebIllustrationPorts({ renderer: createStubRenderer() });
      const execution = buildExecution('ai', 'engineering_diagram');
      const result = await ports.generateAiIllustration(createStubAiService(), execution, {
        plan: { revision: 'rev-1' },
        workspaceStore: harness.technicalPlanStore,
      });
      assert.match(result.asset_url, /^yibiao-asset:\/\/generated-images\/technical-plan\/illustrations\/.*\.png$/, 'AI 图片落盘为 PNG asset URL');
      const relative = result.asset_url.replace('yibiao-asset://generated-images/', '');
      const decoded = relative.split('/').map((part) => decodeURIComponent(part)).join('/');
      const filePath = path.join(harness.tmpDir, 'generated-images', decoded);
      assert.ok(fs.existsSync(filePath), '资产文件确实落盘');
    } finally {
      harness.close();
    }
  });

  await run('重跑清理只删除技术方案图片资产', async () => {
    const harness = createHarness();
    try {
      const ports = createWebIllustrationPorts({ renderer: createStubRenderer() });
      await ports.generateAiIllustration(createStubAiService(), buildExecution('ai', 'engineering_diagram'), {
        plan: { revision: 'rev-1' },
        workspaceStore: harness.technicalPlanStore,
      });
      const illustrationsDir = path.join(harness.tmpDir, 'generated-images', 'technical-plan', 'illustrations');
      assert.ok(fs.existsSync(illustrationsDir), '生成后资产目录存在');
      harness.technicalPlanStore.clearIllustrationFiles();
      assert.ok(!fs.existsSync(illustrationsDir), '清理后资产目录移除');
    } finally {
      harness.close();
    }
  });

  await run('AI 端口缺少持久化服务时报错', async () => {
    const ports = createWebIllustrationPorts({ renderer: createStubRenderer() });
    await assert.rejects(
      () => ports.generateAiIllustration(createStubAiService(), buildExecution('ai', 'engineering_diagram'), { plan: { revision: 'rev-1' } }),
      /持久化/,
    );
  });

  await run('生图返回空 buffer 时报错', async () => {
    const harness = createHarness();
    try {
      const ports = createWebIllustrationPorts({ renderer: createStubRenderer() });
      const emptyAi = { ...createStubAiService(), async generateImage() { return { success: true, buffer: Buffer.alloc(0) }; } };
      await assert.rejects(
        () => ports.generateAiIllustration(emptyAi, buildExecution('ai', 'engineering_diagram'), {
          plan: { revision: 'rev-1' },
          workspaceStore: harness.technicalPlanStore,
        }),
        /有效图片数据/,
      );
    } finally {
      harness.close();
    }
  });

  await run('生图 b64 响应直接返回 buffer', async () => {
    const png = pngWithDimensions(64, 64);
    const harness = createImageRuntimeHarness([
      mockResponse({ json: { data: [{ b64_json: png.toString('base64') }] } }),
    ]);
    try {
      const result = await harness.runtime.generateImage({ prompt: '测试图片', title: '测试' });
      assert.equal(result.success, true, '生图成功');
      assert.ok(result.buffer?.length, '返回图片 buffer');
    } finally {
      await harness.close();
    }
  });

  await run('URL 下载超像素尺寸被拒绝', async () => {
    const harness = createImageRuntimeHarness([
      mockResponse({ json: { data: [{ url: 'https://img.example.com/huge.png' }] } }),
      mockResponse({ buffer: pngWithDimensions(9000, 9000), contentType: 'image/png' }),
    ]);
    try {
      await assert.rejects(
        () => harness.runtime.generateImage({ prompt: '测试图片' }),
        /尺寸超过/,
        '超像素尺寸被拒绝',
      );
    } finally {
      await harness.close();
    }
  });

  await run('URL 下载无 Content-Length 时流式限流生效', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 1);
    const oversizedChunks = Array.from({ length: 25 }, () => chunk);
    const harness = createImageRuntimeHarness([
      mockResponse({ json: { data: [{ url: 'https://img.example.com/big.png' }] } }),
      mockResponse({ chunks: oversizedChunks, contentType: 'image/png' }),
    ]);
    try {
      await assert.rejects(
        () => harness.runtime.generateImage({ prompt: '测试图片' }),
        /体积超过/,
        '流式读取超限被拒绝',
      );
    } finally {
      await harness.close();
    }
  });

  await run('生图返回非图片 content-type 被拒绝', async () => {
    const harness = createImageRuntimeHarness([
      mockResponse({ json: { data: [{ url: 'https://img.example.com/fake.png' }] } }),
      mockResponse({ buffer: Buffer.from('<html></html>'), contentType: 'text/html' }),
    ]);
    try {
      await assert.rejects(
        () => harness.runtime.generateImage({ prompt: '测试图片' }),
        /非图片|失败/,
        '非图片内容被拒绝',
      );
    } finally {
      await harness.close();
    }
  });

  await run('生图 b64 超像素尺寸被拒绝', async () => {
    const oversized = pngWithDimensions(9000, 9000);
    const harness = createImageRuntimeHarness([
      mockResponse({ json: { data: [{ b64_json: oversized.toString('base64') }] } }),
    ]);
    try {
      await assert.rejects(
        () => harness.runtime.generateImage({ prompt: '测试图片' }),
        /尺寸超过/,
        'b64 直返路径同样校验像素尺寸',
      );
    } finally {
      await harness.close();
    }
  });

  await run('生图请求透传用户选择的 image_size', async () => {
    const png = pngWithDimensions(64, 64);
    let sentBody = null;
    const harness = createImageRuntimeHarness([
      mockResponse({ json: { data: [{ b64_json: png.toString('base64') }] } }),
    ], {
      imageModel: {
        provider: 'custom',
        api_key: 'test-image-key',
        base_url: 'https://img.example.com/v1',
        model_name: 'test-image-model',
        image_size: '1536x1024',
        status: 'available',
      },
      captureRequest: (_url, options) => { sentBody = options?.body ? JSON.parse(options.body) : null; },
    });
    try {
      await harness.runtime.generateImage({ prompt: '测试图片' });
      assert.equal(sentBody?.size, '1536x1024', '请求体带上用户选择的 image_size');
    } finally {
      await harness.close();
    }
  });

  console.log(`\nWeb 图片端口测试：${passed.length} 通过，${failed.length} 失败`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
