const assert = require('node:assert/strict');
const { createAgentOpenAiProxy, responsesToChatRequest } = require('../server/agent/agentOpenAiProxy.cjs');

async function main() {
  const translated = responsesToChatRequest({
    instructions: 'Follow the controlled Agent workflow.',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'run' }] },
      { type: 'function_call', call_id: 'call_1', name: 'write', arguments: '{"filePath":"result.json"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    ],
    tools: [{ type: 'function', name: 'write', parameters: { type: 'object' } }],
  });
  assert.deepEqual(translated.messages[0], { role: 'system', content: 'Follow the controlled Agent workflow.' });
  assert.equal(translated.messages[2].tool_calls[0].function.name, 'write');
  assert.equal(translated.messages[3].role, 'tool');
  assert.equal(translated.tools[0].function.name, 'write');

  let captured;
  const aiService = {
    captureTextModelSnapshot: () => ({ modelName: 'fixture' }),
    withQueueScope() { return this; },
    async chatCompletionsRaw(body) {
      captured = body;
      return { model: 'fixture', choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: {} };
    },
  };
  const proxy = await createAgentOpenAiProxy({ aiService, scopeId: 'protocol-test' });
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ instructions: 'Keep tool policy.', input: [{ role: 'user', content: 'hello' }], stream: true }),
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    assert.match(body, /response\.output_text\.delta/);
    assert.match(body, /response\.completed/);
    assert.equal(captured.stream, false);
    assert.deepEqual(captured.messages[0], { role: 'system', content: 'Keep tool policy.' });
    console.log('PASS: Agent Responses/Chat protocol adapter');
  } finally {
    await proxy.close();
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
