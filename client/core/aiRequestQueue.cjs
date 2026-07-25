const AI_QUEUE_SCOPE_PAUSED = 'AI_QUEUE_SCOPE_PAUSED';
const AI_QUEUE_CLOSED = 'AI_REQUEST_QUEUE_CLOSED';

const DEFAULT_QUEUE_LIMITS = Object.freeze({
  text: 10,
  image: 2,
});

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  if (Number.isFinite(number)) {
    const normalized = Math.floor(number);
    if (normalized > 0) {
      return normalized;
    }
  }
  return fallback;
}

function normalizeLane(lane) {
  const normalizedLane = String(lane || '').trim().toLowerCase();
  if (normalizedLane === 'text' || normalizedLane === 'image') {
    return normalizedLane;
  }
  throw new Error(`未知 lane: ${lane}`);
}

function normalizeScopeId(scopeId) {
  return String(scopeId || '').trim();
}

function getQueueLimit(options, lane) {
  if (options && typeof options === 'object') {
    const laneLimits = options.limits || {};
    if (laneLimits[lane]) {
      return normalizePositiveInteger(laneLimits[lane], DEFAULT_QUEUE_LIMITS[lane]);
    }
    if (options[`${lane}Limit`]) {
      return normalizePositiveInteger(options[`${lane}Limit`], DEFAULT_QUEUE_LIMITS[lane]);
    }
    if (options[`${lane}ConcurrencyLimit`]) {
      return normalizePositiveInteger(options[`${lane}ConcurrencyLimit`], DEFAULT_QUEUE_LIMITS[lane]);
    }
  }
  return DEFAULT_QUEUE_LIMITS[lane];
}

function createQueueScopePausedError() {
  const error = new Error('AI 请求队列已暂停');
  error.code = AI_QUEUE_SCOPE_PAUSED;
  return error;
}

function createQueueClosedError() {
  const error = new Error('AI 队列已关闭');
  error.code = AI_QUEUE_CLOSED;
  return error;
}

function getQueuedCount(state) {
  return state.queue.length;
}

function normalizeWorkspaceKey(workspaceKey) {
  const normalized = String(workspaceKey || '').trim();
  if (!normalized) {
    throw new Error('workspace/account key 不能为空');
  }
  return normalized;
}

