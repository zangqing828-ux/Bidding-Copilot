const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const OUTPUT_FILE = 'result.json';
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_TASK_DIRECTORIES = 4;
const STALE_TASK_TTL_MS = 60 * 60 * 1000;

function createWorkspaceError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeRelativePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/');
  if (!normalized || segments.some((segment) => !segment || segment === '.' || segment === '..') || path.posix.isAbsolute(normalized)) {
    throw createWorkspaceError(`Agent 文件路径无效：${value}`, 'AGENT_WORKSPACE_PATH_INVALID');
  }
  const lower = normalized.toLowerCase();
  if (lower === 'opencode.json' || lower === 'opencode.jsonc' || lower === 'agents.md' || lower.startsWith('.opencode/')) {
    throw createWorkspaceError(`Agent 文件路径受保留：${value}`, 'AGENT_WORKSPACE_PATH_INVALID');
  }
  return normalized;
}

function ensureInsideRoot(rootDir, targetPath) {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw createWorkspaceError('Agent 文件路径越界', 'AGENT_WORKSPACE_PATH_INVALID');
  }
  return target;
}

function assertRegularSingleLink(stat, code = 'AGENT_OUTPUT_UNSAFE') {
  if (!stat.isFile() || stat.nlink !== 1) {
    throw createWorkspaceError('Agent 输出不是允许读取的普通单链接文件', code);
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size;
}

function readSafeOutput(outputPath, { maxBytes = MAX_OUTPUT_BYTES, fileSystem = fs } = {}) {
  let descriptor = null;
  try {
    const before = fileSystem.lstatSync(outputPath);
    assertRegularSingleLink(before);
    if (before.size <= 0) throw createWorkspaceError('Agent 未生成有效输出', 'AGENT_OUTPUT_MISSING');
    if (before.size > maxBytes) throw createWorkspaceError('Agent 输出超出大小限制', 'AGENT_OUTPUT_TOO_LARGE');
    descriptor = fileSystem.openSync(outputPath, fileSystem.constants.O_RDONLY | fileSystem.constants.O_NOFOLLOW);
    const opened = fileSystem.fstatSync(descriptor);
    assertRegularSingleLink(opened);
    if (!sameFile(before, opened)) throw createWorkspaceError('Agent 输出在读取前发生替换', 'AGENT_OUTPUT_UNSAFE');
    const content = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < content.length) {
      const bytes = fileSystem.readSync(descriptor, content, offset, content.length - offset, offset);
      if (!bytes) break;
      offset += bytes;
    }
    if (offset !== content.length) throw createWorkspaceError('Agent 输出读取不完整', 'AGENT_OUTPUT_UNSAFE');
    const after = fileSystem.fstatSync(descriptor);
    if (!sameFile(opened, after)) throw createWorkspaceError('Agent 输出在读取期间发生替换', 'AGENT_OUTPUT_UNSAFE');
    return Object.freeze({
      content,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
      bytes: content.length,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') throw createWorkspaceError('Agent 未生成输出文件', 'AGENT_OUTPUT_MISSING');
    if (error?.code === 'ELOOP') throw createWorkspaceError('Agent 输出不允许使用符号链接', 'AGENT_OUTPUT_UNSAFE');
    throw error;
  } finally {
    if (descriptor !== null) fileSystem.closeSync(descriptor);
  }
}

function assertDeclaredFiles(workDir) {
  const visit = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) {
        throw createWorkspaceError('Agent 工作区包含不允许的文件类型', 'AGENT_OUTPUT_UNDECLARED');
      }
      if (stat.isDirectory()) {
        if (relative !== 'input' && !relative.startsWith('input/')) {
          throw createWorkspaceError('Agent 创建了未声明目录', 'AGENT_OUTPUT_UNDECLARED');
        }
        visit(target, relative);
      } else if (relative !== OUTPUT_FILE && !relative.startsWith('input/')) {
        throw createWorkspaceError('Agent 创建了未声明输出', 'AGENT_OUTPUT_UNDECLARED');
      }
    }
  };
  visit(workDir);
}

function freezeInputTree(inputDir) {
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(target);
        fs.chmodSync(target, 0o555);
      } else {
        fs.chmodSync(target, 0o444);
      }
    }
  };
  visit(inputDir);
  fs.chmodSync(inputDir, 0o555);
}

function makeTreeWritable(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) {
      makeTreeWritable(target);
      fs.chmodSync(target, 0o700);
    } else if (!stat.isSymbolicLink()) {
      fs.chmodSync(target, 0o600);
    }
  }
  fs.chmodSync(directory, 0o700);
}

