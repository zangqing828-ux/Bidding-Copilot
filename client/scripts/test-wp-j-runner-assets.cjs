const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyChecksum } = require('./prepare-agent-runner-assets.cjs');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'agent-runner-assets.json'), 'utf8'));
assert.equal(manifest.opencodeVersion, 'v1.17.8');
for (const [architecture, assets] of Object.entries(manifest.architectures || {})) {
  assert.ok(['amd64', 'arm64'].includes(architecture));
  for (const [command, descriptor] of Object.entries(assets)) {
    assert.ok(descriptor.url.startsWith('https://github.com/'), `${command} URL 必须固定到 GitHub HTTPS`);
    assert.match(descriptor.sha256, /^[0-9a-f]{64}$/, `${architecture}/${command} 缺少 SHA-256`);
    assert.ok(descriptor.fileName);
    assert.ok(descriptor.binary);
  }
}
assert.match(fs.readFileSync(path.join(__dirname, 'prepare-agent-runner-assets.cjs'), 'utf8'), /verifyChecksum/);
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bidmaster-wp-j-runner-assets-'));
const fixturePath = path.join(fixtureDir, 'fixture.bin');
fs.writeFileSync(fixturePath, 'checksum-fixture');
assert.throws(
  () => verifyChecksum(fixturePath, '0'.repeat(64), 'fixture'),
  /checksum 校验失败/,
  '错误 checksum 必须 fail closed',
);
fs.rmSync(fixtureDir, { recursive: true, force: true });
console.log('PASS: WP-J fixed Runner assets manifest and checksum preparation');
