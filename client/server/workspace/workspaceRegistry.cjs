// Workspace Registry：按 workspaceId 缓存 workspaceContext，并在空闲且无活跃工作时回收。
const { createWorkspaceContext } = require('./workspaceContext.cjs');

const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;

function normalizeDuration(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return fallback;
  }
  return Math.floor(number);
}

function getDataDir() {
  const config = require('../config.cjs');
  return config.dataDir;
}

function createBusyError(workspaceId) {
  const error = new Error(`workspace ${workspaceId} 仍有活跃资源`);
  error.code = 'WORKSPACE_BUSY';
  return error;
}

function countActiveTasks(value) {
  if (Array.isArray(value)) {
    return value.length;
  }
  if (Number.isFinite(Number(value))) {
    return Math.max(0, Number(value));
  }
  if (value && typeof value === 'object') {
    return Object.keys(value).length;
  }
  return 0;
}

function readActivitySnapshot(context) {
  if (context && typeof context.getActivitySnapshot === 'function') {
    try {
      const snapshot = context.getActivitySnapshot();
      return {
        active: Boolean(snapshot?.active),
        unknown: Boolean(snapshot?.unknown),
        activeTaskCount: Math.max(0, Number(snapshot?.activeTaskCount) || 0),
        aiActiveCount: Math.max(0, Number(snapshot?.aiActiveCount) || 0),
        aiQueuedCount: Math.max(0, Number(snapshot?.aiQueuedCount) || 0),
      };
    } catch {
      return { active: true, unknown: true, activeTaskCount: 0, aiActiveCount: 0, aiQueuedCount: 0 };
    }
  }

  try {
    const activeTaskCount = context?.taskService && typeof context.taskService.getActiveTasks === 'function'
      ? countActiveTasks(context.taskService.getActiveTasks())
      : 0;
    const text = context?.aiService && typeof context.aiService.getTextQueueStatus === 'function'
      ? context.aiService.getTextQueueStatus()
      : {};
    const image = context?.aiService && typeof context.aiService.getImageQueueStatus === 'function'
      ? context.aiService.getImageQueueStatus()
      : {};
    const aiActiveCount = Math.max(0, Number(text?.active) || 0) + Math.max(0, Number(image?.active) || 0);
    const aiQueuedCount = Math.max(0, Number(text?.queued) || 0) + Math.max(0, Number(image?.queued) || 0);
    return {
      active: activeTaskCount > 0 || aiActiveCount > 0 || aiQueuedCount > 0,
      unknown: false,
      activeTaskCount,
      aiActiveCount,
      aiQueuedCount,
    };
  } catch {
    return { active: true, unknown: true, activeTaskCount: 0, aiActiveCount: 0, aiQueuedCount: 0 };
  }
}

