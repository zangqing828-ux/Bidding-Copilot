const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSqliteDatabase } = require('../core/sqliteDatabase.cjs');
const { createTechnicalPlanStore } = require('../core/stores/technicalPlanStore.cjs');
const { detectBidSections } = require('../core/bidSectionDetector.cjs');
const { buildBidSectionContextHint } = require('../core/bidSectionContext.cjs');

function readFixture(fileName) {
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'technical-plan-characterization', fileName);
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

function createTenderFileService(markdown) {
  return {
    importDocument: async () => ({
      success: true,
      file_content: String(markdown || ''),
      file_name: 'tender.md',
      parser_label: 'fixture',
      message: 'multi-section fixture',
    }),
  };
}

function assertDownstreamCleared(state) {
  assert.equal(state.step, 'bid-analysis', '选择标段后应回到 bid-analysis 位置');
  assert.deepEqual(state.bidAnalysisTasks, {}, '选择标段后应清空招标解析任务缓存');
  assert.equal(state.bidAnalysisTask, undefined, '选择标段后应清空 bidAnalysis 任务');
  assert.equal(state.outlineGenerationTask, undefined, '选择标段后应清空 outline 任务');
  assert.equal(state.outlineData, null, '选择标段后应清空目录数据');
  assert.equal(state.globalFacts.length, 0, '选择标段后应清空全局事实');
  assert.equal(state.contentGenerationOptions, undefined, '选择标段后应清空正文选项');
  assert.equal(state.contentGenerationRuntime, undefined, '选择标段后应清空正文运行态');
  assert.equal(state.contentIllustrationPlan, undefined, '选择标段后应清空图片计划');
  assert.equal(state.referenceKnowledgeDocumentIds.length, 0, '选择标段后应清空 reference 文档快照');
}

async function runStoreSelectionCheck(store, sectionId, sectionSeed, selectionMap) {
  const expectedSection = sectionSeed.find((item) => item.id === sectionId);
  const beforeVersion = store.getBidAnalysisInputVersion();

  const result = store.selectBidSection({ id: sectionId, title: expectedSection?.title || '' });
  const state = store.loadTechnicalPlan();
  const afterVersion = store.getBidAnalysisInputVersion();

  assert.equal(result.success, true, `${sectionId} 选择应返回成功`);
  assert.equal(afterVersion.inputRevision, beforeVersion.inputRevision + 1, `${sectionId} 选择应触发输入版本递增`);
  assert.equal(afterVersion.selectedSectionId, sectionId, `${sectionId} 选择应回写 selectedSectionId 到输入版本快照`);
  assert.equal(state.bidSectionMode, 'multiple', '多标段场景应保持多标段模式');
  assert.equal(state.bidSections.length, sectionSeed.length, '选择标段不能丢失标段列表');

  const tenderFile = state.tenderFile || {};
  assert.equal(tenderFile.selectedSectionId, sectionId, `${sectionId} 选择后应写入 tenderFile.selectedSectionId`);
  assert.equal(tenderFile.selectedSectionTitle, expectedSection?.title || '', `${sectionId} 选择后应写入 tenderFile.selectedSectionTitle`);
  assert.equal(tenderFile.markdownPath, 'technical-plan/tender.md', '选择后应基于工作区招标正文路径更新');
  assert.equal(tenderFile.originalMarkdownPath, 'technical-plan/tender-original.md', '原始招标路径应保留');

  const actualMarkdown = store.readTenderMarkdown().trim();
  const expectedMarkdown = (selectionMap && selectionMap[sectionId]) || '';
  assert.equal(actualMarkdown, expectedMarkdown, `${sectionId} 选择后的正文应与 fixture 对齐`);
  assert.equal(result.markdown.trim(), expectedMarkdown, `${sectionId} selectBidSection 返回正文应与读取一致`);
  assert.ok(result.markdown.includes(`## ${expectedSection?.title}`), `${sectionId} 选择正文应保留所选标题`);
  if (sectionId !== 'section-1') {
    assert.ok(!result.markdown.includes('一标段'), '选择二标段时不应保留一标段正文');
  } else {
    assert.ok(!result.markdown.includes('二标段'), '选择一标段时不应保留二标段正文');
  }

  assert.equal(state.bidSectionExtractionStatus, 'success', '选择后提取状态应保持 success');
  assert.equal(state.bidSectionExtractionError, undefined, '选择后提取错误应为空');
  assertDownstreamCleared(state);
  return afterVersion;
}

