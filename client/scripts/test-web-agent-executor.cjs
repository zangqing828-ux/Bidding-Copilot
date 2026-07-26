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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
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
      assert.throws(() => createBusinessAgentTaskRegistry({
        specs: [{ ...spec, applyResult: async () => {} }],
        env: { NODE_ENV: 'test' },
      }));
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

    await run('异步 applyResult 与异步 operation 均 fail closed，零业务写入', async () => {
      inputRevision = 4;
      const asyncApplySpec = {
        ...spec,
        applyResult: async (_validated, tx) => {
          await Promise.resolve();
          tx.applyDeclaredOperation('fixture-apply', { value: 'escaped' });
        },
      };
      await assert.rejects(
        committer.commit({
          envelope: { ...envelope, executionId: 'async-apply', runId: 'async-apply', inputRevision: 4 },
          taskSpec: asyncApplySpec,
          validatedOutput: { expectedRevision: 4, value: 'escaped' },
          outputSha256: hash('async-apply'),
        }),
        (error) => error?.code === 'AGENT_APPLY_FAILED',
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fixture_results').get().count, 1);
      let delayedErrorCode = null;
      let delayedCall = null;
      const delayedApplySpec = {
        ...spec,
        applyResult(_validated, tx) {
          delayedCall = Promise.resolve().then(() => tx.applyDeclaredOperation('fixture-apply', { value: 'late' }))
            .catch((error) => { delayedErrorCode = error.code; });
        },
      };
      await assert.rejects(
        committer.commit({
          envelope: { ...envelope, executionId: 'delayed-apply', runId: 'delayed-apply', inputRevision: 4 },
          taskSpec: delayedApplySpec,
          validatedOutput: { expectedRevision: 4, value: 'late' },
          outputSha256: hash('delayed-apply'),
        }),
        (error) => error?.code === 'AGENT_APPLY_FAILED',
      );
      await delayedCall;
      assert.equal(delayedErrorCode, 'AGENT_APPLY_FAILED');
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fixture_results').get().count, 1);
      assert.throws(() => createAgentResultCommitter({
        db,
        mutationExecutor,
        readInputRevision: () => inputRevision,
        operations: { 'fixture-apply': async () => ({ entityId: 'bad' }) },
      }), (error) => error?.code === 'AGENT_APPLY_FAILED');
    });

    await run('Task Spec 吞掉 operation 异常或 thenable 时，业务结果与账本仍完整回滚', async () => {
      inputRevision = 4;
      const ledgerCountBefore = db.prepare('SELECT COUNT(*) AS count FROM agent_result_applications').get().count;
      const swallowingSpec = {
        ...spec,
        applyResult(validated, tx) {
          try { tx.applyDeclaredOperation('fixture-apply', validated); } catch {}
        },
      };
      const throwingCommitter = createAgentResultCommitter({
        db,
        mutationExecutor,
        readInputRevision: () => inputRevision,
        operations: { 'fixture-apply': () => { throw new Error('operation failed'); } },
      });
      await assert.rejects(
        throwingCommitter.commit({
          envelope: { ...envelope, executionId: 'swallowed-throw', runId: 'swallowed-throw', inputRevision: 4 },
          taskSpec: swallowingSpec,
          validatedOutput: { expectedRevision: 4, value: 'ignored' },
          outputSha256: hash('swallowed-throw'),
        }),
        (error) => error?.code === 'AGENT_APPLY_FAILED',
      );
      const thenableCommitter = createAgentResultCommitter({
        db,
        mutationExecutor,
        readInputRevision: () => inputRevision,
        operations: { 'fixture-apply': () => Promise.reject(new Error('thenable rejected')) },
      });
      await assert.rejects(
        thenableCommitter.commit({
          envelope: { ...envelope, executionId: 'swallowed-thenable', runId: 'swallowed-thenable', inputRevision: 4 },
          taskSpec: swallowingSpec,
          validatedOutput: { expectedRevision: 4, value: 'ignored' },
          outputSha256: hash('swallowed-thenable'),
        }),
        (error) => error?.code === 'AGENT_APPLY_FAILED',
      );
      const partialCommitter = createAgentResultCommitter({
        db,
        mutationExecutor,
        readInputRevision: () => inputRevision,
        operations: {
          'fixture-apply': () => {
            db.prepare('INSERT INTO fixture_results (id, value) VALUES (?, ?)').run('partial-write', 'must rollback');
            throw new Error('after partial write');
          },
        },
      });
      await assert.rejects(
        partialCommitter.commit({
          envelope: { ...envelope, executionId: 'swallowed-partial', runId: 'swallowed-partial', inputRevision: 4 },
          taskSpec: swallowingSpec,
          validatedOutput: { expectedRevision: 4, value: 'ignored' },
          outputSha256: hash('swallowed-partial'),
        }),
        (error) => error?.code === 'AGENT_APPLY_FAILED',
      );
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM fixture_results WHERE id = 'partial-write'").get().count, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_result_applications').get().count, ledgerCountBefore);
    });

    await run('取消在 mutation queue 等待时零写入；BEGIN IMMEDIATE 后允许原子提交', async () => {
      inputRevision = 4;
      const blockedMutationExecutor = createWorkspaceMutationExecutor();
      const hold = new Promise((resolve) => setTimeout(resolve, 15));
      const blocker = blockedMutationExecutor.execute(() => hold);
      const linearizedIds = [];
      const linearizedSpec = {
        ...spec,
        applyResult(validated, tx) { tx.applyDeclaredOperation('fixture-linearized', validated); },
        commitOperationId: 'fixture-linearized',
      };
      const linearizedCommitter = createAgentResultCommitter({
        db,
        mutationExecutor: blockedMutationExecutor,
        readInputRevision: () => inputRevision,
        operations: {
          'fixture-linearized': (payload) => {
            db.prepare('INSERT INTO fixture_results (id, value) VALUES (?, ?)').run(payload.id, payload.value);
            return { entityId: payload.id };
          },
        },
      });
      const beforeController = new AbortController();
      const beforeCommit = linearizedCommitter.commit({
        envelope: { ...envelope, executionId: 'before-linearized', runId: 'before-linearized', inputRevision: 4 },
        taskSpec: linearizedSpec,
        validatedOutput: { expectedRevision: 4, id: 'before-linearized', value: 'never' },
        outputSha256: hash('before-linearized'),
        signal: beforeController.signal,
      });
      beforeController.abort(Object.assign(new Error('cancel before transaction'), { code: 'AGENT_CANCELLED' }));
      await blocker;
      await assert.rejects(beforeCommit, (error) => error?.code === 'AGENT_CANCELLED');
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM fixture_results WHERE id = 'before-linearized'").get().count, 0);

      const afterController = new AbortController();
      const receipt = await linearizedCommitter.commit({
        envelope: { ...envelope, executionId: 'after-linearized', runId: 'after-linearized', inputRevision: 4 },
        taskSpec: linearizedSpec,
        validatedOutput: { expectedRevision: 4, id: 'after-linearized', value: 'committed' },
        outputSha256: hash('after-linearized'),
        signal: afterController.signal,
        onLinearized() {
          linearizedIds.push('after-linearized');
          afterController.abort(Object.assign(new Error('cancel after begin'), { code: 'AGENT_CANCELLED' }));
        },
      });
      assert.equal(receipt.executionId, 'after-linearized');
      assert.deepEqual(linearizedIds, ['after-linearized']);
      assert.equal(db.prepare("SELECT value FROM fixture_results WHERE id = 'after-linearized'").get().value, 'committed');
      await blockedMutationExecutor.close();
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

    await run('相同 execution 并发调用只执行一次 preparation 与 runner', async () => {
      const executionHash = hash('single-flight-input');
      let captureCount = 0;
      let persistCount = 0;
      let buildInputCount = 0;
      let buildPromptCount = 0;
      let runnerCount = 0;
      const gate = new Promise((resolve) => setTimeout(resolve, 10));
      const singleFlightSpec = {
        ...createFixtureSpec(),
        captureSnapshot: async (reader) => {
          captureCount += 1;
          await gate;
          return { inputRevision: reader.getInputRevision(), inputHash: executionHash, readonlySnapshot: { input: 'once' } };
        },
        buildInput: async () => { buildInputCount += 1; return { 'input/fixed.txt': 'once' }; },
        buildPrompt: async () => { buildPromptCount += 1; return 'once'; },
        validateOutput: async (value) => value,
      };
      const registry = createBusinessAgentTaskRegistry({ specs: [singleFlightSpec], env: { NODE_ENV: 'test' } });
      const executor = createBusinessAgentExecutor({
        workspaceId: 'workspace-single-flight',
        registry,
        coordinator: createAgentCoordinator(),
        committer: {
          findApplied: () => null,
          commit: async ({ envelope: committedEnvelope }) => ({ executionId: committedEnvelope.executionId, outputSha256: hash('single-flight-output'), appliedAt: '2026-07-27T00:00:00.000Z', resultLocator: { entityId: 'once' } }),
        },
        snapshotReader: { getInputRevision: () => 9, readBinding: () => 'once' },
        aiService: { captureTextModelSnapshot: () => ({ provider: 'test', baseUrl: 'http://127.0.0.1', modelName: 'fixture', apiKey: 'test' }) },
        runner: { run: async () => { runnerCount += 1; return { output: { expectedRevision: 9, value: 'once' }, outputSha256: hash('single-flight-output') }; } },
      });
      const request = {
        executionId: 'single-flight', workspaceId: 'workspace-single-flight', taskSpecVersion: 1,
        executionEnvelope: { inputRevision: 9, inputHash: executionHash }, ownerCancellationToken: {},
        taskController: { persistExecutionEnvelope: async () => { persistCount += 1; }, reconcileAppliedExecution: async () => {}, projectAgentStage: () => {} },
      };
      const [first, second] = await Promise.all([executor.execute('contract-fixture', request), executor.execute('contract-fixture', { ...request, ownerCancellationToken: {} })]);
      assert.strictEqual(first, second);
      await first.result;
      assert.deepEqual({ captureCount, persistCount, buildInputCount, buildPromptCount, runnerCount }, {
        captureCount: 1, persistCount: 1, buildInputCount: 1, buildPromptCount: 1, runnerCount: 1,
      });
    });

    await run('Workspace close 会等待 buildPrompt preparation 收口，且不得发布 accepted 或启动 runner', async () => {
      const executionHash = hash('close-during-preparation');
      const coordinator = createAgentCoordinator();
      const workspaceLease = coordinator.registerWorkspace('workspace-preparation-close');
      const promptStarted = deferred();
      const releasePrompt = deferred();
      const events = [];
      let runnerCount = 0;
      const closingSpec = {
        ...createFixtureSpec(),
        captureSnapshot: async (reader) => ({ inputRevision: reader.getInputRevision(), inputHash: executionHash, readonlySnapshot: { input: 'close' } }),
        buildInput: async () => ({ 'input/fixed.txt': 'close' }),
        buildPrompt: async () => {
          promptStarted.resolve();
          await releasePrompt.promise;
          return 'late prompt';
        },
        validateOutput: async (value) => value,
      };
      const executor = createBusinessAgentExecutor({
        workspaceId: 'workspace-preparation-close',
        workspaceLease,
        registry: createBusinessAgentTaskRegistry({ specs: [closingSpec], env: { NODE_ENV: 'test' } }),
        coordinator,
        committer: { findApplied: () => null, commit: async () => { throw new Error('must not commit'); } },
        snapshotReader: { getInputRevision: () => 7, readBinding: () => 'close' },
        aiService: { captureTextModelSnapshot: () => ({ provider: 'test', baseUrl: 'http://127.0.0.1', modelName: 'fixture', apiKey: 'test' }) },
        runner: { run: async () => { runnerCount += 1; return { output: {}, outputSha256: hash('never') }; } },
      });
      const executePromise = executor.execute('contract-fixture', {
        executionId: 'close-during-build-prompt', workspaceId: 'workspace-preparation-close', taskSpecVersion: 1,
        executionEnvelope: { inputRevision: 7, inputHash: executionHash }, ownerCancellationToken: {},
        taskController: { persistExecutionEnvelope: async () => {}, reconcileAppliedExecution: async () => {}, projectAgentStage: (event) => events.push(event.phase) },
      });
      await promptStarted.promise;
      const closing = workspaceLease.close();
      let closeCompleted = false;
      void closing.then(() => { closeCompleted = true; });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(closeCompleted, false);
      releasePrompt.resolve();
      await assert.rejects(executePromise, (error) => error?.code === 'AGENT_CLOSING');
      await closing;
      assert.equal(runnerCount, 0);
      assert.equal(events.includes('accepted'), false);
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
