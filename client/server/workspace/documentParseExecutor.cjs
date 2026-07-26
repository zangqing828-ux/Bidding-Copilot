const path = require('node:path');
const { Worker } = require('node:worker_threads');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function createParseError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseDocumentInWorker(filePath, config, { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  if (signal?.aborted) return Promise.reject(createParseError('DOCUMENT_PARSE_ABORTED', '文件解析已取消'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'documentParseWorker.cjs'), {
      workerData: { filePath, config, timeoutMs },
    });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      void worker.terminate().catch(() => undefined);
      callback(value);
    };
    const onAbort = () => finish(reject, createParseError('DOCUMENT_PARSE_ABORTED', '文件解析已取消'));
    const timer = setTimeout(
      () => finish(reject, createParseError('DOCUMENT_PARSE_TIMEOUT', '文件解析超时，请稍后重试')),
      timeoutMs + 1_000,
    );
    timer.unref?.();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    worker.once('message', (message) => {
      if (message?.ok) {
        finish(resolve, message.result);
        return;
      }
      finish(reject, createParseError(message?.error?.code || 'DOCUMENT_PARSE_FAILED', message?.error?.message || '文件解析失败'));
    });
    worker.once('error', (error) => finish(reject, createParseError('DOCUMENT_PARSE_FAILED', error.message || '文件解析 Worker 失败')));
    worker.once('exit', (code) => {
      if (!settled && code !== 0) finish(reject, createParseError('DOCUMENT_PARSE_FAILED', `文件解析 Worker 异常退出（${code}）`));
    });
  });
}

module.exports = { parseDocumentInWorker };
