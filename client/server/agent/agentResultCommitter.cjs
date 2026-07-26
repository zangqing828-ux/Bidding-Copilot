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

  function commit({ envelope, taskSpec, validatedOutput, outputSha256, signal }) {
    const normalizedEnvelope = normalizeEnvelope(envelope);
    if (!taskSpec || typeof taskSpec.applyResult !== 'function') {
      return Promise.reject(createAgentError('Agent Task Spec 无效', 'AGENT_TASK_SPEC_INVALID'));
    }
    if (!/^[a-f0-9]{64}$/i.test(String(outputSha256 || ''))) {
      return Promise.reject(createAgentError('Agent 输出摘要无效', 'AGENT_OUTPUT_INVALID', { retryable: true }));
    }
    return mutationExecutor.execute(() => {
      const transaction = db.transaction(() => {
        const existing = selectApplied.get(normalizedEnvelope.executionId);
        if (existing) {
          assertSameEnvelope(existing, normalizedEnvelope);
          return receiptFromRow(existing);
        }
        if (Number(readInputRevision()) !== normalizedEnvelope.inputRevision) {
          throw createAgentError('Agent 输入已更新，请重新执行', 'AGENT_INPUT_CHANGED', { retryable: true });
        }
        let declaredOperationApplied = false;
        let locator = null;
        const commitTransaction = Object.freeze({
          assertInputRevision(expectedRevision) {
            if (Number(expectedRevision) !== normalizedEnvelope.inputRevision || Number(readInputRevision()) !== normalizedEnvelope.inputRevision) {
              throw createAgentError('Agent 输入已更新，请重新执行', 'AGENT_INPUT_CHANGED', { retryable: true });
            }
          },
          readAppliedExecution(executionId) {
            const row = selectApplied.get(String(executionId || '').trim());
            return row ? receiptFromRow(row) : null;
          },
          applyDeclaredOperation(operationId, payload) {
            if (declaredOperationApplied || operationId !== taskSpec.commitOperationId || typeof operations[operationId] !== 'function') {
              throw createAgentError('Agent 不允许执行该写入操作', 'AGENT_APPLY_FAILED', { retryable: true });
            }
            declaredOperationApplied = true;
            locator = operations[operationId](payload);
          },
          recordAppliedExecution() {
            throw createAgentError('Task Spec 不允许直接写入 Agent 账本', 'AGENT_APPLY_FAILED', { retryable: true });
          },
        });
        taskSpec.applyResult(validatedOutput, commitTransaction);
        if (!declaredOperationApplied) {
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
