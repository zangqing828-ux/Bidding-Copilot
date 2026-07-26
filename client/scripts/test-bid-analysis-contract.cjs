const assert = require('node:assert/strict');
const definitions = require('../shared/bidAnalysisDefinitions.json');
const { methods } = require('../shared/bridgeContract.cjs');
const fs = require('node:fs');
const {
  BID_ANALYSIS_ERROR_CODES,
  bidAnalysisTaskIds,
  normalizeBidAnalysisSelection,
  requiredBidAnalysisTaskIds,
  validateStartBidAnalysisInput,
} = require('../shared/bidAnalysisContract.cjs');
const { getBidAnalysisTasks } = require('../core/bidAnalysisTask.cjs');

function expectError(input, code) {
  assert.throws(() => validateStartBidAnalysisInput(input), (error) => error?.code === code);
}

assert.equal(new Set(bidAnalysisTaskIds).size, bidAnalysisTaskIds.length, '注册表 ID 唯一');
assert.deepEqual(getBidAnalysisTasks('full').map((task) => ({ id: task.id, label: task.label, description: task.description, required: task.required, output: task.output })), definitions, 'core 元数据与共享注册表一致');
assert.deepEqual(getBidAnalysisTasks('key').map((task) => task.id), requiredBidAnalysisTaskIds, '关键项集合与共享注册表一致');
assert.deepEqual(methods.tasks.startBidAnalysis.input[0].properties, {
  mode: { type: 'BidAnalysisMode', required: true, enum: ['key', 'full', 'custom'] },
  selected_task_ids: { type: 'string[]', required: true },
  task_ids: { type: 'string[]', required: false },
  force_rerun: { type: 'boolean', required: false },
}, 'Bridge manifest 冻结严格 DTO 字段');
const typeSource = fs.readFileSync(require.resolve('../src/features/technical-plan/types.ts'), 'utf8');
assert.match(typeSource, /interface StartBidAnalysisInput[\s\S]*selected_task_ids: string\[\]/, 'TypeScript 声明包含 DTO 必填字段');

const keyInput = validateStartBidAnalysisInput({ mode: 'key', selected_task_ids: [...requiredBidAnalysisTaskIds] });
assert.equal(keyInput.mode, 'key', '关键解析 DTO 有效');
const fullInput = validateStartBidAnalysisInput({ mode: 'full', selected_task_ids: [...bidAnalysisTaskIds], force_rerun: true });
assert.equal(fullInput.force_rerun, true, '完整解析 DTO 有效');
const customInput = validateStartBidAnalysisInput({ mode: 'custom', selected_task_ids: [...requiredBidAnalysisTaskIds, 'procurementList'], task_ids: ['procurementList'] });
assert.deepEqual(customInput.task_ids, ['procurementList'], '单项重试 DTO 有效');
assert.deepEqual(normalizeBidAnalysisSelection('custom', ['procurementList']).taskIds, [...requiredBidAnalysisTaskIds, 'procurementList'], '自定义模式自动包含关键项');

expectError({ mode: 'key', selected_task_ids: [...requiredBidAnalysisTaskIds], prompt: 'inject' }, BID_ANALYSIS_ERROR_CODES.INVALID_INPUT);
expectError({ mode: 'custom', selected_task_ids: ['projectOverview'] }, BID_ANALYSIS_ERROR_CODES.INVALID_INPUT);
expectError({ mode: 'custom', selected_task_ids: [...requiredBidAnalysisTaskIds, 'unknown'] }, BID_ANALYSIS_ERROR_CODES.ITEM_NOT_FOUND);
expectError({ mode: 'custom', selected_task_ids: [...requiredBidAnalysisTaskIds, 'procurementList'], task_ids: ['agentInfo'] }, BID_ANALYSIS_ERROR_CODES.INVALID_INPUT);
expectError({ mode: 'full', selected_task_ids: [...requiredBidAnalysisTaskIds] }, BID_ANALYSIS_ERROR_CODES.INVALID_INPUT);
expectError({ mode: 'key', selected_task_ids: [...requiredBidAnalysisTaskIds, 'projectOverview'] }, BID_ANALYSIS_ERROR_CODES.INVALID_INPUT);

console.log('Bid Analysis 严格 DTO 与共享注册表测试通过');
