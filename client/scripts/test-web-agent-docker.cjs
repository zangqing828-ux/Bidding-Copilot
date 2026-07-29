const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWebAgentService } = require('../server/agent/webAgentService.cjs');

function completion(message, finishReason = 'stop') {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'bidmaster-proxy',
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
}

async function main() {
  assert.equal(process.platform, 'linux');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bidmaster-agent-docker-'));
  const requests = [];
  const businessRequests = [];
  const aiService = {
    captureTextModelSnapshot: () => ({ provider: 'test', baseUrl: 'http://127.0.0.1', modelName: 'bidmaster-proxy', apiKey: 'test', capturedAt: new Date().toISOString() }),
    withQueueScope() { return this; },
    async chatCompletionsRaw(body) {
      requests.push(body);
      const writeTool = body.tools?.find((tool) => tool.function?.name === 'write');
      if (writeTool) businessRequests.push(body);
      if (writeTool && !body.messages?.some((message) => message.role === 'tool')) {
        const instructions = body.messages?.find((message) => message.role === 'system')?.content;
        assert.ok(String(instructions || '').trim(), '真实 OpenCode 请求缺少 Responses instructions');
        assert.ok(writeTool, `真实 OpenCode 请求未包含 write 工具：${JSON.stringify(body.tools?.map((tool) => tool.function?.name))}`);
        const properties = writeTool.function.parameters?.properties || {};
        const pathKey = ['filePath', 'path', 'file_path'].find((key) => properties[key]) || 'filePath';
        const contentKey = ['content', 'text'].find((key) => properties[key]) || 'content';
        return completion({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_write_result',
            type: 'function',
            function: {
              name: 'write',
              arguments: JSON.stringify({ [pathKey]: 'result.json', [contentKey]: JSON.stringify({ expectedRevision: 1, value: 'docker-e2e-pass' }) }),
            },
          }],
        }, 'tool_calls');
      }
      if (!writeTool) return completion({ role: 'assistant', content: 'BidMaster Agent Task' });
      const toolMessage = body.messages?.find((message) => message.role === 'tool');
      assert.ok(toolMessage, '第二轮请求缺少真实工具执行结果');
      assert.doesNotMatch(String(toolMessage.content || ''), /error|denied|invalid|failed|not found|prevents/i, `write 工具执行失败：${toolMessage.content}`);
      return completion({ role: 'assistant', content: 'result.json 已生成。' });
    },
  };
  const service = createWebAgentService({
    workspaceId: 'docker-e2e',
    workspaceRoot: root,
    aiService,
    env: {
      ...process.env,
      BIDMASTER_WEB_OPENCODE_BIN: process.env.BIDMASTER_WEB_OPENCODE_BIN,
      BIDMASTER_WEB_PRLIMIT_BIN: '/usr/bin/prlimit',
      BIDMASTER_WEB_AGENT_TOOLS: '',
    },
  });
  try {
    const result = await service.runTask({
      task_id: 'contract-fixture',
      task: '调用允许的 write 工具，将指定 JSON 写入 result.json。',
      files: [{ path: 'input/fixture.txt', content: 'docker fixture input' }],
      timeout_ms: 12_000,
    });
    assert.equal(result.success, true);
    assert.deepEqual(JSON.parse(result.output_content), { expectedRevision: 1, value: 'docker-e2e-pass' });
    assert.equal(businessRequests.length, 2);
    assert.equal(fs.readdirSync(path.join(root, '.agent-tasks')).length, 0);
    console.log('PASS: real OpenCode two-round tool call, safe output and cleanup');
  } finally {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
