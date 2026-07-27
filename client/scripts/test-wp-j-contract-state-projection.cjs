const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  isGroupLocked,
  projectTechnicalPlanTaskState,
  INTERNAL_TASK_STATUSES,
} = require('../shared/contracts/technical-plan/taskStateProjection.cjs');

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../fixtures/technical-plan-contracts/task-state/projection.sample.json'),
  'utf8',
));

for (const testCase of fixture.cases || []) {
  const projected = projectTechnicalPlanTaskState(testCase.internal_status);
  assert.deepEqual(projected, testCase.renderer, `state projection for ${testCase.internal_status}`);
  if (testCase.renderer === null) {
    assert.equal(isGroupLocked(testCase.internal_status), false, `group lock for ${testCase.internal_status}`);
  } else {
    assert.equal(isGroupLocked(testCase.internal_status), Boolean(testCase.renderer.groupLocked), `group lock for ${testCase.internal_status}`);
  }
}

assert.equal(
  INTERNAL_TASK_STATUSES.includes('accepted') && INTERNAL_TASK_STATUSES.includes('interrupted') && INTERNAL_TASK_STATUSES.includes('idle'),
  true,
  'internal state contract should contain required phases',
);

assert.throws(
  () => projectTechnicalPlanTaskState('unsupported'),
  (error) => error.code === 'STATE_PROJECTION_INVALID',
  '不支持状态应抛错',
);

console.log('WP-J Contracts task state projection tests passed');
