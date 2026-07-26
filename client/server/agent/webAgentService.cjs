const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createAgentOpenAiProxy } = require('./agentOpenAiProxy.cjs');
const { OUTPUT_FILE, createOpenCodeTaskWorkspace, safeRelativePath } = require('./openCodeTaskWorkspace.cjs');
const { createWebOpenCodeRunner, terminateProcessGroup, waitForProcessExit } = require('./webOpenCodeRunner.cjs');

const WEB_RUNTIME_ID = 'opencode';
const MAX_PROMPT_CHARS = 32_000;
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

function buildOpenCodeConfig(proxyBaseUrl) {
  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    plugin: [],
    mcp: {},
    instructions: [],
    permission: {
      '*': 'deny',
      read: { '*': 'deny', 'input/**': 'allow' },
      glob: { '*': 'deny', 'input/**': 'allow' },
      grep: { '*': 'deny', 'input/**': 'allow' },
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
    model: 'yibiao/default',
    small_model: 'yibiao/default',
    provider: {
      yibiao: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Yibiao AI Proxy',
        options: {
          baseURL: `${proxyBaseUrl}/v1`,
          apiKey: '{env:YIBIAO_WEB_AGENT_PROXY_TOKEN}',
        },
        models: {
          default: {
            name: 'Yibiao Current Text Model',
            // 自定义 Provider 没有 Models.dev 目录项，明确限额以避免 OpenCode 在启动期额外探测模型元数据。
            limit: { context: 128_000, output: 8_192 },
          },
        },
      },
    },
  };
}

