const { parentPort, workerData } = require('node:worker_threads');
const { parseDocumentWithConfig } = require('../../core/documentParser.cjs');

void parseDocumentWithConfig(workerData.filePath, workerData.config, {
  timeoutMs: workerData.timeoutMs,
}).then(
  (result) => parentPort.postMessage({ ok: true, result }),
  (error) => parentPort.postMessage({
    ok: false,
    error: {
      code: error?.code || 'DOCUMENT_PARSE_FAILED',
      message: error?.message || '文件解析失败',
    },
  }),
);
