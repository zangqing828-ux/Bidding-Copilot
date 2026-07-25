const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createAiRuntime } = require('../core/aiRuntime.cjs');
const { createAiFairCoordinator } = require('../core/aiFairCoordinator.cjs');
const {
  createGlobalAiCoordinator,
  getGlobalAiCoordinator,
  resetGlobalAiCoordinator,
} = require('../server/ai/globalAiCoordinator.cjs');
const { createEncryptedConfigStore } = require('../server/config/encryptedConfigStore.cjs');
const { createWorkspaceContext } = require('../server/workspace/workspaceContext.cjs');
const { createWorkspaceRuntimeFactory } = require('../server/workspace/workspaceRuntimeFactory.cjs');
const bridgeRouter = require('../server/routes/bridge.cjs');
const bridgeContract = require('../shared/bridgeContract.cjs');

const API_KEY = 'sk-web-runtime-test-key';
const ONE_SHOT_KEY = 'sk-one-shot-runtime-key';
const passed = [];
const failed = [];
let bridgeCoordinator;
let workspaceTempDir;

function recordPass(name) {
  passed.push(name);
  console.log(`  PASS: ${name}`);
}

function assertNoSecret(value, label) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  assert(!serialized.includes(API_KEY), `${label} 不得包含保存的明文 Key`);
  assert(!serialized.includes(ONE_SHOT_KEY), `${label} 不得包含本次明文 override Key`);
}

async function run(name, callback) {
  try {
    await callback();
    recordPass(name);
  } catch (error) {
    failed.push(`${name}: ${error.message}`);
    console.error(`  FAIL: ${name}: ${error.message}`);
  }
}

function createResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function createConfig(baseUrl, apiKey = API_KEY) {
  return {
    text_model_provider: 'custom',
    api_key: apiKey,
    base_url: baseUrl,
    model_name: 'runtime-test-model',
    analytics_client_id: 'anonymous-test-client',
    analytics_created_at: '2026-07-25T00:00:00.000Z',
  };
}

function createRuntime({ config, coordinator, fetch, trackRequest, timeouts, retryDelay } = {}) {
  return createAiRuntime({
    workspaceKey: config?.workspaceKey || `runtime-${Math.random()}`,
    loadConfig: () => config || createConfig('http://127.0.0.1:1/v1'),
    sharedCoordinator: coordinator || createAiFairCoordinator(),
    fetch,
    trackRequest,
    timeouts,
    retryDelay,
    version: '0.1.0-test',
  });
}