function createWebAgentService({
  workspaceId,
  workspaceRoot,
  aiService,
  agentCoordinator = null,
  agentWorkspaceLease = null,
  env = process.env,
  runner = createWebOpenCodeRunner({ env }),
}) {
  const activeChildren = new Set();
  let closing = false;
  let activeTask = null;
  let activeRunController = null;
  let activeRunCompletion = null;

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

  function getActivitySnapshot() {
    if (!agentCoordinator || typeof agentCoordinator.getWorkspaceSnapshot !== 'function') {
      return { reserved: 0, admitting: 0, active: 0, queued: 0, cleanup: 0 };
    }
    return agentWorkspaceLease?.getSnapshot?.() || agentCoordinator.getWorkspaceSnapshot(workspaceId);
  }

  function listRuntimes() {
    return [{ id: WEB_RUNTIME_ID, display_name: 'OpenCode Agent', description: 'Web 端隔离 OpenCode 运行时。', is_default: true }];
  }

  async function selfCheck() {
    const binary = getRuntimeBinary(env);
    const runnerStatus = runner.selfCheck?.() || { available: false, prlimit: '' };
    const checks = [
      { id: 'runtime-binary', label: 'OpenCode Linux binary', status: fs.existsSync(binary) ? 'success' : 'error', message: fs.existsSync(binary) ? '可用' : '未找到' },
      { id: 'runtime-prlimit', label: 'prlimit', status: runnerStatus.available ? 'success' : 'error', message: runnerStatus.available ? '可用' : '未找到' },
    ];
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
    if (!task) throw createProcessError('Agent 任务内容不能为空', 'INVALID_BRIDGE_ARGUMENTS');
    if (task.length > MAX_PROMPT_CHARS) throw createProcessError('Agent 任务内容过长', 'INVALID_BRIDGE_ARGUMENTS');
    if (payload.output_file && safeRelativePath(payload.output_file) !== OUTPUT_FILE) {
      throw createProcessError(`Agent 只允许生成 ${OUTPUT_FILE}`, 'AGENT_OUTPUT_UNDECLARED');
    }
    const binary = getRuntimeBinary(env);
    const runId = `${taskId}-${crypto.randomUUID()}`;
    const inputs = {};
    for (const file of Array.isArray(payload.files) ? payload.files : []) {
      inputs[safeRelativePath(file?.path)] = String(file?.content || '');
    }
    const taskWorkspace = createOpenCodeTaskWorkspace({ workspaceRoot, runId, inputs });
    let proxy = null;
    let primaryError = null;
    const runController = new AbortController();
    const forwardAbort = () => runController.abort(options.signal?.reason || createProcessError('Agent 请求已取消', 'AGENT_ABORTED'));
    if (options.signal?.aborted) forwardAbort();
    else options.signal?.addEventListener?.('abort', forwardAbort, { once: true });
    let resolveRunCompletion;
    const runCompletion = new Promise((resolve) => { resolveRunCompletion = resolve; });
    activeRunController = runController;
    activeRunCompletion = runCompletion;
    activeTask = { task_id: taskId, title, stage: 'running', progress_text: 'OpenCode 正在生成', started_at: nowIso(), last_activity_at: nowIso(), elapsed_seconds: 0, idle_seconds: 0 };
    try {
      const modelSnapshot = aiService.captureTextModelSnapshot();
      proxy = await createAgentOpenAiProxy({ aiService, modelSnapshot, scopeId: `${workspaceId}:${runId}` });
      fs.writeFileSync(taskWorkspace.configPath, JSON.stringify(buildOpenCodeConfig(proxy.baseUrl), null, 2), { encoding: 'utf8', mode: 0o600 });
      const result = await runner.run({
        binary,
        taskWorkspace,
        proxyToken: proxy.token,
        prompt: `${task}\n\n仅可读取 input/，并将最终结构化结果写入 ${OUTPUT_FILE}。`,
        timeoutMs: payload.timeout_ms,
        signal: runController.signal,
        onChild(child, completedChild) {
          if (child) activeChildren.add(child);
          if (completedChild) activeChildren.delete(completedChild);
        },
      });
      const output = taskWorkspace.readOutput();
      taskWorkspace.assertDeclaredFiles();
      return {
        success: true,
        runtime_id: WEB_RUNTIME_ID,
        task_id: taskId,
        title,
        output_file: OUTPUT_FILE,
        output_content: output.content.toString('utf8'),
        output_sha256: output.sha256,
        assistant_text: result.stdout.slice(-8_000),
        diagnostics: { stderr_tail: result.stderr.slice(-4_000) },
      };
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      activeTask = null;
      await proxy?.close().catch(() => undefined);
      try {
        taskWorkspace.cleanup();
      } catch (cleanupError) {
        if (!primaryError) throw createProcessError(`Agent 临时目录清理失败：${cleanupError.message}`, 'AGENT_CLEANUP_FAILED');
      } finally {
        options.signal?.removeEventListener?.('abort', forwardAbort);
        if (activeRunController === runController) activeRunController = null;
        if (activeRunCompletion === runCompletion) activeRunCompletion = null;
        resolveRunCompletion();
      }
    }
  }

  return {
    listRuntimes,
    bindSelectedRuntime() { return { runtimeId: WEB_RUNTIME_ID, runTask, getStatus }; },
    runTask,
    selfCheck,
    getStatus,
    getActivitySnapshot,
    cancelWorkspace(reason) {
      return typeof agentCoordinator?.cancelWorkspace === 'function'
        ? agentCoordinator.cancelWorkspace(workspaceId, reason, agentWorkspaceLease ? { generation: agentWorkspaceLease.generation } : undefined)
        : 0;
    },
    restart: async () => getStatus(),
    close: async () => {
      closing = true;
      if (typeof agentWorkspaceLease?.close === 'function') await agentWorkspaceLease.close();
      else if (typeof agentCoordinator?.closeWorkspace === 'function') await agentCoordinator.closeWorkspace(workspaceId);
      else if (typeof agentCoordinator?.cancelWorkspace === 'function') agentCoordinator.cancelWorkspace(workspaceId);
      activeRunController?.abort(createProcessError('Workspace 正在关闭，Agent 任务已取消', 'AGENT_CANCELLED'));
      const children = Array.from(activeChildren);
      children.forEach(terminateProcessGroup);
      await activeRunCompletion?.catch(() => undefined);
      await Promise.all(children.map((child) => waitForProcessExit(child)));
      activeChildren.clear();
    },
  };
}

module.exports = {
  WEB_RUNTIME_ID,
  buildOpenCodeConfig,
  createWebAgentService,
  getRuntimeBinary,
  safeRelativePath,
};
