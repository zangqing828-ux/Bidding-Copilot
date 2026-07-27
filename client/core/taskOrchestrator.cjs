// Portable task lifecycle kernel.
// accepted: persist running -> register controller -> attach runner -> return task
// cleanup: runner settles -> release queue scope -> remove active task/controller
function createTaskOrchestrator({
  definitions,
  createTask,
  getScopeId,
  getPayloadSignature = () => undefined,
  stateAdapter,
  createRunnerContext,
  releaseRunnerContext = () => {},
}) {
  if (!definitions || typeof definitions !== 'object') throw new Error('Task Orchestrator 缺少 definitions');
  if (typeof createTask !== 'function') throw new Error('Task Orchestrator 缺少 createTask');
  if (!stateAdapter || typeof stateAdapter !== 'object') throw new Error('Task Orchestrator 缺少 stateAdapter');
  if (typeof stateAdapter.persist !== 'function' || typeof stateAdapter.load !== 'function' || typeof stateAdapter.snapshot !== 'function') {
    throw new Error('Task Orchestrator stateAdapter 不完整');
  }
  if (typeof createRunnerContext !== 'function') throw new Error('Task Orchestrator 缺少 createRunnerContext');

  const activeTasks = new Map();
  const activeTaskControls = new Map();
  const subscribers = new Set();
  const pendingPersists = new Set();

  function trackPersist(value) {
    if (!value || typeof value.then !== 'function') return value;
    const tracked = Promise.resolve(value).finally(() => {
      pendingPersists.delete(tracked);
    });
    pendingPersists.add(tracked);
    return tracked;
  }

  function createTaskConflictError(definition) {
    const error = new Error(`当前${definition.groupLabel || '任务组'}正在执行“${definition.label || '任务'}”，请等待当前任务完成后再重新分析新的文件集合。`);
    error.code = 'TASK_CONFLICT';
    error.retryable = true;
    return error;
  }

  function definitionFor(type) {
    return definitions[type] || { label: type, stateKey: 'technicalPlan', field: undefined, lockPolicy: 'none' };
  }

  function isActive(task) {
    return task?.status === 'running' || task?.status === 'pausing';
  }

  function emit(task, snapshot) {
    const event = { task, ...snapshot };
    for (const subscriber of subscribers) subscriber(event);
  }

  function snapshotFor(task) {
    const definition = definitionFor(task.type);
    return stateAdapter.snapshot(definition, stateAdapter.load(definition), task);
  }

  function subscribe(callback) {
    if (typeof callback !== 'function') throw new Error('Task Orchestrator subscribe 需要 callback');
    subscribers.add(callback);
    try {
      for (const task of activeTasks.values()) callback({ task, ...snapshotFor(task) });
    } catch (error) {
      subscribers.delete(callback);
      throw error;
    }
    return () => subscribers.delete(callback);
  }

  function getConflict(type, payload) {
    const definition = definitionFor(type);
    if (definition.lockPolicy === 'none' || !definition.group) return null;
    const nextScopeId = getScopeId(payload);
    for (const task of activeTasks.values()) {
      if (!isActive(task) || task.type === type) continue;
      const activeDefinition = definitionFor(task.type);
      if (activeDefinition.group !== definition.group) continue;
      if (definition.lockPolicy === 'group-exclusive' || activeDefinition.lockPolicy === 'group-exclusive') {
        return { task, definition: activeDefinition };
      }
      if (definition.lockPolicy === 'scope-exclusive' && nextScopeId && task.scope_id === nextScopeId) {
        return { task, definition: activeDefinition };
      }
    }
    return null;
  }

  function assertCanStart(type, payload) {
    if (typeof stateAdapter.assertCanStart === 'function') stateAdapter.assertCanStart(type, payload, activeTasks);
    const conflict = getConflict(type, payload);
    if (!conflict) return;
    const definition = definitionFor(type);
    throw new Error(`当前${definition.groupLabel || '任务组'}正在执行“${conflict.definition.label || conflict.task.type}”，请完成后再启动“${definition.label || type}”。`);
  }

  function start({ type, payload, runner, initialPartial = {}, taskMetadata }) {
    if (typeof runner !== 'function') throw new Error(`${type} 缺少 task runner`);
    const existingTask = activeTasks.get(type);
    if (existingTask && isActive(existingTask)) {
      const nextPayloadSignature = getPayloadSignature(type, payload);
      if (existingTask.payload_signature && nextPayloadSignature && existingTask.payload_signature !== nextPayloadSignature) {
        const definition = definitionFor(type);
        throw createTaskConflictError(definition);
      }
      emit(existingTask, snapshotFor(existingTask));
      return existingTask;
    }

    assertCanStart(type, payload);
    const definition = definitionFor(type);
    const task = createTask(type, payload, taskMetadata);
    const queueScopeId = `${type}:${task.task_id}`;
    activeTasks.set(type, task);
    let currentTask = task;
    const taskControl = {
      queueScopeId,
      pauseRequested: false,
      abortController: new AbortController(),
      isPauseRequested() { return this.pauseRequested; },
      cancel(reason) {
        if (!this.abortController.signal.aborted) {
          this.abortController.abort(reason);
        }
      },
      requestPause() {
        this.pauseRequested = true;
        const logs = currentTask.logs?.length ? currentTask.logs : ['已请求暂停，正在等待当前 AI 请求完成。'];
        const pausingTask = updateTask({ status: 'pausing', pause_requested: true, logs });
        const state = trackPersist(stateAdapter.persist(definition, { [definition.field]: pausingTask }));
        if (state && typeof state.then === 'function') {
          void state.then((persistedState) => {
            emit(pausingTask, stateAdapter.snapshot(definition, persistedState, pausingTask));
          }).catch(() => undefined);
        } else {
          emit(pausingTask, stateAdapter.snapshot(definition, state, pausingTask));
        }
        return pausingTask;
      },
    };
    activeTaskControls.set(type, taskControl);

    const updateTask = (partial, workspaceState, eventPatch, options = {}) => {
      const nextStatus = currentTask.status === 'pausing' && partial.status === 'running' ? 'pausing' : partial.status || currentTask.status;
      currentTask = {
        ...currentTask,
        ...partial,
        status: nextStatus,
        pause_requested: partial.pause_requested === false ? false : taskControl.pauseRequested || partial.pause_requested,
        logs: partial.logs || currentTask.logs,
        updated_at: new Date().toISOString(),
      };
      activeTasks.set(type, currentTask);
      if (workspaceState) {
        let persistedState = workspaceState;
        if (definition.field) {
          persistedState = trackPersist(stateAdapter.persist(definition, { [definition.field]: currentTask }, options));
        }
        if (persistedState && typeof persistedState.then === 'function') {
          const emittedTask = currentTask;
          void persistedState.then((nextState) => {
            emit(emittedTask, stateAdapter.snapshot(definition, nextState, emittedTask, eventPatch));
          }).catch(() => undefined);
        } else {
          emit(currentTask, stateAdapter.snapshot(definition, persistedState, currentTask, eventPatch));
        }
      }
      return currentTask;
    };

    const previousState = stateAdapter.load(definition) || {};
    const attachRunner = (acceptedState) => {
      emit(currentTask, stateAdapter.snapshot(definition, acceptedState, currentTask));
      const runnerContext = createRunnerContext({
        definition,
        type,
        payload,
        queueScopeId,
        updateTask,
        taskControl,
        signal: taskControl.abortController.signal,
        previousState,
        taskMetadata,
        emitTask(task, workspaceState, eventPatch) {
          emit(task, stateAdapter.snapshot(definition, workspaceState, task, eventPatch));
        },
      });

      let runnerPromise;
      try {
        runnerPromise = Promise.resolve(runner(runnerContext));
      } catch (error) {
        runnerPromise = Promise.reject(error);
      }
      const settledPromise = runnerPromise.catch((error) => {
        const failedTask = updateTask({
          status: 'error',
          error: error?.message || '任务执行失败',
          error_code: error?.code,
          retryable: error?.retryable === true,
        });
        if (typeof stateAdapter.persistFailure === 'function') {
          return Promise.resolve(stateAdapter.persistFailure(definition, failedTask, error))
            .then((failedState) => emit(failedTask, stateAdapter.snapshot(definition, failedState, failedTask)));
        }
        if (error?.code === 'TASK_INPUT_CHANGED') {
          emit(failedTask, snapshotFor(failedTask));
          return;
        }
        return Promise.resolve(stateAdapter.persist(definition, { [definition.field]: failedTask }))
          .then((failedState) => emit(failedTask, stateAdapter.snapshot(definition, failedState, failedTask)));
      }).finally(() => {
        releaseRunnerContext(runnerContext);
        activeTasks.delete(type);
        activeTaskControls.delete(type);
      });
      taskControl.runnerPromise = settledPromise;
      void settledPromise.catch(() => undefined);
      return currentTask;
    };

    let acceptedState;
    try {
      acceptedState = stateAdapter.persist(definition, { ...initialPartial, [definition.field]: currentTask });
    } catch (error) {
      activeTasks.delete(type);
      activeTaskControls.delete(type);
      throw error;
    }
    if (acceptedState && typeof acceptedState.then === 'function') {
      return acceptedState.then(attachRunner, (error) => {
        activeTasks.delete(type);
        activeTaskControls.delete(type);
        throw error;
      });
    }
    return attachRunner(acceptedState);
  }

  async function close({ reason } = {}) {
    const controls = Array.from(activeTaskControls.values());
    controls.forEach((control) => control.cancel(reason));
    await Promise.allSettled(controls.map((control) => control.runnerPromise).filter(Boolean));
    await Promise.allSettled(Array.from(pendingPersists));
  }

  return Object.freeze({
    activeTaskControls,
    activeTasks,
    emit,
    close,
    getActiveTasks: () => Array.from(activeTasks.values()),
    start,
    subscribe,
    unsubscribe: (callback) => subscribers.delete(callback),
  });
}

module.exports = { createTaskOrchestrator };
