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
const PROVIDER_A_KEY = 'sk-provider-a-runtime-key';
const PROVIDER_B_KEY = 'sk-provider-b-runtime-key';
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

    await run('policy 返回的 requestOptions 会透传到 runtime fetch 并保持 redirect manual', async () => {
      const capture = {
        policyClosed: false,
        fetchOptions: null,
      };
      const dispatcher = { __kind: 'test-dispatcher' };
      const runtimeWithPolicy = createAiRuntime({
        workspaceKey: 'request-options-runtime',
        loadConfig: () => createConfig(mock.baseUrl),
        sharedCoordinator: createAiFairCoordinator(),
        endpointPolicy: {
          assertAllowed: async () => ({ dispatcher }),
          close() {
            capture.policyClosed = true;
          },
        },
        fetch: async (_url, options) => {
          capture.fetchOptions = options;
          return createResponse(200, {
            choices: [{ message: { content: 'dispatcher-ok' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
        },
        retryDelay: 0,
      });
      try {
        const content = await runtimeWithPolicy.chat({ messages: [{ role: 'user', content: 'use dispatcher' }] });
        assert.equal(content, 'dispatcher-ok');
        assert.equal(capture.fetchOptions?.dispatcher, dispatcher);
        assert.equal(capture.fetchOptions?.redirect, 'manual');
      } finally {
        await runtimeWithPolicy.close();
        assert.equal(capture.policyClosed, true, 'runtime.close 应触发 policy.close');
      }
    });

    await run('runtime.close resolve 时返回同一 in-flight Promise 并保持幂等', async () => {
      let closeCalls = 0;
      let resolveClose;
      const policyClose = new Promise((resolve) => {
        resolveClose = resolve;
      });
      const runtimeWithPendingPolicy = createAiRuntime({
        workspaceKey: 'pending-policy-close-runtime',
        loadConfig: () => createConfig(mock.baseUrl),
        sharedCoordinator: createAiFairCoordinator(),
        endpointPolicy: {
          assertAllowed: async () => true,
          close() {
            closeCalls += 1;
            return policyClose;
          },
        },
      });
      try {
        const first = runtimeWithPendingPolicy.close();
        const second = runtimeWithPendingPolicy.close();
        assert(first instanceof Promise);
        assert.equal(first, second, '并发 close 应返回同一 in-flight Promise');
        assert.equal(closeCalls, 0, '关闭处理器在返回 Promise 后异步启动');
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(closeCalls, 1);
        resolveClose();
        await first;
        assert.equal(runtimeWithPendingPolicy.close(), first, '成功后 close 仍保持幂等');
      } finally {
        resolveClose?.();
        await runtimeWithPendingPolicy.close();
      }
    });

    await run('runtime.close 透传异步 policy.close 失败且不会产生未处理拒绝', async () => {
      let closeCalls = 0;
      const unhandledRejections = [];
      const onUnhandledRejection = (error) => unhandledRejections.push(error);
      const runtimeWithRejectingPolicy = createAiRuntime({
        workspaceKey: 'rejecting-policy-close-runtime',
        loadConfig: () => createConfig(mock.baseUrl),
        sharedCoordinator: createAiFairCoordinator(),
        endpointPolicy: {
          assertAllowed: async () => true,
          close() {
            closeCalls += 1;
            return Promise.reject(new Error('policy close failed'));
          },
        },
      });
      process.once('unhandledRejection', onUnhandledRejection);
      try {
        const first = runtimeWithRejectingPolicy.close();
        const second = runtimeWithRejectingPolicy.close();
        assert.equal(first, second, '失败中的重复 close 应共享同一 Promise');
        await assert.rejects(first, /policy close failed/);
        assert.equal(closeCalls, 1);
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(unhandledRejections, []);
      } finally {
        process.removeListener('unhandledRejection', onUnhandledRejection);
      }
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

      const restoredResult = await runtime.listModels({
        api_key: '****-key',
        base_url: mock.baseUrl,
        model_name: 'runtime-test-model',
      });
      assert.equal(restoredResult.success, true);
      const restoredRequest = mock.requests.filter((item) => item.path === '/v1/models').at(-1);
      assert(restoredRequest.headers.authorization === `Bearer ${API_KEY}`, '明文 override 不得污染后续请求');
      assertNoSecret(restoredResult, '恢复保存配置的返回值');
    });

    await run('provider 切换按目标 profile 回退 Key/Base URL，错误与返回值不泄露明文', async () => {
      const providerConfig = {
        workspaceKey: 'provider-switch-runtime',
        text_model_provider: 'provider-a',
        api_key: PROVIDER_A_KEY,
        base_url: 'https://provider-a.example/v1',
        model_name: 'provider-a-model',
        text_model_profiles: {
          'provider-a': {
            api_key: PROVIDER_A_KEY,
            base_url: 'https://provider-a.example/v1',
            model_name: 'provider-a-model',
          },
          'provider-b': {
            api_key: PROVIDER_B_KEY,
            base_url: mock.baseUrl,
            model_name: '',
          },
        },
      };
      const maskedOverride = {
        text_model_provider: 'provider-b',
        api_key: '****-key',
        base_url: '',
        model_name: '',
        text_model_profiles: {
          'provider-b': {
            api_key: '****-key',
            base_url: '',
            model_name: '',
          },
        },
      };
      const providerRuntime = createRuntime({
        config: providerConfig,
        fetch: globalThis.fetch,
        retryDelay: 0,
      });
      try {
        const result = await providerRuntime.listModels(maskedOverride);
        assert.equal(result.success, true);
        const modelRequest = mock.requests.filter((item) => item.path === '/v1/models').at(-1);
        assert(modelRequest.headers.authorization === `Bearer ${PROVIDER_B_KEY}`, '请求必须使用目标 provider 保存的 Key');
        assertNoSecret(result, 'provider 切换返回值');
        assert(!JSON.stringify(result).includes(PROVIDER_A_KEY), '返回值不得包含旧 provider Key');

        const errorRuntime = createRuntime({
          config: providerConfig,
          fetch: async () => createResponse(400, {}),
          retryDelay: 0,
        });
        try {
          const errorResult = await errorRuntime.listModels(maskedOverride);
          assert.equal(errorResult.success, false);
          assertNoSecret(errorResult, 'provider 切换错误');
          assert(!JSON.stringify(errorResult).includes(PROVIDER_B_KEY), '错误不得包含目标 provider Key');
        } finally {
          await errorRuntime.close();
        }
      } finally {
        await providerRuntime.close();
      }
    });

    await run('listModels 不要求模型名，chat 仍在缺模型名时失败', async () => {
      const emptyModelRuntime = createRuntime({
        config: {
          workspaceKey: 'empty-model-runtime',
          text_model_provider: 'provider-b',
          api_key: PROVIDER_B_KEY,
          base_url: mock.baseUrl,
          model_name: '',
          text_model_profiles: {
            'provider-b': {
              api_key: PROVIDER_B_KEY,
              base_url: mock.baseUrl,
              model_name: '',
            },
          },
        },
        fetch: globalThis.fetch,
        retryDelay: 0,
      });
      try {
        const result = await emptyModelRuntime.listModels();
        assert.equal(result.success, true);
        await assert.rejects(
          emptyModelRuntime.chat({ messages: [{ role: 'user', content: 'missing model' }] }),
          (error) => error.code === 'AI_CONFIG_INVALID' && error.message === '请先配置文本模型名称',
        );
      } finally {
        await emptyModelRuntime.close();
      }
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
        await first.close();
        await second.close();
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
          await retryRuntime.close();
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
        await badRequestRuntime.close();
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
        assert.equal(attempts, 1, '总 deadline 用尽后不应再开始新的重试');
      } catch (error) {
        assertNoSecret(error.message, 'timeout 错误');
        throw error;
      } finally {
        await timeoutRuntime.close();
      }
    });

    await run('响应体超过 8 MiB 时取消上游响应并安全失败', async () => {
      let cancelled = false;
      const oversizedRuntime = createRuntime({
        config: createConfig('http://oversized.test/v1'),
        fetch: async () => ({
          ok: true,
          status: 200,
          headers: { get: (name) => (name === 'content-length' ? String(8 * 1024 * 1024 + 1) : null) },
          body: { cancel: async () => { cancelled = true; } },
        }),
        retryDelay: 0,
      });
      try {
        await assert.rejects(
          oversizedRuntime.chat({ messages: [{ role: 'user', content: 'oversized' }] }),
          (error) => error.code === 'AI_RESPONSE_PARSE_ERROR',
        );
        assert.equal(cancelled, true);
      } finally {
        await oversizedRuntime.close();
      }
    });

    await run('浏览器断连信号会中止已开始的上游 AI 请求', async () => {
      let upstreamAborted = false;
      const abortedRuntime = createRuntime({
        config: createConfig('http://abort.test/v1'),
        fetch: async (_url, options) => new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            upstreamAborted = true;
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        }),
        retryDelay: 0,
      });
      const controller = new AbortController();
      try {
        const request = abortedRuntime.chat(
          { messages: [{ role: 'user', content: 'abort' }] },
          { signal: controller.signal },
        );
        await new Promise((resolve) => setImmediate(resolve));
        controller.abort();
        await assert.rejects(request, (error) => error.code === 'AI_REQUEST_ABORTED');
        assert.equal(upstreamAborted, true);
      } finally {
        await abortedRuntime.close();
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
          'ai_request_type', 'ai_model_provider', 'prompt_tokens', 'completion_tokens', 'total_tokens',
          'version', 'platform', 'arch', 'client_id', 'client_created_at',
        ]);
        assert.deepEqual(Object.keys(payloads[0]).filter((key) => !allowed.has(key)), []);
        assert.equal('ai_model_base_url' in payloads[0], false);
        assert.equal('ai_model_name' in payloads[0], false);
        assertNoSecret(payloads[0], 'analytics payload');
        assert(!JSON.stringify(payloads[0]).includes('secret-workspace-id'), 'analytics 不得包含 workspace ID');
      } finally {
        await analyticsRuntime.close();
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
        await high.close();
      } finally {
        resetGlobalAiCoordinator();
        if (oldText === undefined) delete process.env.WEB_AI_GLOBAL_TEXT_LIMIT;
        else process.env.WEB_AI_GLOBAL_TEXT_LIMIT = oldText;
        if (oldImage === undefined) delete process.env.WEB_AI_GLOBAL_IMAGE_LIMIT;
        else process.env.WEB_AI_GLOBAL_IMAGE_LIMIT = oldImage;
      }
    });

    await run('development 显式注入 endpoint policy 仍可测试本地 mock', async () => {
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
            // 该 workspace 测试使用本地 HTTP mock；真实 Web runtime 默认注入安全 endpoint policy。
            endpointPolicy: async () => true,
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

    await run('development workspace factory 未注入时默认创建安全 endpoint policy', async () => {
      const oldNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      const runtimeCoordinator = createAiFairCoordinator();
      const defaultTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-ai-runtime-workspace-dev-default-'));
      let defaultFetchOptions = null;
      const defaultContext = createWorkspaceContext({
        workspaceId: 'bridge-model-list-dev-default',
        dataDir: defaultTempDir,
        runtimeFactory: (runtimeOptions) => createWorkspaceRuntimeFactory({
          ...runtimeOptions,
          sharedCoordinator: runtimeCoordinator,
          aiRuntimeOptions: {
            fetch: async (_url, options) => {
              defaultFetchOptions = options;
              return createResponse(200, {
                data: [{ id: 'model-a' }],
              });
            },
            retryDelay: 0,
          },
        }),
      });
      try {
        defaultContext.configStore.save({
          text_model_provider: 'custom',
          api_key: API_KEY,
          base_url: 'https://93.184.216.34/v1',
          model_name: 'runtime-test-model',
        });
        const result = await bridgeRouter.__contractDispatchers.config.listModels(defaultContext, [{
          api_key: API_KEY,
          base_url: 'https://93.184.216.34/v1',
          model_name: 'runtime-test-model',
        }]);
        assert.equal(result.success, true);
        assert.deepEqual(result.models, ['model-a']);
        assert.ok(defaultFetchOptions?.dispatcher, '开发环境未注入 policy 时仍应带安全 dispatcher');
      } finally {
        process.env.NODE_ENV = oldNodeEnv;
        await defaultContext.close();
        await runtimeCoordinator.close();
        fs.rmSync(defaultTempDir, { recursive: true, force: true });
      }
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
      await context.close();
      assert.deepEqual(bridgeCoordinator.getStatus(), coordinatorStatusBefore);
      const coordinatorProbe = await bridgeCoordinator.enqueue('text', 'post-close-probe', async () => 'alive');
      assert.equal(coordinatorProbe, 'alive');
      context = null;
    });

    await run('生产环境下 workspace factory 强制注入安全 endpoint policy，忽略注入的空策略', async () => {
      const oldNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      const runtimeCoordinator = createAiFairCoordinator();
      let injectedEndpointCalled = false;
      workspaceTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-ai-runtime-workspace-prod-'));
      const productionContext = createWorkspaceContext({
        workspaceId: 'bridge-model-list-prod',
        dataDir: workspaceTempDir,
        runtimeFactory: (runtimeOptions) => createWorkspaceRuntimeFactory({
          ...runtimeOptions,
          sharedCoordinator: runtimeCoordinator,
          aiRuntimeOptions: {
            fetch: async (url) => {
              if (String(url).includes('/v1/models')) {
                return createResponse(200, {
                  data: [{ id: 'model-a' }, { id: 'model-b' }],
                });
              }
              return createResponse(200, {
                choices: [{ message: { content: 'ok' } }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              });
            },
            endpointPolicy: {
              assertAllowed: async () => {
                injectedEndpointCalled = true;
                return false;
              },
            },
            retryDelay: 0,
          },
        }),
      });
      try {
        productionContext.configStore.save({
          text_model_provider: 'custom',
          api_key: API_KEY,
          base_url: 'https://93.184.216.34/v1',
          model_name: 'runtime-test-model',
        });
        const result = await bridgeRouter.__contractDispatchers.config.listModels(productionContext, [{
          api_key: API_KEY,
          base_url: 'https://93.184.216.34/v1',
          model_name: 'runtime-test-model',
        }]);
        assert.equal(result.success, true);
        assert.equal(result.models.length, 2);
        assert.equal(injectedEndpointCalled, false, '生产环境应忽略注入 endpointPolicy');
      } finally {
        process.env.NODE_ENV = oldNodeEnv;
        await productionContext.close();
        await runtimeCoordinator.close();
        if (workspaceTempDir && fs.existsSync(workspaceTempDir)) {
          fs.rmSync(workspaceTempDir, { recursive: true, force: true });
          workspaceTempDir = null;
        }
      }
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
        await context.close();
      } catch {
        // 测试收尾继续释放临时目录。
      }
    }
    if (encryptedRuntime) {
      await encryptedRuntime.close();
    }
    await runtime.close();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    if (workspaceTempDir && fs.existsSync(workspaceTempDir)) {
      fs.rmSync(workspaceTempDir, { recursive: true, force: true });
    }
    if (bridgeCoordinator && typeof bridgeCoordinator.close === 'function') {
      await bridgeCoordinator.close();
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
