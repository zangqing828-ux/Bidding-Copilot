const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSqliteDatabase } = require('../core/sqliteDatabase.cjs');
const { resolveWorkspacePaths } = require('../core/workspacePaths.cjs');
const { createTechnicalPlanStore } = require('../core/stores/technicalPlanStore.cjs');
const { printResult, redactText } = require('./wp-j-ops-utils.cjs');

const RUNTIME_GENERATION = 3001;
const TEST_SECRET = 'rollback-secret-must-not-print';

function contentSections(content) {
  return {
    'rollback-node-1': {
      id: 'rollback-node-1',
      title: '第一节',
      status: 'success',
      content,
      updated_at: new Date().toISOString(),
    },
  };
}

function createFixtureFileService() {
  return {
    async importDocument() {
      return {
        success: true,
        file_content: '# 回滚测试招标文件\n\n需要保留的业务输入。',
        file_name: 'rollback-tender.md',
        parser_label: 'rollback-fixture',
      };
    },
    async importTechnicalPlanDocument() {
      return {
        success: true,
        file_content: '# 回滚测试原方案\n\n已有方案正文。',
        file_name: 'rollback-original-plan.md',
        parser_label: 'rollback-fixture',
      };
    },
  };
}

function openStore(root) {
  const database = createSqliteDatabase({ workspaceRoot: root });
  const store = createTechnicalPlanStore({
    db: database.db,
    fileService: createFixtureFileService(),
    workspaceRoot: root,
    workspaceRuntimeGeneration: RUNTIME_GENERATION,
  });
  return { database, store, paths: resolveWorkspacePaths(root) };
}

async function seedFixture(root) {
  const { database, store } = openStore(root);
  const paths = resolveWorkspacePaths(root);
  fs.mkdirSync(paths.uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(paths.uploadsDir, 'existing-upload.txt'), '保留的上传资产\n', 'utf8');
  try {
    await store.importTenderDocument(['rollback-tender']);
    await store.importOriginalPlanDocument(['rollback-original']);
    store.saveOutline({
      reason: 'replace',
      outlineData: {
        project_name: '回滚测试项目',
        outline: [{
          id: 'rollback-chapter-1',
          title: '第一章',
          description: '保留目录',
          children: [{ id: 'rollback-node-1', title: '第一节', description: '保留正文' }],
        }],
      },
    });
    store.saveGlobalFacts([{ id: 'rollback-fact-seed', title: '初始事实', content: '初始内容。' }]);
    return { database, store, paths };
  } catch (error) {
    database.close();
    throw error;
  }
}

function createManifest(store, taskType, executionId, taskId) {
  return {
    manifest_version: 1,
    execution_id: executionId,
    task_id: taskId,
    task_type: taskType,
    workspace_runtime_generation: RUNTIME_GENERATION,
    stage_revision_vector: store.currentStageRevisions(),
    normalized_input_hash: '0'.repeat(64),
    source_hashes: {
      tender_document_hash: null,
      original_plan_hash: null,
      reference_documents: [],
    },
    selected_bid_section: null,
    upstream_result_hashes: {
      bid_analysis_hash: '0'.repeat(64),
      outline_hash: '0'.repeat(64),
      global_facts_hash: null,
      content_hash: null,
    },
    generation_config_hash: '0'.repeat(64),
    prompt_template_version: 'wp-j3-rollback.v1',
    model_snapshot_ref: 'rollback-fixture-model',
    output_schema_version: `${taskType}.v1`,
  };
}

function writeSuccessfulRun(store, manifest, initialPartial, resultPartial, resultCheckpoint) {
  const accepted = store.acceptTechnicalPlanTaskRun(manifest, {
    initialPartial,
    initialCheckpoint: { status: 'accepted', input: {} },
  });
  const receipt = store.writebackTechnicalPlanTaskRun({
    executionId: accepted.executionId,
    manifestHash: accepted.manifestHash,
    targetStageGeneration: accepted.targetStageGeneration,
    checkpoint: { ...resultCheckpoint, status: 'success' },
    validate: () => undefined,
    apply: () => store.updateTechnicalPlan(resultPartial),
  });
  assert.equal(receipt.status, 'succeeded', `${manifest.task_type} receipt 必须成功`);
  return { accepted, receipt };
}

