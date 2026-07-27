const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  canonicalizeRunManifestV1,
  stringifyRunManifestV1,
  computeRunManifestV1Hash,
} = require('../shared/contracts/technical-plan/runManifest.cjs');

const EXECUTION_STATE_FIELDS = ['progress', 'logs', 'timestamps', 'checkpoint', 'error', 'receipt'];
const fixtureDir = path.join(__dirname, '../fixtures/technical-plan-contracts/run-manifest/v1');
const unsortedPath = path.join(fixtureDir, 'manifest.unsorted.json');
const canonicalPath = path.join(fixtureDir, 'manifest.canonical.json');
const hashPath = path.join(fixtureDir, 'manifest.sha256.txt');

const unsortedManifest = JSON.parse(fs.readFileSync(unsortedPath, 'utf8'));
const expectedCanonical = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));
const expectedHash = fs.readFileSync(hashPath, 'utf8').trim();

const canonicalAsPlain = JSON.parse(stringifyRunManifestV1(unsortedManifest));
assert.deepEqual(canonicalAsPlain, expectedCanonical, 'RunManifestV1 canonical fixture 应匹配');

const canonicalJson = stringifyRunManifestV1(unsortedManifest);
const expectedCanonicalText = fs.readFileSync(canonicalPath, 'utf8').trim();
assert.equal(canonicalJson, expectedCanonicalText, 'RunManifestV1 canonical string 应可复现');

const actualHash = computeRunManifestV1Hash(unsortedManifest);
assert.equal(actualHash, expectedHash, 'RunManifestV1 哈希应与 fixture 一致');

assert.equal(Object.keys(canonicalAsPlain).join(','), Object.keys(canonicalAsPlain).sort().join(','), '顶层字段应按确定性 key 顺序输出');
assert.equal(canonicalJson.indexOf('"workspace_runtime_generation":7') > -1, true, 'canonical JSON 应可被稳定解析');
assert.ok(canonicalJson.includes('"workspace_runtime_generation":7'), 'JSON 序列化中的整数应保持确定性数值');
assert.ok(/"workspace_runtime_generation":7\.0/.test(canonicalJson) === false, '整数不应出现小数点形式');

assert.equal(Array.isArray(canonicalAsPlain.source_hashes.reference_documents), true, 'reference_documents 应保留为数组');
assert.equal(canonicalAsPlain.source_hashes.reference_documents[0].document_id, 'doc-b', '数组顺序应保持不变');
assert.equal(Object.prototype.hasOwnProperty.call(canonicalAsPlain.source_hashes, 'tender_document_hash'), true, 'null 字段应保留');
assert.equal(canonicalAsPlain.selected_bid_section, null, 'selected_bid_section null 应保留');
assert.equal(canonicalAsPlain.prompt_template_version.includes('中文'), true, 'UTF-8 字符应参与规范化');
assert.equal(canonicalAsPlain.source_hashes.reference_documents[0].parse_version.includes('Δ'), true, 'UTF-8 parse_version 应参与规范化');

assert.throws(
  () => canonicalizeRunManifestV1({ ...unsortedManifest, task_id: 1 }),
  (error) => error && error.code === 'MANIFEST_INVALID',
  'RunManifestV1 task_id 必须为字符串',
);

assert.throws(
  () => canonicalizeRunManifestV1({ ...unsortedManifest, manifest_version: '1' }),
  (error) => error && error.code === 'MANIFEST_INVALID',
  'RunManifestV1 不能接受字符串版版本号',
);

assert.throws(
  () => canonicalizeRunManifestV1({ ...unsortedManifest, manifest_version: 'v1' }),
  (error) => error && error.code === 'MANIFEST_INVALID',
  'RunManifestV1 不应接受 v1 字符串',
);

assert.throws(
  () => canonicalizeRunManifestV1({ ...unsortedManifest, manifest_version: 2 }),
  (error) => error && error.code === 'MANIFEST_INVALID',
  'RunManifestV1 只能接受 manifest_version: 1',
);

assert.throws(
  () => canonicalizeRunManifestV1({ ...unsortedManifest, unknown_field: true }),
  (error) => error && error.code === 'MANIFEST_INVALID',
  'RunManifestV1 不能接受未知顶层字段',
);

for (const field of EXECUTION_STATE_FIELDS) {
  assert.throws(
    () => canonicalizeRunManifestV1({ ...unsortedManifest, [field]: {} }),
    (error) => error && error.code === 'MANIFEST_INVALID',
    `RunManifestV1 顶层不应接受 execution-state 字段 ${field}`,
  );
}

for (const field of EXECUTION_STATE_FIELDS) {
  assert.throws(
    () => canonicalizeRunManifestV1({
      ...unsortedManifest,
      source_hashes: {
        ...unsortedManifest.source_hashes,
        [field]: 'forbidden',
      },
    }),
    (error) => error && error.code === 'MANIFEST_INVALID',
    `RunManifestV1 嵌套不应接受执行态字段 ${field}`,
  );
}

