const fs = require('node:fs');
const path = require('node:path');

const { createAiFairCoordinator } = require('../core/aiFairCoordinator.cjs');
const { createAiRequestQueue, AI_QUEUE_SCOPE_PAUSED } = require('../core/aiRequestQueue.cjs');
const { createTextTokenStatsStore } = require('../core/textTokenStatsStore.cjs');

const passed = [];
const failed = [];

function assert(condition, message) {
  if (condition) {
    passed.push(message);
    return;
  }
  failed.push(message);
  console.error(`  FAIL: ${message}`);
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((r, rr) => {
    resolve = r;
    reject = rr;
  });
  return { promise, resolve, reject };
}

function runWithLimitCounter(counterRef, fn, label, delayMs = 10) {
  return async () => {
    counterRef.running += 1;
    counterRef.max = Math.max(counterRef.max, counterRef.running);
    try {
      await wait(delayMs);
      return label;
    } finally {
      counterRef.running -= 1;
    }
  };
}

function assertNoElectronRequires(filePath, content, label) {
  const hasElectronRequire = /\brequire\(\s*['"]electron/.test(content) || /\brequire\(\s*['"]node:electron/.test(content);
  const hasElectronImport = /\bfrom\s+['"]electron/.test(content) || /node:electron/.test(content);
  assert(!hasElectronRequire && !hasElectronImport, label);
}

async function testDefaultLimits() {
  const defaultCoordinator = createAiFairCoordinator();
  const defaultStatus = defaultCoordinator.getStatus();
  assert(defaultStatus.text.limit === 30, '默认协调器 text limit = 30');
  assert(defaultStatus.image.limit === 6, '默认协调器 image limit = 6');

  const configured = createAiFairCoordinator({ textLimit: 3, imageLimit: 1 });
  const configuredStatus = configured.getStatus();
  assert(configuredStatus.text.limit === 3, '配置 coordinator text limit 生效');
  assert(configuredStatus.image.limit === 1, '配置 coordinator image limit 生效');
}

async function testLaneIsolationAndLimits() {
  const coordinator = createAiFairCoordinator({ textLimit: 1, imageLimit: 2 });
  const textCounter = { running: 0, max: 0 };
  const imageCounter = { running: 0, max: 0 };

  const jobs = [
    coordinator.enqueue('text', 'ws-a', runWithLimitCounter(textCounter, null, 'text-a-1', 40)),
    coordinator.enqueue('text', 'ws-a', runWithLimitCounter(textCounter, null, 'text-a-2', 40)),
    coordinator.enqueue('image', 'ws-a', runWithLimitCounter(imageCounter, null, 'image-a-1', 20)),
    coordinator.enqueue('image', 'ws-a', runWithLimitCounter(imageCounter, null, 'image-a-2', 20)),
    coordinator.enqueue('image', 'ws-a', runWithLimitCounter(imageCounter, null, 'image-a-3', 20)),
  ];

  await Promise.all(jobs);
  assert(textCounter.max <= 1, 'text lane 严格受限于 1');
  assert(imageCounter.max <= 2, 'image lane 严格受限于 2');
}

async function testTwoAccountFairness() {
  const coordinator = createAiFairCoordinator({ textLimit: 1 });
  const started = [];
  const firstHold = createDeferred();

  const first = coordinator.enqueue('text', 'A', async () => {
    started.push('A1');
    await firstHold.promise;
    return 'A1';
  });

  const second = coordinator.enqueue('text', 'A', async () => {
    started.push('A2');
    return 'A2';
  });

  await wait(10);
  const third = coordinator.enqueue('text', 'B', async () => {
    started.push('B1');
    return 'B1';
  });

  firstHold.resolve();
  await Promise.all([first, second, third]);

  assert(started[0] === 'A1', 'A1 先启动');
  assert(started[1] === 'B1', 'A 1 还未结束前 B1 先于 A2 执行');
  assert(started[2] === 'A2', 'A2 最后执行，满足按 workspace 轮询公平');
}

async function testLocalQueueLimitsAndScopePause() {
  const coordinator = createAiFairCoordinator({ textLimit: 5 });
  const queue = createAiRequestQueue({
    coordinator,
    workspaceKey: 'local-per-runtime',
    textLimit: 1,
  });

  const localCounter = { running: 0, max: 0 };
  const localJobs = [
    queue.enqueue('text', runWithLimitCounter(localCounter, null, 'local-1', 50)),
    queue.enqueue('text', runWithLimitCounter(localCounter, null, 'local-2', 50)),
    queue.enqueue('text', runWithLimitCounter(localCounter, null, 'local-3', 50)),
  ];

  await Promise.all(localJobs);
  assert(localCounter.max <= 1, '本地队列 text limit 1 限制生效');

  const pauseCoordinator = createAiFairCoordinator({ textLimit: 5 });
  const pauseQueue = createAiRequestQueue({
    coordinator: pauseCoordinator,
    workspaceKey: 'pause-scope',
    textLimit: 1,
  });

  const hold = createDeferred();
  const queueBusy = pauseQueue.enqueue('text', async () => {
    await hold.promise;
    return 'running';
  });

  const pausedJob = pauseQueue.enqueue('text', async () => 'paused-scope', { scopeId: 'scope-1' });
  const activeScope2 = pauseQueue.enqueue('text', async () => 'active-scope-2', { scopeId: 'scope-2' });

  const pausedDropped = pauseQueue.pauseScope('scope-1');
  let caughtPausedCode = null;
  try {
    await pausedJob;
  } catch (error) {
    caughtPausedCode = error && error.code;
  }

  assert(pausedDropped === 1, '暂停 scope 后丢弃该 scope 的队列任务');
  assert(caughtPausedCode === AI_QUEUE_SCOPE_PAUSED, '暂停 scope 丢弃任务返回 AI_QUEUE_SCOPE_PAUSED');

  hold.resolve();
  const scope2Result = await activeScope2;
  const busyResult = await queueBusy;
  assert(scope2Result === 'active-scope-2', '其他 scope 的任务在暂停后继续执行');
  assert(busyResult === 'running', '暂停后运行中的任务仍可完成');
}

async function testDelegatedGlobalWaitPause() {
  const coordinator = createAiFairCoordinator({ textLimit: 1 });
  const queue = createAiRequestQueue({
    coordinator,
    workspaceKey: 'delegated-pause',
    textLimit: 2,
  });
  const hold = createDeferred();
  let pausedRunnerStarted = false;

  const running = queue.enqueue('text', async () => {
    await hold.promise;
    return 'running';
  });
  const paused = queue.enqueue('text', async () => {
    pausedRunnerStarted = true;
    return 'should-not-run';
  }, { scopeId: 'paused-scope' });
  const pausedOutcome = paused.then(
    () => ({ status: 'resolved' }),
    (error) => ({ status: 'rejected', code: error && error.code }),
  );

  assert(coordinator.getStatus().text.active === 1, '暂停回归中的首项正在全局执行');
  assert(coordinator.getStatus().text.queued === 1, '暂停回归中的第二项已进入全局队列');

  const dropped = queue.pauseScope('paused-scope');
  const observed = await Promise.race([
    pausedOutcome,
    wait(100).then(() => ({ status: 'timeout' })),
  ]);

  assert(dropped === 1, '全局排队任务暂停后返回 dropped = 1');
  assert(observed.status === 'rejected' && observed.code === AI_QUEUE_SCOPE_PAUSED, '全局排队任务立即拒绝 AI_QUEUE_SCOPE_PAUSED');
  assert(pausedRunnerStarted === false, '被暂停的全局排队任务 runner 从未执行');

  hold.resolve();
  assert(await running === 'running', '全局排队暂停不影响已执行任务');
  await pausedOutcome;
}

async function testCloseIsolation() {
  const coordinator = createAiFairCoordinator({ textLimit: 2 });
  const queueA = createAiRequestQueue({ coordinator, workspaceKey: 'account-a', textLimit: 1 });
  const queueB = createAiRequestQueue({ coordinator, workspaceKey: 'account-b', textLimit: 1 });

  const hold = createDeferred();
  const aRunning = queueA.enqueue('text', async () => {
    await hold.promise;
    return 'a-running';
  });
  const aQueued = queueA.enqueue('text', async () => 'a-queued');

  const bRunning = queueB.enqueue('text', async () => 'b-running');

  queueA.close();

  let closeErrorCode = null;
  try {
    await aQueued;
  } catch (error) {
    closeErrorCode = error && error.code;
  }
  hold.resolve();
  const bResult = await bRunning;
  const runningResult = await aRunning;

  assert(closeErrorCode === 'AI_REQUEST_QUEUE_CLOSED', '关闭本地 queue 后丢弃本地排队任务');
  assert(runningResult === 'a-running', '关闭本地 queue 后不影响已提交的进行中任务');
  assert(bResult === 'b-running', '关闭一个本地 queue 不影响共享 coordinator 与另一个工作区任务');
  const status = coordinator.getStatus();
  assert(status.text.queued === 0, '共享 coordinator 可继续处理其他队列，不被本地 close 卡住');
}

async function testDelegatedGlobalWaitClose() {
  const coordinator = createAiFairCoordinator({ textLimit: 1 });
  const queueA = createAiRequestQueue({ coordinator, workspaceKey: 'close-a', textLimit: 2 });
  const queueB = createAiRequestQueue({ coordinator, workspaceKey: 'close-b', textLimit: 2 });
  const hold = createDeferred();
  let accountBStarted = false;

  const aRunning = queueA.enqueue('text', async () => {
    await hold.promise;
    return 'a-running';
  });
  const aQueued = queueA.enqueue('text', async () => 'a-queued');
  const bQueued = queueB.enqueue('text', async () => {
    accountBStarted = true;
    return 'b-running';
  });
  const aQueuedOutcome = aQueued.then(
    () => ({ status: 'resolved' }),
    (error) => ({ status: 'rejected', code: error && error.code }),
  );

  queueA.close();
  const observed = await Promise.race([
    aQueuedOutcome,
    wait(100).then(() => ({ status: 'timeout' })),
  ]);
  assert(observed.status === 'rejected' && observed.code === 'AI_REQUEST_QUEUE_CLOSED', '本地 close 立即拒绝全局排队任务');

  hold.resolve();
  const runningResult = await aRunning;
  const bResult = await bQueued;
  assert(runningResult === 'a-running', '本地 close 后已执行任务继续完成');
  assert(bResult === 'b-running' && accountBStarted, '本地 close 后另一个账号继续执行');
  assert(coordinator.getStatus().text.queued === 0, '本地 close 只移除所属全局排队任务');
  await aQueuedOutcome;
}

async function testTextTokenStatsIsolation() {
  const first = createTextTokenStatsStore();
  const second = createTextTokenStatsStore();

  let firstNotify = 0;
  let secondNotify = 0;
  const unsubscribeFirst = first.subscribe(() => {
    firstNotify += 1;
  });
  const unsubscribeSecond = second.subscribe(() => {
    secondNotify += 1;
  });

  first.record({
    prompt_tokens: 10,
    completion_tokens: 3,
    total_tokens: 13,
    cached_tokens: 2,
  });
  second.record({
    prompt_tokens: 20,
    completion_tokens: 5,
    total_tokens: 25,
    cached_tokens: 1,
  });

  assert(first.snapshot().input_tokens === 10, '实例 A 统计独立');
  assert(second.snapshot().input_tokens === 20, '实例 B 统计独立');
  assert(firstNotify === 1 && secondNotify === 1, '每次 record 触发独立监听');

  unsubscribeFirst();
  first.record({
    prompt_tokens: 20,
    completion_tokens: 0,
    total_tokens: 20,
    cached_tokens: 0,
  });
  assert(firstNotify === 1, 'unsubscribe 后不会再次触发监听');

  second.reset();
  second.close();
  second.record({
    prompt_tokens: 999,
    completion_tokens: 999,
    total_tokens: 1998,
    cached_tokens: 0,
  });
  unsubscribeSecond();
  assert(secondNotify === 2, 'close 后监听器清理，不再产生监听副作用');
}

function testCoreFilesNoElectronRequire() {
  const coreFiles = [
    path.join(__dirname, '..', 'core', 'aiFairCoordinator.cjs'),
    path.join(__dirname, '..', 'core', 'aiRequestQueue.cjs'),
    path.join(__dirname, '..', 'core', 'textTokenStatsStore.cjs'),
  ];

  coreFiles.forEach((filePath) => {
    const source = fs.readFileSync(filePath, 'utf-8');
    assertNoElectronRequires(filePath, source, `${path.relative(path.join(__dirname, '..'), filePath)} 不包含 Electron 引用`);
  });
}

async function run() {
  await testDefaultLimits();
  await testLaneIsolationAndLimits();
  await testTwoAccountFairness();
  await testLocalQueueLimitsAndScopePause();
  await testDelegatedGlobalWaitPause();
  await testCloseIsolation();
  await testDelegatedGlobalWaitClose();
  await testTextTokenStatsIsolation();
  testCoreFilesNoElectronRequire();

  console.log(`\n=== AI 调度器核心用例结果 ===`);
  console.log(`通过: ${passed.length}`);
  console.log(`失败: ${failed.length}`);

  if (failed.length > 0) {
    console.log('\n失败项:');
    failed.forEach((item) => {
      console.log(`  - ${item}`);
    });
    process.exit(1);
  }

  console.log('全部通过 ✅');
}

run().catch((error) => {
  failed.push(`脚本异常: ${error?.message || String(error)}`);
  console.log(`\n失败: ${error?.message || String(error)}`);
  process.exit(1);
});
