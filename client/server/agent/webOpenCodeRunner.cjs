const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const STDOUT_RING_BYTES = 2 * 1024 * 1024;
const STDERR_RING_BYTES = 64 * 1024;
const DEFAULT_LIMITS = Object.freeze({
  // Bun/OpenCode 与 RLIMIT_AS 不兼容，会在启动时触发内存断言；内存上限由后续容器 cgroup Gate 承担。
  addressSpaceBytes: null,
  fileSizeBytes: 16 * 1024 * 1024,
  openFiles: 64,
  // Bun/OpenCode 在较低 RLIMIT_NPROC 下启动即会触发 SIGTRAP；512 仍为明确上限，且经 Linux 容器验证可运行。
  processes: 512,
  cpuSeconds: 120,
});

function createRunnerError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeTimeoutMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(Math.floor(number), DEFAULT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
}

function getPrlimitBinary(env = process.env) {
  return String(env.YIBIAO_WEB_PRLIMIT_BIN || '/usr/bin/prlimit').trim();
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function createRingBuffer(maxBytes) {
  const chunks = [];
  let bytes = 0;
  return Object.freeze({
    append(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
      bytes += buffer.length;
      while (bytes > maxBytes && chunks.length) {
        const first = chunks[0];
        const excess = bytes - maxBytes;
        if (first.length <= excess) {
          chunks.shift();
          bytes -= first.length;
        } else {
          chunks[0] = first.subarray(excess);
          bytes -= excess;
        }
      }
    },
    toString() { return Buffer.concat(chunks, bytes).toString('utf8'); },
  });
}

function terminateProcessGroup(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
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
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', done);
    child.once('error', done);
  });
}

function createWebOpenCodeRunner({ env = process.env } = {}) {
  function selfCheck() {
    const prlimit = getPrlimitBinary(env);
    return { prlimit, available: isExecutable(prlimit) };
  }

  function run({ binary, taskWorkspace, proxyToken, prompt, timeoutMs, signal, onChild, limits = DEFAULT_LIMITS }) {
    const prlimit = getPrlimitBinary(env);
    if (!isExecutable(binary)) return Promise.reject(createRunnerError('OpenCode Linux binary 未部署', 'AGENT_RUNTIME_UNAVAILABLE'));
    if (!isExecutable(prlimit)) return Promise.reject(createRunnerError('prlimit 未部署，拒绝启动 Agent', 'AGENT_PRLIMIT_UNAVAILABLE'));
    if (signal?.aborted) return Promise.reject(signal.reason || createRunnerError('Agent 请求已取消', 'AGENT_ABORTED'));
    const effectiveTimeoutMs = normalizeTimeoutMs(timeoutMs);
    const args = [
      ...(Number.isFinite(limits.addressSpaceBytes) && limits.addressSpaceBytes > 0
        ? [`--as=${limits.addressSpaceBytes}:${limits.addressSpaceBytes}`]
        : []),
      `--fsize=${limits.fileSizeBytes}:${limits.fileSizeBytes}`,
      `--nofile=${limits.openFiles}:${limits.openFiles}`,
      `--nproc=${limits.processes}:${limits.processes}`,
      `--cpu=${limits.cpuSeconds}:${limits.cpuSeconds}`,
      '--', binary, 'run', '--format', 'json',
      ...(env.YIBIAO_WEB_OPENCODE_LOG_LEVEL
        ? ['--print-logs', '--log-level', String(env.YIBIAO_WEB_OPENCODE_LOG_LEVEL)]
        : []),
      '--dir', taskWorkspace.workDir, prompt,
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(prlimit, args, {
        cwd: taskWorkspace.workDir,
        detached: process.platform !== 'win32',
        windowsHide: true,
        env: {
          HOME: path.join(taskWorkspace.runtimeDir, 'home'),
          XDG_CONFIG_HOME: path.join(taskWorkspace.runtimeDir, 'config'),
          XDG_DATA_HOME: path.join(taskWorkspace.runtimeDir, 'data'),
          XDG_CACHE_HOME: path.join(taskWorkspace.runtimeDir, 'cache'),
          TMPDIR: path.join(taskWorkspace.runtimeDir, 'tmp'),
          PATH: '/usr/local/bin:/usr/bin:/bin',
          LANG: env.LANG || 'C.UTF-8',
          OPENCODE_CONFIG: taskWorkspace.configPath,
          OPENCODE_CONFIG_DIR: taskWorkspace.runtimeDir,
          OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
          OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
          OPENCODE_DISABLE_AUTOUPDATE: 'true',
          OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
          YIBIAO_WEB_AGENT_PROXY_TOKEN: proxyToken,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      onChild?.(child);
      const stdout = createRingBuffer(STDOUT_RING_BYTES);
      const stderr = createRingBuffer(STDERR_RING_BYTES);
      let settled = false;
      let terminationError = null;
      let forceExitTimer = null;
      const finish = (callback) => (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(forceExitTimer);
        signal?.removeEventListener?.('abort', onAbort);
        onChild?.(null, child);
        callback(value);
      };
      const requestTermination = (error) => {
        if (terminationError) return;
        terminationError = error;
        terminateProcessGroup(child);
        forceExitTimer = setTimeout(() => finish(reject)(terminationError), 4_000);
        forceExitTimer.unref?.();
      };
      const onAbort = () => {
        requestTermination(signal?.reason || createRunnerError('Agent 请求已取消', 'AGENT_ABORTED'));
      };
      const timer = setTimeout(() => {
        requestTermination(createRunnerError('Agent 执行超时', 'AGENT_TIMEOUT'));
      }, effectiveTimeoutMs);
      timer.unref?.();
      signal?.addEventListener?.('abort', onAbort, { once: true });
      child.stdout.on('data', (chunk) => stdout.append(chunk));
      child.stderr.on('data', (chunk) => stderr.append(chunk));
      child.once('error', (error) => finish(reject)(createRunnerError(`OpenCode 启动失败：${error.message}`, 'AGENT_RUNTIME_START_FAILED')));
      child.once('exit', (code, exitSignal) => {
        if (terminationError) {
          const tail = stderr.toString().slice(-2_000);
          if (tail) terminationError.message = `${terminationError.message}：${tail}`;
          return finish(reject)(terminationError);
        }
        if (code === 0) return finish(resolve)({ stdout: stdout.toString(), stderr: stderr.toString() });
        return finish(reject)(createRunnerError(`OpenCode 执行失败（code=${code ?? 'null'} signal=${exitSignal || 'null'}）：${stderr.toString().slice(-1000)}`, 'AGENT_RUNTIME_FAILED'));
      });
    });
  }

  return Object.freeze({ run, selfCheck });
}

module.exports = {
  DEFAULT_LIMITS,
  DEFAULT_TIMEOUT_MS,
  STDERR_RING_BYTES,
  STDOUT_RING_BYTES,
  createRingBuffer,
  createWebOpenCodeRunner,
  getPrlimitBinary,
  isExecutable,
  terminateProcessGroup,
  waitForProcessExit,
};
