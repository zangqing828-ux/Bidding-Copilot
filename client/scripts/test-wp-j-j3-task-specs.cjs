const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSqliteDatabase } = require('../core/sqliteDatabase.cjs');
const { createTechnicalPlanStore } = require('../core/stores/technicalPlanStore.cjs');
const { createWorkspaceMutationExecutor } = require('../server/workspace/workspaceMutationExecutor.cjs');
const { createAgentResultCommitter } = require('../server/agent/agentResultCommitter.cjs');
const { createAgentCoordinator } = require('../server/agent/agentCoordinator.cjs');
const { createBusinessAgentTaskRegistry } = require('../server/agent/businessAgentTaskRegistry.cjs');
const { createBusinessAgentExecutor } = require('../server/agent/businessAgentExecutor.cjs');
const {
  SNAPSHOT_BINDING,
  TECHNICAL_PLAN_AGENT_SPEC_IDS,
  createTechnicalPlanAgentTaskRegistry,
  createTechnicalPlanAgentTaskSpecs,
  sha256,
} = require('../server/agent/technicalPlanAgentTaskSpecs.cjs');

const specs = createTechnicalPlanAgentTaskSpecs();
const passed = [];
const failed = [];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(name, callback) {
  try {
    await callback();
    passed.push(name);
    console.log(`  PASS: ${name}`);
  } catch (error) {
    failed.push(`${name}: ${error.message}`);
    console.error(`  FAIL: ${name}: ${error.message}`);
  }
}

function makeStoreFixture(label) {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), `bidmaster-wp-j3-${label}-`));
  const databasePath = path.join(workspaceRoot, 'workspace.sqlite');
  const sqlite = createSqliteDatabase({ databasePath });
  const store = createTechnicalPlanStore({
    db: sqlite.db,
    workspaceRoot,
    workspaceRuntimeGeneration: 1,
  });
  store.saveOutline({
    outlineData: {
      project_name: 'Agent Quality 测试方案',
      project_overview: '用于验证受控技术方案修复链路。',
      outline: [{
        id: '1',
        title: '实施方案',
        description: '说明实施组织、流程、质量和验收。',
        source_requirement_id: 'requirement-1',
        source_requirement_title: '实施要求',
        children: [
          { id: '1.1', title: '实施组织', description: '说明项目组织和职责。' },
          { id: '1.2', title: '质量控制', description: '说明质量控制和验收。' },
        ],
      }],
    },
  });
  store.saveGlobalFacts([{ id: 'fact-1', title: '项目事实', content: '项目周期为四个月。' }]);
  store.saveChapterContent({ nodeId: '1.1', content: '原始实施组织正文。' });
  store.saveChapterContent({ nodeId: '1.2', content: '原始质量控制正文。' });
  return { ...sqlite, store, workspaceRoot };
}

function captureFor(store, spec, request = {}) {
  const snapshotReader = {
    getInputRevision: () => store.loadTechnicalPlan().inputRevision,
    readBinding: (bindingId) => {
      assert.equal(bindingId, SNAPSHOT_BINDING);
      return store.readAgentQualitySnapshot(request);
    },
  };
  return { snapshotReader, captured: spec.captureSnapshot(snapshotReader) };
}

function commonOutput(spec, captured, snapshot) {
  return {
    schema_version: spec.id,
    base_input_revision: captured.inputRevision,
    base_stage_revisions: clone(snapshot.stage_revisions),
    source_snapshot_hash: captured.inputHash,
  };
}

function outlineSemanticOnly(items) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    id: item.id,
    title: item.title,
    description: item.description,
    ...(item.source_requirement_id ? { source_requirement_id: item.source_requirement_id } : {}),
    ...(item.source_requirement_title ? { source_requirement_title: item.source_requirement_title } : {}),
    ...(Array.isArray(item.children) && item.children.length ? { children: outlineSemanticOnly(item.children) } : {}),
  }));
}

