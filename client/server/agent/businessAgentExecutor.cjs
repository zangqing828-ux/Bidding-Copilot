const crypto = require('node:crypto');
const { createAgentError } = require('./agentCoordinator.cjs');

function createHandle({ executionId, runId, reservation, events, ownerCancellationToken: ownerToken }) {
  return Object.freeze({
    executionId,
    runId,
    getSnapshot: reservation.getSnapshot,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new Error('Agent 订阅 listener 必须是函数');
      events.add(listener);
      return () => events.delete(listener);
    },
    cancel(ownerCancellationToken, reason) {
      if (!ownerCancellationToken || ownerCancellationToken !== ownerToken) {
        throw createAgentError('只有外层任务控制器可以取消 Agent execution', 'AGENT_TASK_SPEC_INVALID');
      }
      return reservation.cancel(reason);
    },
    result: reservation.completion,
  });
}

function createBusinessAgentExecutor({
  workspaceId,
  registry,
  coordinator,
  committer,
  snapshotReader,
  aiService,
  runner,
  now = () => Date.now(),
}) {
  if (!workspaceId || !registry || !coordinator || !committer || !snapshotReader || !aiService || !runner) {
    throw new Error('createBusinessAgentExecutor 缺少必需依赖');
  }
  if (typeof runner.run !== 'function' || typeof aiService.captureTextModelSnapshot !== 'function') {
    throw new Error('BusinessAgentExecutor 依赖能力不完整');
  }

  async function execute(taskSpecId, executionRequest = {}) {
    const executionId = String(executionRequest.executionId || '').trim();
    const requestedWorkspaceId = String(executionRequest.workspaceId || workspaceId).trim();
    if (!executionId || requestedWorkspaceId !== workspaceId) {
      throw createAgentError('Agent execution 请求无效', 'AGENT_TASK_SPEC_INVALID');
    }
    const taskSpecVersion = Number(executionRequest.taskSpecVersion);
    const spec = registry.get(taskSpecId, taskSpecVersion);
    const outer = executionRequest.taskController;
    if (!outer || typeof outer.persistExecutionEnvelope !== 'function' || typeof outer.reconcileAppliedExecution !== 'function') {
      throw createAgentError('Agent 外层任务控制器无效', 'AGENT_TASK_SPEC_INVALID');
    }
    const requestedEnvelope = executionRequest.executionEnvelope || {};
    const provisionalEnvelope = {
      taskSpecId: spec.id,
      taskSpecVersion: spec.version,
      inputRevision: Number(requestedEnvelope.inputRevision),
      inputHash: String(requestedEnvelope.inputHash || ''),
    };
    const existingReceipt = committer.findApplied(executionId, provisionalEnvelope);
    if (existingReceipt) {
      await outer.reconcileAppliedExecution(existingReceipt);
      const completed = Promise.resolve(existingReceipt);
      return Object.freeze({
        executionId,
        runId: null,
        getSnapshot: () => ({ workspaceId, executionId, phase: 'succeeded' }),
        subscribe: () => () => {},
        cancel: () => false,
        result: completed,
      });
    }
    const deadlineAt = Number.isFinite(Number(executionRequest.deadlineAt))
      ? Number(executionRequest.deadlineAt)
      : now() + spec.limits.timeoutMs;
    const reservation = coordinator.reserve({
      workspaceId,
      executionId,
      envelope: provisionalEnvelope,
      deadlineAt,
    });
    const ownerCancellationToken = executionRequest.ownerCancellationToken;
    const events = new Set();
    let runId = null;
    const publish = (event) => {
      outer.projectAgentStage?.(event);
      for (const listener of events) listener(event);
    };

    try {
      const constrainedReader = Object.freeze({
        getInputRevision: () => snapshotReader.getInputRevision(),
        readBinding(bindingId) {
          if (!spec.inputBindings.includes(bindingId)) {
            throw createAgentError('Task Spec 请求了未声明输入', 'AGENT_TASK_SPEC_INVALID');
          }
          return snapshotReader.readBinding(bindingId);
        },
      });
      const captured = await spec.captureSnapshot(constrainedReader);
      const snapshot = captured?.readonlySnapshot;
      const inputRevision = Number(captured?.inputRevision);
      const inputHash = String(captured?.inputHash || '');
      if (!snapshot || !Number.isInteger(inputRevision) || inputRevision < 0 || !/^[a-f0-9]{64}$/i.test(inputHash)) {
        throw createAgentError('Task Spec 快照无效', 'AGENT_INPUT_INVALID');
      }
      if (inputRevision !== provisionalEnvelope.inputRevision || inputHash !== provisionalEnvelope.inputHash) {
        throw createAgentError('Agent execution envelope 与冻结输入不一致', 'AGENT_EXECUTION_CONFLICT');
      }
      runId = crypto.randomUUID();
      const envelope = Object.freeze({ ...provisionalEnvelope, executionId, runId });
      await outer.persistExecutionEnvelope(envelope);
      const input = await spec.buildInput(snapshot);
      const prompt = await spec.buildPrompt(snapshot);
      const modelSnapshot = aiService.captureTextModelSnapshot();
      publish({ phase: 'accepted', executionId, runId: envelope.runId });
      reservation.admit(async ({ signal, setPhase }) => {
        publish({ phase: 'running', executionId, runId: envelope.runId });
        const runResult = await runner.run({
          taskSpec: spec,
          executionId,
          runId: envelope.runId,
          input,
          prompt,
          modelSnapshot,
          signal,
        });
        setPhase('validating');
        publish({ phase: 'validating', executionId, runId: envelope.runId });
        const validated = await spec.validateOutput(runResult.output, { executionId, runId: envelope.runId });
        setPhase('applying');
        publish({ phase: 'applying', executionId, runId: envelope.runId });
        const receipt = await committer.commit({
          envelope,
          taskSpec: spec,
          validatedOutput: validated,
          outputSha256: runResult.outputSha256,
          signal,
        });
        await outer.reconcileAppliedExecution(receipt);
        publish({ phase: 'succeeded', executionId, runId: envelope.runId });
        return receipt;
      });
    } catch (error) {
      reservation.cancel(error);
      throw error;
    }
    return createHandle({ executionId, runId, reservation, events, ownerCancellationToken });
  }

  return Object.freeze({ execute });
}

module.exports = { createBusinessAgentExecutor };
