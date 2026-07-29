// WR-03 Web 技术方案任务编排测试：
// 覆盖四种首发任务注册、组互斥、pause/resume、stale revision 拒绝回写、
// 中断恢复语义（content 转 paused、其他转 retryable error）和 global-facts 真实 runner 文本链。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSqliteDatabase } = require('../core/sqliteDatabase.cjs');
const { createTechnicalPlanStore } = require('../core/stores/technicalPlanStore.cjs');
const { createWorkspaceMutationExecutor } = require('../server/workspace/workspaceMutationExecutor.cjs');
const { createTechnicalPlanTaskService } = require('../server/workspace/technicalPlanTaskService.cjs');

const passed = [];
const failed = [];

async function run(name, fn) {
  try {
    await fn();
    passed.push(name);
    console.log(`  PASS: ${name}`);
  } catch (error) {
    failed.push(`${name}: ${error.message}`);
    console.error(`  FAIL: ${name}`);
    console.error(error?.stack || error?.message || String(error));
  }
}

function flush() {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

async function waitFor(predicate, message, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待超时：${message}`);
}

function createHarness({ aiService, taskRunners } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bidmaster-wr03-'));
  const databasePath = path.join(tmpDir, 'yibiao.sqlite');
  const sqliteDatabase = createSqliteDatabase({ databasePath });
  const technicalPlanStore = createTechnicalPlanStore({ db: sqliteDatabase.db, workspaceRoot: tmpDir });
  const mutationExecutor = createWorkspaceMutationExecutor();
  const service = createTechnicalPlanTaskService({
    aiService: aiService || { withQueueScope: () => ({}), pauseQueueScope: () => {}, resumeQueueScope: () => {} },
    technicalPlanStore,
    knowledgeBaseService: { listDocuments: () => [], readDocument: () => null },
    mutationExecutor,
    ...(taskRunners ? { taskRunners } : {}),
  });
  const events = [];
  const unsubscribe = service.subscribeCallback((event) => events.push(event));
  return {
    tmpDir,
    db: sqliteDatabase.db,
    technicalPlanStore,
    mutationExecutor,
    service,
    events,
    async close() {
      unsubscribe();
      await service.close();
      await mutationExecutor.close().catch(() => {});
      sqliteDatabase.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

// 写入招标文件和目录，让 outline/global-facts/content 前置校验通过。
function seedTechnicalPlan(harness, { withSnapshot = true } = {}) {
  const { db, tmpDir, technicalPlanStore } = harness;
  technicalPlanStore.loadTechnicalPlan();
  const markdownRelative = 'technical-plan/tender.md';
  const markdownPath = path.join(tmpDir, markdownRelative);
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(markdownPath, '# 测试招标文件\n\n项目名称：Web 任务编排测试项目。\n要求完成技术方案。');
  db.prepare(`
    UPDATE technical_plan_meta
    SET tender_markdown_path = ?, tender_markdown_chars = 40, tender_markdown_hash = 'hash-1', tender_file_name = 'tender.docx', updated_at = ?
    WHERE id = 1
  `).run(markdownRelative, new Date().toISOString());
  technicalPlanStore.saveOutline({
    outlineData: {
      project_name: '测试项目',
      project_overview: '测试概述',
      outline: [
        { id: '1', title: '第一章', children: [{ id: '1.1', title: '概述小节', children: [] }] },
      ],
    },
    reason: 'replace',
  });
  if (withSnapshot) {
    db.prepare('UPDATE technical_plan_meta SET outline_word_control_snapshot_json = ? WHERE id = 1')
      .run(JSON.stringify({ enabled: false, minimumWords: 0, maximumWords: 0, sectionWords: 0, strictSectionWords: false }));
  }
  return technicalPlanStore.loadTechnicalPlan();
}

async function main() {
  await run('四种首发任务全部注册且可启动', async () => {
    const releases = new Map();
    const taskRunners = Object.fromEntries([
      'bid-analysis', 'outline-generation', 'global-facts-generation', 'content-generation',
    ].map((type) => [type, () => new Promise((resolve) => releases.set(type, resolve))]));
    const harness = createHarness({ taskRunners });
    try {
      seedTechnicalPlan(harness);
      const outlineTask = await harness.service.startOutlineGeneration({
        reference_knowledge_document_ids: [],
        outline_expansion_mode: 'ai-complement',
        word_control_options: { enabled: false, minimumWords: 0, maximumWords: 0, sectionWords: 0, strictSectionWords: false },
      });
      assert.equal(outlineTask.type, 'outline-generation', '目录任务类型正确');
      assert.equal(outlineTask.status, 'running', '目录任务启动即 running');
      assert.ok(harness.events.some((event) => event.task?.task_id === outlineTask.task_id), '目录任务产生订阅事件');
      releases.get('outline-generation')();
      await flush();

      const factsTask = await harness.service.startGlobalFactsGeneration({});
      assert.equal(factsTask.type, 'global-facts-generation', '全局事实任务类型正确');
      releases.get('global-facts-generation')();
      await flush();

      const contentTask = await harness.service.startContentGeneration({ generationOptions: buildGenerationOptions() });
      assert.equal(contentTask.type, 'content-generation', '正文任务类型正确');
      releases.get('content-generation')();
      await flush();
      assert.equal(harness.service.getActiveTasks().length, 0, 'runner 完成后释放 active task');

      const state = harness.technicalPlanStore.loadTechnicalPlan();
      assert.equal(state.outlineGenerationTask?.status, 'running', '目录任务快照已持久化');
    } finally {
      await harness.close();
    }
  });

  await run('同一任务组保持互斥', async () => {
    const releases = new Map();
    const taskRunners = {
      'outline-generation': () => new Promise((resolve) => releases.set('outline-generation', resolve)),
      'global-facts-generation': () => Promise.resolve(),
    };
    const harness = createHarness({ taskRunners });
    try {
      seedTechnicalPlan(harness);
      await harness.service.startOutlineGeneration({
        reference_knowledge_document_ids: [],
        outline_expansion_mode: 'ai-complement',
        word_control_options: { enabled: false, minimumWords: 0, maximumWords: 0, sectionWords: 0, strictSectionWords: false },
      });
      await assert.rejects(
        async () => harness.service.startGlobalFactsGeneration({}),
        (error) => error?.code === 'TASK_CONFLICT',
        '任务组冲突被 TASK_CONFLICT 拒绝',
      );
      releases.get('outline-generation')();
      await flush();
    } finally {
      await harness.close();
    }
  });

  await run('bridge 边界拒绝未知字段', async () => {
    const harness = createHarness({ taskRunners: { 'outline-generation': () => Promise.resolve() } });
    try {
      seedTechnicalPlan(harness);
      await assert.rejects(
        async () => harness.service.startOutlineGeneration({ evil_field: 1 }),
        (error) => error?.code === 'TASK_INVALID_INPUT',
        '未知字段被 TASK_INVALID_INPUT 拒绝',
      );
      await assert.rejects(
        async () => harness.service.startContentGeneration({ generationOptions: buildGenerationOptions(), extra: true }),
        (error) => error?.code === 'TASK_INVALID_INPUT',
        '正文任务未知字段被拒绝',
      );
    } finally {
      await harness.close();
    }
  });

  await run('目录变化后旧任务无法回写（stale revision）', async () => {
    let runnerContext;
    const taskRunners = {
      'content-generation': (context) => new Promise((resolve) => {
        runnerContext = {
          context,
          finish() {
            const state = context.workspaceStore.updateTechnicalPlan({});
            context.updateTask({ status: 'success', progress: 100 }, state);
            resolve();
          },
        };
      }),
    };
    const harness = createHarness({ taskRunners });
    try {
      seedTechnicalPlan(harness);
      await harness.service.startContentGeneration({ generationOptions: buildGenerationOptions() });
      await waitFor(() => Boolean(runnerContext), 'content runner 已启动');

      // 任务运行中目录编辑会被 store 拒绝；先结束任务再编辑目录制造 stale revision。
      const staleStore = runnerContext.context.workspaceStore;
      runnerContext.finish();
      await flush();
      harness.technicalPlanStore.saveOutline({
        outlineData: {
          project_name: '测试项目',
          project_overview: '测试概述',
          outline: [{ id: '2', title: '新目录', children: [] }],
        },
        reason: 'replace',
      });
      await assert.rejects(
        async () => staleStore.updateTechnicalPlan({ projectOverview: '旧任务回写' }),
        (error) => error?.code === 'TASK_INPUT_CHANGED',
        '旧任务上下文回写被 TASK_INPUT_CHANGED 拒绝',
      );
    } finally {
      await harness.close();
    }
  });

  await run('正文任务 pause -> paused -> resume', async () => {
    let releaseFirst;
    let sawPauseRequest = false;
    let resumeStarted = false;
    const taskRunners = {
      'content-generation': ({ payload, taskControl, updateTask, workspaceStore }) => {
        if (payload.resume) {
          resumeStarted = true;
          const state = workspaceStore.updateTechnicalPlan({});
          updateTask({ status: 'success', progress: 100 }, state);
          return Promise.resolve();
        }
        return new Promise((resolve) => {
          releaseFirst = () => {
            sawPauseRequest = taskControl.isPauseRequested();
            const state = workspaceStore.updateTechnicalPlan({});
            updateTask({ status: 'paused', progress: 40, pause_requested: false }, state);
            resolve();
          };
        });
      },
    };
    const harness = createHarness({ taskRunners });
    try {
      seedTechnicalPlan(harness);
      await harness.service.startContentGeneration({ generationOptions: buildGenerationOptions() });
      await waitFor(() => Boolean(releaseFirst), 'content runner 已启动');
      const pausing = harness.service.pauseContentGeneration();
      assert.equal(pausing.status, 'pausing', '暂停请求进入 pausing');
      releaseFirst();
      await flush();
      const paused = harness.technicalPlanStore.loadTechnicalPlan().contentGenerationTask;
      assert.ok(sawPauseRequest, 'runner 能感知暂停请求');
      assert.equal(paused.status, 'paused', '任务落盘为 paused');

      await harness.service.startContentGeneration({ resume: true });
      await waitFor(() => resumeStarted, 'resume runner 已启动');
      await flush();
      const resumed = harness.technicalPlanStore.loadTechnicalPlan().contentGenerationTask;
      assert.equal(resumed.status, 'success', 'resume 后任务成功');
    } finally {
      await harness.close();
    }
  });

  await run('服务重启后 content 转 paused，其余任务转 retryable error', async () => {
    const harness = createHarness({ taskRunners: {} });
    try {
      seedTechnicalPlan(harness);
      const timestamp = new Date().toISOString();
      const insert = harness.db.prepare(`
        INSERT INTO technical_plan_tasks (type, task_id, status, progress, logs_json, stats_json, error, error_code, retryable, input_revision, pause_requested, started_at, updated_at)
        VALUES (@type, @task_id, 'running', 30, '[]', @stats_json, NULL, NULL, 0, NULL, 0, @timestamp, @timestamp)
      `);
      insert.run({ type: 'outline-generation', task_id: 'task-outline', stats_json: 'null', timestamp });
      insert.run({ type: 'content-generation', task_id: 'task-content', stats_json: JSON.stringify({ content: { phase: 'generating' } }), timestamp });
      harness.db.prepare(`
        INSERT INTO technical_plan_content_sections (node_id, status, error, updated_at)
        VALUES ('1.1', 'running', NULL, ?)
      `).run(timestamp);

      harness.technicalPlanStore.recoverInterruptedTasks();
      const state = harness.technicalPlanStore.loadTechnicalPlan();
      assert.equal(state.outlineGenerationTask?.status, 'error', '目录任务重启后转 error');
      assert.equal(state.outlineGenerationTask?.error_code, 'TASK_INTERRUPTED_BY_RESTART', '目录任务带中断错误码');
      assert.equal(state.outlineGenerationTask?.retryable, true, '目录任务可重试');
      assert.equal(state.contentGenerationTask?.status, 'paused', '正文任务重启后保持暂停恢复语义');
      assert.equal(state.contentGenerationSections?.['1.1']?.status, 'error', '中断小节标记为 error');
      assert.match(String(state.contentGenerationSections?.['1.1']?.error || ''), /中断/, '中断小节带说明');
    } finally {
      await harness.close();
    }
  });

  await run('global-facts 真实 runner 走通完整文本链', async () => {
    const factsFixture = {
      groups: [
        { title: '项目概况', facts: [{ name: '项目名称', value: 'Web 任务编排测试项目' }] },
      ],
    };
    const aiCalls = [];
    const aiService = {
      withQueueScope() { return this; },
      pauseQueueScope() {},
      resumeQueueScope() {},
      async collectJsonResponse(options) {
        aiCalls.push(options.progressLabel || options.logTitle || 'unknown');
        const normalized = options.normalizer ? options.normalizer(factsFixture) : factsFixture;
        if (options.validator) options.validator(normalized);
        return normalized;
      },
      async chat() { return '测试响应'; },
    };
    const harness = createHarness({ aiService });
    try {
      seedTechnicalPlan(harness);
      await harness.service.startGlobalFactsGeneration({});
      await waitFor(() => {
        const task = harness.technicalPlanStore.loadTechnicalPlan().globalFactsTask;
        return task?.status === 'success' || task?.status === 'error';
      }, 'global-facts 任务结束');
      const state = harness.technicalPlanStore.loadTechnicalPlan();
      assert.equal(state.globalFactsTask?.status, 'success', `全局事实任务成功（AI 调用：${aiCalls.join(',')}，错误：${state.globalFactsTask?.error || ''}）`);
      assert.ok(Array.isArray(state.globalFacts) && state.globalFacts.length >= 1, '全局事实已持久化');
      assert.ok(harness.events.some((event) => event.task?.type === 'global-facts-generation' && event.task?.status === 'success'), 'SSE 快照包含成功事件');
    } finally {
      await harness.close();
    }
  });

  console.log(`\nWeb 技术方案任务编排测试：${passed.length} 通过，${failed.length} 失败`);
  if (failed.length) {
    process.exitCode = 1;
  }
}

function buildGenerationOptions() {
  return {
    useAiImages: false,
    maxAiImages: 0,
    useMermaidImages: false,
    maxMermaidImages: 0,
    useHtmlImages: false,
    maxHtmlImages: 0,
    htmlImageTypes: '',
    tableRequirement: 'none',
    enableConsistencyAudit: false,
    consistencyRepairMode: 'normal',
    enableOriginalPlanCoverageAudit: false,
  };
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
