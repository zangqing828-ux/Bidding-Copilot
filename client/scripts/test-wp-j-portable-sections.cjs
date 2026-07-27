const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { applySectionSelection } = require('../core/technical-plan/sectioning/sectionSelection.cjs');

function readFixture(fileName) {
  const fixturePath = path.join(__dirname, '..', 'fixtures', fileName);
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

function assertThrowsMessage(fn, expectedMessage, label) {
  let error;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  assert.ok(error, `${label} 应该抛错`);
  assert.equal(error?.code, 'TASK_INVALID_INPUT', `${label} 错误码应为 TASK_INVALID_INPUT`);
  const message = String(error?.message || '');
  assert.ok(message.includes(expectedMessage), `${label} 错误应包含：${expectedMessage}，实际：${message}`);
}

function normalizeTrailingNewline(markdown) {
  if (typeof markdown !== 'string') {
    return markdown;
  }
  return markdown.endsWith('\n') ? markdown.slice(0, -1) : markdown;
}

function runValidSelectionFixture() {
  const fixture = readFixture('technical-plan-characterization/j1-multi-section-selection.fixture.json');
  const sections = fixture.input.sectionExtractionResponses?.[0]?.sections || fixture.expected.bidSections;
  const selectedSectionId = fixture.expected.selection.selectedSectionId;

  const result = applySectionSelection(fixture.input.tenderMarkdown, sections, selectedSectionId);
  assert.equal(result.selectedSectionId, selectedSectionId, '所选标段 id 应匹配');
  const normalizedActualMap = {};
  for (const [sectionId, content] of Object.entries(result.selectedMarkdownBySection)) {
    normalizedActualMap[sectionId] = normalizeTrailingNewline(content);
  }
  const normalizedExpectedMap = {};
  for (const [sectionId, content] of Object.entries(fixture.expected.selection.selectedMarkdownBySection)) {
    normalizedExpectedMap[sectionId] = normalizeTrailingNewline(content);
  }
  assert.deepEqual(
    normalizedActualMap,
    normalizedExpectedMap,
    '标段选段结果 map 应与基线一致',
  );
  assert.equal(
    normalizeTrailingNewline(result.selectedMarkdown),
    normalizeTrailingNewline(fixture.expected.selection.selectedMarkdown),
    '当前所选标段正文应与基线一致',
  );
  assert.equal(result.metadata.totalSectionCount, sections.length, '标段总数应与输入一致');
}

function runBlanklineSelectionFixture() {
  const fixture = readFixture('technical-plan-portable/sectioning-blankline.fixture.json');
  const result = applySectionSelection(fixture.markdown, fixture.sections, fixture.selectedSectionId);
  assert.equal(result.selectedMarkdown, fixture.expectedSelectedMarkdown, '保留前后空行时正文应保持原行布局');
  assert.deepEqual(result.selectedLineNumbers, fixture.expectedSelectedLineNumbers, '选定行号应可回溯原文行号');
}

function runInvalidSelectionCases() {
  const fixture = readFixture('technical-plan-portable/sectioning-invalid.fixture.json');
  for (const entry of fixture.cases || []) {
    assertThrowsMessage(
      () => applySectionSelection(entry.markdown, entry.sections, entry.selectedSectionId),
      entry.expectedError,
      `case ${entry.name}`,
    );
  }
}

function main() {
  runValidSelectionFixture();
  runBlanklineSelectionFixture();
  runInvalidSelectionCases();
  console.log('WP-J portable sectioning 选段与范围校验通过');
}

main();
