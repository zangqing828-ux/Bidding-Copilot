// 单租户 TenantContext 生命周期管理；保留旧函数名作为内部兼容接口。
const { createWorkspaceContext } = require('./workspaceContext.cjs');

const WORKSPACE_STATE_ACTIVE = 'active';
const WORKSPACE_STATE_CLOSING = 'closing';
const WORKSPACE_STATE_CLOSE_FAILED = 'close_failed';
const WORKSPACE_STATE_CLOSED = 'closed';

function getConfig() {
  return require('../config.cjs');
}

function createBusyError(tenantId) {
  const error = new Error(`tenant ${tenantId} 仍有活跃资源`);
  error.code = 'WORKSPACE_BUSY';
  return error;
}

function createUnavailableError(entry) {
  const error = new Error('租户上下文当前不可用，请稍后重试');
  error.code = 'WORKSPACE_UNAVAILABLE';
  error.state = entry.state;
  error.retryable = true;
  return error;
}

function createTenantMismatchError() {
  const error = new Error('请求未绑定到当前租户');
  error.code = 'TENANT_CONTEXT_MISMATCH';
  error.retryable = false;
  return error;
}

function readActivitySnapshot(context) {
  try {
    if (!context || typeof context.getActivitySnapshot !== 'function') {
      return { active: true, unknown: true };
    }
    const snapshot = context.getActivitySnapshot();
    return {
      active: Boolean(snapshot?.active),
      unknown: Boolean(snapshot?.unknown),
    };
  } catch {
    return { active: true, unknown: true };
  }
}

function createWorkspaceRegistry(options = {}) {
  const config = getConfig();
  const createContext = options.createContext || createWorkspaceContext;
  const dataDir = options.dataDir === undefined ? config.dataDir : options.dataDir;
  const tenantId = String(options.tenantId ?? config.tenantId ?? '').trim();

  if (!tenantId) {
    throw new Error('tenantId is required');
  }

  let entry = null;

  function assertTenantId(requestedTenantId) {
    const normalized = String(requestedTenantId || '').trim();
    if (normalized !== tenantId) {
      throw createTenantMismatchError();
    }
    return tenantId;
  }

  function createEntry() {
    const context = createContext({
      workspaceId: tenantId,
      dataDir,
    });
    if (!context || typeof context.close !== 'function') {
      throw new Error('workspaceContext 必须提供 close 方法');
    }
    entry = {
      workspaceId: tenantId,
      context,
      leases: new Set(),
      closeAttempts: 0,
      lastCloseError: null,
      closePromise: null,
      state: WORKSPACE_STATE_ACTIVE,
    };
    return entry;
  }

  function getEntry(requestedTenantId) {
    assertTenantId(requestedTenantId);
    const current = entry || createEntry();
    if (current.state !== WORKSPACE_STATE_ACTIVE) {
      throw createUnavailableError(current);
    }
    return current;
  }

  function closeEntry(target) {
    if (target.closePromise) {
      return target.closePromise;
    }

    target.state = WORKSPACE_STATE_CLOSING;
    target.closeAttempts += 1;
    const attempt = Promise.resolve()
      .then(() => target.context.close())
      .then(
        () => {
          target.state = WORKSPACE_STATE_CLOSED;
          target.lastCloseError = null;
          if (entry === target) {
            entry = null;
          }
          return true;
        },
        (error) => {
          target.state = WORKSPACE_STATE_CLOSE_FAILED;
          target.lastCloseError = error;
          target.closePromise = null;
          console.warn('[workspace] 关闭租户上下文失败，保留实例等待重试', error?.message || String(error));
          throw error;
        },
      );
    target.closePromise = attempt;
    return attempt;
  }

  function isBusy(target) {
    if (target.leases.size > 0) {
      return true;
    }
    if (target.state !== WORKSPACE_STATE_ACTIVE) {
      return false;
    }
    const activity = readActivitySnapshot(target.context);
    return activity.active || activity.unknown;
  }

  function getWorkspaceContext(requestedTenantId) {
    return getEntry(requestedTenantId).context;
  }

  function touchWorkspaceContext(requestedTenantId) {
    return getEntry(requestedTenantId).context;
  }

  function acquireWorkspaceContext(requestedTenantId) {
    const current = getEntry(requestedTenantId);
    const leaseToken = Symbol(`tenant:${tenantId}`);
    current.leases.add(leaseToken);
    let released = false;

    return {
      context: current.context,
      release() {
        if (released) {
          return false;
        }
        released = true;
        return releaseWorkspaceContext(tenantId, leaseToken);
      },
    };
  }

  function releaseWorkspaceContext(requestedTenantId, leaseToken) {
    if (String(requestedTenantId || '').trim() !== tenantId || !entry) {
      return false;
    }
    if (leaseToken && entry.leases.has(leaseToken)) {
      return entry.leases.delete(leaseToken);
    }
    if (!leaseToken && entry.leases.size > 0) {
      return entry.leases.delete(entry.leases.values().next().value);
    }
    return false;
  }

  function closeWorkspaceContext(requestedTenantId, options = {}) {
    assertTenantId(requestedTenantId);
    const current = entry;
    if (!current) {
      return Promise.resolve(false);
    }
    if (current.closePromise) {
      return current.closePromise;
    }
    if (!options.force && isBusy(current)) {
      return Promise.reject(createBusyError(tenantId));
    }
    return closeEntry(current);
  }

  async function closeAll(options = {}) {
    const current = entry;
    if (!current) {
      return { closed: 0, failed: 0, errors: [] };
    }

    const force = options.force === undefined ? true : Boolean(options.force);
    if (!force && !current.closePromise && isBusy(current)) {
      const error = createBusyError(tenantId);
      current.lastCloseError = error;
      return { closed: 0, failed: 1, errors: [error] };
    }

    try {
      await closeEntry(current);
      return { closed: 1, failed: 0, errors: [] };
    } catch (error) {
      return { closed: 0, failed: 1, errors: [error] };
    }
  }

  function getStatus() {
    if (!entry) {
      return { size: 0, tenantId, entries: [] };
    }
    const activity = readActivitySnapshot(entry.context);
    return {
      size: 1,
      tenantId,
      entries: [{
        workspaceId: tenantId,
        state: entry.state,
        leaseCount: entry.leases.size,
        closeAttempts: entry.closeAttempts,
        closeError: entry.lastCloseError?.message || '',
        active: activity.active || activity.unknown,
        activity,
      }],
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
  };
}

const defaultRegistry = createWorkspaceRegistry();

module.exports = {
  createWorkspaceRegistry,
  getWorkspaceContext: defaultRegistry.getWorkspaceContext,
  touchWorkspaceContext: defaultRegistry.touchWorkspaceContext,
  acquireWorkspaceContext: defaultRegistry.acquireWorkspaceContext,
  releaseWorkspaceContext: defaultRegistry.releaseWorkspaceContext,
  closeWorkspaceContext: defaultRegistry.closeWorkspaceContext,
  closeAll: defaultRegistry.closeAll,
  getStatus: defaultRegistry.getStatus,
};
