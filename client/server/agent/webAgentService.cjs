const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');

const WEB_RUNTIME_ID = 'opencode';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PROMPT_CHARS = 32_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const TOOL_NAMES = Object.freeze(['rg', 'fd', 'jq']);

function nowIso() {
  return new Date().toISOString();
}

function safeTaskSegment(value) {
  return String(value || crypto.randomUUID())
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || crypto.randomUUID();
}

function safeRelativePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || path.posix.isAbsolute(normalized)) {
    throw new Error(`Agent 文件路径无效：${value}`);
  }
  const lower = normalized.toLowerCase();
  if (lower === 'opencode.json' || lower === 'opencode.jsonc' || lower === 'agents.md' || lower.startsWith('.opencode/')) {
    throw new Error(`Agent 文件路径受保留：${value}`);
  }
  return normalized;
}

function ensureInsideRoot(rootDir, targetPath) {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Agent 文件路径越界');
  }
  return target;
}

function normalizeTimeoutMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(Math.floor(number), DEFAULT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
}

function createProcessError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function getRuntimeBinary(env) {
  return String(env.YIBIAO_WEB_OPENCODE_BIN || path.join(__dirname, '..', '..', 'vendor', 'opencode', `linux-${process.arch}`, 'opencode')).trim();
}

function getRuntimeTools(env) {
  const raw = String(env.YIBIAO_WEB_AGENT_TOOLS || TOOL_NAMES.join(',')).trim();
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

function buildOpenCodeConfig(proxyBaseUrl, outputFile = 'result.md') {
  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    plugin: [],
    mcp: {},
    instructions: [],
    permission: {
      '*': 'deny',
      read: {
        '*': 'allow',
        '.runtime/**': 'deny',
      },
      glob: 'allow',
      grep: 'allow',
      edit: {
        '*': 'deny',
        [outputFile]: 'allow',
      },
      bash: 'deny',
      webfetch: 'deny',
      websearch: 'deny',
      task: 'deny',
      skill: 'deny',
      lsp: 'deny',
      question: 'deny',
      external_directory: 'deny',
    },
    model: 'yibiao/default',
    small_model: 'yibiao/default',
    provider: {
      yibiao: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Yibiao AI Proxy',
        options: {
          baseURL: `${proxyBaseUrl}/v1`,
          apiKey: '{env:YIBIAO_WEB_AGENT_PROXY_TOKEN}',
          timeout: DEFAULT_TIMEOUT_MS,
        },
        models: {
          default: { name: 'Yibiao Current Text Model' },
        },
      },
    },
  };
}

function readRequestBody(req, maxBytes = MAX_OUTPUT_BYTES) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(createProcessError('Agent proxy 请求体过大', 'AGENT_PROXY_BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(createProcessError('Agent proxy 请求 JSON 无效', 'AGENT_PROXY_BAD_REQUEST'));
      }
    });
    req.on('error', reject);
  });
}