function validOutput(spec, captured, snapshot) {
  const base = commonOutput(spec, captured, snapshot);
  switch (spec.id) {
    case 'technical-plan.outline-repair.v1':
      return {
        ...base,
        outline: outlineSemanticOnly(snapshot.outline.outline),
        repair_summary: '补齐目录层级与实施要求。',
      };
    case 'technical-plan.outline-word-adjust.v1':
      return {
        ...base,
        outline: outlineSemanticOnly(snapshot.outline.outline),
        word_control: {
          enabled: true,
          minimumWords: 1000,
          maximumWords: 6000,
          sectionWords: 2000,
          strictSectionWords: false,
        },
        repair_summary: '按冻结字数配置调整叶子章节。',
      };
    case 'technical-plan.content-repair.v1':
      return {
        ...base,
        node_id: '1.1',
        content: '修复后的实施组织正文，包含项目经理、专业负责人和交付团队的职责边界。',
        repair_summary: '补齐实施组织职责和交付协同。',
      };
    case 'technical-plan.original-coverage-repair.v1':
      return {
        ...base,
        node_id: '1.1',
        content: '基于原方案覆盖结果补齐的实施组织正文，保留既有交付方法并补充验收责任。',
        source_ids: ['original-section-1'],
        covered_requirements: ['requirement-1'],
        repair_summary: '补齐原方案覆盖缺口。',
      };
    case 'technical-plan.consistency-repair.v1':
      return {
        ...base,
        changes: [
          { node_id: '1.1', content: '统一后的实施组织正文，项目周期统一表述为四个月。', reason: '与全局事实保持一致。' },
          { node_id: '1.2', content: '统一后的质量控制正文，项目周期统一表述为四个月。', reason: '消除跨章节事实差异。' },
        ],
        repair_summary: '统一项目周期事实。',
      };
    case 'technical-plan.illustration-plan.v1':
      return {
        ...base,
        plan_version: 1,
        content_revision: snapshot.stage_revisions.content_revision,
        outline_revision: snapshot.stage_revisions.outline_revision,
        manifest_hash: sha256(snapshot),
        revision: `content-${snapshot.stage_revisions.content_revision}-outline-${snapshot.stage_revisions.outline_revision}`,
        items: [{
          item_id: 'illustration-1',
          kind: 'mermaid',
          image_type: 'process',
          title: '实施交付流程',
          section_ids: ['1.1'],
          placement: 'after',
          priority: 4,
          intent: '展示实施组织到验收的流程。',
        }],
      };
    default:
      throw new Error(`未覆盖 Spec ${spec.id}`);
  }
}

function makeEnvelope(spec, executionId, captured, runId = `${executionId}-run-1`) {
  return {
    executionId,
    runId,
    taskSpecId: spec.id,
    taskSpecVersion: spec.version,
    inputRevision: captured.inputRevision,
    inputHash: captured.inputHash,
  };
}

function makeCommitter(fixture, operations = fixture.store.getAgentQualityOperations()) {
  return createAgentResultCommitter({
    db: fixture.db,
    mutationExecutor: createWorkspaceMutationExecutor(),
    readInputRevision: () => fixture.store.loadTechnicalPlan().inputRevision,
    operations,
    clock: () => '2026-07-27T00:00:00.000Z',
  });
}

function makeInvalidOutput(spec, output, kind) {
  const invalid = clone(output);
  if (kind === 'missing') {
    delete invalid.schema_version;
  } else if (kind === 'extra') {
    invalid.unclaimed_output = 'must fail';
  } else if (kind === 'oversized') {
    if (spec.id === 'technical-plan.illustration-plan.v1') invalid.items = Array.from({ length: 101 }, (_, index) => ({
      item_id: `item-${index}`,
      kind: 'mermaid',
      image_type: 'process',
      title: `流程${index}`,
      section_ids: [`1.${(index % 2) + 1}`],
      placement: 'after',
      priority: 1,
    }));
    else if (spec.id === 'technical-plan.consistency-repair.v1') invalid.changes = Array.from({ length: 101 }, (_, index) => ({
      node_id: `1.${(index % 2) + 1}`,
      content: `变更${index}`,
      reason: '超出变更数量限制',
    }));
    else if (spec.id === 'technical-plan.content-repair.v1' || spec.id === 'technical-plan.original-coverage-repair.v1') invalid.content = 'x'.repeat(120_001);
    else invalid.repair_summary = 'x'.repeat(4_001);
  } else if (kind === 'semantic') {
    if (spec.id === 'technical-plan.outline-repair.v1' || spec.id === 'technical-plan.outline-word-adjust.v1') {
      invalid.outline[0].children[0].title = invalid.outline[0].children[1].title;
    } else if (spec.id === 'technical-plan.original-coverage-repair.v1') {
      invalid.source_ids = ['same', 'same'];
    } else if (spec.id === 'technical-plan.consistency-repair.v1') {
      invalid.changes[1].node_id = invalid.changes[0].node_id;
    } else if (spec.id === 'technical-plan.illustration-plan.v1') {
      invalid.items[0].section_ids = ['1.1', '1.2'];
      invalid.items[0].kind = 'ai';
    } else {
      invalid.word_control = { enabled: true, minimumWords: 10, maximumWords: 1, sectionWords: 0, strictSectionWords: false };
    }
  }
  return invalid;
}

