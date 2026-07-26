const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildOpenCodeConfig, createWebAgentService, safeRelativePath } = require('../server/agent/webAgentService.cjs');
const { MAX_OUTPUT_BYTES, OUTPUT_FILE, createOpenCodeTaskWorkspace } = require('../server/agent/openCodeTaskWorkspace.cjs');
const { STDERR_RING_BYTES, STDOUT_RING_BYTES, createRingBuffer } = require('../server/agent/webOpenCodeRunner.cjs');
const { createAgentOpenAiProxy } = require('../server/agent/agentOpenAiProxy.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-web-agent-'));
const binaryPath = path.join(root, 'fake-opencode');
const prlimitPath = path.join(root, 'fake-prlimit');
const workspaceRoot = path.join(root, 'workspace-a');
const passed = [];
const failed = [];

function check(condition, message) {
  if (condition) passed.push(message);
  else failed.push(message);
}

fs.writeFileSync(binaryPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const dir = args[args.indexOf('--dir') + 1];
const config = JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG, 'utf8'));
if (config.permission?.['*'] !== 'deny'
  || config.permission?.bash !== 'deny'
  || config.permission?.webfetch !== 'deny'
  || config.permission?.websearch !== 'deny'
  || config.permission?.read?.['input/**'] !== 'allow'
  || config.permission?.edit?.['result.json'] !== 'allow') {
  throw new Error('generated OpenCode permission config is unsafe');
}
if (args.some((arg) => arg.includes('wait-forever'))) setInterval(() => {}, 1000);
if (args.some((arg) => arg.includes('mutate-input'))) fs.writeFileSync(path.join(dir, 'input', 'tender.md'), 'tampered', 'utf8');
else if (args.some((arg) => arg.includes('unsafe-symlink'))) fs.symlinkSync(path.join(dir, 'input', 'tender.md'), path.join(dir, 'result.json'));
else if (args.some((arg) => arg.includes('unsafe-fifo'))) require('node:child_process').execFileSync('mkfifo', [path.join(dir, 'result.json')]);
else if (args.some((arg) => arg.includes('oversize-output'))) fs.writeFileSync(path.join(dir, 'result.json'), Buffer.alloc(${MAX_OUTPUT_BYTES + 1}, 0x61));
else if (args.some((arg) => arg.includes('extra-output'))) {
  fs.writeFileSync(path.join(dir, 'result.json'), '{"ok":true}', 'utf8');
  fs.writeFileSync(path.join(dir, 'extra.txt'), 'undeclared', 'utf8');
} else fs.writeFileSync(path.join(dir, 'result.json'), '{"summary":"agent generated content"}', 'utf8');
process.stdout.write(JSON.stringify({ type: 'text', text: 'done' }) + '\\n');
`);
fs.chmodSync(binaryPath, 0o755);
fs.writeFileSync(prlimitPath, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const separator = process.argv.indexOf('--');
if (separator < 0) process.exit(2);
const result = spawnSync(process.argv[separator + 1], process.argv.slice(separator + 2), { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
`);
fs.chmodSync(prlimitPath, 0o755);

