const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSqliteDatabase, schemaVersion } = require('../core/sqliteDatabase.cjs');
const { createWorkspaceMutationExecutor } = require('../server/workspace/workspaceMutationExecutor.cjs');
const { createAgentResultCommitter } = require('../server/agent/agentResultCommitter.cjs');
const { createBusinessAgentTaskRegistry } = require('../server/agent/businessAgentTaskRegistry.cjs');
const { createBusinessAgentExecutor } = require('../server/agent/businessAgentExecutor.cjs');
const { createAgentCoordinator } = require('../server/agent/agentCoordinator.cjs');

const passed = [];
const failed = [];
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

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

function createFixtureSpec() {
  return {
    id: 'contract-fixture',
    version: 1,
    runtime: 'opencode',
    capabilities: { read: ['input/**'], glob: true, grep: true, bash: false, network: false },
    limits: { timeoutMs: 120000, maxInputBytes: 1024, maxOutputBytes: 1024, maxModelCalls: 2, maxTotalTokens: 256 },
    inputBindings: ['fixture-input'],
    commitOperationId: 'fixture-apply',
    testOnly: true,
    async captureSnapshot() {},
    buildInput() {},
    buildPrompt() {},
    validateOutput() {},
    applyResult(validated, tx) {
      tx.assertInputRevision(validated.expectedRevision);
      tx.applyDeclaredOperation('fixture-apply', validated);
    },
  };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bidmaster-agent-commit-'));
  const databasePath = path.join(root, 'workspace.sqlite');
  const sqlite = createSqliteDatabase({ databasePath });
  const { db } = sqlite;
  let inputRevision = 3;
  db.exec('CREATE TABLE fixture_results (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const mutationExecutor = createWorkspaceMutationExecutor();
  const spec = createFixtureSpec();
  const committer = createAgentResultCommitter({
    db,
    mutationExecutor,
    readInputRevision: () => inputRevision,
    operations: {
      'fixture-apply': (payload) => {
        db.prepare('INSERT INTO fixture_results (id, value) VALUES (?, ?)').run('one', payload.value);
        return { entityId: 'one', version: 1 };
      },
    },
    clock: () => '2026-07-27T00:00:00.000Z',
  });
  const envelope = {
    executionId: 'execution-one',
    runId: 'run-one',
    taskSpecId: spec.id,
    taskSpecVersion: spec.version,
    inputRevision: 3,
    inputHash: hash('input-one'),
  };
  try {
    await run('生产注册表为空，测试 fixture 仅在 test 环境可注册', async () => {
      const productionRegistry = createBusinessAgentTaskRegistry({ env: { NODE_ENV: 'production' } });
      assert.equal(productionRegistry.size, 0);
      assert.throws(() => createBusinessAgentTaskRegistry({ specs: [spec], env: { NODE_ENV: 'production' } }));
      const testRegistry = createBusinessAgentTaskRegistry({ specs: [spec], env: { NODE_ENV: 'test' } });
      assert.equal(testRegistry.get('contract-fixture', 1).id, 'contract-fixture');
    });

    await run('runtime migration 创建 Agent 幂等账本并与 schema 版本一致', async () => {
      assert.equal(schemaVersion, 22);
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_result_applications'").get();
      assert.equal(table.name, 'agent_result_applications');
    });

    await run('一次提交同时写入业务结果与账本，重复 execution 不重复 apply', async () => {
      const first = await committer.commit({
        envelope,
        taskSpec: spec,
        validatedOutput: { expectedRevision: 3, value: 'applied' },
        outputSha256: hash('output-one'),
      });
      const second = await committer.commit({
        envelope: { ...envelope, runId: 'run-two' },
        taskSpec: spec,
        validatedOutput: { expectedRevision: 3, value: 'should-not-apply' },
        outputSha256: hash('different-output'),
      });
      assert.deepEqual(second, first);
      assert.equal(db.prepare('SELECT value FROM fixture_results WHERE id = ?').get('one').value, 'applied');
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_result_applications').get().count, 1);
      assert.deepEqual(committer.findApplied('execution-one'), first);
    });

    await run('同 execution 的 immutable envelope 冲突会拒绝，输入 revision 变化零写入', async () => {
      await assert.rejects(
        committer.commit({
          envelope: { ...envelope, inputHash: hash('other-input') },
          taskSpec: spec,
          validatedOutput: { expectedRevision: 3, value: 'bad' },
          outputSha256: hash('bad'),
        }),
        (error) => error?.code === 'AGENT_EXECUTION_CONFLICT',
      );
      inputRevision = 4;
      await assert.rejects(
        committer.commit({
          envelope: { ...envelope, executionId: 'execution-two', runId: 'run-three' },
          taskSpec: spec,
          validatedOutput: { expectedRevision: 3, value: 'stale' },
          outputSha256: hash('stale'),
        }),
        (error) => error?.code === 'AGENT_INPUT_CHANGED',
      );
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fixture_results').get().count, 1);
    });

    await run('Executor 只经受限端口冻结输入、持久化 envelope 后再调用 runner', async () => {
      const executionHash = hash('executor-input');
      const executorSpec = {
        ...createFixtureSpec(),
        captureSnapshot: async (reader) => ({
          inputRevision: reader.getInputRevision(),
          inputHash: executionHash,
          readonlySnapshot: { input: reader.readBinding('fixture-input') },
        }),
        buildInput: async (snapshot) => ({ 'input/fixed.txt': snapshot.input }),
        buildPrompt: async () => 'fixture prompt',
        validateOutput: async (output) => output,
      };
      const registry = createBusinessAgentTaskRegistry({ specs: [executorSpec], env: { NODE_ENV: 'test' } });
      const calls = [];
      const executor = createBusinessAgentExecutor({
        workspaceId: 'workspace-a',
        registry,
        coordinator: createAgentCoordinator(),
        committer: {
          findApplied: () => null,
          commit: async ({ envelope: committedEnvelope }) => ({
            executionId: committedEnvelope.executionId,
            outputSha256: hash('executor-output'),
            appliedAt: '2026-07-27T00:00:00.000Z',
            resultLocator: { entityId: 'fixture' },
          }),
        },
        snapshotReader: { getInputRevision: () => 4, readBinding: (bindingId) => (bindingId === 'fixture-input' ? 'frozen input' : null) },
        aiService: { captureTextModelSnapshot: () => ({ modelName: 'fixture', apiKey: 'test-only', baseUrl: 'http://127.0.0.1', provider: 'test' }) },
        runner: {
          run: async ({ input, prompt }) => {
            calls.push(['runner', input, prompt]);
            return { output: { expectedRevision: 4, value: 'ok' }, outputSha256: hash('executor-output') };
          },
        },
      });
      const ownerCancellationToken = {};
      const handle = await executor.execute('contract-fixture', {
        executionId: 'executor-one',
        workspaceId: 'workspace-a',
        taskSpecVersion: 1,
        executionEnvelope: { inputRevision: 4, inputHash: executionHash },
        ownerCancellationToken,
        taskController: {
          persistExecutionEnvelope: async () => calls.push(['persist']),
          reconcileAppliedExecution: async () => calls.push(['reconcile']),
          projectAgentStage: (event) => calls.push([event.phase]),
        },
      });
      const receipt = await handle.result;
      assert.equal(receipt.executionId, 'executor-one');
      assert.deepEqual(calls.slice(0, 2), [['persist'], ['accepted']]);
      assert.deepEqual(calls.find((entry) => entry[0] === 'runner')[1], { 'input/fixed.txt': 'frozen input' });
      assert.throws(() => handle.cancel({}, new Error('unauthorized')));
    });
  } finally {
    await mutationExecutor.close();
    sqlite.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().finally(() => {
  console.log(`Web Agent Executor 测试：${passed.length} 通过，${failed.length} 失败`);
  for (const message of failed) console.error(`  FAIL: ${message}`);
  process.exitCode = failed.length ? 1 : 0;
});
