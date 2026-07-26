const crypto = require('node:crypto');
const { createAgentError } = require('./agentCoordinator.cjs');

const MAX_RESULT_LOCATOR_BYTES = 2 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function normalizeEnvelope(value) {
  const source = value && typeof value === 'object' ? value : {};
  const taskSpecId = String(source.taskSpecId || '').trim();
  const taskSpecVersion = Number(source.taskSpecVersion);
  const inputRevision = Number(source.inputRevision);
  const inputHash = String(source.inputHash || '').trim();
  const executionId = String(source.executionId || '').trim();
  const runId = String(source.runId || '').trim();
  if (!executionId || !runId || !taskSpecId || !Number.isInteger(taskSpecVersion) || taskSpecVersion <= 0
    || !Number.isInteger(inputRevision) || inputRevision < 0 || !/^[a-f0-9]{64}$/i.test(inputHash)) {
    throw createAgentError('Agent 提交 envelope 无效', 'AGENT_TASK_SPEC_INVALID');
  }
  return { executionId, runId, taskSpecId, taskSpecVersion, inputRevision, inputHash };
}

function normalizeResultLocator(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createAgentError('Agent result locator 无效', 'AGENT_APPLY_FAILED', { retryable: true });
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_LOCATOR_BYTES) {
    throw createAgentError('Agent result locator 过大', 'AGENT_APPLY_FAILED', { retryable: true });
  }
  const walk = (node) => {
    if (typeof node === 'string') {
      if (node.length > 256 || /(^|[\\/])(?:data|users|workspace|agent-tasks)(?:[\\/]|$)/i.test(node)) {
        throw createAgentError('Agent result locator 包含不允许的路径或正文', 'AGENT_APPLY_FAILED', { retryable: true });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(value);
  return serialized;
}

function receiptFromRow(row) {
  return Object.freeze({
    executionId: row.execution_id,
    outputSha256: row.output_sha256,
    appliedAt: row.applied_at,
    resultLocator: JSON.parse(row.result_locator_json),
  });
}

function isThenable(value) {
  return Boolean(value && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function');
}

function assertSynchronousFunction(fn, label) {
  if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') {
    throw createAgentError(`${label} 必须是同步函数`, 'AGENT_APPLY_FAILED', { retryable: true });
  }
}

function assertSameEnvelope(row, envelope) {
  if (
    row.task_spec_id !== envelope.taskSpecId
    || Number(row.task_spec_version) !== envelope.taskSpecVersion
    || Number(row.input_revision) !== envelope.inputRevision
    || row.input_sha256 !== envelope.inputHash
  ) {
    throw createAgentError('相同 executionId 的 Agent envelope 不一致', 'AGENT_EXECUTION_CONFLICT');
  }
}

function createAgentResultCommitter({ db, mutationExecutor, readInputRevision, operations = {}, clock = nowIso }) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new Error('createAgentResultCommitter 需要 SQLite database');
  }
  if (!mutationExecutor || typeof mutationExecutor.execute !== 'function') {
    throw new Error('createAgentResultCommitter 需要 Workspace mutation executor');
  }
  if (typeof readInputRevision !== 'function') {
    throw new Error('createAgentResultCommitter 需要 input revision reader');
  }
  for (const [operationId, operation] of Object.entries(operations)) {
    assertSynchronousFunction(operation, `Agent operation ${operationId}`);
  }
  const selectApplied = db.prepare('SELECT * FROM agent_result_applications WHERE execution_id = ?');
  const insertApplied = db.prepare(`
    INSERT INTO agent_result_applications (
      idempotency_key, execution_id, run_id, task_spec_id, task_spec_version,
      input_revision, input_sha256, output_sha256, result_locator_json, applied_at
    ) VALUES (
      @idempotencyKey, @executionId, @runId, @taskSpecId, @taskSpecVersion,
      @inputRevision, @inputHash, @outputSha256, @resultLocatorJson, @appliedAt
    )
  `);

  function findApplied(executionId, immutableEnvelope = null) {
    const row = selectApplied.get(String(executionId || '').trim());
    if (row && immutableEnvelope) {
      assertSameEnvelope(row, {
        taskSpecId: String(immutableEnvelope.taskSpecId || '').trim(),
        taskSpecVersion: Number(immutableEnvelope.taskSpecVersion),
        inputRevision: Number(immutableEnvelope.inputRevision),
        inputHash: String(immutableEnvelope.inputHash || '').trim(),
      });
    }
    return row ? receiptFromRow(row) : null;
  }

  function commit({ envelope, taskSpec, validatedOutput, outputSha256, signal, onLinearized }) {
    const normalizedEnvelope = normalizeEnvelope(envelope);
    if (!taskSpec || typeof taskSpec.applyResult !== 'function') {
      return Promise.reject(createAgentError('Agent Task Spec 无效', 'AGENT_TASK_SPEC_INVALID'));
    }
    if (!/^[a-f0-9]{64}$/i.test(String(outputSha256 || ''))) {
      return Promise.reject(createAgentError('Agent 输出摘要无效', 'AGENT_OUTPUT_INVALID', { retryable: true }));
    }
    if (onLinearized !== undefined && typeof onLinearized !== 'function') {
      return Promise.reject(createAgentError('Agent 事务线性化回调无效', 'AGENT_TASK_SPEC_INVALID'));
    }
    return mutationExecutor.execute(() => {
      if (signal?.aborted) throw signal.reason || createAgentError('Agent 执行已取消', 'AGENT_CANCELLED', { retryable: true });
      const transaction = db.transaction(() => {
        // The transaction body runs only after BEGIN IMMEDIATE has acquired the SQLite write lock.
        // From this point a cancellation is deliberately linearized behind this atomic commit.
        onLinearized?.();
        const existing = selectApplied.get(normalizedEnvelope.executionId);
        if (existing) {
          assertSameEnvelope(existing, normalizedEnvelope);
          return receiptFromRow(existing);
        }
        if (Number(readInputRevision()) !== normalizedEnvelope.inputRevision) {
          throw createAgentError('Agent 输入已更新，请重新执行', 'AGENT_INPUT_CHANGED', { retryable: true });
        }
        assertSynchronousFunction(taskSpec.applyResult, 'Task Spec applyResult');
        let operationAttempted = false;
        let operationSucceeded = false;
        let operationFailure = null;
        let locator = null;
        let transactionCapabilityActive = true;
        const assertActiveCapability = () => {
          if (!transactionCapabilityActive) {
            throw createAgentError('Agent transaction capability 已过期', 'AGENT_APPLY_FAILED', { retryable: true });
          }
        };
        const commitTransaction = Object.freeze({
          assertInputRevision(expectedRevision) {
            assertActiveCapability();
            if (Number(expectedRevision) !== normalizedEnvelope.inputRevision || Number(readInputRevision()) !== normalizedEnvelope.inputRevision) {
              throw createAgentError('Agent 输入已更新，请重新执行', 'AGENT_INPUT_CHANGED', { retryable: true });
            }
          },
          readAppliedExecution(executionId) {
            assertActiveCapability();
            const row = selectApplied.get(String(executionId || '').trim());
            return row ? receiptFromRow(row) : null;
          },
          applyDeclaredOperation(operationId, payload) {
            assertActiveCapability();
            if (operationAttempted || operationId !== taskSpec.commitOperationId || typeof operations[operationId] !== 'function') {
              throw createAgentError('Agent 不允许执行该写入操作', 'AGENT_APPLY_FAILED', { retryable: true });
            }
            operationAttempted = true;
            try {
              const operationResult = operations[operationId](payload);
              if (isThenable(operationResult)) {
                void Promise.resolve(operationResult).catch(() => undefined);
                throw createAgentError('Agent operation 不允许异步返回', 'AGENT_APPLY_FAILED', { retryable: true });
              }
              locator = operationResult;
              operationSucceeded = true;
            } catch (error) {
              operationFailure = error?.code
                ? error
                : createAgentError(`Agent operation 执行失败：${error?.message || '未知错误'}`, 'AGENT_APPLY_FAILED', { retryable: true });
              throw operationFailure;
            }
          },
          recordAppliedExecution() {
            assertActiveCapability();
            throw createAgentError('Task Spec 不允许直接写入 Agent 账本', 'AGENT_APPLY_FAILED', { retryable: true });
          },
        });
        let applyResult;
        try {
          applyResult = taskSpec.applyResult(validatedOutput, commitTransaction);
          if (isThenable(applyResult)) {
            void Promise.resolve(applyResult).catch(() => undefined);
            throw createAgentError('Task Spec applyResult 不允许异步返回', 'AGENT_APPLY_FAILED', { retryable: true });
          }
        } finally {
          transactionCapabilityActive = false;
        }
        if (operationFailure) throw operationFailure;
        if (!operationSucceeded) {
          throw createAgentError('Task Spec 未执行声明的写入操作', 'AGENT_APPLY_FAILED', { retryable: true });
        }
        const resultLocatorJson = normalizeResultLocator(locator || {});
        const appliedAt = clock();
        insertApplied.run({
          idempotencyKey: crypto.createHash('sha256').update(normalizedEnvelope.executionId).digest('hex'),
          ...normalizedEnvelope,
          outputSha256: String(outputSha256).toLowerCase(),
          resultLocatorJson,
          appliedAt,
        });
        return Object.freeze({
          executionId: normalizedEnvelope.executionId,
          outputSha256: String(outputSha256).toLowerCase(),
          appliedAt,
          resultLocator: JSON.parse(resultLocatorJson),
        });
      });
      return transaction.immediate();
    }, { signal });
  }

  return Object.freeze({ commit, findApplied });
}

module.exports = {
  MAX_RESULT_LOCATOR_BYTES,
  createAgentResultCommitter,
  receiptFromRow,
};