function createWorkspaceRegistry(options = {}) {
  const env = options.env || process.env;
  const createContext = options.createContext || createWorkspaceContext;
  const dataDir = options.dataDir;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const idleTtlMs = normalizeDuration(
    options.idleTtlMs ?? env.WEB_WORKSPACE_IDLE_TTL_MS,
    DEFAULT_IDLE_TTL_MS,
  );
  const sweepIntervalMs = normalizeDuration(
    options.sweepIntervalMs ?? env.WEB_WORKSPACE_SWEEP_INTERVAL_MS,
    Math.min(DEFAULT_SWEEP_INTERVAL_MS, Math.max(1000, Math.floor(idleTtlMs / 2))),
  );
  const contexts = new Map();
  let sweepTimer = null;

  function touch(entry) {
    entry.lastAccessAt = now();
  }

  function ensureSweepTimer() {
    if (sweepTimer || !contexts.size) {
      return;
    }
    sweepTimer = setInterval(() => {
      sweepIdleContexts();
    }, sweepIntervalMs);
    if (typeof sweepTimer.unref === 'function') {
      sweepTimer.unref();
    }
  }

  function stopSweepTimerIfEmpty() {
    if (contexts.size || !sweepTimer) {
      return;
    }
    clearInterval(sweepTimer);
    sweepTimer = null;
  }

  function createEntry(workspaceId) {
    const context = createContext({
      workspaceId,
      dataDir: dataDir === undefined ? getDataDir() : dataDir,
    });
    if (!context || typeof context.close !== 'function') {
      throw new Error('workspaceContext 必须提供 close 方法');
    }
    const entry = {
      workspaceId,
      context,
      lastAccessAt: now(),
      leases: new Set(),
      closeAttempts: 0,
      lastCloseError: null,
    };
    contexts.set(workspaceId, entry);
    ensureSweepTimer();
    return entry;
  }

  function getEntry(workspaceId) {
    const normalized = String(workspaceId || '').trim();
    if (!normalized) {
      throw new Error('workspaceId is required');
    }
    let entry = contexts.get(normalized);
    if (!entry) {
      entry = createEntry(normalized);
    }
    touch(entry);
    return entry;
  }

  function closeEntry(entry) {
    entry.closeAttempts += 1;
    try {
      entry.context.close();
      contexts.delete(entry.workspaceId);
      entry.lastCloseError = null;
      return null;
    } catch (error) {
      entry.lastCloseError = error;
      console.warn('[workspace] 关闭 workspace 失败，保留上下文等待重试', error?.message || String(error));
      return error;
    }
  }

  function isReclaimable(entry, timestamp) {
    if (entry.leases.size > 0) {
      return false;
    }
    const activity = readActivitySnapshot(entry.context);
    if (activity.active || activity.unknown) {
      return false;
    }
    return timestamp - entry.lastAccessAt >= idleTtlMs;
  }

  function sweepIdleContexts() {
    const timestamp = now();
    for (const entry of Array.from(contexts.values())) {
      if (isReclaimable(entry, timestamp)) {
        closeEntry(entry);
      }
    }
    stopSweepTimerIfEmpty();
  }

  function getWorkspaceContext(workspaceId) {
    return getEntry(workspaceId).context;
  }

  function touchWorkspaceContext(workspaceId) {
    return getEntry(workspaceId).context;
  }

  function acquireWorkspaceContext(workspaceId) {
    const entry = getEntry(workspaceId);
    const leaseToken = Symbol(`workspace:${entry.workspaceId}`);
    entry.leases.add(leaseToken);
    touch(entry);
    let released = false;

    return {
      context: entry.context,
      release() {
        if (released) {
          return false;
        }
        released = true;
        return releaseWorkspaceContext(entry.workspaceId, leaseToken);
      },
    };
  }

  function releaseWorkspaceContext(workspaceId, leaseToken) {
    const normalized = String(workspaceId || '').trim();
    const entry = contexts.get(normalized);
    if (!entry) {
      return false;
    }

    let released = false;
    if (leaseToken && entry.leases.has(leaseToken)) {
      released = entry.leases.delete(leaseToken);
    } else if (!leaseToken && entry.leases.size > 0) {
      const first = entry.leases.values().next().value;
      released = entry.leases.delete(first);
    }
    if (released) {
      touch(entry);
    }
    return released;
  }

  function closeWorkspaceContext(workspaceId, options = {}) {
    const normalized = String(workspaceId || '').trim();
    const entry = contexts.get(normalized);
    if (!entry) {
      return false;
    }
    const force = Boolean(options.force);
    if (!force && (entry.leases.size > 0 || readActivitySnapshot(entry.context).active)) {
      throw createBusyError(normalized);
    }
    const error = closeEntry(entry);
    if (error) {
      throw error;
    }
    stopSweepTimerIfEmpty();
    return true;
  }

  function closeAll(options = {}) {
    const force = options.force === undefined ? true : Boolean(options.force);
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }

    const errors = [];
    let closed = 0;
    for (const entry of Array.from(contexts.values())) {
      if (!force && (entry.leases.size > 0 || readActivitySnapshot(entry.context).active)) {
        const busyError = createBusyError(entry.workspaceId);
        entry.lastCloseError = busyError;
        errors.push(busyError);
        continue;
      }
      const error = closeEntry(entry);
      if (error) {
        errors.push(error);
      } else {
        closed += 1;
      }
    }
    return { closed, failed: errors.length, errors };
  }

  function getStatus() {
    const entries = Array.from(contexts.values()).map((entry) => {
      const activity = readActivitySnapshot(entry.context);
      return {
        workspaceId: entry.workspaceId,
        leaseCount: entry.leases.size,
        lastAccessAt: entry.lastAccessAt,
        closeAttempts: entry.closeAttempts,
        closeError: entry.lastCloseError?.message || '',
        active: activity.active,
        activity,
      };
    });
    return {
      size: entries.length,
      idleTtlMs,
      sweepIntervalMs,
      timerActive: Boolean(sweepTimer),
      entries,
    };
  }

  return {
    getWorkspaceContext,
    touchWorkspaceContext,
    acquireWorkspaceContext,
    releaseWorkspaceContext,
    closeWorkspaceContext,
    closeAll,
    getStatus,
    sweepIdleContexts,
  };
}

const defaultRegistry = createWorkspaceRegistry();

module.exports = {
  DEFAULT_IDLE_TTL_MS,
  DEFAULT_SWEEP_INTERVAL_MS,
  createWorkspaceRegistry,
  getWorkspaceContext: defaultRegistry.getWorkspaceContext,
  touchWorkspaceContext: defaultRegistry.touchWorkspaceContext,
  acquireWorkspaceContext: defaultRegistry.acquireWorkspaceContext,
  releaseWorkspaceContext: defaultRegistry.releaseWorkspaceContext,
  closeWorkspaceContext: defaultRegistry.closeWorkspaceContext,
  closeAll: defaultRegistry.closeAll,
  getStatus: defaultRegistry.getStatus,
};