function cleanupTaskDirectory(taskDir) {
  if (!fs.existsSync(taskDir)) return;
  try {
    makeTreeWritable(taskDir);
  } finally {
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
}

function sweepOrphanTaskDirectories(workspaceRoot, {
  maxTaskDirectories = MAX_TASK_DIRECTORIES,
  staleTtlMs = STALE_TASK_TTL_MS,
  now = Date.now,
} = {}) {
  const taskRoot = ensureInsideRoot(workspaceRoot, path.join(workspaceRoot, '.agent-tasks'));
  if (!fs.existsSync(taskRoot)) return { removed: 0, remaining: 0 };
  const entries = fs.readdirSync(taskRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const target = path.join(taskRoot, entry.name);
      return { target, mtimeMs: fs.statSync(target).mtimeMs };
    })
    .sort((left, right) => left.mtimeMs - right.mtimeMs);
  const cutoff = Number(now()) - Math.max(0, Number(staleTtlMs) || STALE_TASK_TTL_MS);
  let removed = 0;
  const candidates = entries.filter((entry) => entry.mtimeMs <= cutoff);
  for (const entry of candidates) {
    cleanupTaskDirectory(entry.target);
    removed += 1;
  }
  const remainingEntries = entries.filter((entry) => fs.existsSync(entry.target));
  if (remainingEntries.length > maxTaskDirectories) {
    for (const entry of remainingEntries.slice(0, remainingEntries.length - maxTaskDirectories)) {
      cleanupTaskDirectory(entry.target);
      removed += 1;
    }
  }
  const remaining = fs.existsSync(taskRoot)
    ? fs.readdirSync(taskRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
    : 0;
  return { removed, remaining };
}

function createOpenCodeTaskWorkspace({ workspaceRoot, runId, inputs = {}, maxInputBytes = MAX_INPUT_BYTES }) {
  const normalizedRunId = String(runId || '').trim();
  if (!workspaceRoot || !normalizedRunId) throw new Error('createOpenCodeTaskWorkspace 缺少 workspaceRoot 或 runId');
  const taskDir = ensureInsideRoot(path.join(workspaceRoot, '.agent-tasks'), path.join(workspaceRoot, '.agent-tasks', normalizedRunId));
  const workDir = path.join(taskDir, 'work');
  const inputDir = path.join(workDir, 'input');
  const runtimeDir = path.join(taskDir, 'runtime');
  const configPath = path.join(runtimeDir, 'opencode.json');
  const outputPath = path.join(workDir, OUTPUT_FILE);
  try {
    fs.mkdirSync(inputDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    let totalBytes = 0;
    const declared = new Set();
    for (const [sourcePath, sourceContent] of Object.entries(inputs)) {
      const relative = safeRelativePath(sourcePath);
      if (!relative.startsWith('input/')) {
        throw createWorkspaceError('Agent 输入必须位于 input/ 目录', 'AGENT_WORKSPACE_PATH_INVALID');
      }
      const folded = relative.toLowerCase();
      if (declared.has(folded)) throw createWorkspaceError('Agent 输入路径重复', 'AGENT_WORKSPACE_PATH_INVALID');
      declared.add(folded);
      const content = Buffer.isBuffer(sourceContent) ? sourceContent : Buffer.from(String(sourceContent ?? ''), 'utf8');
      totalBytes += content.length;
      if (totalBytes > maxInputBytes) throw createWorkspaceError('Agent 输入超出大小限制', 'AGENT_INPUT_TOO_LARGE');
      const target = ensureInsideRoot(workDir, path.join(workDir, relative));
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, content, { mode: 0o600 });
    }
    freezeInputTree(inputDir);
  } catch (error) {
    try {
      cleanupTaskDirectory(taskDir);
    } catch (cleanupError) {
      error.cleanupError = cleanupError;
    }
    throw error;
  }
  return Object.freeze({
    taskDir,
    workDir,
    runtimeDir,
    inputDir,
    configPath,
    outputPath,
    cleanup() {
      cleanupTaskDirectory(taskDir);
    },
    assertDeclaredFiles: () => assertDeclaredFiles(workDir),
    readOutput: (options) => readSafeOutput(outputPath, options),
  });
}

module.exports = {
  MAX_INPUT_BYTES,
  MAX_OUTPUT_BYTES,
  OUTPUT_FILE,
  assertDeclaredFiles,
  createOpenCodeTaskWorkspace,
  ensureInsideRoot,
  readSafeOutput,
  safeRelativePath,
  MAX_TASK_DIRECTORIES,
  STALE_TASK_TTL_MS,
  sweepOrphanTaskDirectories,
};
