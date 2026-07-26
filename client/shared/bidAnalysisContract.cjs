const definitions = require('./bidAnalysisDefinitions.json');

const BID_ANALYSIS_MODES = Object.freeze(['key', 'full', 'custom']);
const BID_ANALYSIS_ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'TASK_INVALID_INPUT',
  ITEM_NOT_FOUND: 'TASK_ITEM_NOT_FOUND',
});
const definitionById = new Map(definitions.map((definition) => [definition.id, Object.freeze({ ...definition })]));
const bidAnalysisDefinitions = Object.freeze([...definitionById.values()]);
const bidAnalysisTaskIds = Object.freeze(bidAnalysisDefinitions.map((definition) => definition.id));
const requiredBidAnalysisTaskIds = Object.freeze(bidAnalysisDefinitions.filter((definition) => definition.required).map((definition) => definition.id));
const allowedInputFields = Object.freeze(['mode', 'selected_task_ids', 'task_ids', 'force_rerun']);

function createInputError(message, code = BID_ANALYSIS_ERROR_CODES.INVALID_INPUT) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validateKnownTaskIds(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw createInputError(`${field} 必须为非空字符串数组`);
  }
  const ids = value.map((item) => item.trim());
  if (new Set(ids).size !== ids.length) {
    throw createInputError(`${field} 不允许重复 ID`);
  }
  const unknownId = ids.find((id) => !definitionById.has(id));
  if (unknownId) {
    throw createInputError(`${field} 包含未注册解析项`, BID_ANALYSIS_ERROR_CODES.ITEM_NOT_FOUND);
  }
  return ids;
}

function validateStartBidAnalysisInput(input) {
  if (!isPlainObject(input)) {
    throw createInputError('解析配置必须为对象');
  }
  const unknownField = Object.keys(input).find((key) => !allowedInputFields.includes(key));
  if (unknownField) {
    throw createInputError(`解析配置不允许字段：${unknownField}`);
  }
  if (!BID_ANALYSIS_MODES.includes(input.mode)) {
    throw createInputError('解析模式无效');
  }
  const selectedTaskIds = validateKnownTaskIds(input.selected_task_ids, 'selected_task_ids');
  const selectedSet = new Set(selectedTaskIds);
  if (requiredBidAnalysisTaskIds.some((id) => !selectedSet.has(id))) {
    throw createInputError('关键解析项必须全部包含');
  }
  if (input.mode === 'key' && selectedTaskIds.length !== requiredBidAnalysisTaskIds.length) {
    throw createInputError('关键解析模式只能包含关键项');
  }
  if (input.mode === 'full' && selectedTaskIds.length !== bidAnalysisTaskIds.length) {
    throw createInputError('完整解析模式必须包含全部解析项');
  }
  const taskIds = input.task_ids === undefined ? undefined : validateKnownTaskIds(input.task_ids, 'task_ids');
  if (taskIds && taskIds.some((id) => !selectedSet.has(id))) {
    throw createInputError('task_ids 必须是 selected_task_ids 的子集');
  }
  if (input.force_rerun !== undefined && typeof input.force_rerun !== 'boolean') {
    throw createInputError('force_rerun 必须为布尔值');
  }
  return Object.freeze({
    mode: input.mode,
    selected_task_ids: Object.freeze(selectedTaskIds),
    ...(taskIds ? { task_ids: Object.freeze(taskIds) } : {}),
    ...(input.force_rerun === undefined ? {} : { force_rerun: input.force_rerun }),
  });
}

function normalizeBidAnalysisSelection(mode, selectedTaskIds) {
  const ids = validateKnownTaskIds(selectedTaskIds, 'selectedTaskIds');
  const requiredSet = new Set(requiredBidAnalysisTaskIds);
  const selectedSet = new Set([...requiredBidAnalysisTaskIds, ...ids]);
  const normalizedIds = bidAnalysisTaskIds.filter((id) => selectedSet.has(id));
  if (mode === 'full' || normalizedIds.length === bidAnalysisTaskIds.length) {
    return { mode: 'full', taskIds: [...bidAnalysisTaskIds] };
  }
  if (mode === 'custom' || normalizedIds.some((id) => !requiredSet.has(id))) {
    return { mode: 'custom', taskIds: normalizedIds };
  }
  return { mode: 'key', taskIds: [...requiredBidAnalysisTaskIds] };
}

module.exports = {
  BID_ANALYSIS_ERROR_CODES,
  BID_ANALYSIS_MODES,
  allowedInputFields,
  bidAnalysisDefinitions,
  bidAnalysisTaskIds,
  definitionById,
  normalizeBidAnalysisSelection,
  requiredBidAnalysisTaskIds,
  validateStartBidAnalysisInput,
};
