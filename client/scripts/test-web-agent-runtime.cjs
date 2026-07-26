const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWebAgentService, safeRelativePath } = require('../server/agent/webAgentService.cjs');
const { createWebTaskService } = require('../server/workspace/webServices.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-web-agent-'));
const binaryPath = path.join(root, 'fake-opencode');
const workspaceRoot = path.join(root, 'workspace-a');
const passed = [];
const failed = [];

function check(condition, message) {
  if (condition) passed.push(message);
  else failed.push(message);
}

fs.writeFileSync(binaryPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const dir = args[args.indexOf('--dir') + 1];
if (args.includes('wait-forever')) setInterval(() => {}, 1000);
fs.writeFileSync(path.join(dir, 'result.md'), 'agent generated content', 'utf8');
process.stdout.write(JSON.stringify({ type: 'text', text: 'done' }) + '\\n');
`);
fs.chmodSync(binaryPath, 0o755);

async function run() {
  const service = createWebAgentService({
    workspaceId: 'account-a',
    workspaceRoot,
    env: { YIBIAO_WEB_OPENCODE_BIN: binaryPath, YIBIAO_WEB_AGENT_TOOLS: '' },
    aiService: { withQueueScope: () => ({ chat: async () => 'unused' }) },
  });

  const descriptors = service.listRuntimes();
  check(descriptors.length === 1 && descriptors[0].id === 'opencode', '仅暴露 OpenCode Web Runtime');

  const result = await service.runTask({
    task_id: 'plan-1',
    task: '生成一段投标摘要',
    output_file: 'result.md',
    files: [{ path: 'input/tender.md', content: '# 招标文件' }],
  });
  check(result.success === true, 'Agent 成功执行');
  check(result.output_content === 'agent generated content', 'Agent 读取受控输出文件');
  check(!fs.existsSync(path.join(workspaceRoot, '.agent-tasks', 'plan-1')), '任务结束后清理临时工作区');
  check(service.getStatus().active_task === null, '任务结束后状态恢复空闲');

  assert.throws(() => safeRelativePath('../outside.md'));
  check(true, '拒绝相对路径越界');
  assert.throws(() => safeRelativePath('AGENTS.md'));
  check(true, '拒绝覆盖 Agent 指令文件');

  await assert.rejects(
    service.runTask({ task: 'wait-forever', timeout_ms: 25 }),
    (error) => error?.code === 'AGENT_TIMEOUT',
  );
  check(true, '超时时终止 Agent 进程');

  const writes = [];
  const taskService = createWebTaskService({
    agentService: { runTask: async () => ({ output_content: '项目概述结果' }) },
    technicalPlanStore: {
      readTenderMarkdown: () => '# 招标文件',
      loadTechnicalPlan: () => ({ bidAnalysisTasks: {} }),
      updateTechnicalPlanWithoutReload: (patch) => writes.push(patch),
    },
  });
  taskService.startBidAnalysis({});
  await new Promise((resolve) => setTimeout(resolve, 20));
  const finalWrite = writes.at(-1);
  check(finalWrite?.bidAnalysisTasks?.projectOverview?.content === '项目概述结果', '核心项目概述任务通过 Agent 写回技术方案 Store');
  taskService.close();
  await service.close();
}

run().catch((error) => {
  failed.push(error?.stack || error?.message || String(error));
}).finally(() => {
  fs.rmSync(root, { recursive: true, force: true });
  for (const message of passed) console.log(`  PASS: ${message}`);
  for (const message of failed) console.error(`  FAIL: ${message}`);
  console.log(`Web Agent Runtime 测试：${passed.length} 通过，${failed.length} 失败`);
  process.exitCode = failed.length ? 1 : 0;
});