async function commitOnce(fixture, spec, output, { executionId, operations } = {}) {
  const committer = makeCommitter(fixture, operations);
  const envelope = makeEnvelope(spec, executionId || `${spec.id}-execution`, {
    inputRevision: output.base_input_revision,
    inputHash: output.source_snapshot_hash,
  });
  return committer.commit({
    envelope,
    taskSpec: spec,
    validatedOutput: output,
    outputSha256: sha256({ spec: spec.id, executionId: envelope.executionId, output }),
  });
}

async function testRegistryGate() {
  const off = createTechnicalPlanAgentTaskRegistry({ env: { NODE_ENV: 'production', AGENT_QUALITY_ENABLED: 'false' } });
  assert.equal(off.size, 0, '默认关闭时生产 registry 必须为空');
  const blocked = createTechnicalPlanAgentTaskRegistry({ env: { NODE_ENV: 'production', AGENT_QUALITY_ENABLED: 'true' }, sidecarReadiness: { status: 'blocked' } });
  assert.equal(blocked.size, 0, 'sidecar 未 ready 时生产 registry 必须为空');
  const open = createTechnicalPlanAgentTaskRegistry({ env: { NODE_ENV: 'production', AGENT_QUALITY_ENABLED: 'true' }, sidecarReadiness: { status: 'ready' } });
  assert.equal(open.size, 6, '开关和 sidecar readiness 均通过后必须开放六个 Spec');
  assert.deepEqual(open.list().map((item) => item.id), TECHNICAL_PLAN_AGENT_SPEC_IDS);
}

async function testSchemasAndBounds() {
  for (const spec of specs) {
    const fixture = makeStoreFixture(`schema-${spec.id.replace(/[^a-z0-9]+/gi, '-')}`);
    const { captured } = captureFor(fixture.store, spec);
    const output = validOutput(spec, captured, captured.readonlySnapshot);
    assert.deepEqual(spec.validateOutput(output).schema_version, spec.id);
    for (const kind of ['missing', 'extra', 'oversized', 'semantic']) {
      assert.throws(() => spec.validateOutput(makeInvalidOutput(spec, output, kind)), (error) => error?.code === 'AGENT_OUTPUT_INVALID', `${spec.id} ${kind} 必须返回 AGENT_OUTPUT_INVALID`);
    }
    fixture.db.close();
  }
}

async function testCommitAndReceiptRecovery() {
  for (const spec of specs) {
    const fixture = makeStoreFixture(`commit-${spec.id.replace(/[^a-z0-9]+/gi, '-')}`);
    const { captured } = captureFor(fixture.store, spec);
    const output = spec.validateOutput(validOutput(spec, captured, captured.readonlySnapshot));
    const committer = makeCommitter(fixture);
    const envelope = makeEnvelope(spec, `receipt-${spec.id}`, captured);
    const first = await committer.commit({
      envelope,
      taskSpec: spec,
      validatedOutput: output,
      outputSha256: sha256('first-output'),
    });
    const second = await committer.commit({
      envelope: { ...envelope, runId: 'different-run-id' },
      taskSpec: spec,
      validatedOutput: output,
      outputSha256: sha256('second-output'),
    });
    assert.deepEqual(second, first, `${spec.id} 重试必须从 ledger 恢复相同 receipt`);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM agent_result_applications').get().count, 1, `${spec.id} ledger 只能有一条应用记录`);
    if (spec.id === 'technical-plan.illustration-plan.v1') {
      const state = fixture.store.loadTechnicalPlan();
      assert.equal(state.contentIllustrationPlan.plan_version, 1, 'IllustrationPlan 必须使用 v1 计划字段');
      assert.deepEqual(state.contentIllustrationRenderReceipts, {}, 'IllustrationPlan 不得生成 render receipt');
      assert.equal(state.contentIllustrationPlan.items.some((item) => Object.prototype.hasOwnProperty.call(item, 'generation')), false, 'IllustrationPlan 不得写入 generation');
    }
    fixture.db.close();
  }
}