async function run() {
  const service = createWebAgentService({
    workspaceId: 'account-a',
    workspaceRoot,
    env: { YIBIAO_WEB_OPENCODE_BIN: binaryPath, YIBIAO_WEB_PRLIMIT_BIN: prlimitPath, YIBIAO_WEB_AGENT_TOOLS: '' },
    aiService: {
      captureTextModelSnapshot: () => ({
        provider: 'test',
        baseUrl: 'http://127.0.0.1:1/v1',
        modelName: 'test-model',
        apiKey: 'test-key',
        capturedAt: '2026-07-27T00:00:00.000Z',
      }),
      chatCompletionsRaw: async () => ({ choices: [{ message: { role: 'assistant', content: 'unused' } }] }),
      withQueueScope: () => ({
        chatCompletionsRaw: async () => ({ choices: [{ message: { role: 'assistant', content: 'unused' } }] }),
      }),
    },
  });

  const descriptors = service.listRuntimes();
  check(descriptors.length === 1 && descriptors[0].id === 'opencode', '仅暴露 OpenCode Web Runtime');

  const result = await service.runTask({
    task_id: 'plan-1',
    task: '生成一段投标摘要',
    files: [{ path: 'input/tender.md', content: '# 招标文件' }],
  });
  check(result.success === true, 'Agent 成功执行');
  check(result.success === true, 'Agent 子进程读取并验证实际生成的 OpenCode 权限配置');
  check(result.output_file === OUTPUT_FILE && result.output_content.includes('agent generated content'), 'Agent 读取受控输出文件');
  check(!fs.existsSync(path.join(workspaceRoot, '.agent-tasks', 'plan-1')), '任务结束后清理临时工作区');
  check(service.getStatus().active_task === null, '任务结束后状态恢复空闲');
  const config = buildOpenCodeConfig('http://127.0.0.1:3000');
  check(config.permission?.['*'] === 'deny', 'Agent 权限默认全部拒绝');
  check(config.permission?.bash === 'deny', 'Agent 禁止 Bash');
  check(config.permission?.webfetch === 'deny' && config.permission?.websearch === 'deny', 'Agent 禁止网络工具');
  check(config.permission?.read?.['input/**'] === 'allow' && config.permission?.read?.['*'] === 'deny', 'Agent 只允许读取 input 目录');
  check(config.permission?.edit?.[OUTPUT_FILE] === 'allow', 'Agent 只允许写入约定输出文件');

  const stdoutRing = createRingBuffer(STDOUT_RING_BYTES);
  stdoutRing.append(Buffer.alloc(STDOUT_RING_BYTES + 128, 0x61));
  check(Buffer.byteLength(stdoutRing.toString()) === STDOUT_RING_BYTES, 'stdout 使用固定上限 ring buffer');
  const stderrRing = createRingBuffer(STDERR_RING_BYTES);
  stderrRing.append(Buffer.alloc(STDERR_RING_BYTES + 128, 0x62));
  check(Buffer.byteLength(stderrRing.toString()) === STDERR_RING_BYTES, 'stderr 使用固定上限 ring buffer');

  let forwardedStream = null;
  const protocolProxy = await createAgentOpenAiProxy({
    scopeId: 'proxy-test',
    aiService: {
      captureTextModelSnapshot: () => ({ provider: 'test', baseUrl: 'http://127.0.0.1', modelName: 'test', apiKey: 'test', capturedAt: '2026-07-27T00:00:00.000Z' }),
      chatCompletionsRaw: async (body) => {
        forwardedStream = body.stream;
        const error = new Error('stream unsupported');
        error.code = 'AGENT_PROTOCOL_UNSUPPORTED';
        throw error;
      },
      withQueueScope() { return this; },
    },
  });
  try {
    const response = await fetch(`${protocolProxy.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${protocolProxy.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [] }),
    });
    const payload = await response.json();
    check(response.status === 502 && payload.error?.type === 'AGENT_PROTOCOL_UNSUPPORTED', 'Proxy 对 stream=true 返回稳定协议错误');
    check(forwardedStream === true, 'Proxy 不静默改写 stream=true');
  } finally {
    await protocolProxy.close();
  }

  assert.throws(() => safeRelativePath('../outside.md'));
  check(true, '拒绝相对路径越界');
  assert.throws(() => safeRelativePath('AGENTS.md'));
  check(true, '拒绝覆盖 Agent 指令文件');

  await assert.rejects(
    service.runTask({ task: 'wait-forever', timeout_ms: 25 }),
    (error) => error?.code === 'AGENT_TIMEOUT',
  );
  check(true, '超时时终止 Agent 进程');
  check(fs.readdirSync(path.join(workspaceRoot, '.agent-tasks')).length === 0, '超时后清理 Agent 临时工作区');

  const abortController = new AbortController();
  const cancelledTask = service.runTask({ task: 'wait-forever' }, { signal: abortController.signal });
  setTimeout(() => abortController.abort(Object.assign(new Error('请求取消'), { code: 'AGENT_ABORTED' })), 25).unref();
  await assert.rejects(cancelledTask, (error) => error?.code === 'AGENT_ABORTED');
  check(true, '取消后等待 Agent 进程退出并返回取消终态');
  check(fs.readdirSync(path.join(workspaceRoot, '.agent-tasks')).length === 0, '取消后清理 Agent 临时工作区');

  await assert.rejects(
    service.runTask({ task: 'mutate-input', files: [{ path: 'input/tender.md', content: '# 招标文件' }] }),
    (error) => error?.code === 'AGENT_RUNTIME_FAILED',
  );
  check(true, 'Agent 无法篡改只读输入文件');

  await assert.rejects(
    service.runTask({ task: 'unsafe-symlink', files: [{ path: 'input/tender.md', content: '# 招标文件' }] }),
    (error) => error?.code === 'AGENT_OUTPUT_UNSAFE',
  );
  check(true, '拒绝符号链接输出');
  await assert.rejects(
    service.runTask({ task: 'unsafe-fifo', files: [{ path: 'input/tender.md', content: '# 招标文件' }] }),
    (error) => error?.code === 'AGENT_OUTPUT_UNSAFE',
  );
  check(true, '拒绝 FIFO 输出');
  await assert.rejects(
    service.runTask({ task: 'oversize-output', files: [{ path: 'input/tender.md', content: '# 招标文件' }] }),
    (error) => error?.code === 'AGENT_OUTPUT_TOO_LARGE',
  );
  check(true, '拒绝超出上限的输出');
  await assert.rejects(
    service.runTask({ task: 'extra-output', files: [{ path: 'input/tender.md', content: '# 招标文件' }] }),
    (error) => error?.code === 'AGENT_OUTPUT_UNDECLARED',
  );
  check(true, '拒绝未声明输出');
  await assert.rejects(
    service.runTask({ task: 'wrong-output', output_file: 'result.md' }),
    (error) => error?.code === 'AGENT_OUTPUT_UNDECLARED',
  );
  check(true, '拒绝非唯一输出文件名');

  const unsafeWorkspace = createOpenCodeTaskWorkspace({ workspaceRoot, runId: 'unsafe-hard-link', inputs: { 'input/source.json': '{}' } });
  try {
    fs.linkSync(path.join(unsafeWorkspace.inputDir, 'source.json'), unsafeWorkspace.outputPath);
    assert.throws(() => unsafeWorkspace.readOutput(), (error) => error?.code === 'AGENT_OUTPUT_UNSAFE');
    check(true, '拒绝硬链接输出');
  } finally {
    unsafeWorkspace.cleanup();
  }

  const replacementWorkspace = createOpenCodeTaskWorkspace({ workspaceRoot, runId: 'unsafe-replacement', inputs: { 'input/source.json': '{}' } });
  try {
    fs.writeFileSync(replacementWorkspace.outputPath, '{"version":1}', 'utf8');
    const realOpenSync = fs.openSync;
    let replaced = false;
    fs.openSync = function guardedOpen(target, ...args) {
      if (!replaced && target === replacementWorkspace.outputPath) {
        replaced = true;
        fs.unlinkSync(replacementWorkspace.outputPath);
        fs.writeFileSync(replacementWorkspace.outputPath, '{"version":2}', 'utf8');
      }
      return realOpenSync.call(this, target, ...args);
    };
    try {
      assert.throws(() => replacementWorkspace.readOutput(), (error) => error?.code === 'AGENT_OUTPUT_UNSAFE');
      check(true, '拒绝读取前被替换的输出文件');
    } finally {
      fs.openSync = realOpenSync;
    }
  } finally {
    replacementWorkspace.cleanup();
  }

  const missingPrlimitService = createWebAgentService({
    workspaceId: 'account-prlimit',
    workspaceRoot,
    env: { YIBIAO_WEB_OPENCODE_BIN: binaryPath, YIBIAO_WEB_PRLIMIT_BIN: path.join(root, 'missing-prlimit'), YIBIAO_WEB_AGENT_TOOLS: '' },
    aiService: {
      captureTextModelSnapshot: () => ({ provider: 'test', baseUrl: 'http://127.0.0.1:1/v1', modelName: 'test-model', apiKey: 'test-key' }),
      chatCompletionsRaw: async () => ({}),
      withQueueScope() { return this; },
    },
  });
  await assert.rejects(missingPrlimitService.runTask({ task: 'prlimit-missing' }), (error) => error?.code === 'AGENT_PRLIMIT_UNAVAILABLE');
  const missingPrlimitCheck = await missingPrlimitService.selfCheck();
  check(missingPrlimitCheck.success === false, '缺少 prlimit 时 Runtime 自检失败');
  await missingPrlimitService.close();

  const shutdownService = createWebAgentService({
    workspaceId: 'account-shutdown',
    workspaceRoot,
    env: { YIBIAO_WEB_OPENCODE_BIN: binaryPath, YIBIAO_WEB_PRLIMIT_BIN: prlimitPath, YIBIAO_WEB_AGENT_TOOLS: '' },
    aiService: {
      captureTextModelSnapshot: () => ({ provider: 'test', baseUrl: 'http://127.0.0.1:1/v1', modelName: 'test-model', apiKey: 'test-key' }),
      chatCompletionsRaw: async () => ({}),
      withQueueScope() { return this; },
    },
  });
  const shutdownTask = shutdownService.runTask({ task: 'wait-forever' });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const shutdownOutcome = assert.rejects(shutdownTask, (error) => error?.code === 'AGENT_CANCELLED');
  await shutdownService.close();
  await shutdownOutcome;
  check(true, 'Workspace 关闭等待 Agent 任务以取消终态完成');
  check(fs.readdirSync(path.join(workspaceRoot, '.agent-tasks')).length === 0, 'Workspace 关闭后无 Agent 临时目录泄漏');

  await service.close();

  let releaseWorkspaceClose;
  let closeWorkspaceCalled = false;
  const workspaceCloseGate = new Promise((resolve) => { releaseWorkspaceClose = resolve; });
  const lifecycleService = createWebAgentService({
    workspaceId: 'account-close',
    workspaceRoot,
    env: { YIBIAO_WEB_OPENCODE_BIN: binaryPath, YIBIAO_WEB_PRLIMIT_BIN: prlimitPath, YIBIAO_WEB_AGENT_TOOLS: '' },
    aiService: { captureTextModelSnapshot: () => ({}), withQueueScope: () => ({ chatCompletionsRaw: async () => ({}) }) },
    agentCoordinator: {
      getWorkspaceSnapshot: () => ({ reserved: 0, admitting: 0, active: 1, queued: 0, cleanup: 0 }),
      cancelWorkspace() {},
      closeWorkspace: async () => {
        closeWorkspaceCalled = true;
        await workspaceCloseGate;
      },
    },
  });
  const lifecycleClose = lifecycleService.close();
  await new Promise((resolve) => setImmediate(resolve));
  check(closeWorkspaceCalled, 'Workspace close 调用 Coordinator closeWorkspace');
  releaseWorkspaceClose();
  await lifecycleClose;
  check(true, 'Agent service 等待 Workspace Coordinator 收敛后关闭');
}

run().catch((error) => {
  failed.push(error?.stack || error?.message || String(error));
}).finally(() => {
  fs.rmSync(root, { recursive: true, force: true });
  for (const message of passed) console.log(`  PASS: ${message}`);
  for (const message of failed) console.error(`  FAIL: ${message}`);
  console.log(`Web Agent Runtime 测试：${passed.length} 通过，${failed.length} 失败`);
  process.exitCode = failed.length ? 1 : 0;
});