function createOpenAiProxy({ aiService, scopeId }) {
  const token = crypto.randomBytes(24).toString('base64url');
  const scopedAi = aiService.withQueueScope(scopeId);
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await readRequestBody(req);
      const content = await scopedAi.chat({
        messages: Array.isArray(body.messages) ? body.messages : [],
        temperature: body.temperature,
        max_tokens: body.max_tokens || body.max_completion_tokens,
      });
      const payload = {
        id: `yibiao-${crypto.randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'yibiao/default',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({
        error: { message: error?.message || 'Agent AI proxy 请求失败', type: error?.code || 'agent_proxy_error' },
      }));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        token,
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function terminateProcess(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, 'SIGTERM');
    } else {
      child.kill('SIGTERM');
    }
  } catch {}
  const forceTimer = setTimeout(() => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {}
  }, 2_000);
  forceTimer.unref?.();
}

function waitForProcessExit(child, timeoutMs = 4_000) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    child.once('exit', finish);
    child.once('error', finish);
  });
}

function runOpenCode({ binary, taskDir, configPath, proxyToken, prompt, timeoutMs, signal, env, onChild }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['run', '--format', 'json', '--dir', taskDir, prompt], {
      cwd: taskDir,
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: {
        HOME: path.join(taskDir, '.home'),
        XDG_CONFIG_HOME: path.join(taskDir, '.config'),
        XDG_DATA_HOME: path.join(taskDir, '.data'),
        XDG_CACHE_HOME: path.join(taskDir, '.cache'),
        TMPDIR: path.join(taskDir, '.tmp'),
        PATH: '/usr/local/bin:/usr/bin:/bin',
        LANG: env.LANG || 'C.UTF-8',
        OPENCODE_CONFIG: configPath,
        OPENCODE_CONFIG_DIR: path.dirname(configPath),
        OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
        OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
        OPENCODE_DISABLE_AUTOUPDATE: 'true',
        OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
        YIBIAO_WEB_AGENT_PROXY_TOKEN: proxyToken,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    onChild?.(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback) => (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      onChild?.(null, child);
      callback(value);
    };
    const onAbort = () => {
      terminateProcess(child);
      finish(reject)(createProcessError('Agent 请求已取消', 'AGENT_ABORTED'));
    };
    const timer = setTimeout(() => {
      terminateProcess(child);
      finish(reject)(createProcessError('Agent 执行超时', 'AGENT_TIMEOUT'));
    }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-MAX_OUTPUT_BYTES); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_000); });
    child.once('error', (error) => finish(reject)(createProcessError(`OpenCode 启动失败：${error.message}`, 'AGENT_RUNTIME_START_FAILED')));
    child.once('exit', (code, exitSignal) => {
      if (code === 0) return finish(resolve)({ stdout, stderr });
      return finish(reject)(createProcessError(`OpenCode 执行失败（code=${code ?? 'null'} signal=${exitSignal || 'null'}）：${stderr.slice(-1000)}`, 'AGENT_RUNTIME_FAILED'));
    });
  });
}

function createWebAgentService({ workspaceId, workspaceRoot, aiService, env = process.env }) {
  const activeChildren = new Set();
  let closing = false;
  let activeTask = null;

  function getStatus() {
    return {
      runtime_id: WEB_RUNTIME_ID,
      runtime_name: 'OpenCode Agent',
      phase: activeTask ? 'running' : 'idle',
      healthy: !closing,
      message: activeTask ? 'OpenCode 正在执行任务' : 'OpenCode Web Runtime 就绪',
      updated_at: nowIso(),
      active_task: activeTask,
      queued_count: 0,
      queued_tasks: [],
    };
  }

  function listRuntimes() {
    return [{ id: WEB_RUNTIME_ID, display_name: 'OpenCode Agent', description: 'Web 端隔离 OpenCode 运行时。', is_default: true }];
  }

  async function selfCheck() {
    const binary = getRuntimeBinary(env);
    const checks = [{ id: 'runtime-binary', label: 'OpenCode Linux binary', status: fs.existsSync(binary) ? 'success' : 'error', message: fs.existsSync(binary) ? '可用' : '未找到' }];
    for (const tool of getRuntimeTools(env)) {
      const found = ['/usr/local/bin', '/usr/bin', '/bin'].some((root) => fs.existsSync(path.join(root, tool)));
      checks.push({ id: `tool-${tool}`, label: tool, status: found ? 'success' : 'error', message: found ? '可用' : '未找到' });
    }
    const success = checks.every((item) => item.status === 'success');
    return {
      success,
      runtime_id: WEB_RUNTIME_ID,
      runtime_name: 'OpenCode Agent',
      status: success ? 'normal' : 'error',
      message: success ? 'OpenCode Web Runtime 自检通过' : 'OpenCode Web Runtime 依赖缺失',
      checked_at: nowIso(),
      duration_ms: 0,
      log_dir: '',
      log_file: '',
      runtime_root: '',
      workspace_dir: '',
      output_file: '',
      output_path: '',
      steps: checks,
      sections: [],
      detail_text: checks.map((item) => `${item.label}: ${item.message}`).join('\n'),
      runtime_status: getStatus(),
    };
  }

  async function runTask(payload = {}, options = {}) {
    if (closing) throw createProcessError('Agent 服务正在关闭', 'AGENT_CLOSING');
    if (activeTask) throw createProcessError('Agent 当前有任务正在运行，请稍后重试', 'AGENT_BUSY');
    const taskId = safeTaskSegment(payload.task_id);
    const title = String(payload.title || '易标智能体任务').slice(0, 160);
    const task = String(payload.task || payload.prompt || '').trim();
    const outputFile = safeRelativePath(payload.output_file || 'result.md');
    if (!task) throw createProcessError('Agent 任务内容不能为空', 'INVALID_BRIDGE_ARGUMENTS');
    if (task.length > MAX_PROMPT_CHARS) throw createProcessError('Agent 任务内容过长', 'INVALID_BRIDGE_ARGUMENTS');
    const binary = getRuntimeBinary(env);
    if (!fs.existsSync(binary)) throw createProcessError('OpenCode Linux binary 未部署', 'AGENT_RUNTIME_UNAVAILABLE');

    const runId = `${taskId}-${crypto.randomUUID()}`;
    const taskDir = path.join(workspaceRoot, '.agent-tasks', runId);
    const configPath = path.join(taskDir, '.runtime', 'opencode.json');
    const outputPath = ensureInsideRoot(taskDir, path.join(taskDir, outputFile));
    fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
    for (const file of Array.isArray(payload.files) ? payload.files : []) {
      const relative = safeRelativePath(file?.path);
      const target = ensureInsideRoot(taskDir, path.join(taskDir, relative));
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, String(file?.content || ''), { encoding: 'utf8', mode: 0o600 });
    }
    fs.writeFileSync(path.join(taskDir, 'AGENT_INSTRUCTIONS.md'), [
      '仅可读取和写入当前工作目录。',
      '禁止访问工作目录外的文件，禁止联网。',
      `请将最终业务结果写入 ${outputFile}。`,
    ].join('\n'), { encoding: 'utf8', mode: 0o600 });

    const proxy = await createOpenAiProxy({ aiService, scopeId: `${workspaceId}:${runId}` });
    fs.writeFileSync(configPath, JSON.stringify(buildOpenCodeConfig(proxy.baseUrl, outputFile), null, 2), { encoding: 'utf8', mode: 0o600 });
    activeTask = { task_id: taskId, title, stage: 'running', progress_text: 'OpenCode 正在生成', started_at: nowIso(), last_activity_at: nowIso(), elapsed_seconds: 0, idle_seconds: 0 };
    try {
      const result = await runOpenCode({
        binary,
        taskDir,
        configPath,
        proxyToken: proxy.token,
        prompt: `${task}\n\n请遵守 AGENT_INSTRUCTIONS.md。`,
        timeoutMs: normalizeTimeoutMs(payload.timeout_ms),
        signal: options.signal,
        env,
        onChild(child, completedChild) {
          if (child) activeChildren.add(child);
          if (completedChild) activeChildren.delete(completedChild);
        },
      });
      const outputContent = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8').slice(0, MAX_OUTPUT_BYTES) : '';
      if (!outputContent) throw createProcessError(`Agent 未生成 ${outputFile}`, 'AGENT_OUTPUT_MISSING');
      return { success: true, runtime_id: WEB_RUNTIME_ID, task_id: taskId, title, output_file: outputFile, output_content: outputContent, assistant_text: result.stdout.slice(-8_000), diagnostics: { stderr_tail: result.stderr.slice(-4_000) } };
    } finally {
      activeTask = null;
      await proxy.close().catch(() => undefined);
      fs.rmSync(taskDir, { recursive: true, force: true });
    }
  }

  return {
    listRuntimes,
    bindSelectedRuntime() { return { runtimeId: WEB_RUNTIME_ID, runTask, getStatus }; },
    runTask,
    selfCheck,
    getStatus,
    restart: async () => getStatus(),
    close: async () => {
      closing = true;
      const children = Array.from(activeChildren);
      children.forEach(terminateProcess);
      await Promise.all(children.map((child) => waitForProcessExit(child)));
      activeChildren.clear();
    },
  };
}

module.exports = { WEB_RUNTIME_ID, buildOpenCodeConfig, createWebAgentService, getRuntimeBinary, safeRelativePath };
