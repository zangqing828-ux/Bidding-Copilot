#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

async function callProxy(baseUrl, token, executionId, messages, tools) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ executionId, messages, model: 'fixture-model', stream: false, tools }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`fixture proxy failed: ${response.status}`);
  return body;
}

async function main() {
  const config = JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG, 'utf8'));
  const baseUrl = config.provider.openai.options.baseURL;
  const token = process.env.YIBIAO_AGENT_PROXY_TOKEN;
  const executionId = process.env.YIBIAO_AGENT_EXECUTION_ID;
  const input = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'input', 'request.json'), 'utf8'));
  const tools = [{
    type: 'function',
    function: {
      name: 'write',
      description: 'write the final result.json',
      parameters: { type: 'object', properties: { filePath: { type: 'string' }, content: { type: 'string' } }, required: ['filePath', 'content'] },
    },
  }];
  const messages = [{ role: 'system', content: 'Only use read/glob/grep/write; never use bash or network.' }, { role: 'user', content: JSON.stringify(input) }];
  const first = await callProxy(baseUrl, token, executionId, messages, tools);
  const call = first.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) throw new Error('fixture did not receive tool call');
  const args = JSON.parse(call.function.arguments);
  if (args.filePath !== 'result.json') throw new Error('fixture attempted undeclared output');
  fs.writeFileSync(path.join(process.cwd(), args.filePath), args.content, { encoding: 'utf8', mode: 0o600 });
  messages.push({ role: 'assistant', content: null, tool_calls: [call] });
  messages.push({ role: 'tool', tool_call_id: call.id, content: 'write result.json succeeded' });
  await callProxy(baseUrl, token, executionId, messages, tools);
  process.stdout.write(JSON.stringify({ ok: true }));
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
