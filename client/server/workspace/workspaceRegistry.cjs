// Workspace Registry：按 workspaceId 缓存 workspaceContext，并在空闲且无活跃工作时回收。
const { createWorkspaceContext } = require('./workspaceContext.cjs');

const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;
const WORKSPACE_STATE_ACTIVE = 'active';
const WORKSPACE_STATE_CLOSING = 'closing';
const WORKSPACE_STATE_CLOSE_FAILED = 'close_failed';
const WORKSPACE_STATE_CLOSED = 'closed';

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

function createUnavailableError(entry) {
  const error = new Error(`workspace ${entry.workspaceId} 当前不可用，请稍后重试`);
  error.code = 'WORKSPACE_UNAVAILABLE';
  error.state = entry.state;
  error.retryable = true;
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
      void sweepIdleContexts().catch((error) => {
        console.warn('[workspace] 空闲 workspace 回收失败', error?.message || String(error));
      });
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
      closePromise: null,
      state: WORKSPACE_STATE_ACTIVE,
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
    if (entry.state !== WORKSPACE_STATE_ACTIVE) {
      throw createUnavailableError(entry);
    }
    touch(entry);
    return entry;
  }

  function closeEntry(entry) {
    if (entry.closePromise) {
      return entry.closePromise;
    }

    entry.state = WORKSPACE_STATE_CLOSING;
    entry.closeAttempts += 1;
    const attempt = Promise.resolve()
      .then(() => entry.context.close())
      .then(
        () => {
          entry.state = WORKSPACE_STATE_CLOSED;
          if (contexts.get(entry.workspaceId) === entry) {
            contexts.delete(entry.workspaceId);
          }
          entry.lastCloseError = null;
          stopSweepTimerIfEmpty();
          return true;
        },
        (error) => {
          entry.state = WORKSPACE_STATE_CLOSE_FAILED;
          entry.lastCloseError = error;
          console.warn('[workspace] 关闭 workspace 失败，保留上下文等待重试', error?.message || String(error));
          if (entry.closePromise === attempt) {
            entry.closePromise = null;
          }
          throw error;
        },
      );
    entry.closePromise = attempt;
    return attempt;
  }

  function isReclaimable(entry, timestamp) {
    if (entry.leases.size > 0) {
      return false;
    }
    if (entry.state === WORKSPACE_STATE_CLOSE_FAILED) {
      return true;
    }
    if (entry.state !== WORKSPACE_STATE_ACTIVE) {
      return false;
    }
    const activity = readActivitySnapshot(entry.context);
    if (activity.active || activity.unknown) {
      return false;
    }
    return timestamp - entry.lastAccessAt >= idleTtlMs;
  }

  async function sweepIdleContexts() {
    const timestamp = now();
    const closePromises = [];
    for (const entry of Array.from(contexts.values())) {
      if (isReclaimable(entry, timestamp)) {
        closePromises.push(closeEntry(entry));
      }
    }
    const results = await Promise.allSettled(closePromises);
    stopSweepTimerIfEmpty();
    const errors = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    return {
      closed: results.filter((result) => result.status === 'fulfilled').length,
      failed: errors.length,
      errors,
    };
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
      if (entry.state === WORKSPACE_STATE_ACTIVE) {
        touch(entry);
      }
    }
    return released;
  }

  function closeWorkspaceContext(workspaceId, options = {}) {
    const normalized = String(workspaceId || '').trim();
    const entry = contexts.get(normalized);
    if (!entry) {
      return Promise.resolve(false);
    }
    if (entry.closePromise) {
      return entry.closePromise;
    }
    const force = Boolean(options.force);
    if (!force && (
      entry.leases.size > 0
      || (entry.state === WORKSPACE_STATE_ACTIVE && readActivitySnapshot(entry.context).active)
    )) {
      return Promise.reject(createBusyError(normalized));
    }
    return closeEntry(entry);
  }

  async function closeAll(options = {}) {
    const force = options.force === undefined ? true : Boolean(options.force);
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }

    const errors = [];
    let closed = 0;
    const closePromises = [];
    for (const entry of Array.from(contexts.values())) {
      if (!force && !entry.closePromise && (
        entry.leases.size > 0
        || (entry.state === WORKSPACE_STATE_ACTIVE && readActivitySnapshot(entry.context).active)
      )) {
        const busyError = createBusyError(entry.workspaceId);
        entry.lastCloseError = busyError;
        errors.push(busyError);
        continue;
      }
      closePromises.push(closeEntry(entry));
    }

    const results = await Promise.allSettled(closePromises);
    for (const result of results) {
      if (result.status === 'fulfilled') {
        closed += 1;
      } else {
        errors.push(result.reason);
      }
    }
    stopSweepTimerIfEmpty();
    if (contexts.size > 0) {
      ensureSweepTimer();
    }
    return { closed, failed: errors.length, errors };
  }

  function getStatus() {
    const entries = Array.from(contexts.values()).map((entry) => {
      const activity = readActivitySnapshot(entry.context);
      return {
        workspaceId: entry.workspaceId,
        state: entry.state,
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
