// WR-03 technical plan 浏览器 E2E：
// 验证 Web 端技术方案任务（目录桥接、全局事实完整链、正文入口非占位）与刷新后状态恢复。
const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.route('https://analytics.agnet.top/notice**', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 0, notice: null }) });
  });
});

async function login(page, email) {
  await page.goto('/');
  await page.getByRole('button', { name: '使用 MainQuest 账号登录' }).click();
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('姓名').fill('浏览器技术方案测试');
  await Promise.all([
    page.waitForURL('http://127.0.0.1:5173/'),
    page.getByRole('button', { name: '登录' }).click(),
  ]);
  await page.waitForFunction(() => window.yibiao?.platform === 'web');
}

test('technical plan 任务链：全局事实生成、刷新恢复与正文入口真实校验', async ({ page }) => {
  await login(page, 'browser-technical-plan@test.com');

  // 单租户共享工作区：先清空技术方案状态，避免前序 spec 残留的流程模式干扰。
  await page.evaluate(async () => {
    await window.yibiao.technicalPlan.clear();
    await window.yibiao.technicalPlan.setWorkflowKind('technical-plan');
  });

  // 上传并导入招标文件，注入目录，构造 global-facts 前置状态。
  await page.evaluate(async () => {
    const form = new FormData();
    form.append('file', new File(['# 测试招标文件\n项目概况、技术要求。'], 'browser-tender.md', { type: 'text/markdown' }));
    const upload = await fetch('/api/uploads', { method: 'POST', body: form });
    const uploaded = await upload.json();
    if (!upload.ok) throw new Error(uploaded.message || '上传失败');
    await window.yibiao.technicalPlan.importTenderDocument([uploaded.fileId]);
    await window.yibiao.technicalPlan.saveOutline({
      outlineData: {
        project_name: '浏览器测试项目',
        project_overview: '测试概述',
        outline: [{ id: '1', title: '第一章', children: [{ id: '1.1', title: '概述小节', children: [] }] }],
      },
      reason: 'replace',
    });
  });

  // 全局事实任务：真实 runner + 测试 AI 完整链。
  const factsTask = await page.evaluate(async () => window.yibiao.tasks.startGlobalFactsGeneration({}));
  expect(factsTask.type).toBe('global-facts-generation');

  await expect.poll(async () => page.evaluate(async () => {
    const state = await window.yibiao.technicalPlan.loadState();
    const task = state.globalFactsTask;
    return task?.status === 'error' ? `error:${task.error || ''}` : task?.status;
  }), { timeout: 15_000 }).toBe('success');

  // 刷新后从 Store 恢复全局事实。
  await page.reload();
  await page.waitForFunction(() => window.yibiao?.platform === 'web');
  const persisted = await page.evaluate(async () => {
    const state = await window.yibiao.technicalPlan.loadState();
    return { facts: state.globalFacts, status: state.globalFactsTask?.status };
  });
  expect(persisted.status).toBe('success');
  expect(persisted.facts.length).toBeGreaterThan(0);
  expect(persisted.facts[0].title).toBe('项目概况');

  // 正文任务入口不再是占位：返回真实业务校验错误而非 WEB_CAPABILITY_PENDING。
  const contentStartError = await page.evaluate(async () => {
    try {
      await window.yibiao.tasks.startContentGeneration({
        generationOptions: {
          useAiImages: false,
          maxAiImages: 0,
          useMermaidImages: false,
          maxMermaidImages: 0,
          useHtmlImages: false,
          maxHtmlImages: 0,
          htmlImageTypes: '',
          tableRequirement: 'none',
          enableConsistencyAudit: false,
          consistencyRepairMode: 'normal',
          enableOriginalPlanCoverageAudit: false,
        },
      });
      return null;
    } catch (error) {
      return { code: error?.code || '', message: error?.message || '' };
    }
  });
  expect(contentStartError).not.toBeNull();
  expect(contentStartError.code).not.toBe('WEB_CAPABILITY_PENDING');
  expect(contentStartError.message).toContain('字数控制生效快照');

  // 目录桥接同样非占位：非法入参返回契约校验错误。
  const outlineStartError = await page.evaluate(async () => {
    try {
      await window.yibiao.tasks.startOutlineGeneration({ evil: true });
      return null;
    } catch (error) {
      return { code: error?.code || '', message: error?.message || '' };
    }
  });
  expect(outlineStartError).not.toBeNull();
  // 非法入参在 bridge 参数校验或 taskContracts 校验层被拒绝，均为真实边界而非占位。
  expect(['INVALID_BRIDGE_ARGUMENTS', 'TASK_INVALID_INPUT']).toContain(outlineStartError.code);
});
