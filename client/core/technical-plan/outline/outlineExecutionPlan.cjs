const DECISION_AGENT_QUALITY_DISABLED = 'AGENT_QUALITY_DISABLED';
const DECISION_PLAN_READY = 'AGENT_PLAN_READY';

function normalizeWorkflowKind(value) {
  if (value === 'existing-plan-expansion' || value === 'existing-plan') {
    return 'existing-plan-expansion';
  }
  return 'technical-plan';
}

function normalizeOutlineExpansionMode(value) {
  return value === 'original-only' ? 'original-only' : 'ai-complement';
}

function detectQualityCapability(capabilities = {}) {
  if (!capabilities || typeof capabilities !== 'object') {
    return false;
  }
  return Boolean(
    capabilities.qualityRepair
    || capabilities.agentQualityRepair
    || capabilities.qualityReview
    || capabilities.enableQualityRepair,
  );
}

function withDecisionForOptionalStage(stage, capable) {
  if (capable) {
    return {
      ...stage,
      required: false,
      runnable: true,
    };
  }
  return {
    ...stage,
    required: false,
    runnable: false,
    decision: DECISION_AGENT_QUALITY_DISABLED,
    reason: `缺少能力：${stage.capabilityKey || 'complex_repair'}`,
  };
}

function getBaseStageTemplates(workflowKind, outlineExpansionMode) {
  if (workflowKind === 'existing-plan-expansion') {
    if (outlineExpansionMode === 'original-only') {
      return [
        { kind: 'load-original-outline' },
        { kind: 'validate-normalized-original-outline' },
        { kind: 'persist-original-outline' },
      ];
    }

    return [
      { kind: 'load-original-outline' },
      { kind: 'extract-complement-plan' },
      { kind: 'generate-complement-outline' },
      { kind: 'integrate-complement-outline' },
      { kind: 'validate-complement-outline' },
      { kind: 'finalize-complement-outline' },
      { kind: 'persist-complement-outline' },
      { kind: 'complex-repair-existing', optional: true, capabilityKey: 'qualityRepair' },
    ];
  }

  return [
    { kind: 'extract-requirement-groups' },
    { kind: 'build-outline' },
    { kind: 'validate-core-outline' },
    { kind: 'finalize-core-outline' },
    { kind: 'persist-outline' },
    { kind: 'complex-repair-standard', optional: true, capabilityKey: 'qualityRepair' },
  ];
}

function buildOutlineExecutionPlan(input = {}) {
  const workflowKind = normalizeWorkflowKind(input.workflowKind);
  const outlineExpansionMode = normalizeOutlineExpansionMode(input.outlineExpansionMode);
  const qualityCapable = detectQualityCapability(input.capabilities);
  const templates = getBaseStageTemplates(workflowKind, outlineExpansionMode);

  const stages = [];
  const decisions = [];

  for (const template of templates) {
    if (!template.optional) {
      stages.push({
        ...template,
        required: true,
        runnable: true,
      });
      continue;
    }

    const resolved = withDecisionForOptionalStage(template, qualityCapable);
    stages.push({
      ...resolved,
      capability: template.capabilityKey,
      optional: true,
    });
    if (!resolved.runnable) {
      decisions.push({ stage: template.kind, decision: DECISION_AGENT_QUALITY_DISABLED });
    }
  }

  return {
    workflowKind,
    outlineExpansionMode,
    stages,
    decisions,
    decision: decisions.length ? DECISION_AGENT_QUALITY_DISABLED : DECISION_PLAN_READY,
    runnable: true,
  };
}

module.exports = {
  DECISION_AGENT_QUALITY_DISABLED,
  buildOutlineExecutionPlan,
};
