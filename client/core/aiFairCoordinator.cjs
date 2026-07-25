const DEFAULT_LANE_LIMITS = Object.freeze({
  text: 30,
  image: 6,
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

function normalizeWorkspaceKey(workspaceKey) {
  const normalized = String(workspaceKey || '').trim();
  if (!normalized) {
    throw new Error('workspace/account key 不能为空');
  }
  return normalized;
}

function createQueueClosedError() {
  const error = new Error('AI 调度器已关闭');
  error.code = 'AI_SCHEDULER_CLOSED';
  return error;
}

function getLaneLimit(options, lane) {
  if (options && typeof options === 'object') {
    const directLimits = options.laneLimits || options.limits || {};
    if (Number.isFinite(Number(directLimits[lane]))) {
      return normalizePositiveInteger(directLimits[lane], DEFAULT_LANE_LIMITS[lane]);
    }
    if (Number.isFinite(Number(options[`${lane}Limit`]))) {
      return normalizePositiveInteger(options[`${lane}Limit`], DEFAULT_LANE_LIMITS[lane]);
    }
    if (Number.isFinite(Number(options[`${lane}ConcurrencyLimit`]))) {
      return normalizePositiveInteger(options[`${lane}ConcurrencyLimit`], DEFAULT_LANE_LIMITS[lane]);
    }
  }
  return DEFAULT_LANE_LIMITS[lane];
}

function createLaneState(limit) {
  return {
    limit,
    activeCount: 0,
    queues: new Map(),
    lastScheduledWorkspace: null,
  };
}

function getQueuedCount(laneState) {
  let count = 0;
  for (const queue of laneState.queues.values()) {
    count += queue.length;
  }
  return count;
}

function pickNextWorkspaceKey(laneState) {
  const workspaceKeys = Array.from(laneState.queues.keys());
  if (!workspaceKeys.length) {
    return null;
  }

  const lastIndex = laneState.lastScheduledWorkspace === null ? -1 : workspaceKeys.indexOf(laneState.lastScheduledWorkspace);
  const startIndex = lastIndex >= 0 ? lastIndex : -1;

  for (let offset = 1; offset <= workspaceKeys.length; offset += 1) {
    const index = (startIndex + offset) % workspaceKeys.length;
    const workspaceKey = workspaceKeys[index];
    const queue = laneState.queues.get(workspaceKey);

    if (!Array.isArray(queue) || queue.length === 0) {
      laneState.queues.delete(workspaceKey);
      if (laneState.lastScheduledWorkspace === workspaceKey) {
        laneState.lastScheduledWorkspace = null;
      }
      continue;
    }

    return { workspaceKey, queue };
  }

  return null;
}

function createAiFairCoordinator(options = {}) {
  let isClosed = false;
  const lanes = Object.freeze({
    text: createLaneState(getLaneLimit(options, 'text')),
    image: createLaneState(getLaneLimit(options, 'image')),
  });

  async function runJob(laneState, lane, laneKey, job) {
    try {
      const result = await job.runner();
      job.settled = true;
      job.resolve(result);
    } catch (error) {
      job.settled = true;
      job.reject(error);
    } finally {
      laneState.activeCount = Math.max(0, laneState.activeCount - 1);
      pumpLane(lane);
    }
  }

  function dequeueJob(lane, laneState) {
    const pick = pickNextWorkspaceKey(laneState);
    if (!pick) {
      return null;
    }

    const { workspaceKey, queue } = pick;
    const job = queue.shift();
    if (queue.length === 0) {
      laneState.queues.delete(workspaceKey);
    }
    laneState.lastScheduledWorkspace = workspaceKey;
    return job;
  }

  function pumpLane(lane) {
    const laneState = lanes[lane];
    while (!isClosed && laneState.activeCount < laneState.limit) {
      const job = dequeueJob(lane, laneState);
      if (!job) {
        break;
      }

      laneState.activeCount += 1;
      job.started = true;
      void runJob(laneState, lane, lane, job);
    }
  }

  function cancelQueuedJob(lane, workspaceKey, job, reason) {
    if (job.started || job.settled) {
      return false;
    }

    const laneState = lanes[lane];
    const queue = laneState.queues.get(workspaceKey);
    if (!queue) {
      return false;
    }

    const index = queue.indexOf(job);
    if (index < 0) {
      return false;
    }

    queue.splice(index, 1);
    if (queue.length === 0) {
      laneState.queues.delete(workspaceKey);
      if (laneState.lastScheduledWorkspace === workspaceKey) {
        laneState.lastScheduledWorkspace = null;
      }
    }

    job.settled = true;
    job.reject(reason);
    return true;
  }

  function rejectQueuedJobs(lane) {
    const laneState = lanes[lane];
    for (const queue of laneState.queues.values()) {
      while (queue.length) {
        const job = queue.shift();
        job.settled = true;
        job.reject(createQueueClosedError());
      }
    }
    laneState.queues = new Map();
  }

  function enqueue(lane, workspaceKey, runner) {
    if (isClosed) {
      return Promise.reject(createQueueClosedError());
    }

    const normalizedLane = normalizeLane(lane);
    const key = normalizeWorkspaceKey(workspaceKey);
    if (typeof runner !== 'function') {
      return Promise.reject(new Error('runner 必须是函数'));
    }

    const laneState = lanes[normalizedLane];
    let queue = laneState.queues.get(key);
    if (!queue) {
      queue = [];
      laneState.queues.set(key, queue);
    }

    const job = {
      runner,
      resolve: null,
      reject: null,
      started: false,
      settled: false,
    };
    const promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
      queue.push(job);
      pumpLane(normalizedLane);
    });

    promise.cancel = (reason) => cancelQueuedJob(normalizedLane, key, job, reason);
    return promise;
  }

  function getLaneStatus(laneState) {
    return {
      active: laneState.activeCount,
      queued: getQueuedCount(laneState),
      limit: laneState.limit,
    };
  }

  function getStatus() {
    return {
      text: getLaneStatus(lanes.text),
      image: getLaneStatus(lanes.image),
    };
  }

  function close() {
    if (isClosed) {
      return;
    }

    isClosed = true;
    rejectQueuedJobs('text');
    rejectQueuedJobs('image');
  }

  return {
    enqueue,
    getStatus,
    close,
  };
}

module.exports = {
  createAiFairCoordinator,
};