async function createMockServer() {
  const requests = [];
  let chatCount = 0;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        body = null;
      }
      requests.push({
        path: request.url,
        method: request.method,
        headers: request.headers,
        rawBody,
        body,
      });

      let payload;
      if (request.url === '/v1/models') {
        payload = { data: [{ id: 'model-a' }, { id: 'model-b' }] };
      } else if (request.url === '/v1/chat/completions') {
        chatCount += 1;
        payload = {
          choices: [{
            message: {
              content: chatCount === 1 ? 'hello from mock' : '```json\n{"ok":true}\n```',
            },
          }],
          usage: {
            prompt_tokens: 4,
            completion_tokens: 2,
            total_tokens: 6,
          },
        };
      } else {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function collectRelativeRequireGraph(entryPath, visited = new Set()) {
  const absoluteEntry = path.resolve(entryPath);
  if (visited.has(absoluteEntry) || !fs.existsSync(absoluteEntry)) {
    return visited;
  }
  visited.add(absoluteEntry);
  const source = fs.readFileSync(absoluteEntry, 'utf8');
  const requirePattern = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match = requirePattern.exec(source);
  while (match) {
    const request = match[1];
    if (request.startsWith('.')) {
      const base = path.resolve(path.dirname(absoluteEntry), request);
      const candidate = fs.existsSync(base) ? base : fs.existsSync(`${base}.cjs`) ? `${base}.cjs` : `${base}.js`;
      if (fs.existsSync(candidate)) {
        collectRelativeRequireGraph(candidate, visited);
      }
    }
    match = requirePattern.exec(source);
  }
  return visited;
}

async function main() {
  const mock = await createMockServer();
  const runtime = createRuntime({
    config: createConfig(mock.baseUrl),
    trackRequest: () => Promise.reject(new Error(API_KEY)),
  });
  let encryptedRuntime;
  let context;
  let tempDir;

  try {
    await run('本地 HTTP mock /models 使用保存的明文 Key，返回值与请求体不泄露', async () => {
      const result = await runtime.listModels();
      assert.deepEqual(result, {
        success: true,
        message: '模型列表已更新',
        models: ['model-a', 'model-b'],
      });
      const modelRequest = mock.requests.find((request) => request.path === '/v1/models');
      assert.equal(modelRequest.headers.authorization, `Bearer ${API_KEY}`);
      assertNoSecret(result, 'listModels 返回值');
      assertNoSecret(modelRequest.body, 'listModels 请求体');
    });

    await run('chat 保留常用字段并记录 token stats', async () => {
      const changed = [];
      const unsubscribe = runtime.onChanged((stats) => changed.push(stats));
      const content = await runtime.chat({
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.2,
        response_format: { type: 'text' },
      });
      unsubscribe();
      assert.equal(content, 'hello from mock');
      assert.equal(runtime.getTextTokenStats().request_count, 1);
      assert.equal(runtime.getTextTokenStats().input_tokens, 4);
      assert.equal(runtime.getTextTokenStats().output_tokens, 2);
      assert.equal(runtime.getTextTokenStats().total_tokens, 6);
      assert.equal(changed.length, 1);
      const chatRequest = mock.requests.find((request) => request.path === '/v1/chat/completions');
      assert.deepEqual(chatRequest.body.messages, [{ role: 'user', content: 'hello' }]);
      assert.equal(chatRequest.body.model, 'runtime-test-model');
      assert.equal(chatRequest.body.temperature, 0.2);
      assert.deepEqual(chatRequest.body.response_format, { type: 'text' });
      assert.equal(chatRequest.body.stream, false);
      assertNoSecret(content, 'chat 返回值');
      assertNoSecret(chatRequest.body, 'chat 请求体');
    });

    await run('requestJson 支持 fenced JSON 与平衡 JSON', async () => {
      const parsed = await runtime.requestJson({
        messages: [{ role: 'user', content: 'json please' }],
      });
      assert.deepEqual(parsed, { ok: true });
      assertNoSecret(parsed, 'requestJson 返回值');
    });

    await run('configStore.load 脱敏，loadDecrypted 与 runtime 使用明文', async () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-ai-runtime-config-'));
      process.env.CONFIG_ENCRYPTION_KEY = 'web-ai-runtime-test-encryption-key';
      const configStore = createEncryptedConfigStore({ configPath: path.join(tempDir, 'config.enc.json') });
      configStore.save({
        text_model_provider: 'custom',
        api_key: API_KEY,
        base_url: mock.baseUrl,
        model_name: 'runtime-test-model',
      });
      const masked = configStore.load();
      const decrypted = configStore.loadDecrypted();
      assert.equal(masked.api_key, '****-key');
      assert.equal(decrypted.api_key, API_KEY);
      assertNoSecret(masked, 'configStore.load');
      assert(decrypted.api_key === API_KEY, 'loadDecrypted 应返回明文 Key');
      encryptedRuntime = createAiRuntime({
        workspaceKey: 'encrypted-config-runtime',
        loadConfig: configStore.loadDecrypted,
        sharedCoordinator: createAiFairCoordinator(),
        fetch: globalThis.fetch,
        retryDelay: 0,
      });
      const result = await encryptedRuntime.listModels();
      assert.equal(result.success, true);
      const request = mock.requests.filter((item) => item.path === '/v1/models').at(-1);
      assert.equal(request.headers.authorization, `Bearer ${API_KEY}`);
    });

    await run('listModels 对脱敏 override 使用保存的明文，明文 override 仅本次生效', async () => {
      const maskedResult = await runtime.listModels({
        api_key: '****-key',
        base_url: mock.baseUrl,
        model_name: 'runtime-test-model',
      });
      assert.equal(maskedResult.success, true);
      const maskedRequest = mock.requests.filter((item) => item.path === '/v1/models').at(-1);
      assert.equal(maskedRequest.headers.authorization, `Bearer ${API_KEY}`);

      const oneShotResult = await runtime.listModels({
        api_key: ONE_SHOT_KEY,
        base_url: mock.baseUrl,
        model_name: 'runtime-test-model',
      });
      assert.equal(oneShotResult.success, true);
      const oneShotRequest = mock.requests.filter((item) => item.path === '/v1/models').at(-1);
      assert.equal(oneShotRequest.headers.authorization, `Bearer ${ONE_SHOT_KEY}`);
      assertNoSecret(oneShotResult, '明文 override 返回值');
    });

    await run('两个 runtime 的 token stats 与 queue scope 相互隔离', async () => {
      const coordinator = createAiFairCoordinator({ textLimit: 2 });
      const fetch = async () => createResponse(200, {
        choices: [{ message: { content: 'isolated' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      const config = createConfig('http://isolated.test/v1');
      const first = createRuntime({ config: { ...config, workspaceKey: 'account-a' }, coordinator, fetch });
      const second = createRuntime({ config: { ...config, workspaceKey: 'account-b' }, coordinator, fetch });
      try {
        first.pauseQueueScope('scope-a');
        await assert.rejects(
          first.withQueueScope('scope-a').chat({ messages: [{ role: 'user', content: 'paused' }] }),
          (error) => error.code === 'AI_QUEUE_SCOPE_PAUSED',
        );
        await second.withQueueScope('scope-a').chat({ messages: [{ role: 'user', content: 'active' }] });
        assert.equal(first.getTextTokenStats().request_count, 0);
        assert.equal(second.getTextTokenStats().request_count, 1);
      } finally {
        first.close();
        second.close();
      }
    });

    await run('429 与 5xx 最多重试三次，普通 400 不重试', async () => {
      for (const transientStatus of [429, 503]) {
        let attempts = 0;
        const retryRuntime = createRuntime({
          config: createConfig('http://retry.test/v1'),
          fetch: async () => {
            attempts += 1;
            if (attempts < 3) {
              return createResponse(transientStatus, {});
            }
            return createResponse(200, {
              choices: [{ message: { content: 'retry success' } }],
              usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
            });
          },
          retryDelay: 0,
        });
        try {
          assert.equal(await retryRuntime.chat({ messages: [{ role: 'user', content: 'retry' }] }), 'retry success');
          assert.equal(attempts, 3);
        } finally {
          retryRuntime.close();
        }
      }

      let badRequestAttempts = 0;
      const badRequestRuntime = createRuntime({
        config: createConfig('http://bad-request.test/v1'),
        fetch: async () => {
          badRequestAttempts += 1;
          return createResponse(400, {});
        },
        retryDelay: 0,
      });
      try {
        await assert.rejects(
          badRequestRuntime.chat({ messages: [{ role: 'user', content: 'bad request' }] }),
          (error) => error.code === 'AI_HTTP_ERROR' && error.status === 400,
        );
        assert.equal(badRequestAttempts, 1);
      } finally {
        badRequestRuntime.close();
      }
    });

    await run('timeout 会安全失败且不回显 Key', async () => {
      let attempts = 0;
      const timeoutRuntime = createRuntime({
        config: createConfig('http://timeout.test/v1'),
        fetch: async () => {
          attempts += 1;
          return new Promise(() => {});
        },
        timeouts: { text: 5 },
        retryDelay: 0,
      });
      try {
        await assert.rejects(
          timeoutRuntime.chat({ messages: [{ role: 'user', content: 'timeout' }] }),
          (error) => error.code === 'AI_REQUEST_TIMEOUT',
        );
        assert.equal(attempts, 3);
      } catch (error) {
        assertNoSecret(error.message, 'timeout 错误');
        throw error;
      } finally {
        timeoutRuntime.close();
      }
    });

    await run('analytics 仅收到低敏字段，统计失败不影响 AI', async () => {
      const payloads = [];
      const analyticsRuntime = createRuntime({
        config: { ...createConfig('https://api.example.test/v1'), workspaceKey: 'secret-workspace-id' },
        fetch: async () => createResponse(200, {
          choices: [{ message: { content: 'analytics ok' } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
        trackRequest(payload) {
          payloads.push(payload);
          throw new Error(API_KEY);
        },
      });
      try {
        assert.equal(await analyticsRuntime.chat({ messages: [{ role: 'user', content: 'secret prompt' }] }), 'analytics ok');
        assert.equal(payloads.length, 1);
        const allowed = new Set([
          'ai_request_type', 'ai_model_provider', 'ai_model_base_url', 'ai_model_name',
          'text_model_name', 'prompt_tokens', 'completion_tokens', 'total_tokens',
          'version', 'platform', 'arch', 'client_id', 'client_created_at',
        ]);
        assert.deepEqual(Object.keys(payloads[0]).filter((key) => !allowed.has(key)), []);
        assert.equal(payloads[0].ai_model_base_url, 'api.example.test');
        assertNoSecret(payloads[0], 'analytics payload');
        assert(!JSON.stringify(payloads[0]).includes('secret-workspace-id'), 'analytics 不得包含 workspace ID');
      } finally {
        analyticsRuntime.close();
      }
    });

    await run('global coordinator singleton 的低值生效且高值 clamp 到 30/6', async () => {
      const oldText = process.env.WEB_AI_GLOBAL_TEXT_LIMIT;
      const oldImage = process.env.WEB_AI_GLOBAL_IMAGE_LIMIT;
      try {
        process.env.WEB_AI_GLOBAL_TEXT_LIMIT = '7';
        process.env.WEB_AI_GLOBAL_IMAGE_LIMIT = '99';
        resetGlobalAiCoordinator();
        const low = getGlobalAiCoordinator();
        assert.equal(low.getStatus().text.limit, 7);
        assert.equal(low.getStatus().image.limit, 6);
        assert.equal(low, getGlobalAiCoordinator());

        process.env.WEB_AI_GLOBAL_TEXT_LIMIT = '35';
        process.env.WEB_AI_GLOBAL_IMAGE_LIMIT = '8';
        resetGlobalAiCoordinator();
        const high = createGlobalAiCoordinator();
        assert.equal(high.getStatus().text.limit, 30);
        assert.equal(high.getStatus().image.limit, 6);
        high.close();
      } finally {
        resetGlobalAiCoordinator();
        if (oldText === undefined) delete process.env.WEB_AI_GLOBAL_TEXT_LIMIT;
        else process.env.WEB_AI_GLOBAL_TEXT_LIMIT = oldText;
        if (oldImage === undefined) delete process.env.WEB_AI_GLOBAL_IMAGE_LIMIT;
        else process.env.WEB_AI_GLOBAL_IMAGE_LIMIT = oldImage;
      }
    });

    await run('config.listModels dispatcher 真实成功，合同仅 listModels implemented', async () => {
      assert.equal(bridgeContract.methods.config.listModels.status, 'implemented');
      assert.equal(bridgeContract.methods.ai.chat.status, 'pending');
      assert.equal(bridgeContract.methods.ai.requestJson.status, 'pending');
      assert.equal(bridgeContract.methods.ai.testImageModel.status, 'pending');
      assert.equal(typeof bridgeRouter.__contractDispatchers.config.listModels, 'function');

      const coordinator = createAiFairCoordinator();
      bridgeCoordinator = coordinator;
      workspaceTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-ai-runtime-workspace-'));
      context = createWorkspaceContext({
        workspaceId: 'bridge-model-list',
        dataDir: workspaceTempDir,
        runtimeFactory: (runtimeOptions) => createWorkspaceRuntimeFactory({
          ...runtimeOptions,
          sharedCoordinator: coordinator,
          aiRuntimeOptions: {
            fetch: globalThis.fetch,
            retryDelay: 0,
          },
        }),
      });
      context.configStore.save({
        text_model_provider: 'custom',
        api_key: API_KEY,
        base_url: mock.baseUrl,
        model_name: 'runtime-test-model',
      });
      const bridgeConfig = await bridgeRouter.__contractDispatchers.config.load(context, []);
      assert.equal(bridgeConfig.api_key, '****-key');
      assertNoSecret(bridgeConfig, 'bridge config.load');
      assert(context.aiService, 'workspace context 应暴露 aiService');
      const result = await bridgeRouter.__contractDispatchers.config.listModels(context, [{
        api_key: '****-key',
        base_url: mock.baseUrl,
        model_name: 'runtime-test-model',
      }]);
      assert.equal(result.success, true);
      assert.deepEqual(result.models, ['model-a', 'model-b']);
      assertNoSecret(result, 'bridge listModels 返回值');
    });

    await run('live workspace factory 不再使用 AI stub，workspace close 不关闭共享 coordinator', async () => {
      const factorySource = fs.readFileSync(
        path.join(__dirname, '../server/workspace/workspaceRuntimeFactory.cjs'),
        'utf8',
      );
      assert(!factorySource.includes('createWebAiServiceStub'), 'live workspace factory 不得引用 createWebAiServiceStub');
      assert.equal(typeof context.aiService.chat, 'function');
      assert.notEqual(context.aiService.chat, undefined);
      const coordinatorStatusBefore = bridgeCoordinator.getStatus();
      context.close();
      assert.deepEqual(bridgeCoordinator.getStatus(), coordinatorStatusBefore);
      const coordinatorProbe = await bridgeCoordinator.enqueue('text', 'post-close-probe', async () => 'alive');
      assert.equal(coordinatorProbe, 'alive');
      context = null;
    });

    await run('Web/core 可达 require 图不进入 Electron', async () => {
      const entries = [
        path.join(__dirname, '../core/aiRuntime.cjs'),
        path.join(__dirname, '../server/workspace/workspaceRuntimeFactory.cjs'),
        path.join(__dirname, '../server/routes/bridge.cjs'),
      ];
      const graph = new Set();
      entries.forEach((entry) => collectRelativeRequireGraph(entry, graph));
      const electronPaths = [...graph].filter((entry) => entry.includes(`${path.sep}electron${path.sep}`));
      assert.deepEqual(electronPaths, []);
    });
  } finally {
    if (context) {
      try {
        context.close();
      } catch {
        // 测试收尾继续释放临时目录。
      }
    }
    if (encryptedRuntime) {
      encryptedRuntime.close();
    }
    runtime.close();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    if (workspaceTempDir && fs.existsSync(workspaceTempDir)) {
      fs.rmSync(workspaceTempDir, { recursive: true, force: true });
    }
    if (bridgeCoordinator && typeof bridgeCoordinator.close === 'function') {
      bridgeCoordinator.close();
    }
    await mock.close();
    resetGlobalAiCoordinator();
  }

  console.log(`\n=== Web AI Runtime 测试结果 ===`);
  console.log(`通过: ${passed.length}`);
  console.log(`失败: ${failed.length}`);
  failed.forEach((message) => console.log(`  ${message}`));
  assertNoSecret(failed, '测试输出');
  if (failed.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  assertNoSecret(error.message, '测试异常输出');
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
