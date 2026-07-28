const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.route('https://analytics.agnet.top/notice**', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 0, notice: null }) });
  });
});

async function login(page) {
  await page.goto('/');
  await page.getByRole('button', { name: '使用 MainQuest 账号登录' }).click();
  await page.getByLabel('邮箱').fill('browser-surface@test.com');
  await page.getByLabel('姓名').fill('浏览器表面挂载测试');
  await Promise.all([
    page.waitForURL('http://127.0.0.1:5173/'),
    page.getByRole('button', { name: '登录' }).click(),
  ]);
  await page.waitForFunction(() => window.yibiao?.platform === 'web');
}

test('登录后 App 成功挂载且四个首发入口可达', async ({ page }) => {
  page.on('pageerror', (error) => {
    throw new Error(`页面运行时异常：${error.message}`);
  });

  const bridgeRemovedResponses = [];
  page.on('response', (response) => {
    const sameOrigin = new URL(response.url()).origin === new URL(page.url()).origin;
    if (sameOrigin && response.status() === 410) {
      bridgeRemovedResponses.push(response.url());
    }
  });

  await login(page);

  await expect(page.locator('#root')).not.toBeEmpty();
  await expect(page.getByRole('navigation', { name: '主菜单' })).toBeVisible();
  await expect(page.getByRole('button', { name: '标书生成' })).toBeVisible();
  await expect(page.getByRole('button', { name: '模版设置' })).toBeVisible();
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible();

  await page.getByRole('button', { name: '标书生成' }).click();
  await expect(page.getByRole('button', { name: /生成技术方案/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /已有方案扩写/ })).toBeVisible();
  await page.getByRole('button', { name: /生成技术方案/ }).click();
  await expect(page.getByText('STEP 01').or(page.getByText('文档分析')).first()).toBeVisible();

  await page.getByRole('button', { name: '标书生成' }).click();
  await page.getByRole('button', { name: /已有方案扩写/ }).click();
  await expect(page.getByText('STEP 01').or(page.getByText('文档分析')).first()).toBeVisible();

  await page.getByRole('button', { name: '模版设置' }).click();
  await expect(page.getByRole('button', { name: /我的模板/ })).toBeVisible();
  await page.getByRole('button', { name: /我的模板/ }).click();
  await expect(page.getByText('我的模板').or(page.getByText('暂无模板')).first()).toBeVisible();

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByText('文本模型').or(page.getByText('通用')).first()).toBeVisible();
  await expect(page.getByText('开发者模式')).toHaveCount(0);
  await expect(page.getByText('GPU 硬件加速')).toHaveCount(0);
  await expect(page.getByText('自动更新渠道')).toHaveCount(0);
  await expect(page.getByText('智能体配置')).toHaveCount(0);
  await expect(page.getByText('离线激活授权')).toHaveCount(0);

  await expect(page.getByRole('button', { name: /商务标|文档知识库|标书查重|废标项检查|AI评标|测试页/ })).toHaveCount(0);

  expect(
    bridgeRemovedResponses,
    `检测到 ${bridgeRemovedResponses.length} 次 410 Bridge 响应（已下线能力仍被 Renderer 调用）: ${bridgeRemovedResponses.join(', ')}`,
  ).toHaveLength(0);
});
