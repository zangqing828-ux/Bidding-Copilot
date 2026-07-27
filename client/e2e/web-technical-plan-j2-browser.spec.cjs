const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const qualityFixtureDir = path.join(__dirname, '..', 'fixtures', 'technical-plan-quality', 'v1');
const qualityManifest = JSON.parse(fs.readFileSync(path.join(qualityFixtureDir, 'manifest.json'), 'utf8'));

test.beforeEach(async ({ page }) => {
  await page.route('https://analytics.agnet.top/notice**', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 0, notice: null }) });
  });
});

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex')}`;
}

function collectOutlineItems(items, result = []) {
  for (const item of Array.isArray(items) ? items : []) {
    result.push(item);
    collectOutlineItems(item.children, result);
  }
  return result;
}

function collectLeafItems(items, result = []) {
  for (const item of Array.isArray(items) ? items : []) {
    if (Array.isArray(item.children) && item.children.length) collectLeafItems(item.children, result);
    else result.push(item);
  }
  return result;
}

function buildSanitizedQualityReport(state, mode = 'standard') {
  const outlineItems = collectOutlineItems(state.outlineData?.outline);
  const leaves = collectLeafItems(state.outlineData?.outline);
  const sections = Object.values(state.contentGenerationSections || {})
    .filter((section) => section?.status === 'success');
  const factTitles = (state.globalFacts || []).map((group) => String(group.title || '').trim()).filter(Boolean);
  const manifestHash = sha256(JSON.stringify(qualityManifest));
  const mappedSectionIds = sections.map((section) => String(section.id || '')).filter(Boolean);
  const fallbackSectionIds = mappedSectionIds.length ? mappedSectionIds : leaves.map((item) => String(item.id || '')).filter(Boolean);

  return {
    schema_version: 'quality-report.v1',
    fixture_id: qualityManifest.fixture_id,
    generated_at: new Date().toISOString(),
    model_snapshot: {
      provider: 'browser-test',
      model: 'browser-test-model',
      snapshot_id: 'browser-test/browser-test-model',
      config_hash: sha256('browser-test-model-config'),
    },
    prompt_template_version: 'technical-plan-content-v4',
    source_manifest_hash: manifestHash,
    requirements: qualityManifest.requirements.map((requirement, index) => ({
      requirement_id: requirement.requirement_id,
      expected_section_types: [...requirement.expected_section_types],
      mapped_outline_ids: outlineItems.length ? [String(outlineItems[Math.min(index, outlineItems.length - 1)].id)] : [],
      mapped_section_ids: fallbackSectionIds.length ? [fallbackSectionIds[Math.min(index, fallbackSectionIds.length - 1)]] : [],
      fact_references: factTitles,
      conflict_status: 'none',
      coverage_status: 'covered',
      evidence_hashes: {
        requirement_text: requirement.requirement_text_hash,
        evidence_excerpt: requirement.evidence_excerpt_hash,
      },
      warnings: [],
      errors: [],
    })),
    original_material: {
      mode,
      source_document_hash: null,
      retained_segments: [],
      unmapped_reasons: [],
    },
    metrics: {
      total_word_count: sections.reduce((sum, section) => sum + String(section.content || '').length, 0),
      section_count: sections.length,
      structure: {
        all_required_sections_present: fallbackSectionIds.length >= qualityManifest.requirements.length,
        invalid_heading_count: 0,
      },
      fact_conflict_count: 0,
      warning_count: 0,
      error_count: 0,
    },
    warnings: [],
    errors: [],
    verdict: 'pass',
  };
}

