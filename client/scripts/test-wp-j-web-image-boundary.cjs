const assert = require('node:assert/strict');
const { runStaticChecks, printResult } = require('./wp-j-ops-utils.cjs');

const checks = runStaticChecks();
const failures = checks.filter((check) => check.status === 'fail');
assert.deepEqual(failures, [], `WP-J Web/Runner image boundary failed: ${JSON.stringify(failures)}`);
printResult({ status: 'ok', check: 'web_image_boundary', checks });
