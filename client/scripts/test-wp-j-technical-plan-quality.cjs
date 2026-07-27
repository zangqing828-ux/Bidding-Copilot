const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fixtureDir = path.join(__dirname, '..', 'fixtures', 'technical-plan-quality', 'v1');
const manifest = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'manifest.json'), 'utf8'));
const schema = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'quality-report.v1.schema.json'), 'utf8'));
const report = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'report.example.sanitized.json'), 'utf8'));

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

function assertHash(value, label) {
  assert.match(value, HASH_PATTERN, `${label} 必须是 sha256 哈希`);
}

function validateReport(candidate) {
  assert.equal(candidate.schema_version, 'quality-report.v1', '报告 schema 版本固定');
  assert.equal(candidate.fixture_id, manifest.fixture_id, '报告必须引用当前 fixture');
  assert.ok(Date.parse(candidate.generated_at), '报告 generated_at 必须可解析');
  assert.ok(candidate.model_snapshot?.snapshot_id, '报告必须冻结模型 snapshot');
  assert.ok(candidate.prompt_template_version, '报告必须冻结 prompt/template 版本');
  assertHash(candidate.model_snapshot.config_hash, 'model config hash');
  assertHash(candidate.source_manifest_hash, 'source manifest hash');
  assert.equal(candidate.requirements.length, manifest.requirements.length, '报告必须覆盖 fixture 全部要求');

  const manifestById = new Map(manifest.requirements.map((item) => [item.requirement_id, item]));
  const seen = new Set();
  for (const result of candidate.requirements) {
    assert.ok(manifestById.has(result.requirement_id), `报告包含未知 requirement：${result.requirement_id}`);
    assert.equal(seen.has(result.requirement_id), false, `requirement 不得重复：${result.requirement_id}`);
    seen.add(result.requirement_id);
    assert.ok(result.expected_section_types.length > 0, `${result.requirement_id} 必须记录预期章节类型`);
    assert.ok(Array.isArray(result.mapped_section_ids), `${result.requirement_id} 必须记录实际 section 映射`);
    assert.ok(['none', 'warning', 'error'].includes(result.conflict_status), `${result.requirement_id} conflict 状态无效`);
    assert.ok(['covered', 'partial', 'uncovered'].includes(result.coverage_status), `${result.requirement_id} coverage 状态无效`);
    assertHash(result.evidence_hashes.requirement_text, `${result.requirement_id} requirement hash`);
    assertHash(result.evidence_hashes.evidence_excerpt, `${result.requirement_id} evidence hash`);
    if (manifestById.get(result.requirement_id).hard_requirement) {
      assert.equal(result.coverage_status, 'covered', `${result.requirement_id} 硬性要求必须覆盖`);
      assert.equal(result.conflict_status, 'none', `${result.requirement_id} 不得存在事实冲突`);
    }
  }
  assert.equal(seen.size, manifest.requirements.length, '报告 requirement 集合必须完整');
  assert.ok(['standard', 'original-only', 'ai-complement'].includes(candidate.original_material.mode), '原方案模式必须使用冻结枚举');
  assert.equal(candidate.metrics.fact_conflict_count, 0, '示例报告不得有事实冲突');
  assert.equal(candidate.metrics.error_count, 0, '示例报告不得有错误');
  assert.equal(candidate.verdict, 'pass', '示例报告应通过');
}

assert.equal(schema.$id.endsWith('/quality-report.v1.schema.json'), true, 'Schema ID 必须版本化');
assert.equal(schema.properties.schema_version.const, 'quality-report.v1', 'Schema 必须锁定 quality-report.v1');
for (const required of ['requirements', 'original_material', 'metrics', 'model_snapshot', 'prompt_template_version']) {
  assert.ok(schema.required.includes(required), `Schema 必须要求 ${required}`);
}
assert.equal(new Set(manifest.requirements.map((item) => item.requirement_id)).size, manifest.requirements.length, 'fixture requirement ID 必须稳定且唯一');
for (const item of manifest.requirements) {
  assertHash(item.requirement_text_hash, `${item.requirement_id} requirement text hash`);
  assertHash(item.evidence_excerpt_hash, `${item.requirement_id} evidence hash`);
  assert.ok(item.expected_section_types.length > 0, `${item.requirement_id} 必须有预期章节类型`);
}

validateReport(report);

const uncovered = JSON.parse(JSON.stringify(report));
uncovered.requirements[0].coverage_status = 'uncovered';
assert.throws(() => validateReport(uncovered), /硬性要求必须覆盖/, '硬性要求未覆盖必须失败');

const conflicting = JSON.parse(JSON.stringify(report));
conflicting.requirements[1].conflict_status = 'error';
assert.throws(() => validateReport(conflicting), /不得存在事实冲突/, '事实冲突必须失败');

console.log('WP-J technical-plan-quality/v1 manifest and quality-report.v1 schema tests passed');
