const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseDocumentWithConfig } = require('../core/documentParser.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bidmaster-document-parser-'));
const config = { components: { file_parser: { provider: 'local' } } };

async function main() {
  const oversized = path.join(tmpDir, 'oversized.txt');
  fs.writeFileSync(oversized, '');
  fs.truncateSync(oversized, 16 * 1024 * 1024 + 1);
  await assert.rejects(
    parseDocumentWithConfig(oversized, config),
    (error) => error?.code === 'DOCUMENT_RESPONSE_TOO_LARGE',
  );

  const normal = path.join(tmpDir, 'normal.txt');
  fs.writeFileSync(normal, '正常文件', 'utf8');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    parseDocumentWithConfig(normal, config, { signal: controller.signal }),
    (error) => error?.code === 'DOCUMENT_PARSE_ABORTED',
  );
  console.log('文档解析限额测试：2 通过，0 失败');
}

main().finally(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
