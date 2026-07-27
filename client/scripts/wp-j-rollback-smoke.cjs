const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, printResult } = require('./wp-j-ops-utils.cjs');

const checks = [];
function verify(name, condition, message) {
  assert.equal(condition, true, message);
  checks.push({ name, status: 'ok' });
}

try {
  const compose = fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8');
  const rollback = fs.readFileSync(path.join(REPO_ROOT, 'docs/runbooks/wp-j-rollback.md'), 'utf8');
  const deployment = fs.readFileSync(path.join(REPO_ROOT, 'docs/web-deployment.md'), 'utf8');
  verify('persistent_web_volume', /web-data:/.test(compose), 'Web 持久化卷缺失');
  verify('rollback_backup', /备份|backup/i.test(rollback), '回滚手册缺少备份步骤');
  verify('rollback_schema_guard', /schema|版本|迁移/i.test(rollback), '回滚手册缺少 schema 兼容性说明');
  verify('deployment_rollback_reference', /回滚/.test(deployment), '部署指南缺少回滚入口');
  printResult({ status: 'ok', check: 'rollback_smoke', checks, mode: 'static' });
} catch (error) {
  printResult({ status: 'fail', check: 'rollback_smoke', message: error?.message || 'rollback smoke failed', checks });
  process.exitCode = 1;
}
