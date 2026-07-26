const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSqliteDatabase } = require('../core/sqliteDatabase.cjs');
const { createTechnicalPlanStore } = require('../core/stores/technicalPlanStore.cjs');
const { createWorkspaceMutationExecutor } = require('../server/workspace/workspaceMutationExecutor.cjs');
const { createWebBidAnalysisTaskService } = require('../server/workspace/webServices.cjs');

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
    const aiService = {
      chat: async ({ messages }) => `已解析：${messages.at(-1).content.slice(0, 12)}`,
      getConfig: () => ({}),
      withQueueScope() { return this; },
      resumeQueueScope() {},
    };
    const service = createWebBidAnalysisTaskService({ aiService, technicalPlanStore: store, mutationExecutor });
    const events = [];
    const unsubscribe = service.subscribeCallback((event) => events.push(event));
    const startPayload = {
      mode: 'key',
      selected_task_ids: ['projectOverview', 'techRequirements', 'projectInfo', 'partAInfo', 'deliveryAndServiceRequirements'],
      force_rerun: true,
    };
    const [task, duplicateDuringStart] = await Promise.all([
      service.startBidAnalysis(startPayload),
      service.startBidAnalysis(startPayload),
    ]);
    assert.equal(task.status, 'running', 'Web 返回运行中的任务');
    assert.equal(duplicateDuringStart.task_id, task.task_id, '并发重复启动复用同一个准备中的 Web 任务');
    assert.equal(store.getBidAnalysisInputVersion().inputRevision, 1, '并发重复启动只递增一次 input revision');
    const duplicate = service.startBidAnalysis({
      mode: 'key',
      selected_task_ids: ['projectOverview', 'techRequirements', 'projectInfo', 'partAInfo', 'deliveryAndServiceRequirements'],
    });
    assert.equal(duplicate.task_id, task.task_id, '重复启动复用当前 Web 任务');
    await waitFor(() => {
      const status = store.loadTechnicalPlan().bidAnalysisTask?.status;
      return status === 'success' || status === 'error';
    });
    const state = store.loadTechnicalPlan();
    assert.equal(state.bidAnalysisTask.status, 'success', `Web 任务成功完成：${state.bidAnalysisTask.error || ''}`);
    assert.equal(state.bidAnalysisTasks.projectOverview.status, 'success', '项目概况真实落盘');
    assert.equal(state.bidAnalysisTasks.techRequirements.status, 'success', '技术要求真实落盘');
    assert.equal(state.bidAnalysisTasks.projectInfo.status, 'success', '项目信息真实落盘');
    assert(events.some((event) => event.task?.status === 'success'), '事务提交后推送成功 SSE 快照');
    await waitFor(() => service.getActiveTasks().length === 0);
    unsubscribe();
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