assert.throws(
  () => canonicalizeRunManifestV1({
    ...unsortedManifest,
    stage_revision_vector: { ...unsortedManifest.stage_revision_vector, unknown_revision: 1 },
  }),
  (error) => error && error.code === 'MANIFEST_INVALID',
  'RunManifestV1 不应接受 nested 未知字段',
);

assert.throws(
  () => canonicalizeRunManifestV1({
    ...unsortedManifest,
    selected_bid_section: { section_id: 'sec-1' },
  }),
  (error) => error && error.code === 'MANIFEST_INVALID',
  'RunManifestV1 selected_bid_section 应要求包含 content_hash',
);

assert.throws(
  () => canonicalizeRunManifestV1({
    ...unsortedManifest,
    selected_bid_section: null,
    prompt_template_version: undefined,
  }),
  (error) => error && error.code === 'MANIFEST_INVALID',
  'RunManifestV1 missing-vs-null: prompt_template_version 不应允许缺失',
);

assert.equal(computeRunManifestV1Hash(unsortedManifest), expectedHash, '基线哈希保持一致');
assert.notEqual(computeRunManifestV1Hash({
  ...unsortedManifest,
  workspace_runtime_generation: 8,
}), expectedHash, 'workspace_runtime_generation 变更应影响哈希');

for (const revisionField of ['source_revision', 'analysis_revision', 'outline_revision', 'facts_revision', 'content_revision']) {
  const changed = {
    ...unsortedManifest,
    stage_revision_vector: {
      ...unsortedManifest.stage_revision_vector,
      [revisionField]: unsortedManifest.stage_revision_vector[revisionField] + 1,
    },
  };
  assert.notEqual(computeRunManifestV1Hash(changed), expectedHash, `stage_revision_vector 字段 ${revisionField} 变更应影响哈希`);
}

assert.notEqual(computeRunManifestV1Hash({
  ...unsortedManifest,
  normalized_input_hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
}), expectedHash, 'normalized_input_hash 变更应影响哈希');

assert.notEqual(computeRunManifestV1Hash({
  ...unsortedManifest,
  source_hashes: {
    ...unsortedManifest.source_hashes,
    tender_document_hash: '1111111111111111111111111111111111111111111111111111111111111111',
  },
}), expectedHash, 'source_hashes 变更应影响哈希');

assert.notEqual(computeRunManifestV1Hash({
  ...unsortedManifest,
  selected_bid_section: {
    section_id: 'sec-override',
    content_hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
}), expectedHash, 'selected_bid_section 变更应影响哈希');

assert.notEqual(computeRunManifestV1Hash({
  ...unsortedManifest,
  source_hashes: {
    ...unsortedManifest.source_hashes,
    reference_documents: [
      ...unsortedManifest.source_hashes.reference_documents,
      {
        document_id: 'doc-extra',
        content_hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        parse_version: 'parser-extra',
        source_record_hash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      },
    ],
  },
}), expectedHash, 'reference_documents 顺序变更/增长应影响哈希');

assert.notEqual(computeRunManifestV1Hash({
  ...unsortedManifest,
  source_hashes: {
    ...unsortedManifest.source_hashes,
    reference_documents: [
      ...unsortedManifest.source_hashes.reference_documents.slice(1),
      unsortedManifest.source_hashes.reference_documents[0],
    ],
  },
}), expectedHash, 'reference_documents 数组顺序影响哈希');

assert.notEqual(computeRunManifestV1Hash({
  ...unsortedManifest,
  generation_config_hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
}), expectedHash, 'generation_config_hash 变更应影响哈希');

assert.notEqual(computeRunManifestV1Hash({
  ...unsortedManifest,
  prompt_template_version: 'tmpl-中文-v2',
}), expectedHash, 'prompt_template_version 变更应影响哈希');

assert.notEqual(computeRunManifestV1Hash({
  ...unsortedManifest,
  model_snapshot_ref: 'model-snapshot-v2',
}), expectedHash, 'model_snapshot_ref 变更应影响哈希');

assert.notEqual(computeRunManifestV1Hash({
  ...unsortedManifest,
  upstream_result_hashes: {
    ...unsortedManifest.upstream_result_hashes,
    global_facts_hash: '2222222222222222222222222222222222222222222222222222222222222222',
  },
}), expectedHash, 'upstream_result_hashes 变更应影响哈希');

assert.notEqual(computeRunManifestV1Hash({
  ...unsortedManifest,
  task_type: 'outline-generation',
}), expectedHash, 'task_type 变更应影响哈希');

assert.notEqual(computeRunManifestV1Hash({
  ...unsortedManifest,
  workspace_runtime_generation: 9,
}), expectedHash, 'workspace_runtime_generation 变更应再次影响哈希');

assert.throws(
  () => canonicalizeRunManifestV1({
    ...unsortedManifest,
    workspace_runtime_generation: 7.5,
  }),
  (error) => error && error.code === 'MANIFEST_INVALID',
  '整数字段必须是整数',
);

console.log('WP-J Contracts runManifest tests passed');
