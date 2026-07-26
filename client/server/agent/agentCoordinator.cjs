const DEFAULT_LIMITS = Object.freeze({
  globalActive: 4,
  globalQueued: 32,
  workspaceActive: 1,
  workspaceQueued: 2,
  retryAfterSeconds: 5,
});

function normalizePositiveInteger(value, fallback, ceiling = fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(number), ceiling);
}

function createAgentError(message, code, options = {}) {
  const error = new Error(message);
  error.code = code;
  error.retryable = Boolean(options.retryable);
  if (options.retryAfterSeconds) {
    error.retryAfterSeconds = options.retryAfterSeconds;
  }
  return error;
}

function createQueueOverloadedError(retryAfterSeconds) {
  return createAgentError('Agent 执行队列繁忙，请稍后重试', 'AGENT_QUEUE_OVERLOADED', {
    retryable: true,
    retryAfterSeconds,
  });
}

function createCancelledError() {
  return createAgentError('Agent 执行已取消', 'AGENT_CANCELLED', { retryable: true });
}

function normalizeWorkspaceId(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw createAgentError('Agent workspaceId 不能为空', 'AGENT_TASK_SPEC_INVALID');
  }
  return normalized;
}

function normalizeExecutionId(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw createAgentError('Agent executionId 不能为空', 'AGENT_TASK_SPEC_INVALID');
  }
  return normalized;
}

function stableEnvelope(value) {
  if (!value || typeof value !== 'object') {
    throw createAgentError('Agent execution envelope 无效', 'AGENT_TASK_SPEC_INVALID');
  }
  const required = ['taskSpecId', 'taskSpecVersion', 'inputRevision', 'inputHash'];
  const normalized = {};
  for (const key of required) {
    const current = value[key];
    if (current === undefined || current === null || String(current).trim() === '') {
      throw createAgentError(`Agent execution envelope 缺少 ${key}`, 'AGENT_TASK_SPEC_INVALID');
    }
    normalized[key] = current;
  }
  return Object.freeze(normalized);
}

function isSameEnvelope(left, right) {
  return left.taskSpecId === right.taskSpecId
    && left.taskSpecVersion === right.taskSpecVersion
    && left.inputRevision === right.inputRevision
    && left.inputHash === right.inputHash;
}

