const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  createOpenCodeTaskWorkspace,
  OUTPUT_FILE,
  MAX_TASK_DIRECTORIES,
  sweepOrphanTaskDirectories,
} = require('../server/agent/openCodeTaskWorkspace.cjs');
const { createWebOpenCodeRunner, terminateProcessGroup, waitForProcessExit } = require('../server/agent/webOpenCodeRunner.cjs');

const MAX_PROMPT_BYTES = 32 * 1024;
const DEFAULT_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000;

function createRunnerExecutionError(message, code, { retryable = false } = {}) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

function safeExecutionSegment(value) {
  const normalized = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  return normalized || crypto.randomUUID();
}

function resolveBinary(env) {
  return String(
    env.YIBIAO_AGENT_OPENCODE_BIN
      || env.YIBIAO_WEB_OPENCODE_BIN
      || '/opt/agent-assets/bin/opencode',
  ).trim();
}

function resolveWorkspaceRoot(env) {
  return path.resolve(String(env.AGENT_WORKSPACE_ROOT || env.AGENT_OUTPUT_DIR || '/var/lib/bidmaster/output'));
}

function buildOpenCodeConfig(agentListenerUrl) {
  const baseUrl = `${String(agentListenerUrl || '').replace(/\/+$/, '')}/internal/agent/v1`;
  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    plugin: [],
    enabled_providers: ['openai'],
    mcp: {},
    instructions: [],
    permission: {
      '*': 'deny',
      read: { '*': 'deny', 'input/**': 'allow' },
      glob: { '*': 'deny', 'input/**': 'allow' },
      grep: { '*': 'deny', 'input/**': 'allow' },
      write: { '*': 'deny', [OUTPUT_FILE]: 'allow' },
      edit: { '*': 'deny', [OUTPUT_FILE]: 'allow' },
      bash: 'deny',
      webfetch: 'deny',
      websearch: 'deny',
      task: 'deny',
      skill: 'deny',
      lsp: 'deny',
      question: 'deny',
      external_directory: 'deny',
    },
    model: 'openai/bidmaster-proxy',
    small_model: 'openai/bidmaster-proxy',
    provider: {
      openai: {
        name: 'BidMaster Internal AI Proxy',
        options: {
          baseURL: baseUrl,
          apiKey: '{env:YIBIAO_AGENT_PROXY_TOKEN}',
        },
        models: {
          'bidmaster-proxy': {
            name: 'BidMaster frozen model snapshot',
            limit: { context: 128_000, output: 8_192 },
          },
        },
      },
    },
  };
}

function normalizeInputFiles(inputFiles) {
  if (!inputFiles || typeof inputFiles !== 'object' || Array.isArray(inputFiles)) return {};
  return Object.fromEntries(Object.entries(inputFiles).map(([key, value]) => [key, String(value ?? '')]));
}