async function testCasAndOperationFailures() {
  for (const spec of specs) {
    const baseFixture = makeStoreFixture(`cas-${spec.id.replace(/[^a-z0-9]+/gi, '-')}`);
    const { captured } = captureFor(baseFixture.store, spec);
    const valid = spec.validateOutput(validOutput(spec, captured, captured.readonlySnapshot));
    baseFixture.db.prepare('UPDATE technical_plan_meta SET input_revision = input_revision + 1 WHERE id = 1').run();
    await assert.rejects(commitOnce(baseFixture, spec, valid, { executionId: `cas-${spec.id}` }), (error) => error?.code === 'AGENT_INPUT_CHANGED');
    assert.equal(baseFixture.db.prepare('SELECT COUNT(*) AS count FROM agent_result_applications').get().count, 0);
    baseFixture.db.close();

    for (const failureKind of ['throw', 'thenable', 'swallow']) {
      const fixture = makeStoreFixture(`${failureKind}-${spec.id.replace(/[^a-z0-9]+/gi, '-')}`);
      const { captured: failureCaptured } = captureFor(fixture.store, spec);
      const output = spec.validateOutput(validOutput(spec, failureCaptured, failureCaptured.readonlySnapshot));
      const operation = failureKind === 'throw'
        ? () => { throw new Error('fixture operation failed'); }
        : failureKind === 'thenable'
          ? () => Promise.reject(new Error('fixture operation thenable failed'))
          : () => { throw new Error('fixture operation swallowed failed'); };
      const swallowingSpec = failureKind === 'swallow'
        ? {
          ...spec,
          applyResult(value, tx) {
            try { tx.applyDeclaredOperation(spec.commitOperationId, value); } catch {}
          },
        }
        : spec;
      const operations = { ...fixture.store.getAgentQualityOperations(), [spec.commitOperationId]: operation };
      const committer = makeCommitter(fixture, operations);
      await assert.rejects(
        committer.commit({
          envelope: makeEnvelope(spec, `${failureKind}-${spec.id}`, failureCaptured),
          taskSpec: swallowingSpec,
          validatedOutput: output,
          outputSha256: sha256(`${failureKind}-${spec.id}`),
        }),
        (error) => error?.code === 'AGENT_APPLY_FAILED',
        `${spec.id} ${failureKind} operation 必须 fail closed`,
      );
      assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM agent_result_applications').get().count, 0, `${spec.id} ${failureKind} 不得写 ledger`);
      fixture.db.close();
    }
  }
}

async function testSingleFlight() {
  for (const spec of specs) {
    const fixture = makeStoreFixture(`flight-${spec.id.replace(/[^a-z0-9]+/gi, '-')}`);
    const { snapshotReader, captured } = captureFor(fixture.store, spec);
    const output = validOutput(spec, captured, captured.readonlySnapshot);
    let runnerCount = 0;
    const registry = createBusinessAgentTaskRegistry({ specs: [spec], env: { NODE_ENV: 'test' } });
    const coordinator = createAgentCoordinator();
    const executor = createBusinessAgentExecutor({
      workspaceId: `workspace-${spec.id}`,
      registry,
      coordinator,
      committer: makeCommitter(fixture),
      snapshotReader,
      aiService: {
        captureTextModelSnapshot: () => ({ provider: 'fixture', modelName: 'fixture-model', baseUrl: 'http://agent-internal.invalid' }),
      },
      runner: {
        async run() {
          runnerCount += 1;
          await sleep(5);
          return { output, outputSha256: sha256(`${spec.id}-runner-output`) };
        },
      },
    });
    const request = {
      executionId: `single-flight-${spec.id}`,
      workspaceId: `workspace-${spec.id}`,
      taskSpecVersion: spec.version,
      executionEnvelope: { inputRevision: captured.inputRevision, inputHash: captured.inputHash },
      ownerCancellationToken: {},
      taskController: {
        persistExecutionEnvelope: async () => {},
        reconcileAppliedExecution: async () => {},
        projectAgentStage: () => {},
      },
    };
    const [first, second] = await Promise.all([
      executor.execute(spec.id, request),
      executor.execute(spec.id, { ...request, ownerCancellationToken: {} }),
    ]);
    assert.strictEqual(first, second, `${spec.id} 并发重复 execution 必须共享同一 handle`);
    await first.result;
    assert.equal(runnerCount, 1, `${spec.id} runner 必须只执行一次`);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM agent_result_applications').get().count, 1);
    await coordinator.close();
    fixture.db.close();
  }
}

async function main() {
  await run('生产 registry 受 AGENT_QUALITY_ENABLED + Sidecar readiness 双门禁', testRegistryGate);
  await run('六个 Task Spec JSON Schema、validator、未声明字段与输入输出上限', testSchemasAndBounds);
  await run('六个 Task Spec 真实 Store operation、CAS、SQLite transaction 与 receipt 恢复', testCommitAndReceiptRecovery);
  await run('六个 Task Spec operation 抛错、thenable、吞错均零写入', testCasAndOperationFailures);
  await run('六个 Task Spec 通过 BusinessAgentExecutor single-flight', testSingleFlight);
  if (failed.length) {
    console.error(`WP-J J3 T8 failed: ${failed.length} group(s)`);
    process.exitCode = 1;
    return;
  }
  console.log(`WP-J J3 T8 Task Specs passed: ${passed.length} groups`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
