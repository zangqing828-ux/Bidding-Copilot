const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSqliteDatabase, schemaVersion } = require('../core/sqliteDatabase.cjs');
const { createTechnicalPlanStore } = require('../core/stores/technicalPlanStore.cjs');

const HASH = '0'.repeat(64);

function buildManifest({ executionId, taskId, taskType, workspaceRuntimeGeneration, stageRevisionVector }) {
  return {
    manifest_version: 1,
    execution_id: executionId,
    task_id: taskId,
    task_type: taskType,
    workspace_runtime_generation: workspaceRuntimeGeneration,
    stage_revision_vector: stageRevisionVector,
    normalized_input_hash: HASH,
    source_hashes: {
      tender_document_hash: null,
      original_plan_hash: null,
      reference_documents: [],
    },
    selected_bid_section: null,
    upstream_result_hashes: {
      bid_analysis_hash: HASH,
      outline_hash: HASH,
      global_facts_hash: HASH,
      content_hash: HASH,
    },
    generation_config_hash: HASH,
    prompt_template_version: 'prompt-v1',
    model_snapshot_ref: 'model-v1',
    output_schema_version: 'schema/v1',
  };
}

function assertErrorCode(runner, expectedCode, name) {
  return assert.rejects(
    Promise.resolve().then(() => runner()),
    (error) => error?.code === expectedCode,
    name,
  );
}

function seedDownstream(db) {
  const timestamp = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`
      INSERT OR REPLACE INTO technical_plan_bid_items (item_id, label, status, content, sort_order, updated_at)
      VALUES ('projectOverview', '项目概况', 'success', '旧招标分析', 0, ?)
    `).run(timestamp);
    db.prepare("INSERT OR REPLACE INTO technical_plan_reference_docs (document_id, sort_order) VALUES ('reference-1', 0)").run();
    db.prepare('DELETE FROM technical_plan_content_sections').run();
    db.prepare('DELETE FROM technical_plan_content_plans').run();
    db.prepare('DELETE FROM technical_plan_outline_nodes').run();
    db.prepare(`
      INSERT INTO technical_plan_outline_nodes (node_id, parent_node_id, sort_order, level, title, description, content, created_at, updated_at)
      VALUES ('node-1', NULL, 0, 1, '旧目录', '旧描述', '旧正文', ?, ?)
    `).run(timestamp, timestamp);
    db.prepare(`
      INSERT INTO technical_plan_content_sections (node_id, status, error, updated_at)
      VALUES ('node-1', 'success', NULL, ?)
    `).run(timestamp);
    db.prepare(`
      INSERT INTO technical_plan_content_plans (node_id, plan_json, updated_at)
      VALUES ('node-1', ?, ?)
    `).run(JSON.stringify({ plan_version: 1, plan: { title: '旧正文计划' } }), timestamp);
    db.prepare(`
      INSERT OR REPLACE INTO technical_plan_global_fact_groups (group_id, title, content, sort_order, created_at, updated_at)
      VALUES ('fact-1', '旧事实', '旧事实内容', 0, ?, ?)
    `).run(timestamp, timestamp);
    db.prepare('UPDATE technical_plan_meta SET content_illustration_plan_json = ? WHERE id = 1')
      .run(JSON.stringify({ items: [{ id: 'image-1', generation: { receipt: 'legacy-render-receipt' } }] }));
  })();
}

function createMatrixFileService() {
  return {
    async importDocument() {
      return { success: true, file_name: '招标文件.md', file_content: '# 招标文件\n测试内容' };
    },
    async importTechnicalPlanDocument() {
      return { success: true, file_name: '原方案.md', file_content: '# 原方案\n测试内容' };
    },
  };
}

function assertIllustrationPlanCleared(store, name) {
  assert.equal(store.loadTechnicalPlan().contentIllustrationPlan, undefined, `${name} 应清空配图计划与 render receipt`);
}

