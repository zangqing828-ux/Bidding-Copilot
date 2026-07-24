const path = require('node:path');
const { spawnSync } = require('node:child_process');

const result = spawnSync(process.execPath, [path.join(__dirname, 'test-web-contract.cjs'), '--strict'], {
  stdio: 'inherit',
  env: {
    ...process.env,
  },
  cwd: path.join(__dirname, '..'),
});

if (result.status === 0) {
  console.error('strict-guard 失败：当前合同存在 pending 也不应返回失败');
  process.exit(1);
}

if (result.error) {
  console.error('strict-guard 执行异常:', result.error.message);
  process.exit(1);
}

console.log('strict-guard 通过：--strict 因 pending 返回非零');
process.exit(0);