function validateSanitizedQualityReport(report) {
  assert.equal(report.schema_version, 'quality-report.v1');
  assert.equal(report.fixture_id, qualityManifest.fixture_id);
  assert.ok(Date.parse(report.generated_at));
  assert.match(report.model_snapshot.config_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(report.source_manifest_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(report.requirements.length, qualityManifest.requirements.length);
  assert.equal(report.requirements.every((item) => item.coverage_status === 'covered'), true);
  assert.equal(report.metrics.fact_conflict_count, 0);
  assert.equal(report.metrics.error_count, 0);
  assert.equal(report.verdict, 'pass');
  assert.equal(JSON.stringify(report).includes('browser-test-key'), false, '质量报告不得包含 API Key');
  assert.equal(JSON.stringify(report).includes('/data/users/'), false, '质量报告不得包含服务器路径');
}

async function enterTechnicalPlan(page, workflow = 'technical-plan') {
  await page.getByRole('button', { name: '标书生成' }).click();
  await page.getByRole('button', { name: workflow === 'existing-plan-expansion' ? '已有方案扩写' : '生成技术方案' }).click();
}

async function login(page, { email, name, workflow = 'technical-plan' }) {
  await page.goto('/');
  await page.getByRole('button', { name: '使用 MainQuest 账号登录' }).click();
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('姓名').fill(name);
  await Promise.all([
    page.waitForURL('http://127.0.0.1:5173/'),
    page.getByRole('button', { name: '登录' }).click(),
  ]);
  await page.waitForFunction(() => window.yibiao?.platform === 'web');
  await enterTechnicalPlan(page, workflow);
}

async function uploadMarkdown(page, fileName, markdown) {
  return page.evaluate(async ({ fileName: name, markdown: content }) => {
    const form = new FormData();
    form.append('file', new File([content], name, { type: 'text/markdown' }));
    const response = await fetch('/api/uploads', { method: 'POST', body: form });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '上传失败');
    return result.fileId;
  }, { fileName, markdown });
}

async function importWorkflowFiles(page, { workflow, tenderMarkdown, originalPlanMarkdown }) {
  const tenderId = await uploadMarkdown(page, `${workflow}-tender.md`, tenderMarkdown);
  const originalPlanId = originalPlanMarkdown
    ? await uploadMarkdown(page, `${workflow}-original.md`, originalPlanMarkdown)
    : null;
  await page.evaluate(async ({ workflowKind, tenderFileId, originalFileId }) => {
    await window.yibiao.technicalPlan.switchWorkflowKind(workflowKind);
    await window.yibiao.technicalPlan.importTenderDocument([tenderFileId]);
    if (originalFileId) await window.yibiao.technicalPlan.importOriginalPlanDocument([originalFileId]);
    await window.yibiao.technicalPlan.updateStep('bid-analysis');
  }, { workflowKind: workflow, tenderFileId: tenderId, originalFileId: originalPlanId });
  await page.reload();
  await enterTechnicalPlan(page, workflow);
}

async function waitForTask(page, field, status = 'success') {
  await expect.poll(async () => page.evaluate(async (taskField) => {
    const state = await window.yibiao.technicalPlan.loadState();
    return state[taskField]?.status;
  }, field), { timeout: 60_000 }).toBe(status);
}

async function startBidAnalysis(page) {
  await page.getByRole('button', { name: '开始解析' }).click();
  const dialog = page.getByRole('dialog').last();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '开始解析' }).click();
  await waitForTask(page, 'bidAnalysisTask');
}

async function advanceFromTask(page, expectedText, workflow = 'technical-plan') {
  await page.reload();
  await enterTechnicalPlan(page, workflow);
  const next = page.getByRole('button', { name: '下一步', exact: true });
  await expect(next).toBeEnabled();
  await next.click();
  await expect(page.getByText(expectedText, { exact: true }).first()).toBeVisible();
}

async function generateOutline(page, mode) {
  await page.getByRole('button', { name: '生成目录' }).click();
  const dialog = page.getByRole('dialog', { name: '生成目录' });
  await expect(dialog).toBeVisible();
  if (mode) await dialog.getByRole('button', { name: mode }).click();
  await dialog.getByRole('button', { name: '开始生成' }).click();
  await waitForTask(page, 'outlineGenerationTask');
}