function createAgentCoordinator(options = {}) {
  const configured = options.limits && typeof options.limits === 'object' ? options.limits : {};
  const limits = Object.freeze({
    globalActive: normalizePositiveInteger(configured.globalActive, DEFAULT_LIMITS.globalActive),
    globalQueued: normalizePositiveInteger(configured.globalQueued, DEFAULT_LIMITS.globalQueued),
    workspaceActive: normalizePositiveInteger(configured.workspaceActive, DEFAULT_LIMITS.workspaceActive),
    workspaceQueued: normalizePositiveInteger(configured.workspaceQueued, DEFAULT_LIMITS.workspaceQueued),
    retryAfterSeconds: normalizePositiveInteger(configured.retryAfterSeconds, DEFAULT_LIMITS.retryAfterSeconds),
  });
  const jobs = new Map();
  const workspaceQueues = new Map();
  const workspaceState = new Map();
  let lastScheduledWorkspaceId = null;
  let activeCount = 0;
  let closing = false;
  let closePromise = null;

  function jobKey(workspaceId, executionId) {
    return `${workspaceId}\u0000${executionId}`;
  }

  function getWorkspaceState(workspaceId) {
    if (!workspaceState.has(workspaceId)) {
      workspaceState.set(workspaceId, {
        reserved: 0,
        admitting: 0,
        queued: 0,
        active: 0,
        cleanup: 0,
      });
    }
    return workspaceState.get(workspaceId);
  }

  function clearWorkspaceStateIfIdle(workspaceId) {
    const state = workspaceState.get(workspaceId);
    if (state && Object.values(state).every((value) => value === 0)) {
      workspaceState.delete(workspaceId);
    }
  }

  function queuedCount() {
    let total = 0;
    for (const queue of workspaceQueues.values()) {
      total += queue.length;
    }
    return total;
  }

  function pendingAdmissionCount() {
    let total = 0;
    for (const job of jobs.values()) {
      if (job.phase === 'reserved' || job.phase === 'admitting' || job.phase === 'queued') {
        total += 1;
      }
    }
    return total;
  }

  function clearDeadlineTimer(job) {
    if (job.deadlineTimer) {
      clearTimeout(job.deadlineTimer);
      job.deadlineTimer = null;
    }
  }

  function removeQueuedJob(job) {
    const queue = workspaceQueues.get(job.workspaceId);
    if (!queue) return false;
    const index = queue.indexOf(job);
    if (index < 0) return false;
    queue.splice(index, 1);
    if (!queue.length) {
      workspaceQueues.delete(job.workspaceId);
    }
    const state = getWorkspaceState(job.workspaceId);
    state.queued = Math.max(0, state.queued - 1);
    clearWorkspaceStateIfIdle(job.workspaceId);
    return true;
  }

  function finalizeJob(job, error, result) {
    if (job.settled) return;
    job.settled = true;
    clearDeadlineTimer(job);
    jobs.delete(job.key);
    if (job.phase === 'reserved') {
      getWorkspaceState(job.workspaceId).reserved = Math.max(0, getWorkspaceState(job.workspaceId).reserved - 1);
    } else if (job.phase === 'admitting') {
      getWorkspaceState(job.workspaceId).admitting = Math.max(0, getWorkspaceState(job.workspaceId).admitting - 1);
    } else if (job.phase === 'queued') {
      removeQueuedJob(job);
    }
    clearWorkspaceStateIfIdle(job.workspaceId);
    if (error) {
      job.reject(error);
    } else {
      job.resolve(result);
    }
  }

  function setPhase(job, phase) {
    if (job.settled) return;
    job.phase = phase;
  }

  function pickNextJob() {
    const workspaceIds = Array.from(workspaceQueues.keys());
    if (!workspaceIds.length) return null;
    const lastIndex = lastScheduledWorkspaceId === null ? -1 : workspaceIds.indexOf(lastScheduledWorkspaceId);
    const startIndex = lastIndex >= 0 ? lastIndex : -1;
    for (let offset = 1; offset <= workspaceIds.length; offset += 1) {
      const index = (startIndex + offset) % workspaceIds.length;
      const workspaceId = workspaceIds[index];
      const queue = workspaceQueues.get(workspaceId);
      const state = getWorkspaceState(workspaceId);
      if (!queue?.length) {
        workspaceQueues.delete(workspaceId);
        continue;
      }
      if (state.active >= limits.workspaceActive) {
        continue;
      }
      const job = queue.shift();
      if (!queue.length) workspaceQueues.delete(workspaceId);
      state.queued = Math.max(0, state.queued - 1);
      lastScheduledWorkspaceId = workspaceId;
      return job;
    }
    return null;
  }

  async function runJob(job) {
    const state = getWorkspaceState(job.workspaceId);
    state.active += 1;
    activeCount += 1;
    setPhase(job, 'running');
    try {
      if (job.controller.signal.aborted) {
        throw createCancelledError();
      }
      const result = await job.runner({
        signal: job.controller.signal,
        setPhase: (phase) => setPhase(job, phase),
      });
      setPhase(job, 'cleanup');
      state.cleanup += 1;
      finalizeJob(job, null, result);
    } catch (error) {
      const normalized = job.controller.signal.aborted || error?.code === 'AGENT_ABORTED'
        ? createCancelledError()
        : error;
      setPhase(job, 'cleanup');
      state.cleanup += 1;
      finalizeJob(job, normalized);
    } finally {
      state.cleanup = Math.max(0, state.cleanup - 1);
      state.active = Math.max(0, state.active - 1);
      activeCount = Math.max(0, activeCount - 1);
      clearWorkspaceStateIfIdle(job.workspaceId);
      pump();
    }
  }

  function pump() {
    while (!closing && activeCount < limits.globalActive) {
      const job = pickNextJob();
      if (!job) break;
      void runJob(job);
    }
  }

  function cancelJob(job, reason = createCancelledError()) {
    if (!job || job.settled) return false;
    if (job.phase === 'queued') {
      finalizeJob(job, reason);
      return true;
    }
    if (job.phase === 'reserved' || job.phase === 'admitting') {
      finalizeJob(job, reason);
      return true;
    }
    job.controller.abort(reason);
    return true;
  }

  function getJobSnapshot(job) {
    return {
      workspaceId: job.workspaceId,
      executionId: job.executionId,
      phase: job.phase,
      deadlineAt: job.deadlineAt,
      envelope: job.envelope,
    };
  }

  function reserve(input = {}) {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const executionId = normalizeExecutionId(input.executionId);
    const envelope = stableEnvelope(input.envelope);
    if (closing) {
      throw createAgentError('Agent 调度器正在关闭', 'AGENT_CLOSING', { retryable: true });
    }
    const key = jobKey(workspaceId, executionId);
    const existing = jobs.get(key);
    if (existing) {
      if (!isSameEnvelope(existing.envelope, envelope)) {
        throw createAgentError('相同 executionId 的 Agent envelope 不一致', 'AGENT_EXECUTION_CONFLICT');
      }
      return existing.reservation;
    }
    const state = getWorkspaceState(workspaceId);
    if (
      state.reserved + state.admitting + state.queued >= limits.workspaceQueued
      || pendingAdmissionCount() >= limits.globalQueued
    ) {
      throw createQueueOverloadedError(limits.retryAfterSeconds);
    }
    const deadlineAt = Number.isFinite(Number(input.deadlineAt)) ? Number(input.deadlineAt) : Date.now() + 120_000;
    if (deadlineAt <= Date.now()) {
      throw createAgentError('Agent 执行已超时', 'AGENT_TIMEOUT', { retryable: true });
    }
    const job = {
      key,
      workspaceId,
      executionId,
      envelope,
      deadlineAt,
      phase: 'reserved',
      controller: new AbortController(),
      runner: null,
      settled: false,
      resolve: null,
      reject: null,
      deadlineTimer: null,
      reservation: null,
    };
    job.completion = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    // A caller may attach after a reservation fails during admission; avoid a process-level unhandled rejection.
    void job.completion.catch(() => undefined);
    jobs.set(key, job);
    state.reserved += 1;
    const deadlineDelay = Math.max(1, deadlineAt - Date.now());
    job.deadlineTimer = setTimeout(() => cancelJob(job, createAgentError('Agent 执行超时', 'AGENT_TIMEOUT', { retryable: true })), deadlineDelay);
    job.deadlineTimer.unref?.();
    job.reservation = Object.freeze({
      workspaceId,
      executionId,
      completion: job.completion,
      getSnapshot: () => getJobSnapshot(job),
      cancel: (reason) => cancelJob(job, reason || createCancelledError()),
      admit(runner) {
        if (job.settled) return job.completion;
        if (closing) {
          finalizeJob(job, createAgentError('Agent 调度器正在关闭', 'AGENT_CLOSING', { retryable: true }));
          return job.completion;
        }
        if (job.phase !== 'reserved') {
          return job.completion;
        }
        if (typeof runner !== 'function') {
          finalizeJob(job, createAgentError('Agent runner 必须是函数', 'AGENT_TASK_SPEC_INVALID'));
          return job.completion;
        }
        const currentState = getWorkspaceState(workspaceId);
        currentState.reserved = Math.max(0, currentState.reserved - 1);
        currentState.admitting += 1;
        setPhase(job, 'admitting');
        job.runner = runner;
        if (closing || job.controller.signal.aborted) {
          finalizeJob(job, closing
            ? createAgentError('Agent 调度器正在关闭', 'AGENT_CLOSING', { retryable: true })
            : createCancelledError());
          return job.completion;
        }
        currentState.admitting = Math.max(0, currentState.admitting - 1);
        currentState.queued += 1;
        setPhase(job, 'queued');
        if (!workspaceQueues.has(workspaceId)) workspaceQueues.set(workspaceId, []);
        workspaceQueues.get(workspaceId).push(job);
        pump();
        return job.completion;
      },
    });
    return job.reservation;
  }

  function getWorkspaceSnapshot(workspaceId) {
    const state = workspaceState.get(String(workspaceId || '').trim());
    if (!state) {
      return { reserved: 0, admitting: 0, active: 0, queued: 0, cleanup: 0 };
    }
    return { ...state };
  }

  function getStatus() {
    return {
      closing,
      active: activeCount,
      queued: queuedCount(),
      reservations: pendingAdmissionCount() - queuedCount(),
      limits,
    };
  }

  function cancelWorkspace(workspaceId, reason = createCancelledError()) {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    let cancelled = 0;
    for (const job of Array.from(jobs.values())) {
      if (job.workspaceId === normalizedWorkspaceId && cancelJob(job, reason)) cancelled += 1;
    }
    return cancelled;
  }

  function beginClosing(reason = createAgentError('Agent 调度器正在关闭', 'AGENT_CLOSING', { retryable: true })) {
    closing = true;
    for (const job of Array.from(jobs.values())) {
      cancelJob(job, reason);
    }
  }

  function close({ timeoutMs = 30_000 } = {}) {
    if (closePromise) return closePromise;
    beginClosing();
    const pending = Array.from(jobs.values()).map((job) => job.completion.catch(() => undefined));
    closePromise = Promise.race([
      Promise.allSettled(pending),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(createAgentError('Agent 调度器关闭超时', 'AGENT_SHUTDOWN_TIMEOUT', { retryable: true })), timeoutMs);
        timer.unref?.();
      }),
    ]);
    return closePromise;
  }

  return {
    beginClosing,
    cancelWorkspace,
    close,
    getStatus,
    getWorkspaceSnapshot,
    reserve,
  };
}

module.exports = {
  DEFAULT_LIMITS,
  createAgentCoordinator,
  createAgentError,
};