function seedSuccessfulJCoreRuns(store) {
  const globalManifest = createManifest(store, 'global-facts-generation', 'rollback-global-execution', 'rollback-global-task');
  const globalTask = {
    task_id: globalManifest.task_id,
    type: globalManifest.task_type,
    execution_id: globalManifest.execution_id,
    manifest_hash: undefined,
    status: 'success',
    progress: 100,
    logs: [],
  };
  const global = store.acceptTechnicalPlanTaskRun(globalManifest, {
    initialPartial: { globalFacts: [], globalFactsTask: { ...globalTask, status: 'running' } },
    initialCheckpoint: { status: 'accepted', input: {} },
  });
  globalTask.manifest_hash = global.manifestHash;
  const globalReceipt = store.writebackTechnicalPlanTaskRun({
    executionId: global.executionId,
    manifestHash: global.manifestHash,
    targetStageGeneration: global.targetStageGeneration,
    checkpoint: { status: 'success', input: {}, result: 'global-facts-retained' },
    validate: () => undefined,
    apply: () => store.updateTechnicalPlan({
      globalFacts: [{ id: 'rollback-fact', title: '回滚事实', content: '关闭 Agent 后仍可读取。' }],
      globalFactsTask: globalTask,
    }),
  });

  const contentManifest = createManifest(store, 'content-generation', 'rollback-content-execution', 'rollback-content-task');
  const contentTask = {
    task_id: contentManifest.task_id,
    type: contentManifest.task_type,
    execution_id: contentManifest.execution_id,
    status: 'running',
    progress: 0,
    logs: [],
  };
  const content = store.acceptTechnicalPlanTaskRun(contentManifest, {
    initialPartial: { contentGenerationTask: contentTask },
    initialCheckpoint: { status: 'accepted', input: {} },
  });
  contentTask.manifest_hash = content.manifestHash;
  const contentReceipt = store.writebackTechnicalPlanTaskRun({
    executionId: content.executionId,
    manifestHash: content.manifestHash,
    targetStageGeneration: content.targetStageGeneration,
    checkpoint: {
      status: 'success',
      input: {},
      result: 'content-retained',
      completed_item_ids: ['rollback-node-1'],
    },
    validate: () => undefined,
    apply: () => store.updateTechnicalPlan({
      contentGenerationSections: contentSections('回滚前 J-Core 正文'),
      contentGenerationTask: { ...contentTask, status: 'success', progress: 100 },
      contentGenerationRuntime: { completed_item_ids: ['rollback-node-1'] },
    }),
  });
  return {
    global: store.getTechnicalPlanRunRecord(global.executionId),
    globalReceipt,
    content: store.getTechnicalPlanRunRecord(content.executionId),
    contentReceipt,
  };
}

function snapshot(store, paths) {
  const state = store.loadTechnicalPlan();
  return {
    stageRevisions: store.currentStageRevisions(),
    globalFacts: state.globalFacts,
    content: state.contentGenerationSections,
    outline: state.outlineData,
    tender: store.readTenderMarkdown(),
    originalPlan: store.readOriginalPlanMarkdown(),
    directories: {
      technicalPlan: fs.existsSync(paths.technicalPlanDir),
      uploads: fs.existsSync(paths.uploadsDir),
      uploadedAsset: fs.existsSync(path.join(paths.uploadsDir, 'existing-upload.txt')),
    },
  };
}

function assertRunRecord(record, label) {
  assert.ok(record, `${label} run manifest 必须保留`);
  assert.equal(record.status, 'succeeded', `${label} run receipt 必须为 succeeded`);
  assert.ok(record.manifestHash, `${label} manifest hash 必须保留`);
  assert.ok(record.manifest?.execution_id, `${label} manifest execution_id 必须保留`);
  assert.ok(record.checkpoint, `${label} receipt checkpoint 必须保留`);
  assert.equal(JSON.stringify(record).includes(TEST_SECRET), false, `${label} 不得持久化明文密钥`);
}

