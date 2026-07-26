const fs = require('node:fs');
const { test, expect } = require('@playwright/test');

test('Web Bridge 生成 Word 后可由真实浏览器下载', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '使用 MainQuest 账号登录' }).click();
  await page.getByLabel('邮箱').fill('browser-export@test.com');
  await page.getByLabel('姓名').fill('浏览器导出测试');
  await Promise.all([
    page.waitForURL('http://127.0.0.1:5173/'),
    page.getByRole('button', { name: '登录' }).click(),
  ]);
  await page.waitForFunction(() => window.yibiao?.platform === 'web');

  const result = await page.evaluate(() => window.yibiao.export.exportWord({
    project_name: '浏览器导出测试',
    outline: [{ id: 'chapter-1', title: '第一章', content: '真实浏览器下载验证', children: [] }],
  }));

  expect(result.success).toBe(true);
  expect(result.downloadUrl).toMatch(/^\/api\/downloads\/[0-9a-f-]+$/i);
  expect(result.fileName).toMatch(/^浏览器导出测试_.*\.docx$/);

  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(({ downloadUrl, fileName }) => {
    const anchor = document.createElement('a');
    anchor.href = downloadUrl;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, { downloadUrl: result.downloadUrl, fileName: result.fileName });
  const download = await downloadPromise;
  const savedPath = await download.path();
  expect(download.suggestedFilename()).toBe(result.fileName);
  expect(fs.readFileSync(savedPath).subarray(0, 2).toString('utf8')).toBe('PK');

  const reused = await page.request.get(result.downloadUrl);
  expect(reused.status()).toBe(404);
});