function createAiRequestQueue(options = {}) {
  const coordinator = options.coordinator;
  const workspaceKey = normalizeWorkspaceKey(options.workspaceKey);
  const textLimit = getQueueLimit(options, 'text');
  const imageLimit = getQueueLimit(options, 'image');
  const laneStates = {
    text: {
      queue: [],
      activeCount: 0,
      limit: textLimit,
      pausedScopes: new Set(),
      delegatedJobs: new Set(),
    },
    image: {
      queue: [],
      activeCount: 0,
      limit: imageLimit,
      pausedScopes: new Set(),
      delegatedJobs: new Set(),
    },
  };
  let isClosed = false;

  if (!coordinator || typeof coordinator.enqueue !== 'function' || typeof coordinator.getStatus !== 'function') {
    throw new Error('createAiRequestQueue 需要共享 createAiFairCoordinator 实例');
  }

  function isScopePaused(scopeId) {
    return scopeId && this.pausedScopes.has(scopeId);
  }

  function rejectPausedJob(job, state) {
    if (!isScopePaused.call(state, job.scopeId)) {
      return false;
    }
    job.reject(createQueueScopePausedError());
    return true;
  }

  function createRunnerJob(lane, state, job) {
    let delegated;
    try {
      delegated = coordinator.enqueue(lane, workspaceKey, job.runner);
    } catch (error) {
      job.reject(error);
      return Promise.resolve().then(() => {
        state.activeCount -= 1;
        pumpLane(lane);
      });
    }

    job.delegated = delegated;
    state.delegatedJobs.add(job);
    return Promise.resolve(delegated)
      .then((value) => {
        job.resolve(value);
      }, (error) => {
        job.reject(error);
      })
      .finally(() => {
        state.delegatedJobs.delete(job);
        state.activeCount -= 1;
        pumpLane(lane);
      });
  }

  function runJob(lane, state, job) {
    return createRunnerJob(lane, state, job);
  }

  function pumpLane(lane) {
    const state = laneStates[lane];
    while (!isClosed && state.activeCount < state.limit && state.queue.length) {
      const job = state.queue.shift();
      if (!job) {
        break;
      }

      if (rejectPausedJob(job, state)) {
        continue;
      }

      state.activeCount += 1;
      void runJob(lane, state, job);
    }
  }

  function rejectQueuedJobs(state) {
    while (state.queue.length) {
      const job = state.queue.shift();
      job.reject(createQueueClosedError());
    }
  }

  function cancelDelegatedJobs(state, shouldCancel, createError) {
    let dropped = 0;
    for (const job of state.delegatedJobs) {
      if (!shouldCancel(job) || !job.delegated || typeof job.delegated.cancel !== 'function') {
        continue;
      }

      if (job.delegated.cancel(createError())) {
        dropped += 1;
      }
    }
    return dropped;
  }

  function enqueue(lane, runner, options = {}) {
    if (isClosed) {
      return Promise.reject(createQueueClosedError());
    }

    const normalizedLane = normalizeLane(lane);
    const state = laneStates[normalizedLane];
    const scopeId = normalizeScopeId(options.scopeId || options.queueScopeId);
    if (typeof runner !== 'function') {
      return Promise.reject(new Error('runner 必须是函数'));
    }

    const job = {
      runner,
      scopeId,
      resolve: null,
      reject: null,
    };

    return new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
      if (scopeId && state.pausedScopes.has(scopeId)) {
        job.reject(createQueueScopePausedError());
        return;
      }

      state.queue.push(job);
      pumpLane(normalizedLane);
    });
  }

  function pauseScope(scopeId) {
    const normalizedScopeId = normalizeScopeId(scopeId);
    if (!normalizedScopeId) {
      return 0;
    }

    let dropped = 0;
    Object.keys(laneStates).forEach((lane) => {
      const state = laneStates[lane];
      state.pausedScopes.add(normalizedScopeId);

      const remaining = [];
      for (let i = 0; i < state.queue.length; i += 1) {
        const job = state.queue[i];
        if (job.scopeId === normalizedScopeId) {
          job.reject(createQueueScopePausedError());
          dropped += 1;
        } else {
          remaining.push(job);
        }
      }
      state.queue = remaining;
      dropped += cancelDelegatedJobs(
        state,
        (job) => job.scopeId === normalizedScopeId,
        createQueueScopePausedError,
      );
    });

    return dropped;
  }

  function resumeScope(scopeId) {
    const normalizedScopeId = normalizeScopeId(scopeId);
    if (!normalizedScopeId) {
      return;
    }

    Object.keys(laneStates).forEach((lane) => {
      laneStates[lane].pausedScopes.delete(normalizedScopeId);
      pumpLane(lane);
    });
  }

  function getStatus() {
    const status = {};
    Object.keys(laneStates).forEach((lane) => {
      const state = laneStates[lane];
      status[lane] = {
        active: state.activeCount,
        queued: getQueuedCount(state),
        limit: state.limit,
      };
    });
    return status;
  }

  function close() {
    if (isClosed) {
      return;
    }
    isClosed = true;

    Object.keys(laneStates).forEach((lane) => {
      const state = laneStates[lane];
      rejectQueuedJobs(state);
      cancelDelegatedJobs(state, () => true, createQueueClosedError);
      state.pausedScopes.clear();
    });
  }

  return {
    enqueue,
    pauseScope,
    resumeScope,
    getStatus,
    close,
  };
}

module.exports = {
  AI_QUEUE_SCOPE_PAUSED,
  createAiRequestQueue,
  createQueueScopePausedError,
};