function verifyRegistryFailsClosedInWrongOrder() {
  const { createTechnicalPlanAgentTaskRegistry } = require('../server/agent/technicalPlanAgentTaskSpecs.cjs');
  const disabled = createTechnicalPlanAgentTaskRegistry({
    env: { NODE_ENV: 'production', AGENT_QUALITY_ENABLED: 'false' },
    sidecarReadiness: { status: 'ready' },
  });
  assert.deepEqual(disabled.list(), [], '关闭开关后即使 Sidecar ready 也不得暴露 Agent Task Spec');
  const runnerUnavailable = createTechnicalPlanAgentTaskRegistry({
    env: { NODE_ENV: 'production', AGENT_QUALITY_ENABLED: 'true' },
    sidecarReadiness: { status: 'blocked' },
  });
  assert.deepEqual(runnerUnavailable.list(), [], 'Runner 未就绪时不得暴露 Agent Task Spec');
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-j3-rollback-'));
  const checks = [];
  let first;
  let second;
  try {
    first = await seedFixture(root);
    const runs = seedSuccessfulJCoreRuns(first.store);
    const expected = snapshot(first.store, first.paths);
    assertRunRecord(runs.global, '初始全局事实');
    assertRunRecord(runs.content, '初始正文');
    first.database.close();
    first = null;
    checks.push({ name: 'persist_jcore_workspace', status: 'ok' });

    const previousFlag = process.env.AGENT_QUALITY_ENABLED;
    process.env.AGENT_QUALITY_ENABLED = '0';
    try {
      second = openStore(root);
      const after = snapshot(second.store, second.paths);
      assert.deepEqual(after, expected, '关闭 Agent 后已有 Workspace 数据必须完整保留');
      assertRunRecord(second.store.getTechnicalPlanRunRecord(runs.global.executionId), '回滚后全局事实');
      assertRunRecord(second.store.getTechnicalPlanRunRecord(runs.content.executionId), '回滚后正文');
      checks.push({ name: 'rollback_restart_preserves_data', status: 'ok' });

      const beforeJCore = second.store.loadTechnicalPlan();
      second.store.saveChapterContent({ nodeId: 'rollback-node-1', content: '回滚后 J-Core 继续执行并写入正文。' });
      const afterJCore = second.store.loadTechnicalPlan();
      assert.equal(afterJCore.contentGenerationSections['rollback-node-1'].status, 'success', '回滚后 J-Core 必须可继续写入正文');
      assert.notDeepEqual(second.store.currentStageRevisions(), expected.stageRevisions, 'J-Core 执行必须产生新的 content revision');
      assert.equal(beforeJCore.outlineData.outline[0].children[0].id, 'rollback-node-1', 'J-Core 重新加载目录必须成功');
      checks.push({ name: 'rollback_jcore_load_and_execute', status: 'ok' });
    } finally {
      if (previousFlag === undefined) delete process.env.AGENT_QUALITY_ENABLED;
      else process.env.AGENT_QUALITY_ENABLED = previousFlag;
    }
    second.database.close();
    second = null;

    verifyRegistryFailsClosedInWrongOrder();
    checks.push({ name: 'rollback_order_fail_closed', status: 'ok' });
    const output = JSON.stringify({ checks });
    assert.equal(output.includes(TEST_SECRET), false, 'rollback smoke 输出不得包含密钥');
    assert.equal(output.includes(root), false, 'rollback smoke 输出不得包含临时绝对路径');
    printResult({ status: 'ok', check: 'rollback_smoke', mode: 'sqlite_runtime_fixture', checks });
  } catch (error) {
    printResult({
      status: 'fail',
      check: 'rollback_smoke',
      mode: 'sqlite_runtime_fixture',
      message: redactText(error?.message || 'rollback smoke failed'),
      checks,
    });
    process.exitCode = 1;
  } finally {
    try { first?.database.close(); } catch {}
    try { second?.database.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  printResult({ status: 'fail', check: 'rollback_smoke', message: redactText(error?.message || String(error)) });
  process.exitCode = 1;
});