function createSidecarExecutionService({
  env = process.env,
  workspaceRoot = resolveWorkspaceRoot(env),
  runner = createWebOpenCodeRunner({ env }),
  binary = resolveBinary(env),
  maxActive = 1,
} = {}) {
  const active = new Map();
  let closing = false;
  const taskRoot = path.join(workspaceRoot, '.agent-tasks');

  function prepareTaskRoot() {
    fs.mkdirSync(taskRoot, { recursive: true, mode: 0o700 });
    const sweep = sweepOrphanTaskDirectories(workspaceRoot, { maxTaskDirectories: MAX_TASK_DIRECTORIES });
    if (sweep.remaining >= MAX_TASK_DIRECTORIES) {
      throw createRunnerExecutionError('Agent 临时目录配额已满', 'AGENT_OUTPUT_QUOTA_EXCEEDED', { retryable: true });
    }
  }

  function assertCapacity() {
    if (active.size >= maxActive) {
      throw createRunnerExecutionError('Runner 当前只允许一个活动 execution', 'SIDE_CAR_EXECUTION_BUSY', { retryable: true });
    }
  }

  function start(execution, { onStarted, onResult, onError } = {}) {
    if (closing) return Promise.reject(createRunnerExecutionError('Runner 正在关闭', 'AGENT_CLOSING', { retryable: true }));
    if (!execution?.executionId) return Promise.reject(createRunnerExecutionError('execution 缺少 executionId', 'SIDE_CAR_INVALID_INPUT'));
    if (active.has(execution.executionId)) return active.get(execution.executionId).promise;
    try {
      assertCapacity();
    } catch (error) {
      return Promise.reject(error);
    }

    const controller = new AbortController();
    let child = null;
    let taskWorkspace = null;
    let settled = false;
    let terminal = null;
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    void promise.catch(() => undefined);
    const record = { controller, promise, get child() { return child; } };
    active.set(execution.executionId, record);

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      active.delete(execution.executionId);
      callback(value);
    };

    void (async () => {
      try {
        const inputFiles = normalizeInputFiles(execution.inputFiles);
        inputFiles['input/request.json'] = JSON.stringify(execution.input || {}, null, 2);
        prepareTaskRoot();
        taskWorkspace = createOpenCodeTaskWorkspace({
          workspaceRoot,
          runId: safeExecutionSegment(execution.executionId),
          inputs: inputFiles,
          maxInputBytes: 32 * 1024 * 1024,
        });
        if (!execution.agentListenerUrl || !execution.proxyToken) {
          throw createRunnerExecutionError('execution 缺少 Web internal AI Proxy 能力', 'AGENT_PROXY_UNAVAILABLE', { retryable: true });
        }
        fs.writeFileSync(
          taskWorkspace.configPath,
          JSON.stringify(buildOpenCodeConfig(execution.agentListenerUrl), null, 2),
          { encoding: 'utf8', mode: 0o600 },
        );
        const prompt = String(execution.prompt || `读取 input/ 中的冻结任务输入，完成 ${execution.taskSpecId}，只将最终 JSON 写入 ${OUTPUT_FILE}。`);
        if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
          throw createRunnerExecutionError('Agent prompt 超过大小限制', 'SIDE_CAR_LIMIT_EXCEEDED');
        }
        onStarted?.();
        const result = await runner.run({
          binary,
          taskWorkspace,
          proxyToken: execution.proxyToken,
          executionId: execution.executionId,
          prompt,
          timeoutMs: execution.timeoutMs || DEFAULT_EXECUTION_TIMEOUT_MS,
          signal: controller.signal,
          onChild(nextChild, completedChild) {
            if (nextChild) child = nextChild;
            if (completedChild && child === completedChild) child = null;
          },
        });
        const output = taskWorkspace.readOutput({ maxBytes: execution.resultMaxBytes });
        taskWorkspace.assertDeclaredFiles();
        let parsed;
        try {
          parsed = JSON.parse(output.content.toString('utf8'));
        } catch {
          throw createRunnerExecutionError('Agent result.json 不是合法 JSON', 'AGENT_OUTPUT_INVALID');
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw createRunnerExecutionError('Agent result.json 必须是对象', 'AGENT_OUTPUT_INVALID');
        }
        const payload = Object.freeze({
          success: true,
          executionId: execution.executionId,
          taskSpecId: execution.taskSpecId,
          result: parsed,
          resultFileName: OUTPUT_FILE,
          outputSha256: output.sha256,
          outputBytes: output.bytes,
          assistantText: result.stdout.slice(-8_000),
          diagnostics: { stderrTail: result.stderr.slice(-4_000) },
        });
        terminal = { callback: resolvePromise, value: payload, success: true };
      } catch (error) {
        const normalized = error?.code ? error : createRunnerExecutionError(String(error?.message || error), 'AGENT_RUNTIME_FAILED', { retryable: true });
        terminal = { callback: rejectPromise, value: normalized, success: false };
      } finally {
        let cleanupError = null;
        try {
          if (child) terminateProcessGroup(child);
          if (child) await waitForProcessExit(child);
        } catch (error) { cleanupError = error; }
        try {
          taskWorkspace?.cleanup();
          const taskRoot = taskWorkspace ? path.dirname(taskWorkspace.taskDir) : '';
          if (taskRoot && fs.existsSync(taskRoot) && fs.readdirSync(taskRoot).length === 0) fs.rmdirSync(taskRoot);
        } catch (error) {
          cleanupError = cleanupError || error;
        }
        if (cleanupError) {
          const normalizedCleanupError = createRunnerExecutionError('Agent 临时目录清理失败', 'AGENT_CLEANUP_FAILED', { retryable: true });
          onError?.(normalizedCleanupError);
          terminal = { callback: rejectPromise, value: normalizedCleanupError, success: false };
        } else if (terminal?.success) {
          try {
            onResult?.(terminal.value);
          } catch (error) {
            terminal = { callback: rejectPromise, value: createRunnerExecutionError('Agent 结果回调失败', 'AGENT_CALLBACK_FAILED', { retryable: true }), success: false };
          }
        } else if (terminal) {
          onError?.(terminal.value);
        }
        if (terminal) finish(terminal.callback, terminal.value);
      }
    })();

    return promise;
  }

  function cancel(executionId, reason = 'user-cancel') {
    const record = active.get(executionId);
    if (!record) return false;
    const error = createRunnerExecutionError(`Agent execution 已取消：${reason}`, reason === 'timeout' ? 'AGENT_TIMEOUT' : 'AGENT_CANCELLED', { retryable: reason === 'timeout' });
    record.controller.abort(error);
    if (record.child) terminateProcessGroup(record.child);
    return true;
  }

  async function close() {
    closing = true;
    for (const executionId of active.keys()) cancel(executionId, 'shutdown');
    await Promise.allSettled(Array.from(active.values()).map((record) => record.promise));
    active.clear();
  }

  return Object.freeze({
    start,
    cancel,
    close,
    selfCheck: () => ({
      binary,
      available: fs.existsSync(binary),
      active: active.size,
      maxActive,
    }),
    getActiveCount: () => active.size,
  });
}

module.exports = {
  DEFAULT_EXECUTION_TIMEOUT_MS,
  buildOpenCodeConfig,
  createSidecarExecutionService,
  normalizeInputFiles,
  resolveBinary,
  resolveWorkspaceRoot,
};
