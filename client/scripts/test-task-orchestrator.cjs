const assert = require('node:assert/strict');
const { createTaskOrchestrator } = require('../core/taskOrchestrator.cjs');

let sequence = 0;
let state = {};
const events = [];
const definition = { label: '测试任务', group: 'test', groupLabel: '测试', lockPolicy: 'group-exclusive', stateKey: 'test', field: 'task' };
let release;
const orchestrator = createTaskOrchestrator({
  definitions: { alpha: definition, beta: { ...definition, label: '第二任务' } },
  createTask: (type) => ({ task_id: `task-${++sequence}`, type, status: 'running', progress: 0, logs: [] }),
  getScopeId: () => '',
  stateAdapter: {
    load: () => state,
    persist: (_definition, patch) => { state = { ...state, ...patch }; return state; },
    snapshot: (_definition, currentState, task) => ({ testState: currentState, taskId: task.task_id }),
  },
  createRunnerContext: ({ updateTask, taskControl }) => ({ updateTask, taskControl }),
  releaseRunnerContext: () => {},
});

const unsubscribe = orchestrator.subscribe((event) => events.push(event));
const task = orchestrator.start({
  type: 'alpha',
  payload: {},
  runner: async ({ updateTask }) => {
    updateTask({ progress: 50 }, state);
    await new Promise((resolve) => { release = resolve; });
    updateTask({ status: 'success', progress: 100 }, state);
  },
});
assert.equal(state.task.task_id, task.task_id, 'accepted 前已持久化 running task');
assert.strictEqual(orchestrator.start({ type: 'alpha', payload: {}, runner: () => {} }), task, '同类型重复启动复用 active task');
assert.throws(() => orchestrator.start({ type: 'beta', payload: {}, runner: () => {} }), /测试正在执行/, '任务组冲突被拒绝');
assert.ok(events.some((event) => event.taskId === task.task_id), '状态提交后才投影订阅快照');
release();

setImmediate(() => setImmediate(() => {
  assert.equal(orchestrator.getActiveTasks().length, 0, 'runner 完成后释放 task controller');
  unsubscribe();
  console.log('Portable Task Orchestrator 测试通过');
}));
