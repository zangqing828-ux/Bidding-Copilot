const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.route('https://analytics.agnet.top/notice**', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 0, notice: null }) });
  });
});

async function enterTechnicalPlan(page) {
  await page.getByRole('button', { name: /标书生成/ }).click();
  await page.getByRole('button', { name: /生成技术方案/ }).click();
}

async function login(page) {
  await page.goto('/');
  await page.getByRole('button', { name: '使用 MainQuest 账号登录' }).click();
  await page.getByLabel('邮箱').fill('browser-technical-plan-j1@test.com');
  await page.getByLabel('姓名').fill('J1 浏览器技术方案测试');
  await Promise.all([page.waitForURL('http://127.0.0.1:5173/'), page.getByRole('button', { name: '登录' }).click()]);
  await page.waitForFunction(() => window.yibiao?.platform === 'web');
  await enterTechnicalPlan(page);
}

test('真实 Chromium 完成双标段识别、选段、目录生成并在刷新后恢复', async ({ page }) => {
  await login(page);
  const fileId = await page.evaluate(async () => {
    const markdown = ['# J-1 双标段招标文件', '项目概况：建设统一业务平台。', '一标段：云平台建设', '范围：平台架构、系统集成与上线。', '通用要求：项目管理和验收。', '二标段：运维保障', '范围：监控、培训和 SLA 服务。', '交付要求：提交验收资料。'].join('\n');
    const form = new FormData();
    form.append('file', new File([markdown], 'j1-two-sections.md', { type: 'text/markdown' }));
    const response = await fetch('/api/uploads', { method: 'POST', body: form });
    const uploaded = await response.json();
    if (!response.ok) throw new Error(uploaded.message || '上传失败');
    return uploaded.fileId;
  });

  await page.evaluate(async (uploadedFileId) => {
    await window.yibiao.technicalPlan.importTenderDocument([uploadedFileId]);
    await window.yibiao.technicalPlan.updateStep('bid-analysis');
  }, fileId);
  await page.reload();
  await enterTechnicalPlan(page);

  await page.getByRole('button', { name: '开始解析' }).click();
  const configDialog = page.getByRole('dialog');
  await expect(configDialog).toBeVisible();
  await configDialog.getByRole('button', { name: '多标段' }).click();
  await configDialog.getByRole('button', { name: '开始解析' }).click();
  const sectionWarning = page.getByRole('dialog', { name: '投标范围确认' });
  if (await sectionWarning.isVisible().catch(() => false)) {
    await sectionWarning.getByRole('button', { name: '切换多标段' }).click();
  }
  await expect(page.getByText('多标段识别任务已在后台启动', { exact: true })).toBeVisible();

  await expect.poll(async () => page.evaluate(async () => {
    const state = await window.yibiao.technicalPlan.loadState();
    return { status: state.bidSectionExtractionStatus, count: state.bidSections?.length || 0 };
  }), { timeout: 15_000 }).toEqual({ status: 'success', count: 2 });

  await page.reload();
  await enterTechnicalPlan(page);
  const sectionDialog = page.getByRole('dialog', { name: '选择投标范围' });
  await expect(sectionDialog).toBeVisible();
  await sectionDialog.getByRole('radio', { name: /二标段/ }).click();
  await sectionDialog.getByRole('button', { name: '确认导入' }).click();
  await page.reload();
  await enterTechnicalPlan(page);
  await page.getByRole('button', { name: '开始解析' }).click();
  const analysisDialog = page.getByRole('dialog');
  await expect(analysisDialog).toBeVisible();
  await analysisDialog.getByRole('button', { name: '开始解析' }).click();
  await expect.poll(async () => page.evaluate(async () => (await window.yibiao.technicalPlan.loadState()).bidAnalysisTask?.status), { timeout: 15_000 }).toBe('success');
  await expect.poll(async () => page.evaluate(async () => {
    const state = await window.yibiao.technicalPlan.loadState();
    return { selected: state.tenderFile?.selectedSectionId, markdown: await window.yibiao.technicalPlan.readTenderMarkdown() };
  })).toMatchObject({ selected: 'section-2', markdown: expect.stringContaining('二标段：运维保障') });
  const selectedMarkdown = await page.evaluate(async () => window.yibiao.technicalPlan.readTenderMarkdown());
  expect(selectedMarkdown).not.toContain('范围：平台架构、系统集成与上线。');

  await page.evaluate(() => window.yibiao.technicalPlan.updateStep('outline-generation'));
  await page.reload();
  await enterTechnicalPlan(page);
  await page.getByRole('button', { name: '生成目录' }).click();
  await expect(page.getByRole('dialog', { name: '生成目录' })).toBeVisible();
  await page.getByRole('dialog', { name: '生成目录' }).getByRole('button', { name: '开始生成' }).click();
  await expect(page.getByText('目录生成任务已在后台启动', { exact: true })).toBeVisible();
  await expect.poll(async () => page.evaluate(async () => (await window.yibiao.technicalPlan.loadState()).outlineGenerationTask?.status), { timeout: 15_000 }).toBe('success');

  await page.reload();
  await enterTechnicalPlan(page);
  await expect.poll(async () => page.evaluate(async () => {
    const state = await window.yibiao.technicalPlan.loadState();
    return { task: state.outlineGenerationTask?.status, title: state.outlineData?.outline?.[0]?.title };
  })).toEqual({ task: 'success', title: '技术实现能力' });
  await expect(page.getByText('技术实现能力', { exact: true })).toBeVisible();
});