async function main() {
  const fixture = readFixture('j1-multi-section-selection.fixture.json');
  const expected = fixture.expected;
  const input = fixture.input;
  const selectedSectionId = expected.selection.selectedSectionId;

  const detector = detectBidSections(input.tenderMarkdown);
  assert.deepEqual(detector, expected.detector, '多标段检测结果应与基线一致');

  const selectedSection = input.sectionExtractionResponses?.[0]?.sections?.find((section) => section.id === selectedSectionId)
    || expected.bidSections.find((section) => section.id === selectedSectionId);
  const expectedSectionData = expected.bidSections.find((item) => item.id === selectedSectionId);
  const contextHint = buildBidSectionContextHint(selectedSection || expectedSectionData, {
    hasSelectedSection: true,
  });
  assert.equal(contextHint, expected.contextHint, '多标段场景上下文提示应与基线一致');

  const sectionSeed = input.sectionExtractionResponses?.[0]?.sections || expected.bidSections;
  const alternativeSection = sectionSeed.find((item) => item.id !== selectedSectionId);
  assert.ok(alternativeSection, 'fixture 应该包含可重选的第二标段');
  assert.equal(expected.task.bidSectionExtractionStatus, 'success', '多标段识别任务状态应为 success');
  assert.equal(expected.task.bidSectionExtractionError, null, '成功场景错误信息应为空');

  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-j-j1-sections-'));
  let database;
  try {
    database = createSqliteDatabase({ workspaceRoot });
    const store = createTechnicalPlanStore({
      db: database.db,
      workspaceRoot,
      fileService: createTenderFileService(input.tenderMarkdown),
    });
    await store.importTenderDocument(['fixture-tender']);

    store.updateTechnicalPlan({
      bidSectionMode: 'multiple',
      bidSections: sectionSeed,
      bidSectionExtractionStatus: 'success',
      bidSectionExtractionError: null,
      bidAnalysisTask: {
        task_id: 'seed-bid-analysis',
        status: 'success',
        progress: 100,
        logs: ['seed bid analysis'],
      },
      bidAnalysisTasks: {
        projectOverview: {
          id: 'projectOverview',
          label: '项目概况',
          status: 'success',
          content: input.requiredBidAnalysisTasks?.projectOverview || '项目概况完成',
        },
      },
      referenceKnowledgeDocumentIds: ['doc-1', 'doc-2'],
      globalFacts: [{ id: 'fact-1', title: '既有事实', content: '已生成事实' }],
      outlineGenerationTask: {
        task_id: 'seed-outline',
        status: 'success',
        progress: 100,
      },
      outlineData: {
        project_name: '测试项目',
        project_overview: '投标文件摘要',
        outline: [
          {
            id: '1',
            title: '前置说明',
            description: '可回收的目录数据',
            children: [
              {
                id: '1.1',
                title: '子章节',
                description: '测试子章节',
              },
            ],
          },
        ],
      },
      contentGenerationOptions: { enabled: true },
      contentGenerationRuntime: { version: 1 },
      contentIllustrationPlan: { version: 1 },
    });

    const preSelectVersion = store.getBidAnalysisInputVersion();
    const section1Version = await runStoreSelectionCheck(store, selectedSectionId, sectionSeed, expected.selection.selectedMarkdownBySection);
    assert.equal(section1Version.inputRevision, preSelectVersion.inputRevision + 1, '第一轮选择应导致单步输入版本递增');
    const section2Version = await runStoreSelectionCheck(store, alternativeSection.id, sectionSeed, expected.selection.selectedMarkdownBySection);
    assert.equal(section2Version.inputRevision, section1Version.inputRevision + 1, '重选应再次提升输入版本');
    const rollbackVersion = await runStoreSelectionCheck(store, selectedSectionId, sectionSeed, expected.selection.selectedMarkdownBySection);
    assert.equal(rollbackVersion.inputRevision, section2Version.inputRevision + 1, '回退重选应再次提升输入版本');
    const finalState = store.loadTechnicalPlan();
    assert.equal(finalState.tenderFile.selectedSectionId, selectedSectionId, '回退后最终应回到期望标段');
    assert.equal(store.readTenderMarkdown().trim(), expected.selection.selectedMarkdownBySection?.[selectedSectionId] || expected.selection.selectedMarkdown, '回退后正文应回到目标基线');
    console.log('WP-J J-1 多标段检测与选段 fixture 验证通过');
  } finally {
    database?.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
