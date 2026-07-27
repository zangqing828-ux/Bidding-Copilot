const INTERNAL_TASK_STATUSES = Object.freeze([
  'idle',
  'accepted',
  'queued',
  'running',
  'pausing',
  'paused',
  'validating',
  'committing',
  'success',
  'error',
  'cancelled',
  'interrupted',
]);

const TECHNICAL_PLAN_GROUP_LOCK_ACTIVE = Object.freeze([
  'accepted',
  'queued',
  'running',
  'pausing',
  'paused',
  'validating',
  'committing',
]);

const TECHNICAL_PLAN_RENDERER_PHASES = Object.freeze({
  accepted: 'accepted',
  queued: 'queued',
  validating: 'validating',
  committing: 'committing',
});

const TECHNICAL_PLAN_RENDERER_STATUS_MAP = Object.freeze({
  accepted: 'running',
  queued: 'running',
  running: 'running',
  pausing: 'pausing',
  paused: 'paused',
  validating: 'running',
  committing: 'running',
  success: 'success',
  error: 'error',
  cancelled: 'error',
  interrupted: 'error',
});

function createProjectionError(message) {
  const error = new Error(message);
  error.code = 'STATE_PROJECTION_INVALID';
  return error;
}

function isKnownStatus(status) {
  return INTERNAL_TASK_STATUSES.includes(status);
}

function isGroupLocked(status) {
  if (!isKnownStatus(status)) {
    return false;
  }
  return TECHNICAL_PLAN_GROUP_LOCK_ACTIVE.includes(status);
}

function projectTechnicalPlanTaskState(status) {
  if (!isKnownStatus(status)) {
    throw createProjectionError(`未知任务状态：${String(status || '')}`);
  }
  if (status === 'idle') {
    return null;
  }
  const projected = {
    status: TECHNICAL_PLAN_RENDERER_STATUS_MAP[status],
  };
  if (!projected.status) {
    throw createProjectionError(`任务状态不可映射到渲染态：${status}`);
  }
  const phase = TECHNICAL_PLAN_RENDERER_PHASES[status];
  if (phase) {
    projected.stats = { phase };
  }
  return Object.freeze({
    ...projected,
    ...(isGroupLocked(status) ? { groupLocked: true } : {}),
  });
}

module.exports = {
  INTERNAL_TASK_STATUSES: Array.from(INTERNAL_TASK_STATUSES),
  TECHNICAL_PLAN_GROUP_LOCK_ACTIVE,
  TECHNICAL_PLAN_RENDERER_PHASES,
  TECHNICAL_PLAN_RENDERER_STATUS_MAP,
  isGroupLocked,
  projectTechnicalPlanTaskState,
};
