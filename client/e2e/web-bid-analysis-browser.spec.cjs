const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.route('https://analytics.agnet.top/notice**', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 0, notice: null }) });
  });
});

async function login(page) {
  await page.goto('/');
  await page.getByRole('button', { name: '使用 MainQuest 账号登录' }).click();
  await page.getByLabel('邮箱').fill('browser-bid-analysis@test.com');
  await page.getByLabel('姓名').fill('浏览器投标解析测试');
  await Promise.all([
    page.waitForURL('http://127.0.0.1:5173/'),
    page.getByRole('button', { name: '登录' }).click(),
  ]);
  await page.waitForFunction(() => window.yibiao?.platform === 'web');
  await enterTechnicalPlan(page);
}

async function enterTechnicalPlan(page) {
  await page.getByRole('button', { name: /标书生成/ }).click();
  await page.getByRole('button', { name: /生成技术方案/ }).click();
}

test('真实浏览器完成招标文件解析并展示持久化结果', async ({ page }) => {
  await login(page);
  const fileId = await page.evaluate(async () => {
    const form = new FormData();
    form.append('file', new File(['# 测试招标文件\n项目概况、技术要求、交货服务要求。'], 'browser-tender.md', { type: 'text/markdown' }));
    const upload = await fetch('/api/uploads', { method: 'POST', body: form });
    const uploaded = await upload.json();
    if (!upload.ok) throw new Error(uploaded.message || '上传失败');
    return uploaded.fileId;
  });

  await page.evaluate(async (uploadedFileId) => {
    await window.yibiao.technicalPlan.importTenderDocument([uploadedFileId]);
    await window.yibiao.technicalPlan.updateStep('bid-analysis');
  }, fileId);
  await page.reload();
  await enterTechnicalPlan(page);

  await expect(page.getByText('招标文件解析', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '开始解析' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: '多标段' })).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: '开始解析' }).click();

  await expect(page.getByText('招标文件解析任务已在后台启动', { exact: true })).toBeVisible();
  await page.reload();
  await enterTechnicalPlan(page);
  await expect.poll(async () => page.evaluate(async () => {
    const state = await window.yibiao.technicalPlan.loadState();
    return state.bidAnalysisTask?.status;
  }), { timeout: 15_000 }).toBe('success');

  await page.reload();
  await enterTechnicalPlan(page);
  await expect(page.getByText('浏览器测试解析结果：', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('可以进入下一步。')).toBeVisible();
});
