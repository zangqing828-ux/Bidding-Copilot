const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readExpectedChecksum, verifyChecksum } = require('./prepare-opencode-binary.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bidmaster-opencode-checksum-'));
const archivePath = path.join(tmpDir, 'opencode.zip');

try {
  fs.writeFileSync(archivePath, 'verified OpenCode archive');
  const expected = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
  assert.equal(verifyChecksum(archivePath, expected), expected);
  assert.throws(() => verifyChecksum(archivePath, '0'.repeat(64)), /checksum 校验失败/);
  assert.match(readExpectedChecksum('v1.17.8', 'opencode-linux-x64.tar.gz'), /^[0-9a-f]{64}$/);
  console.log('OpenCode checksum 测试：3 通过，0 失败');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
