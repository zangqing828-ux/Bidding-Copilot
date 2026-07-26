const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const MAX_WORKER_COUNT = 4;
const DEFAULT_WORKER_COUNT = Math.max(
  1,
  Math.min(MAX_WORKER_COUNT, Math.max(1, os.availableParallelism() - 1)),
);

let sharedPool = null;

function normalizeWorkerCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return DEFAULT_WORKER_COUNT;
  }
  return Math.min(MAX_WORKER_COUNT, Math.max(1, Math.floor(number)));
}

function hashWorkspaceId(workspaceId) {
  let hash = 2166136261;
  for (const char of String(workspaceId || '')) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function deserializeError(payload) {
  const error = new Error(payload?.message || 'Store Worker 执行失败');
  error.name = payload?.name || 'Error';
  if (typeof payload?.code === 'string') error.code = payload.code;
  if (typeof payload?.retryable === 'boolean') error.retryable = payload.retryable;
  if (Number.isFinite(Number(payload?.status))) error.status = Number(payload.status);
  return error;
}

function createStoreBridgePool({
  workerCount = normalizeWorkerCount(process.env.WEB_STORE_WORKER_COUNT),
  workerPath = path.join(__dirname, 'storeBridgeWorker.cjs'),
} = {}) {
  const slots = Array.from({ length: workerCount }, () => ({
    worker: null,
    pending: new Map(),
    intentionalExit: false,
  }));
  let requestSequence = 0;
  let closing = false;

  function rejectPending(slot, error) {
    for (const request of slot.pending.values()) {
      request.reject(error);
    }
    slot.pending.clear();
    if (slot.worker && typeof slot.worker.unref === 'function') {
      slot.worker.unref();
    }
  }

  function handleWorkerFailure(slot, error) {
    rejectPending(slot, error);
    slot.worker = null;
  }

  function ensureWorker(index) {
    const slot = slots[index];
    if (slot.worker) {
      return slot.worker;
    }
    if (closing) {
      throw new Error('Store Worker 池已关闭');
    }

    slot.intentionalExit = false;
    const worker = new Worker(workerPath);
    slot.worker = worker;
    worker.on('message', (message) => {
      const request = slot.pending.get(message?.id);
      if (!request) {
        return;
      }
      slot.pending.delete(message.id);
      if (message.ok) {
        request.resolve(message.data);
      } else {
        request.reject(deserializeError(message.error));
      }
      if (slot.pending.size === 0 && slot.worker && typeof slot.worker.unref === 'function') {
        slot.worker.unref();
      }
    });
    worker.on('error', (error) => {
      handleWorkerFailure(slot, error);
    });
    worker.on('exit', (code) => {
      const isCurrentWorker = slot.worker === worker;
      if (isCurrentWorker) {
        slot.worker = null;
      }
      if (isCurrentWorker && !slot.intentionalExit && code !== 0) {
        rejectPending(slot, new Error(`Store Worker 异常退出：${code}`));
      }
    });
    if (typeof worker.unref === 'function') {
      worker.unref();
    }
    return worker;
  }

  function request(index, type, payload) {
    let worker;
    try {
      worker = ensureWorker(index);
    } catch (error) {
      return Promise.reject(error);
    }

    const id = ++requestSequence;
    return new Promise((resolve, reject) => {
      const slot = slots[index];
      if (typeof worker.ref === 'function') {
        worker.ref();
      }
      slot.pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, type, payload });
      } catch (error) {
        slot.pending.delete(id);
        if (slot.pending.size === 0 && typeof worker.unref === 'function') {
          worker.unref();
        }
        reject(error);
      }
    });
  }

  function getWorkerIndex(workspaceId) {
    return hashWorkspaceId(workspaceId) % slots.length;
  }

  return {
    execute(payload) {
      return request(getWorkerIndex(payload.workspaceId), 'execute', payload);
    },
    closeWorkspace(workspaceId) {
      const index = getWorkerIndex(workspaceId);
      if (!slots[index].worker) {
        return Promise.resolve({ closed: false });
      }
      return request(index, 'close-workspace', { workspaceId });
    },
    async close() {
      if (closing) {
        return;
      }
      closing = true;
      await Promise.all(slots.map(async (slot) => {
        if (!slot.worker) {
          return;
        }
        slot.intentionalExit = true;
        rejectPending(slot, new Error('Store Worker 池已关闭'));
        const worker = slot.worker;
        slot.worker = null;
        await worker.terminate();
      }));
    },
  };
}

function acquireSharedPool() {
  if (!sharedPool) {
    sharedPool = {
      pool: createStoreBridgePool(),
      references: 0,
    };
  }
  sharedPool.references += 1;
  return sharedPool;
}

async function releaseSharedPool(poolEntry) {
  poolEntry.references = Math.max(0, poolEntry.references - 1);
  if (poolEntry.references > 0) {
    return;
  }
  if (sharedPool === poolEntry) {
    sharedPool = null;
  }
  await poolEntry.pool.close();
}

function createWorkspaceStoreExecutor({
  workspaceId,
  workspaceRoot,
  databasePath,
  configPath,
}) {
  const poolEntry = acquireSharedPool();
  const operationPromises = new Set();
  let executed = false;
  let closed = false;
  let released = false;
  let closePromise = null;

  function execute(targetName, method, args = []) {
    if (closed) {
      const error = new Error('Workspace Store Executor 已关闭');
      error.code = 'WORKSPACE_UNAVAILABLE';
      error.retryable = true;
      return Promise.reject(error);
    }
    executed = true;
    const operation = poolEntry.pool.execute({
      workspaceId,
      workspaceRoot,
      databasePath,
      configPath,
      targetName,
      method,
      args,
    });
    operationPromises.add(operation);
    operation.then(
      () => operationPromises.delete(operation),
      () => operationPromises.delete(operation),
    );
    return operation;
  }

  function close() {
    if (closePromise) {
      return closePromise;
    }
    closed = true;
    const attempt = (async () => {
      await Promise.allSettled(Array.from(operationPromises));
      if (executed) {
        await poolEntry.pool.closeWorkspace(workspaceId);
      }
      if (!released) {
        released = true;
        await releaseSharedPool(poolEntry);
      }
    })();
    closePromise = attempt;
    void attempt.catch(() => {
      if (closePromise === attempt) {
        closePromise = null;
      }
    });
    return attempt;
  }

  return {
    execute,
    getStatus() {
      return {
        active: operationPromises.size,
        queued: 0,
      };
    },
    close,
  };
}

module.exports = {
  createStoreBridgePool,
  createWorkspaceStoreExecutor,
  _internals: {
    hashWorkspaceId,
    normalizeWorkerCount,
  },
};
