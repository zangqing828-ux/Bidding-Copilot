const crypto = require('node:crypto');
const http = require('node:http');

const MAX_PROXY_BODY_BYTES = 2 * 1024 * 1024;

function createProxyError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readRequestBody(req, maxBytes = MAX_PROXY_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(createProxyError('Agent proxy 请求体过大', 'AGENT_PROXY_BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(createProxyError('Agent proxy 请求 JSON 无效', 'AGENT_PROXY_BAD_REQUEST'));
      }
    });
    req.on('error', reject);
  });
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function responsesToChatRequest(source) {
  const messages = (Array.isArray(source.input) ? source.input : []).map((item) => {
    if (item.type === 'function_call') {
      return { role: 'assistant', content: null, tool_calls: [{ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } }] };
    }
    if (item.type === 'function_call_output') {
      return { role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output) };
    }
    return {
      role: item.role,
      content: typeof item.content === 'string'
        ? item.content
        : (Array.isArray(item.content) ? item.content.map((part) => part.text || part.content || '').join('') : ''),
    };
  });
  const tools = (Array.isArray(source.tools) ? source.tools : []).filter((tool) => tool.type === 'function').map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters || {} },
  }));
  return { messages, tools, tool_choice: source.tool_choice, stream: false };
}

function writeResponsesSse(res, chatPayload) {
  const choice = chatPayload?.choices?.[0] || {};
  const message = choice.message || {};
  const responseId = `resp_${crypto.randomUUID().replace(/-/g, '')}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const output = [];
  if (message.tool_calls?.length) {
    for (const call of message.tool_calls) {
      output.push({ type: 'function_call', id: `fc_${crypto.randomUUID().replace(/-/g, '')}`, call_id: call.id, name: call.function.name, arguments: call.function.arguments, status: 'completed' });
    }
  } else {
    output.push({ type: 'message', id: `msg_${crypto.randomUUID().replace(/-/g, '')}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: String(message.content || ''), annotations: [] }] });
  }
  const response = { id: responseId, object: 'response', created_at: createdAt, status: 'completed', model: chatPayload?.model || 'bidmaster-proxy', output, usage: { input_tokens: chatPayload?.usage?.prompt_tokens || 0, output_tokens: chatPayload?.usage?.completion_tokens || 0, total_tokens: chatPayload?.usage?.total_tokens || 0 } };
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
  res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } })}\n\n`);
  output.forEach((item, outputIndex) => {
    res.write(`event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: outputIndex, item: { ...item, status: 'in_progress' } })}\n\n`);
    if (item.type === 'function_call') {
      res.write(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: outputIndex, delta: item.arguments })}\n\n`);
      res.write(`event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: outputIndex, arguments: item.arguments })}\n\n`);
    } else {
      res.write(`event: response.content_part.added\ndata: ${JSON.stringify({ type: 'response.content_part.added', item_id: item.id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })}\n\n`);
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', item_id: item.id, output_index: outputIndex, content_index: 0, delta: item.content[0].text })}\n\n`);
      res.write(`event: response.output_text.done\ndata: ${JSON.stringify({ type: 'response.output_text.done', item_id: item.id, output_index: outputIndex, content_index: 0, text: item.content[0].text })}\n\n`);
      res.write(`event: response.content_part.done\ndata: ${JSON.stringify({ type: 'response.content_part.done', item_id: item.id, output_index: outputIndex, content_index: 0, part: item.content[0] })}\n\n`);
    }
    res.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: outputIndex, item })}\n\n`);
  });
  res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`);
}

function createAgentOpenAiProxy({ aiService, modelSnapshot, scopeId }) {
  if (!aiService || typeof aiService.withQueueScope !== 'function') {
    throw new Error('createAgentOpenAiProxy 需要 AI service');
  }
  if (!aiService || typeof aiService.captureTextModelSnapshot !== 'function') {
    throw new Error('AI service 缺少模型快照能力');
  }
  if (typeof aiService.chatCompletionsRaw !== 'function') {
    throw new Error('AI service 缺少 raw chat 能力');
  }

  const token = crypto.randomBytes(24).toString('base64url');
  const scopedAi = aiService.withQueueScope(scopeId);
  const frozenSnapshot = modelSnapshot || aiService.captureTextModelSnapshot();
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== 'POST' || !['/v1/chat/completions', '/v1/responses'].includes(req.url)) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await readRequestBody(req);
      const payload = await scopedAi.chatCompletionsRaw(
        req.url === '/v1/responses' ? responsesToChatRequest(body) : body,
        { modelSnapshot: frozenSnapshot },
      );
      if (req.url === '/v1/responses') writeResponsesSse(res, payload);
      else writeJson(res, 200, payload);
    } catch (error) {
      writeJson(res, 502, {
        error: {
          message: error?.message || 'Agent AI proxy 请求失败',
          type: error?.code || 'agent_proxy_error',
        },
      });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        token,
        baseUrl: `http://127.0.0.1:${address.port}`,
        modelSnapshot: frozenSnapshot,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

module.exports = {
  MAX_PROXY_BODY_BYTES,
  createAgentOpenAiProxy,
  readRequestBody,
  responsesToChatRequest,
  writeResponsesSse,
};
