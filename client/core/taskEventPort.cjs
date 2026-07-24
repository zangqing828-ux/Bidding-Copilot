const { assertPort } = require('./ports.cjs');

function createTaskEventPort(taskService) {
  if (!taskService || typeof taskService.subscribeCallback !== 'function') {
    throw new Error('taskEvents 需要 taskService.subscribeCallback');
  }

  const records = new Set();
  let closed = false;

  function createRecord(callback) {
    return {
      callback,
      closed: false,
      taskServiceUnsubscribe: null,
    };
  }

  function mergeCleanupError(primary, cleanupErrors, message) {
    if (!cleanupErrors.length) {
      throw primary;
    }
    throw new AggregateError(
      [primary, ...cleanupErrors],
      message,
      { cause: primary },
    );
  }

  function releaseRecord(record) {
    if (!record || record.closed) {
      return [];
    }

    const errors = [];
    const unsubscribeFn = record.taskServiceUnsubscribe;

    if (typeof unsubscribeFn === 'function') {
      try {
        unsubscribeFn();
      } catch (error) {
        errors.push(error);
      }
    } else if (typeof taskService.unsubscribeCallback === 'function') {
      try {
        taskService.unsubscribeCallback(record.callback);
      } catch (error) {
        errors.push(error);
      }
    } else {
      errors.push(new Error('taskEvents 清理失败：taskService 缺少取消订阅接口'));
    }

    if (!errors.length) {
      record.closed = true;
      records.delete(record);
    }

    return errors;
  }

  function subscribe(callback) {
    if (closed) {
      return () => {};
    }

    if (typeof callback !== 'function') {
      throw new Error('taskEvents.subscribe 需要函数 callback');
    }

    const wrappedCallback = (event) => callback(event);
    const record = createRecord(wrappedCallback);
    records.add(record);

    let taskServiceUnsubscribe;
    try {
      taskServiceUnsubscribe = taskService.subscribeCallback(wrappedCallback);
    } catch (error) {
      const cleanupErrors = releaseRecord(record);
      mergeCleanupError(error, cleanupErrors, 'taskEvents.subscribe 订阅失败');
    }

    if (typeof taskServiceUnsubscribe !== 'function') {
      const cleanupErrors = releaseRecord(record);
      mergeCleanupError(new Error('taskEvents.subscribeCallback 未返回取消订阅函数'), cleanupErrors, 'taskEvents.subscribeCallback 未返回取消订阅函数');
    }

    record.taskServiceUnsubscribe = taskServiceUnsubscribe;

    if (closed) {
      const cleanupErrors = releaseRecord(record);
      if (cleanupErrors.length > 0) {
        return () => {};
      }
      return () => {};
    }

    const unsubscribe = () => {
      const errors = releaseRecord(record);
      if (!errors.length) {
        return;
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      throw new AggregateError(
        errors,
        `taskEvents.unsubscribe 取消订阅失败 (${errors.length} 个错误)`,
        { cause: errors[0] },
      );
    };

    return unsubscribe;
  }

  function close() {
    if (closed) {
      return;
    }

    const errors = [];
    for (const record of Array.from(records)) {
      const releaseErrors = releaseRecord(record);
      for (const releaseError of releaseErrors) {
        errors.push(releaseError);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `taskEvents.close 关闭失败 (${errors.length} 个订阅释放异常)`,
        { cause: errors[0] },
      );
    }

    closed = true;
  }

  return assertPort('taskEvents', {
    subscribe,
    close,
  });
}

module.exports = {
  createTaskEventPort,
};