async function runStageInvalidationMatrix() {
  const cases = [
    {
      name: '替换招标文件',
      revision: 'source_revision',
      run: (store) => store.importTenderDocument(['tender-file']),
      assert: (store) => {
        const state = store.loadTechnicalPlan();
        assert.equal(state.outlineData, null, '替换招标文件应清空目录');
        assert.equal(Object.keys(state.bidAnalysisTasks).length, 0, '替换招标文件应清空招标分析');
        assert.equal(state.globalFacts.length, 0, '替换招标文件应清空全局事实');
        assertIllustrationPlanCleared(store, '替换招标文件');
      },
    },
    {
      name: '替换原方案',
      revision: 'source_revision',
      run: (store) => store.importOriginalPlanDocument(['original-plan-file']),
      assert: (store) => {
        const state = store.loadTechnicalPlan();
        assert.equal(state.outlineData, null, '替换原方案应清空目录');
        assert.equal(Object.keys(state.bidAnalysisTasks).length, 0, '替换原方案应清空招标分析');
        assert.equal(state.globalFacts.length, 0, '替换原方案应清空全局事实');
        assertIllustrationPlanCleared(store, '替换原方案');
      },
    },
    {
      name: '选择标段',
      revision: 'source_revision',
      setup: async ({ store, db }) => {
        await store.importTenderDocument(['tender-file']);
        db.prepare('UPDATE technical_plan_meta SET bid_sections_json = ? WHERE id = 1').run(JSON.stringify([
          { id: 'section-1', title: '标段一', includeRanges: [{ startLine: 1, endLine: 1 }] },
          { id: 'section-2', title: '标段二', includeRanges: [{ startLine: 2, endLine: 2 }] },
        ]));
      },
      run: (store) => store.selectBidSection({ id: 'section-1', title: '标段一' }),
      assert: (store) => {
        const state = store.loadTechnicalPlan();
        assert.equal(state.outlineData, null, '选择标段应清空目录');
        assert.equal(Object.keys(state.bidAnalysisTasks).length, 0, '选择标段应清空招标分析');
        assertIllustrationPlanCleared(store, '选择标段');
      },
    },
    {
      name: '修改招标分析配置',
      revision: 'analysis_revision',
      run: (store) => store.saveBidAnalysisConfig({ mode: 'full', selectedTaskIds: [] }),
      assert: (store) => {
        const state = store.loadTechnicalPlan();
        assert.equal(state.outlineData, null, '修改招标分析配置应清空目录');
        assert.equal(state.globalFacts.length, 0, '修改招标分析配置应清空全局事实');
        assertIllustrationPlanCleared(store, '修改招标分析配置');
      },
    },
    {
      name: '写入招标分析结果',
      revision: 'analysis_revision',
      run: (store) => store.updateTechnicalPlanForInputRevision(store.getBidAnalysisInputVersion().inputRevision, {
        bidAnalysisTasks: {
          projectOverview: { status: 'success', content: '新的招标分析结果' },
        },
      }),
      assert: (store) => {
        const state = store.loadTechnicalPlan();
        assert.equal(state.outlineData, null, '写入招标分析结果应清空目录');
        assert.equal(state.globalFacts.length, 0, '写入招标分析结果应清空全局事实');
        assertIllustrationPlanCleared(store, '写入招标分析结果');
      },
    },
    {
      name: '目录保存（含 reason=sort）',
      revision: 'outline_revision',
      run: (store) => store.saveOutline({
        reason: 'sort',
        outlineData: { outline: [{ id: 'node-1', title: '语义重排后的目录', description: '新描述' }] },
      }),
      assert: (store) => {
        const state = store.loadTechnicalPlan();
        assert.equal(state.globalFacts.length, 0, '普通 saveOutline 应清空全局事实');
        assert.equal(state.contentGenerationSections['node-1'], undefined, '普通 saveOutline 应清空正文状态');
        assertIllustrationPlanCleared(store, '普通 saveOutline');
      },
    },
    {
      name: '编辑全局事实',
      revision: 'facts_revision',
      run: (store) => store.saveGlobalFacts([{ id: 'fact-new', title: '新事实', content: '新事实内容' }]),
      assert: (store) => {
        const state = store.loadTechnicalPlan();
        assert.equal(state.globalFacts.length, 1, '编辑全局事实应保留新事实');
        assert.equal(state.contentGenerationSections['node-1'], undefined, '编辑全局事实应清空正文状态');
        assertIllustrationPlanCleared(store, '编辑全局事实');
      },
    },
    {
      name: '编辑正文',
      revision: 'content_revision',
      run: (store) => store.saveChapterContent({ nodeId: 'node-1', content: '手工编辑后的正文' }),
      assert: (store) => {
        const state = store.loadTechnicalPlan();
        assert.equal(state.outlineData.outline[0].content, '手工编辑后的正文', '编辑正文应保存正文');
        assertIllustrationPlanCleared(store, '编辑正文');
      },
    },
  ];

  for (const item of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-j-stage-matrix-'));
    let sqlite = createSqliteDatabase({ databasePath: path.join(root, 'workspace.sqlite') });
    try {
      const store = createTechnicalPlanStore({
        db: sqlite.db,
        workspaceRoot: root,
        fileService: createMatrixFileService(),
      });
      await item.setup?.({ store, db: sqlite.db });
      store.currentStageRevisions();
      seedDownstream(sqlite.db);
      const before = store.currentStageRevisions();
      await item.run(store);
      const after = store.currentStageRevisions();
      assert.equal(after[item.revision], before[item.revision] + 1, `${item.name} 应递增 ${item.revision}`);
      for (const revision of ['source_revision', 'analysis_revision', 'outline_revision', 'facts_revision', 'content_revision']) {
        if (revision !== item.revision) {
          assert.equal(after[revision], before[revision], `${item.name} 不应重复递增 ${revision}`);
        }
      }
      item.assert(store);
    } finally {
      sqlite?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-j-store-cas-'));
  const dbPath = path.join(root, 'workspace.sqlite');
  let sqlite = createSqliteDatabase({ databasePath: dbPath });

  try {
    const workspaceRuntimeGeneration = 7;
    const store = createTechnicalPlanStore({
      db: sqlite.db,
      workspaceRoot: root,
      workspaceRuntimeGeneration,
    });
    const legacyStore = createTechnicalPlanStore({ db: sqlite.db, workspaceRoot: root });

    await assertErrorCode(
      () => legacyStore.acceptTechnicalPlanTaskRun(buildManifest({
        executionId: 'exec-legacy-01',
        taskId: 'task-legacy-01',
        taskType: 'bid-section-extraction',
        workspaceRuntimeGeneration,
        stageRevisionVector: legacyStore.currentStageRevisions(),
      })),
      'TASK_CONFLICT',
      '未绑定 store runtime generation 的实例不应接受任务',
    );

    const baseInput = store.getBidAnalysisInputVersion();
    const updatedInputRevision = baseInput.inputRevision + 10;
    sqlite.db.prepare('UPDATE technical_plan_meta SET input_revision = ? WHERE id = 1').run(updatedInputRevision);

    const bidStageVector = store.currentStageRevisions();
    const bidManifest = buildManifest({
      executionId: 'exec-bid-01',
      taskId: 'task-bid-01',
      taskType: 'bid-section-extraction',
      workspaceRuntimeGeneration,
      stageRevisionVector: bidStageVector,
    });
    const acceptedBid = store.acceptTechnicalPlanTaskRun(bidManifest);
    assert.equal(acceptedBid.targetStageGeneration, bidStageVector.source_revision + 1, 'accept 使用当前阶段代号生成目标代号');
    const replayBid = store.acceptTechnicalPlanTaskRun(bidManifest);
    assert.equal(replayBid.isReplay, true, '重复同一 execution_id 且同一 manifest 会进入 replay');

    await assertErrorCode(
      () => store.acceptTechnicalPlanTaskRun({ ...bidManifest, task_id: 'task-bid-01-wrong-gen', workspace_runtime_generation: 8 }),
      'TASK_CONFLICT',
      '当运行时代号不匹配时应拒绝',
    );

    await assertErrorCode(
      () => store.acceptTechnicalPlanTaskRun({ ...bidManifest, task_id: 'task-bid-01-conflict' }),
      'TASK_CONFLICT',
      '重复 execution_id 但 manifest 改变会进入冲突',
    );

    const outlineManifest = buildManifest({
      executionId: 'exec-outline-01',
      taskId: 'task-outline-01',
      taskType: 'outline-generation',
      workspaceRuntimeGeneration,
      stageRevisionVector: store.currentStageRevisions(),
    });
    const acceptedOutline = store.acceptTechnicalPlanTaskRun(outlineManifest);
    const outlineManifest2 = buildManifest({
      executionId: 'exec-outline-02',
      taskId: 'task-outline-02',
      taskType: 'outline-generation',
      workspaceRuntimeGeneration,
      stageRevisionVector: store.currentStageRevisions(),
    });
    const acceptedOutline2 = store.acceptTechnicalPlanTaskRun(outlineManifest2);

    await assertErrorCode(
      () => store.writebackTechnicalPlanTaskRun({
        executionId: acceptedOutline.executionId,
        manifestHash: acceptedOutline.manifestHash,
        targetStageGeneration: acceptedOutline.targetStageGeneration,
        checkpoint: { label: 'stale-target' },
        apply: () => ({ payload: 'should-not-apply' }),
      }),
      'TASK_INPUT_CHANGED',
      '目标代号过期的 writeback 会被拒绝',
    );
    assert.equal(
      store.getTechnicalPlanRunRecord(acceptedOutline.executionId).status,
      'accepted',
      '过期 target writeback 不会把记录更新为 succeeded',
    );

    const bidManifest2 = buildManifest({
      executionId: 'exec-bid-02',
      taskId: 'task-bid-02',
      taskType: 'bid-section-extraction',
      workspaceRuntimeGeneration,
      stageRevisionVector: store.currentStageRevisions(),
    });
    store.acceptTechnicalPlanTaskRun(bidManifest2);

    await assertErrorCode(
      () => store.writebackTechnicalPlanTaskRun({
        executionId: acceptedOutline2.executionId,
        manifestHash: acceptedOutline2.manifestHash,
        targetStageGeneration: acceptedOutline2.targetStageGeneration,
        checkpoint: { label: 'stale-upstream' },
        apply: () => ({ payload: 'should-not-apply' }),
      }),
      'TASK_INPUT_CHANGED',
      '上游阶段变化导致 writeback 拒绝',
    );
    assert.equal(
      store.getTechnicalPlanRunRecord(acceptedOutline2.executionId).status,
      'accepted',
      '过期 upstream writeback 不会把记录更新为 succeeded',
    );

    const globalFactsManifest = buildManifest({
      executionId: 'exec-global-facts-01',
      taskId: 'task-global-facts-01',
      taskType: 'global-facts-generation',
      workspaceRuntimeGeneration,
      stageRevisionVector: store.currentStageRevisions(),
    });
    const acceptedGlobalFacts = store.acceptTechnicalPlanTaskRun(globalFactsManifest);
    const successWriteback = store.writebackTechnicalPlanTaskRun({
      executionId: acceptedGlobalFacts.executionId,
      manifestHash: acceptedGlobalFacts.manifestHash,
      targetStageGeneration: acceptedGlobalFacts.targetStageGeneration,
      checkpoint: { label: 'success-checkpoint' },
      apply: () => ({ payload: 'ok' }),
    });
    assert.equal(successWriteback.payload.payload, 'ok', '同步 apply 回调的 writeback 正常返回 payload');
    assert.equal(successWriteback.status, 'succeeded', '同步 writeback 会更新状态为 succeeded');

    const asyncManifest = buildManifest({
      executionId: 'exec-outline-03',
      taskId: 'task-outline-03',
      taskType: 'outline-generation',
      workspaceRuntimeGeneration,
      stageRevisionVector: store.currentStageRevisions(),
    });
    const acceptedAsync = store.acceptTechnicalPlanTaskRun(asyncManifest);
    await assertErrorCode(
      () => store.writebackTechnicalPlanTaskRun({
        executionId: acceptedAsync.executionId,
        manifestHash: acceptedAsync.manifestHash,
        targetStageGeneration: acceptedAsync.targetStageGeneration,
        apply: async () => ({ payload: 'async' }),
      }),
      'TASK_APPLY_FAILED',
      '异步 apply 回调应 fail-closed',
    );
    assert.equal(
      store.getTechnicalPlanRunRecord(acceptedAsync.executionId).status,
      'accepted',
      '异步 writeback 不应更新为 succeeded',
    );

    const delayedManifest = buildManifest({
      executionId: 'exec-outline-04',
      taskId: 'task-outline-04',
      taskType: 'outline-generation',
      workspaceRuntimeGeneration,
      stageRevisionVector: store.currentStageRevisions(),
    });
    const acceptedDelayed = store.acceptTechnicalPlanTaskRun(delayedManifest);
    await assertErrorCode(
      () => store.writebackTechnicalPlanTaskRun({
        executionId: acceptedDelayed.executionId,
        manifestHash: acceptedDelayed.manifestHash,
        targetStageGeneration: acceptedDelayed.targetStageGeneration,
        apply: () => Promise.resolve().then(() => ({ payload: 'delayed' })),
      }),
      'TASK_APPLY_FAILED',
      '延迟 apply 回调应 fail-closed 并保持回滚',
    );
    assert.equal(
      store.getTechnicalPlanRunRecord(acceptedDelayed.executionId).status,
      'accepted',
      '延迟 writeback 不应更新为 succeeded',
    );

    sqlite.close();
    sqlite = null;

    const reopened = createSqliteDatabase({ databasePath: dbPath });
    sqlite = reopened;
    const reopenedStore = createTechnicalPlanStore({ db: reopened.db, workspaceRoot: root });
    assert.equal(reopened.schemaVersion, schemaVersion, '重新打开数据库为当前 schemaVersion');
    assert.equal(
      reopenedStore.getTechnicalPlanRunRecord(acceptedBid.executionId)?.status,
      'accepted',
      'schema23 重开后 run record 可读取',
    );
    assert.equal(
      reopenedStore.getBidAnalysisInputVersion().inputRevision,
      updatedInputRevision,
      'schema23 重开后输入版本可恢复',
    );

    reopened.close();
    sqlite = null;
    const migrationProbe = createSqliteDatabase({ databasePath: dbPath });
    migrationProbe.db.pragma('user_version = 22');
    migrationProbe.close();
    const remigrated = createSqliteDatabase({ databasePath: dbPath });
    sqlite = remigrated;
    assert.equal(remigrated.schemaVersion, schemaVersion, '阶段版本 migration 重跑后仍为当前 schemaVersion');
    const stageColumns = remigrated.db.prepare('PRAGMA table_info(technical_plan_meta)').all().map((row) => row.name);
    for (const column of ['source_revision', 'analysis_revision', 'outline_revision', 'facts_revision', 'content_revision']) {
      assert.equal(stageColumns.includes(column), true, `migration 幂等后保留 ${column}`);
    }

    await runStageInvalidationMatrix();
    console.log('technicalPlanStore CAS tests passed.');
  } finally {
    sqlite?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
