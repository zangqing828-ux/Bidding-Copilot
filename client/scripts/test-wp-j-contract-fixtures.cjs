const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { computeRunManifestV1Hash } = require('../shared/contracts/technical-plan/runManifest.cjs');

const fixtureDir = path.join(__dirname, '../fixtures/technical-plan-contracts');
const files = {
  unsorted: path.join(fixtureDir, 'run-manifest/v1/manifest.unsorted.json'),
  canonical: path.join(fixtureDir, 'run-manifest/v1/manifest.canonical.json'),
  hash: path.join(fixtureDir, 'run-manifest/v1/manifest.sha256.txt'),
  renderer: path.join(fixtureDir, 'content-generation/renderer-canonicalization.samples.json'),
  states: path.join(fixtureDir, 'task-state/projection.sample.json'),
};

const unsorted = JSON.parse(fs.readFileSync(files.unsorted, 'utf8'));
const canonicalFromDisk = JSON.parse(fs.readFileSync(files.canonical, 'utf8'));
const hashFromDisk = fs.readFileSync(files.hash, 'utf8').trim();
const rendererSample = JSON.parse(fs.readFileSync(files.renderer, 'utf8'));
const stateSample = JSON.parse(fs.readFileSync(files.states, 'utf8'));

assert.equal(computeRunManifestV1Hash(unsorted), hashFromDisk, 'fixture hash 验证一致');
assert.ok(Array.isArray(rendererSample.valid), 'renderer fixture should include valid samples');
assert.ok(Array.isArray(rendererSample.invalid), 'renderer fixture should include invalid samples');
assert.ok(Array.isArray(stateSample.cases), 'state fixture should include projection cases');
assert.ok(Object.keys(canonicalFromDisk).length > 0, 'canonical manifest fixture 不应为空');
assert.equal(Object.prototype.hasOwnProperty.call(canonicalFromDisk, 'selected_bid_section'), true, 'canonical manifest 应包含 selected_bid_section');
assert.equal(Object.prototype.hasOwnProperty.call(canonicalFromDisk, 'workspace_runtime_generation'), true, 'canonical manifest 应包含 workspace_runtime_generation');
assert.equal(Object.prototype.hasOwnProperty.call(canonicalFromDisk, 'source_hashes'), true, 'canonical manifest 应包含 source_hashes');
assert.equal(Object.prototype.hasOwnProperty.call(canonicalFromDisk, 'prompt_template_version'), true, 'canonical manifest 应包含 prompt_template_version');
assert.equal(Object.prototype.hasOwnProperty.call(canonicalFromDisk, 'model_snapshot_ref'), true, 'canonical manifest 应包含 model_snapshot_ref');
assert.equal(Object.prototype.hasOwnProperty.call(canonicalFromDisk, 'output_schema_version'), true, 'canonical manifest 应包含 output_schema_version');
const staleFields = ['task_spec_id', 'input_revision', 'source_revision', 'generation_options', 'content_sections'];
for (const field of staleFields) {
  assert.equal(Object.prototype.hasOwnProperty.call(canonicalFromDisk, field), false, `canonical manifest 不应包含旧字段 ${field}`);
}

for (const caseItem of stateSample.cases || []) {
  assert.equal(typeof caseItem.internal_status, 'string', 'state case internal_status 必须字符串');
  if (caseItem.renderer !== null) {
    assert.equal(typeof caseItem.renderer.status, 'string', 'state case renderer.status 必须字符串');
  }
}

console.log('WP-J Contracts fixtures integrity tests passed');
