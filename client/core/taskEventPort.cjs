const { assertPort } = require('./ports.cjs');

function createTaskEventPort(taskService) {
  if (!taskService || typeof taskService.subscribeCallback !== 'function') {
    throw new Error('taskEvents 需要 taskService.subscribeCallback');
  }

  const records = new Set();
  let closed = false;

  function unsubscribeRecord(record) {
    if (record.closed) {
      return;
    }
    record.closed = true;
    records.delete(record);
    return record.taskServiceUnsubscribe();
  }

  function subscribe(callback) {
    if (closed) {
      return () => {};
    }
    if (typeof callback !== 'function') {
      throw new Error('taskEvents.subscribe 需要函数 callback');
    }

    const wrappedCallback = (event) => callback(event);
    const taskServiceUnsubscribe = taskService.subscribeCallback(wrappedCallback);
    if (typeof taskServiceUnsubscribe !== 'function') {
      throw new Error('taskEvents.subscribeCallback 未返回取消订阅函数');
    }

    const record = {
      closed: false,
      taskServiceUnsubscribe,
    };
    records.add(record);

    const unsubscribe = () => {
      unsubscribeRecord(record);
    };
    record.unsubscribe = unsubscribe;

    if (closed) {
      unsubscribe();
      return () => {};
    }

    return unsubscribe;
  }

  function close() {
    if (closed) {
      return;
    }
    closed = true;

    const errors = [];
    for (const record of Array.from(records)) {
      try {
        unsubscribeRecord(record);
      } catch (error) {
        errors.push(error);
      }
    }

    records.clear();

    if (errors.length) {
      const aggregateError = new AggregateError(
        errors,
        `taskEvents.close 关闭失败: ${errors.length} 个订阅释放异常`,
      );
      aggregateError.name = 'AggregateError';
      throw aggregateError;
    }
  }

  return assertPort('taskEvents', {
    subscribe,
    close,
  });
}

module.exports = {
  createTaskEventPort,
};
