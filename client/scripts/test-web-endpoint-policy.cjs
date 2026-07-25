const assert = require('node:assert/strict');
const http = require('node:http');
const { fetch: undiciFetch } = require('undici');

const { createAiFairCoordinator } = require('../core/aiFairCoordinator.cjs');
const { createAiRuntime } = require('../core/aiRuntime.cjs');
const {
  createWebEndpointPolicy,
  isBlockedAddress,
} = require('../server/ai/webEndpointPolicy.cjs');

const passed = [];
const failed = [];

async function run(name, callback) {
  try {
    await callback();
    passed.push(name);
    console.log(`  PASS: ${name}`);
  } catch (error) {
    failed.push(`${name}: ${error.message}`);
    console.error(`  FAIL: ${name}: ${error.message}`);
  }
}

function createPolicy(lookup, options = {}) {
  return createWebEndpointPolicy({
    production: false,
    allowHttp: true,
    lookup,
    ...options,
  });
}

function createResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

async function main() {
  await run('literal IPv4/IPv6 的 loopback、私网、链路本地、未指定和组播地址均拒绝', async () => {
    const policy = createPolicy(async () => {
      throw new Error('literal 地址不应触发 DNS');
    });
    const addresses = [
      '0.0.0.0',
      '10.0.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '192.168.1.1',
      '224.0.0.1',
      '::',
      '::1',
      'fc00::1',
      'fe80::1',
      'ff02::1',
    ];
    try {
      for (const address of addresses) {
        const endpoint = address.includes(':') ? `https://[${address}]/v1` : `https://${address}/v1`;
        await assert.rejects(policy.assertAllowed(endpoint), (error) => error.code === 'AI_ENDPOINT_NOT_ALLOWED');
        assert.equal(isBlockedAddress(address), true, `${address} 应归入受限地址`);
      }
    } finally {
      await policy.close();
    }
  });

  await run('localhost 和云元数据类主机名拒绝', async () => {
    const policy = createPolicy(async () => [{ address: '93.184.216.34', family: 4 }]);
    try {
      for (const hostname of ['localhost', 'foo.localhost', 'metadata.google.internal', 'metadata.azure.com', 'instance-data']) {
        await assert.rejects(
          policy.assertAllowed(`https://${hostname}/v1`),
          (error) => error.code === 'AI_ENDPOINT_NOT_ALLOWED',
        );
      }
    } finally {
      await policy.close();
    }
  });

  await run('DNS 解析结果逐个检查，公开地址允许且私网混合结果拒绝', async () => {
    const seen = [];
    const policy = createPolicy(async (hostname) => {
      seen.push(hostname);
      if (hostname === 'private.example') {
        return [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.9', family: 4 }];
      }
      return [{ address: '93.184.216.34', family: 4 }];
    });
    try {
      await policy.assertAllowed('https://public.example/v1');
      await assert.rejects(
        policy.assertAllowed('https://private.example/v1'),
        (error) => error.code === 'AI_ENDPOINT_NOT_ALLOWED',
      );
      assert.deepEqual(seen, ['public.example', 'private.example']);
    } finally {
      await policy.close();
    }
  });

  await run('预检与连接 lookup 分离：预检返回公网，连接解析返回私网须拒绝', async () => {
    const seen = [];
    const policy = createPolicy(async (hostname) => {
      seen.push(hostname);
      if (hostname === 'rebinding.test') {
        if (seen.length === 1) {
          return [{ address: '93.184.216.34', family: 4 }];
        }
        return [{ address: '10.0.0.7', family: 4 }];
      }
      return [{ address: '93.184.216.34', family: 4 }];
    });

    try {
      const options = await policy.assertAllowed('https://rebinding.test/v1');
      assert.ok(options && options.dispatcher, 'policy 应返回带 dispatcher 的 request options');
      assert.equal(seen.length, 1);

      const connectLookup = policy.getConnectLookup();
      await assert.rejects(
        connectLookup('rebinding.test', {}),
        (error) => error.code === 'AI_ENDPOINT_NOT_ALLOWED',
      );
      assert.equal(seen.length, 2);
      assert.equal(seen[1], 'rebinding.test');
    } finally {
      await policy.close();
    }
  });

  await run('undici connect lookup callback 使用已校验的 address/family', async () => {
    const policy = createPolicy(async () => [{ address: '93.184.216.34', family: 4 }]);
    try {
      const connectLookup = policy.getConnectLookup();
      const result = await new Promise((resolve, reject) => {
        connectLookup('public.example', { family: 4 }, (error, address, family) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ address, family });
        });
      });
      assert.deepEqual(result, { address: '93.184.216.34', family: 4 });
    } finally {
      await policy.close();
    }
  });

  await run('生产环境拒绝 HTTP，开发环境只有显式 allowHttp 才放行', async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const productionPolicy = createWebEndpointPolicy({ production: true, lookup });
    const developmentPolicy = createWebEndpointPolicy({ production: false, lookup });
    const allowedPolicy = createWebEndpointPolicy({ production: false, allowHttp: true, lookup });
    try {
      await assert.rejects(
        productionPolicy.assertAllowed('http://public.example/v1'),
        (error) => error.code === 'AI_ENDPOINT_NOT_ALLOWED',
      );
      await assert.rejects(
        developmentPolicy.assertAllowed('http://public.example/v1'),
        (error) => error.code === 'AI_ENDPOINT_NOT_ALLOWED',
      );
      await allowedPolicy.assertAllowed('http://public.example/v1');
    } finally {
      await Promise.all([
        productionPolicy.close(),
        developmentPolicy.close(),
        allowedPolicy.close(),
      ]);
    }
  });

  await run('请求强制 manual redirect，3xx 作为安全错误且不重试', async () => {
    let attempts = 0;
    let redirectMode = '';
    const runtime = createAiRuntime({
      workspaceKey: 'endpoint-policy-redirect',
      loadConfig: () => ({
        api_key: 'sk-endpoint-policy-test',
        base_url: 'https://public.example/v1',
        model_name: 'test-model',
      }),
      sharedCoordinator: createAiFairCoordinator(),
      endpointPolicy: createPolicy(async () => [{ address: '93.184.216.34', family: 4 }]),
      fetch: async (_url, options) => {
        attempts += 1;
        redirectMode = options.redirect;
        return createResponse(302, {});
      },
      retryDelay: 0,
    });
    try {
      const result = await runtime.listModels();
      assert.equal(result.success, false);
      assert.equal(attempts, 1);
      assert.equal(redirectMode, 'manual');
      assert(!result.message.includes('public.example'));
      assert(!result.message.includes('sk-endpoint-policy-test'));
    } finally {
      await runtime.close();
    }
  });

  await run('真实 Undici 请求在连接期命中 127.0.0.1 时拒绝且本机服务零命中', async () => {
    let lookupCalls = 0;
    let serverHits = 0;
    const server = http.createServer(() => {
      serverHits += 1;
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const policy = createPolicy(async () => {
      lookupCalls += 1;
      if (lookupCalls === 1) {
        return [{ address: '93.184.216.34', family: 4 }];
      }
      return [{ address: '127.0.0.1', family: 4 }];
    });

    const requestAbortController = new AbortController();
    try {
      const requestOptions = await policy.assertAllowed(`http://rebind.test:${port}/v1`);
      assert.equal(lookupCalls, 1, '预检只使用公网解析结果');
      await assert.rejects(
        undiciFetch(`http://rebind.test:${port}/v1`, {
          ...requestOptions,
          redirect: 'manual',
          signal: AbortSignal.any([
            requestAbortController.signal,
            AbortSignal.timeout(2000),
          ]),
        }),
      );
      assert.equal(serverHits, 0, '连接期私网解析不得触达本机 HTTP 服务');
      assert(lookupCalls >= 2, 'Undici 连接阶段应再次执行 lookup');
    } finally {
      requestAbortController.abort();
      await policy.close();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  await run('policy.close 可关闭且可安全重复关闭', async () => {
    const policy = createPolicy(async () => [{ address: '93.184.216.34', family: 4 }]);
    try {
      await policy.assertAllowed('https://public.example/v1');
      assert.equal(typeof policy.close, 'function');
      await policy.close();
      await policy.close();
    } finally {
      await policy.close();
    }
  });

  if (failed.length) {
    console.error(`\n=== Web endpoint policy 测试失败：${failed.length} ===`);
    failed.forEach((message) => console.error(`- ${message}`));
    process.exitCode = 1;
  }
  console.log(`\n=== Web endpoint policy 测试结果 ===`);
  console.log(`通过: ${passed.length}`);
  console.log(`失败: ${failed.length}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
