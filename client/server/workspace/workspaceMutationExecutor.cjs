function createUnavailableError() {
  const error = new Error('Workspace 正在关闭，暂不接受新的状态写入');
  error.code = 'WORKSPACE_UNAVAILABLE';
  error.retryable = true;
  return error;
}

// 一个 workspace 内所有业务状态写入共用此队列；队列之外不能写业务 Store。
function createWorkspaceMutationExecutor() {
  let accepting = true;
  let active = 0;
  let queued = 0;
  let tail = Promise.resolve();
  let closePromise = null;

  function execute(operation, { signal } = {}) {
    if (!accepting) {
      return Promise.reject(createUnavailableError());
    }
    if (typeof operation !== 'function') {
      return Promise.reject(new Error('Workspace mutation 必须提供执行函数'));
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason || createUnavailableError());
    }

    queued += 1;
    const mutation = tail.then(async () => {
      queued -= 1;
      if (signal?.aborted) {
        throw signal.reason || createUnavailableError();
      }
      active += 1;
      try {
        return await operation();
      } finally {
        active -= 1;
      }
    });
    tail = mutation.catch(() => undefined);
    return mutation;
  }

  function close() {
    if (closePromise) return closePromise;
    accepting = false;
    closePromise = tail;
    return closePromise;
  }

  return Object.freeze({
    close,
    execute,
    getStatus() {
      return { active, queued, accepting };
    },
  });
}

module.exports = { createWorkspaceMutationExecutor };