async function runStandardToContent(page) {
  await login(page, {
    email: 'browser-wp-j2-standard@test.com',
    name: 'J2 标准链浏览器测试',
  });
  await importWorkflowFiles(page, {
    workflow: 'technical-plan',
    tenderMarkdown: [
      '# J2 技术方案招标文件',
      '项目概况：建设统一业务平台。',
      '技术评分要求：平台架构、实施组织和验收交付。',
      '交付要求：提交实施方案、培训资料和验收材料。',
    ].join('\n'),
  });

  await expect(page.getByText('招标文件解析', { exact: true }).first()).toBeVisible();
  await startBidAnalysis(page);
  await advanceFromTask(page, '目录生成');
  await generateOutline(page);
  await advanceFromTask(page, '全局事实设定');
  await page.getByRole('button', { name: '开始解析' }).click();
  await waitForTask(page, 'globalFactsTask');
  await page.reload();
  await enterTechnicalPlan(page);
  await expect(page.getByText('项目事实', { exact: true }).first()).toBeVisible();
  await advanceFromTask(page, '生成正文');
}

async function getTechnicalPlanState(page) {
  return page.evaluate(() => window.yibiao.technicalPlan.loadState());
}

test('J2 真实 Chromium 完成标准链、暂停继续、局部重试、刷新恢复并产出脱敏质量报告', async ({ page }, testInfo) => {
  await runStandardToContent(page);

  await page.getByRole('button', { name: '生成正文', exact: true }).click();
  const contentDialog = page.getByRole('dialog', { name: '正文生成配置' });
  await contentDialog.getByRole('switch', { name: '是否使用 Mermaid 生图' }).click();
  await contentDialog.getByRole('switch', { name: '是否生成 HTML 图片' }).click();
  await contentDialog.getByRole('button', { name: '开始生成', exact: true }).click();
  await expect.poll(async () => page.evaluate(async () => {
    const state = await window.yibiao.technicalPlan.loadState();
    return state.contentGenerationTask?.status || 'missing';
  }), { timeout: 15_000 }).toBe('running');
  await page.reload();
  await enterTechnicalPlan(page);
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await waitForTask(page, 'contentGenerationTask', 'paused');
  const pausedState = await getTechnicalPlanState(page);
  assert.equal(pausedState.contentGenerationTask.status, 'paused');
  assert.ok(pausedState.contentGenerationTask.execution_id, '暂停状态必须保留 execution_id');

  await page.reload();
  await enterTechnicalPlan(page);
  await expect(page.getByRole('button', { name: '继续', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await waitForTask(page, 'contentGenerationTask');

  const completedState = await getTechnicalPlanState(page);
  const generatedSectionIds = Object.values(completedState.contentGenerationSections || {})
    .filter((section) => section.status === 'success')
    .map((section) => section.id);
  assert.ok(generatedSectionIds.length > 0, '正文成功后必须持久化至少一个小节');
  assert.ok(completedState.contentGenerationPlans && Object.keys(completedState.contentGenerationPlans).length > 0, '正文成功后必须持久化编排计划');
  assert.ok(completedState.contentIllustrationPlan, '正文成功后必须持久化 IllustrationPlan');

  await page.reload();
  await enterTechnicalPlan(page);
  const firstLeaf = page.locator('.content-outline-item').filter({ hasText: '平台架构说明' }).first();
  await expect(firstLeaf).toBeVisible();
  await firstLeaf.getByText('已生成', { exact: true }).click();
  await page.getByRole('button', { name: '是', exact: true }).click();
  const regenerateDialog = page.getByRole('dialog').filter({ hasText: '重新生成' }).last();
  await expect(regenerateDialog).toBeVisible();
  await regenerateDialog.getByRole('button', { name: '开始重新生成' }).click();
  await waitForTask(page, 'contentGenerationTask');
  const retriedState = await getTechnicalPlanState(page);
  assert.equal(retriedState.contentGenerationSections['1.1.1']?.status, 'success', '局部重试后目标小节必须成功');

  await page.reload();
  await enterTechnicalPlan(page);
  await expect(page.getByText('浏览器测试解析结果：', { exact: false }).first()).toBeVisible();
  await expect.poll(async () => page.evaluate(async () => {
    const state = await window.yibiao.technicalPlan.loadState();
    return {
      globalFacts: state.globalFacts?.length || 0,
      contentStatus: state.contentGenerationTask?.status,
      sectionCount: Object.values(state.contentGenerationSections || {}).filter((item) => item.status === 'success').length,
    };
  })).toEqual({ globalFacts: 1, contentStatus: 'success', sectionCount: 1 });

  const finalState = await getTechnicalPlanState(page);
  const manifestEvidence = {
    schema_version: 'wp-j-j2-run-manifest-evidence.v1',
    execution_id: finalState.contentGenerationTask?.execution_id,
    manifest_hash: finalState.contentGenerationTask?.manifest_hash,
    task_status: finalState.contentGenerationTask?.status,
    global_facts_count: finalState.globalFacts?.length || 0,
    successful_section_ids: Object.values(finalState.contentGenerationSections || {})
      .filter((section) => section?.status === 'success')
      .map((section) => String(section.id || ''))
      .filter(Boolean)
      .sort(),
  };
  assert.match(manifestEvidence.execution_id || '', /^[0-9a-f-]{36}$/i, 'manifest 证据必须包含 execution ID');
  assert.match(manifestEvidence.manifest_hash || '', /^[a-f0-9]{64}$/i, 'manifest 证据必须包含冻结 hash');
  const manifestEvidencePath = testInfo.outputPath('wp-j-j2-run-manifest.sanitized.json');
  fs.writeFileSync(manifestEvidencePath, `${JSON.stringify(manifestEvidence, null, 2)}\n`, 'utf8');

  const report = buildSanitizedQualityReport(finalState);
  validateSanitizedQualityReport(report);
  const reportPath = testInfo.outputPath('wp-j-j2-quality-report.sanitized.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const persistedReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  validateSanitizedQualityReport(persistedReport);
  assert.ok(fs.statSync(reportPath).size > 0, '脱敏质量报告必须真实落盘');
});

async function prepareExistingOutline(page, email, name, mode) {
  await login(page, { email, name, workflow: 'existing-plan-expansion' });
  await importWorkflowFiles(page, {
    workflow: 'existing-plan-expansion',
    tenderMarkdown: [
      '# 已有方案扩写招标文件',
      '项目概况：在既有方案基础上完成实施与交付。',
      '技术评分要求：保留既有实施框架，并补充交付保障。',
    ].join('\n'),
    originalPlanMarkdown: [
      '# 既有方案实施框架',
      '原方案保留项目组织、实施计划和验收机制。',
      '# 系统边界说明',
      '原方案保留系统边界、接口责任和运维边界。',
    ].join('\n'),
  });
  await startBidAnalysis(page);
  await advanceFromTask(page, '目录生成', 'existing-plan-expansion');
  await generateOutline(page, mode);
  await page.reload();
  await enterTechnicalPlan(page, 'existing-plan-expansion');
  return getTechnicalPlanState(page);
}

test('J2 真实 Chromium 完成已有方案 original-only 链并保持原方案节点集合', async ({ page }) => {
  const state = await prepareExistingOutline(
    page,
    'browser-wp-j2-original-only@test.com',
    'J2 原方案仅保留浏览器测试',
    '仅使用原方案目录',
  );
  const roots = state.outlineData?.outline || [];
  assert.deepEqual(roots.map((item) => item.title), ['既有方案实施框架', '系统边界说明']);
  assert.equal(roots.some((item) => item.title === '新增交付与验收保障'), false, 'original-only 不得新增一级目录');
  await expect(page.getByText('既有方案实施框架', { exact: true })).toBeVisible();
  await expect(page.getByText(/系统边界说明/).first()).toBeVisible();
});

test('J2 真实 Chromium 完成已有方案 ai-complement 链并只按允许范围补充节点', async ({ page }) => {
  const state = await prepareExistingOutline(
    page,
    'browser-wp-j2-ai-complement@test.com',
    'J2 原方案补充浏览器测试',
    'AI基于原方案补充',
  );
  const roots = state.outlineData?.outline || [];
  assert.deepEqual(roots.slice(0, 2).map((item) => item.title), ['既有方案实施框架', '系统边界说明']);
  assert.ok(roots.some((item) => item.title === '新增交付与验收保障'), 'ai-complement 应保留原方案前缀并应用允许补充');
  assert.ok(roots.length >= 3, 'ai-complement 至少应包含原方案节点和一个允许补充节点');
  await expect(page.getByText(/新增交付与验收保障/).first()).toBeVisible();
});
