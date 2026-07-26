const DEFAULT_LIMITS = Object.freeze({
  globalActive: 4,
  globalQueued: 32,
  workspaceActive: 1,
  workspaceQueued: 2,
  retryAfterSeconds: 5,
});

function normalizePositiveInteger(value, fallback, ceiling = fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), ceiling);
}

function createAgentError(message, code, options = {}) {
  const error = new Error(message);
  error.code = code;
  error.retryable = Boolean(options.retryable);
  if (options.retryAfterSeconds) error.retryAfterSeconds = options.retryAfterSeconds;
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
  if (!normalized) throw createAgentError('Agent workspaceId 不能为空', 'AGENT_TASK_SPEC_INVALID');
  return normalized;
}

function normalizeExecutionId(value) {
  const normalized = String(value || '').trim();
  if (!normalized) throw createAgentError('Agent executionId 不能为空', 'AGENT_TASK_SPEC_INVALID');
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
  const workspaceGenerationCounters = new Map();
  const activeWorkspaceGenerations = new Map();
  const closingWorkspaceKeys = new Set();
  const workspaceClosePromises = new Map();
  let lastScheduledWorkspaceKey = null;
  let activeCount = 0;
  let closing = false;
  let closePromise = null;

  function workspaceKey(workspaceId, generation) {
    return `${workspaceId}\u0000${generation}`;
  }

  function jobKey(workspaceId, generation, executionId) {
    return `${workspaceKey(workspaceId, generation)}\u0000${executionId}`;
  }

  function getWorkspaceState(key) {
    if (!workspaceState.has(key)) {
      workspaceState.set(key, { reserved: 0, admitting: 0, queued: 0, active: 0, cleanup: 0 });
    }
    return workspaceState.get(key);
  }

  function clearWorkspaceStateIfIdle(key) {
    const state = workspaceState.get(key);
    if (state && Object.values(state).every((value) => value === 0)) workspaceState.delete(key);
  }

  function ensureWorkspaceGeneration(workspaceId, requestedGeneration) {
    const current = activeWorkspaceGenerations.get(workspaceId);
    if (requestedGeneration !== undefined && requestedGeneration !== null) {
      const generation = Number(requestedGeneration);
      if (!Number.isInteger(generation) || generation <= 0 || current !== generation) {
        throw createAgentError('Agent workspace lease 已失效', 'AGENT_CLOSING', { retryable: true });
      }
      return generation;
    }
    if (current) return current;
    return registerWorkspace(workspaceId).generation;
  }

  function isWorkspaceAvailable(workspaceId, generation) {
    const key = workspaceKey(workspaceId, generation);
    return !closing && activeWorkspaceGenerations.get(workspaceId) === generation && !closingWorkspaceKeys.has(key);
  }

  function queuedCount() {
    let total = 0;
    for (const queue of workspaceQueues.values()) total += queue.length;
    return total;
  }

  function pendingAdmissionCount() {
    let total = 0;
    for (const job of jobs.values()) {
      if (job.phase === 'reserved' || job.phase === 'admitting' || job.phase === 'queued') total += 1;
    }
    return total;
  }

  function clearDeadlineTimer(job) {
    if (!job.deadlineTimer) return;
    clearTimeout(job.deadlineTimer);
    job.deadlineTimer = null;
  }

  function removeQueuedJob(job) {
    const queue = workspaceQueues.get(job.workspaceKey);
    if (!queue) return false;
    const index = queue.indexOf(job);
    if (index < 0) return false;
    queue.splice(index, 1);
    if (!queue.length) workspaceQueues.delete(job.workspaceKey);
    const state = getWorkspaceState(job.workspaceKey);
    state.queued = Math.max(0, state.queued - 1);
    clearWorkspaceStateIfIdle(job.workspaceKey);
    return true;
  }

  function normalizeCancellation(job, fallback) {
    return job.controller.signal.aborted
      ? (job.controller.signal.reason || fallback || createCancelledError())
      : fallback;
  }

  function finalizeJob(job, error, result) {
    if (job.settled) return;
    job.settled = true;
    job.terminalError = error || null;
    clearDeadlineTimer(job);
    jobs.delete(job.key);
    const state = getWorkspaceState(job.workspaceKey);
    if (job.phase === 'reserved') state.reserved = Math.max(0, state.reserved - 1);
    else if (job.phase === 'admitting') state.admitting = Math.max(0, state.admitting - 1);
    else if (job.phase === 'queued') removeQueuedJob(job);
    clearWorkspaceStateIfIdle(job.workspaceKey);
    if (error) job.reject(error);
    else job.resolve(result);
    if (!job.running) job.finish();
  }

  function setPhase(job, phase) {
    if (!job.settled) job.phase = phase;
  }

  function assertJobAvailable(job) {
    if (job.controller.signal.aborted) throw job.controller.signal.reason || createCancelledError();
    if (job.settled || !isWorkspaceAvailable(job.workspaceId, job.workspaceGeneration)) {
      throw job.terminalError || createAgentError('Agent workspace 正在关闭', 'AGENT_CLOSING', { retryable: true });
    }
  }

  function pickNextJob() {
    const keys = Array.from(workspaceQueues.keys());
    if (!keys.length) return null;
    const lastIndex = lastScheduledWorkspaceKey === null ? -1 : keys.indexOf(lastScheduledWorkspaceKey);
    const startIndex = lastIndex >= 0 ? lastIndex : -1;
    for (let offset = 1; offset <= keys.length; offset += 1) {
      const index = (startIndex + offset) % keys.length;
      const key = keys[index];
      const queue = workspaceQueues.get(key);
      const state = getWorkspaceState(key);
      if (!queue?.length) {
        workspaceQueues.delete(key);
        continue;
      }
      if (state.active >= limits.workspaceActive) continue;
      const job = queue.shift();
      if (!queue.length) workspaceQueues.delete(key);
      state.queued = Math.max(0, state.queued - 1);
      lastScheduledWorkspaceKey = key;
      return job;
    }
    return null;
  }

  async function runJob(job) {
    const state = getWorkspaceState(job.workspaceKey);
    state.active += 1;
    activeCount += 1;
    job.running = true;
    setPhase(job, 'running');
    try {
      assertJobAvailable(job);
      const result = await job.runner({
        signal: job.controller.signal,
        setPhase: (phase) => setPhase(job, phase),
      });
      if (job.controller.signal.aborted && job.phase !== 'applying') {
        throw job.controller.signal.reason || createCancelledError();
      }
      setPhase(job, 'cleanup');
      state.cleanup += 1;
      finalizeJob(job, null, result);
    } catch (error) {
      const normalized = normalizeCancellation(job, error?.code === 'AGENT_ABORTED' ? createCancelledError() : error);
      setPhase(job, 'cleanup');
      state.cleanup += 1;
      finalizeJob(job, normalized);
    } finally {
      state.cleanup = Math.max(0, state.cleanup - 1);
      state.active = Math.max(0, state.active - 1);
      activeCount = Math.max(0, activeCount - 1);
      job.running = false;
      job.finish();
      clearWorkspaceStateIfIdle(job.workspaceKey);
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
    if (job.phase === 'queued' || job.phase === 'reserved') {
      finalizeJob(job, reason);
      return true;
    }
    if (job.phase === 'admitting') {
      job.controller.abort(reason);
      return true;
    }
    if (job.phase === 'applying' || job.phase === 'cleanup') return false;
    job.controller.abort(reason);
    return true;
  }

  function getJobSnapshot(job) {
    return {
      workspaceId: job.workspaceId,
      workspaceGeneration: job.workspaceGeneration,
      executionId: job.executionId,
      phase: job.phase,
      deadlineAt: job.deadlineAt,
      envelope: job.envelope,
    };
  }

  function reserve(input = {}) {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const workspaceGeneration = ensureWorkspaceGeneration(workspaceId, input.workspaceGeneration);
    const currentWorkspaceKey = workspaceKey(workspaceId, workspaceGeneration);
    const executionId = normalizeExecutionId(input.executionId);
    const envelope = stableEnvelope(input.envelope);
    if (!isWorkspaceAvailable(workspaceId, workspaceGeneration)) {
      throw createAgentError('Agent 调度器正在关闭', 'AGENT_CLOSING', { retryable: true });
    }
    const key = jobKey(workspaceId, workspaceGeneration, executionId);
    const existing = jobs.get(key);
    if (existing) {
      if (!isSameEnvelope(existing.envelope, envelope)) {
        throw createAgentError('相同 executionId 的 Agent envelope 不一致', 'AGENT_EXECUTION_CONFLICT');
      }
      return existing.reservation;
    }
    const state = getWorkspaceState(currentWorkspaceKey);
    if (state.reserved + state.admitting + state.queued >= limits.workspaceQueued || pendingAdmissionCount() >= limits.globalQueued) {
      throw createQueueOverloadedError(limits.retryAfterSeconds);
    }
    const deadlineAt = Number.isFinite(Number(input.deadlineAt)) ? Number(input.deadlineAt) : Date.now() + 120_000;
    if (deadlineAt <= Date.now()) throw createAgentError('Agent 执行已超时', 'AGENT_TIMEOUT', { retryable: true });
    const job = {
      key,
      workspaceId,
      workspaceGeneration,
      workspaceKey: currentWorkspaceKey,
      executionId,
      envelope,
      deadlineAt,
      phase: 'reserved',
      controller: new AbortController(),
      runner: null,
      settled: false,
      terminalError: null,
      resolve: null,
      reject: null,
      deadlineTimer: null,
      reservation: null,
      running: false,
      preparing: false,
      prepared: false,
      preparation: null,
      finish: null,
    };
    job.completion = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    void job.completion.catch(() => undefined);
    job.finished = new Promise((resolve) => { job.finish = resolve; });
    jobs.set(key, job);
    state.reserved += 1;
    const delay = Math.max(1, deadlineAt - Date.now());
    job.deadlineTimer = setTimeout(() => cancelJob(job, createAgentError('Agent 执行超时', 'AGENT_TIMEOUT', { retryable: true })), delay);
    job.deadlineTimer.unref?.();

    function queueRunner(runner) {
      if (job.settled) return job.completion;
      try {
        assertJobAvailable(job);
      } catch (error) {
        finalizeJob(job, error);
        return job.completion;
      }
      if (job.phase !== 'reserved' && job.phase !== 'admitting') return job.completion;
      if (typeof runner !== 'function') {
        finalizeJob(job, createAgentError('Agent runner 必须是函数', 'AGENT_TASK_SPEC_INVALID'));
        return job.completion;
      }
      const currentState = getWorkspaceState(currentWorkspaceKey);
      if (job.phase === 'reserved') {
        currentState.reserved = Math.max(0, currentState.reserved - 1);
        currentState.admitting += 1;
        setPhase(job, 'admitting');
      }
      job.runner = runner;
      try {
        assertJobAvailable(job);
      } catch (error) {
        finalizeJob(job, error);
        return job.completion;
      }
      currentState.admitting = Math.max(0, currentState.admitting - 1);
      currentState.queued += 1;
      setPhase(job, 'queued');
      if (!workspaceQueues.has(currentWorkspaceKey)) workspaceQueues.set(currentWorkspaceKey, []);
      workspaceQueues.get(currentWorkspaceKey).push(job);
      pump();
      return job.completion;
    }

    job.reservation = Object.freeze({
      workspaceId,
      workspaceGeneration,
      executionId,
      completion: job.completion,
      getSnapshot: () => getJobSnapshot(job),
      assertActive: () => assertJobAvailable(job),
      cancel: (reason) => cancelJob(job, reason || createCancelledError()),
      prepare(preparer) {
        if (job.preparation) return job.preparation;
        if (job.settled) return Promise.reject(job.terminalError || createCancelledError());
        if (typeof preparer !== 'function') {
          const error = createAgentError('Agent preparation 必须是函数', 'AGENT_TASK_SPEC_INVALID');
          finalizeJob(job, error);
          return Promise.reject(error);
        }
        const currentState = getWorkspaceState(currentWorkspaceKey);
        currentState.reserved = Math.max(0, currentState.reserved - 1);
        currentState.admitting += 1;
        setPhase(job, 'admitting');
        job.preparing = true;
        job.preparation = Promise.resolve().then(async () => {
          assertJobAvailable(job);
          const value = await preparer({ signal: job.controller.signal, assertActive: () => assertJobAvailable(job) });
          assertJobAvailable(job);
          job.prepared = true;
          return value;
        }).catch((error) => {
          const normalized = normalizeCancellation(job, error);
          finalizeJob(job, normalized);
          throw normalized;
        }).finally(() => {
          job.preparing = false;
        });
        return job.preparation;
      },
      admit(runner) {
        if (job.preparation && !job.prepared) {
          return job.preparation.then(() => queueRunner(runner));
        }
        return queueRunner(runner);
      },
    });
    return job.reservation;
  }

  function registerWorkspace(workspaceId) {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    if (closing) throw createAgentError('Agent 调度器正在关闭', 'AGENT_CLOSING', { retryable: true });
    if (activeWorkspaceGenerations.has(normalizedWorkspaceId)) {
      throw createAgentError('Agent workspace 已有活动 Runtime', 'AGENT_CLOSING', { retryable: true });
    }
    const generation = (workspaceGenerationCounters.get(normalizedWorkspaceId) || 0) + 1;
    workspaceGenerationCounters.set(normalizedWorkspaceId, generation);
    activeWorkspaceGenerations.set(normalizedWorkspaceId, generation);
    return Object.freeze({
      workspaceId: normalizedWorkspaceId,
      generation,
      close: (options) => closeWorkspace(normalizedWorkspaceId, { ...options, generation }),
      getSnapshot: () => getWorkspaceSnapshot(normalizedWorkspaceId, generation),
    });
  }

  function getWorkspaceSnapshot(workspaceId, generation) {
    const normalizedWorkspaceId = String(workspaceId || '').trim();
    const currentGeneration = generation || activeWorkspaceGenerations.get(normalizedWorkspaceId);
    if (!normalizedWorkspaceId || !currentGeneration) return { reserved: 0, admitting: 0, active: 0, queued: 0, cleanup: 0 };
    const state = workspaceState.get(workspaceKey(normalizedWorkspaceId, currentGeneration));
    return state ? { ...state } : { reserved: 0, admitting: 0, active: 0, queued: 0, cleanup: 0 };
  }

  function getStatus() {
    return { closing, active: activeCount, queued: queuedCount(), reservations: pendingAdmissionCount() - queuedCount(), limits };
  }

  function cancelWorkspace(workspaceId, reason = createCancelledError(), { generation } = {}) {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const targetGeneration = generation || activeWorkspaceGenerations.get(normalizedWorkspaceId);
    if (!targetGeneration) return 0;
    let cancelled = 0;
    for (const job of Array.from(jobs.values())) {
      if (job.workspaceId === normalizedWorkspaceId && job.workspaceGeneration === targetGeneration && cancelJob(job, reason)) cancelled += 1;
    }
    return cancelled;
  }

  async function waitForWorkspaceSettled(workspaceId, generation, timeoutMs) {
    const deadlineAt = Date.now() + timeoutMs;
    while (true) {
      const pending = Array.from(jobs.values())
        .filter((job) => job.workspaceId === workspaceId && job.workspaceGeneration === generation)
        .map((job) => job.finished);
      if (!pending.length) return;
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) throw createAgentError('Agent workspace 关闭超时', 'AGENT_SHUTDOWN_TIMEOUT', { retryable: true });
      await Promise.race([
        Promise.allSettled(pending),
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(createAgentError('Agent workspace 关闭超时', 'AGENT_SHUTDOWN_TIMEOUT', { retryable: true })), remainingMs);
          timer.unref?.();
        }),
      ]);
    }
  }

  function closeWorkspace(workspaceId, { timeoutMs = 5_000, generation } = {}) {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const targetGeneration = generation || activeWorkspaceGenerations.get(normalizedWorkspaceId);
    if (!targetGeneration) return Promise.resolve();
    const targetKey = workspaceKey(normalizedWorkspaceId, targetGeneration);
    const existing = workspaceClosePromises.get(targetKey);
    if (existing) return existing;
    closingWorkspaceKeys.add(targetKey);
    cancelWorkspace(normalizedWorkspaceId, createAgentError('Agent workspace 正在关闭', 'AGENT_CLOSING', { retryable: true }), { generation: targetGeneration });
    const attempt = waitForWorkspaceSettled(normalizedWorkspaceId, targetGeneration, timeoutMs);
    workspaceClosePromises.set(targetKey, attempt);
    void attempt.then(() => {
      if (activeWorkspaceGenerations.get(normalizedWorkspaceId) === targetGeneration) activeWorkspaceGenerations.delete(normalizedWorkspaceId);
      closingWorkspaceKeys.delete(targetKey);
    }).finally(() => {
      workspaceClosePromises.delete(targetKey);
    }).catch(() => undefined);
    return attempt;
  }

  function beginClosing(reason = createAgentError('Agent 调度器正在关闭', 'AGENT_CLOSING', { retryable: true })) {
    closing = true;
    for (const job of Array.from(jobs.values())) cancelJob(job, reason);
  }

  function close({ timeoutMs = 30_000 } = {}) {
    if (closePromise) return closePromise;
    beginClosing();
    const pending = Array.from(jobs.values()).map((job) => job.finished);
    closePromise = Promise.race([
      Promise.allSettled(pending),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(createAgentError('Agent 调度器关闭超时', 'AGENT_SHUTDOWN_TIMEOUT', { retryable: true })), timeoutMs);
        timer.unref?.();
      }),
    ]);
    return closePromise;
  }

  return { beginClosing, cancelWorkspace, closeWorkspace, close, getStatus, getWorkspaceSnapshot, registerWorkspace, reserve };
}

module.exports = { DEFAULT_LIMITS, createAgentCoordinator, createAgentError };
