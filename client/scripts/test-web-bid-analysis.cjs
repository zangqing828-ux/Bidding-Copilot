const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSqliteDatabase } = require('../core/sqliteDatabase.cjs');
const { createTechnicalPlanStore } = require('../core/stores/technicalPlanStore.cjs');
const { createWorkspaceMutationExecutor } = require('../server/workspace/workspaceMutationExecutor.cjs');
const { createTechnicalPlanTaskService } = require('../server/workspace/technicalPlanTaskService.cjs');

function waitFor(predicate, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('等待 Web 招标解析任务超时'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

async function main() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'web-bid-analysis-'));
  let database;
  try {
    database = createSqliteDatabase({ workspaceRoot });
    const store = createTechnicalPlanStore({ db: database.db, workspaceRoot });
    store.loadTechnicalPlan();
    const tenderPath = path.join(workspaceRoot, 'technical-plan', 'tender.md');
    fs.mkdirSync(path.dirname(tenderPath), { recursive: true });
    fs.writeFileSync(tenderPath, '# 测试招标文件\n项目概况与技术要求。', 'utf-8');
    database.db.prepare(`
      UPDATE technical_plan_meta
      SET tender_markdown_path = 'technical-plan/tender.md', tender_markdown_hash = 'test-hash', tender_markdown_chars = 18
      WHERE id = 1
    `).run();

    const mutationExecutor = createWorkspaceMutationExecutor();
    let activeAiRequests = 0;
    let peakAiRequests = 0;
    let failingPrompt = null;
    const aiService = {
      chat: async ({ messages }) => {
        if (failingPrompt && String(messages.at(-1)?.content || '').includes(failingPrompt)) {
          throw Object.assign(new Error(`${failingPrompt} 模拟失败`), { code: 'AI_TIMEOUT', retryable: true });
        }
        activeAiRequests += 1;
        peakAiRequests = Math.max(peakAiRequests, activeAiRequests);
        await new Promise((resolve) => setTimeout(resolve, 25));
        activeAiRequests -= 1;
        return `已解析：${messages.at(-1).content.slice(0, 12)}`;
      },
      getConfig: () => ({}),
      withQueueScope() { return this; },
      resumeQueueScope() {},
    };
    const service = createTechnicalPlanTaskService({ aiService, technicalPlanStore: store, mutationExecutor });
    const events = [];
    const unsubscribe = service.subscribeCallback((event) => events.push(event));
    const startPayload = {
      mode: 'key',
      selected_task_ids: ['projectOverview', 'techRequirements', 'projectInfo', 'partAInfo', 'deliveryAndServiceRequirements'],
      force_rerun: true,
    };
    let releaseAcceptance;
    const acceptanceGate = new Promise((resolve) => {
      releaseAcceptance = resolve;
    });
    const acceptanceBlocker = mutationExecutor.execute(() => acceptanceGate);
    const acceptanceController = new AbortController();
    const cancelledBeforeAcceptance = service.startBidAnalysis(startPayload, { signal: acceptanceController.signal });
    acceptanceController.abort(Object.assign(new Error('客户端在任务受理前断开'), { code: 'TASK_ACCEPTANCE_ABORTED' }));
    releaseAcceptance();
    await acceptanceBlocker;
    await assert.rejects(
      () => cancelledBeforeAcceptance,
      (error) => error?.code === 'TASK_ACCEPTANCE_ABORTED',
      'HTTP 断连只在 accepted 前取消受理且不启动 runner',
    );
    assert.equal(service.getActiveTasks().length, 0, '受理前断连不留下活动任务');
    const [task, duplicateDuringStart] = await Promise.all([
      service.startBidAnalysis(startPayload),
      service.startBidAnalysis(startPayload),
    ]);
    assert.equal(task.status, 'running', 'Web 返回运行中的任务');
    assert.equal(duplicateDuringStart.task_id, task.task_id, '并发重复启动复用同一个准备中的 Web 任务');
    assert.equal(store.getBidAnalysisInputVersion().inputRevision, 1, '并发重复启动只递增一次 input revision');
    const duplicate = service.startBidAnalysis(startPayload);
    assert.equal(duplicate.task_id, task.task_id, '重复启动复用当前 Web 任务');
    await assert.rejects(
      () => service.startBidAnalysis({
        ...startPayload,
        task_ids: ['projectOverview'],
      }),
      (error) => error?.code === 'TASK_CONFLICT',
      '不同 payload 必须返回稳定冲突错误',
    );
    await waitFor(() => {
      const status = store.loadTechnicalPlan().bidAnalysisTask?.status;
      return status === 'success' || status === 'error';
    });
    const state = store.loadTechnicalPlan();
    assert.equal(state.bidAnalysisTask.status, 'success', `Web 任务成功完成：${state.bidAnalysisTask.error || ''}`);
    assert.equal(state.bidAnalysisTasks.projectOverview.status, 'success', '项目概况真实落盘');
    assert.equal(state.bidAnalysisTasks.techRequirements.status, 'success', '技术要求真实落盘');
    assert.equal(state.bidAnalysisTasks.projectInfo.status, 'success', '项目信息真实落盘');
    assert.ok(peakAiRequests >= 2, '项目概述完成后剩余解析项保持并发执行');
    assert(events.some((event) => event.task?.status === 'success'), '事务提交后推送成功 SSE 快照');
    await waitFor(() => service.getActiveTasks().length === 0);

    const customPayload = {
      mode: 'custom',
      selected_task_ids: [...startPayload.selected_task_ids, 'procurementList'],
      force_rerun: true,
    };
    failingPrompt = '采购清单';
    await service.startBidAnalysis(customPayload);
    await waitFor(() => {
      const taskState = store.loadTechnicalPlan().bidAnalysisTask;
      return taskState?.status === 'success' || taskState?.status === 'error';
    });
    let partialFailureState = store.loadTechnicalPlan();
    assert.equal(partialFailureState.bidAnalysisTask.status, 'success', '附加解析项失败不阻断进入下一阶段');
    assert.equal(partialFailureState.bidAnalysisTasks.procurementList.status, 'error', '附加解析项失败状态仍完整落盘');
    await waitFor(() => service.getActiveTasks().length === 0);

    failingPrompt = '提取并总结项目概述信息';
    await service.startBidAnalysis(startPayload);
    await waitFor(() => {
      const taskState = store.loadTechnicalPlan().bidAnalysisTask;
      return taskState?.status === 'success' || taskState?.status === 'error';
    });
    const requiredFailureState = store.loadTechnicalPlan();
    assert.equal(requiredFailureState.bidAnalysisTask.status, 'error', '关键解析项失败阻断进入下一阶段');
    assert.equal(requiredFailureState.bidAnalysisTasks.projectOverview.status, 'error', '关键解析项错误完整落盘');
    failingPrompt = null;
    await waitFor(() => service.getActiveTasks().length === 0);
    unsubscribe();

    const closingAiService = {
      chat: async (_request, { signal } = {}) => new Promise((_resolve, reject) => {
        signal?.addEventListener?.('abort', () => reject(signal.reason), { once: true });
      }),
      getConfig: () => ({}),
      withQueueScope() { return this; },
      resumeQueueScope() {},
    };
    const closingService = createTechnicalPlanTaskService({ aiService: closingAiService, technicalPlanStore: store, mutationExecutor });
    await closingService.startBidAnalysis(startPayload);
    await closingService.close();
    const interrupted = store.loadTechnicalPlan().bidAnalysisTask;
    assert.equal(interrupted.status, 'error', 'Workspace close 将活动任务收口为错误状态');
    assert.equal(interrupted.error_code, 'TASK_INTERRUPTED_BY_RESTART', 'Workspace close 持久化稳定中断错误码');
    await mutationExecutor.close();
    console.log('Web bid analysis real runner tests passed.');
  } finally {
    database?.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
