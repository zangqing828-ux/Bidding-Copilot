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
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await readRequestBody(req);
      const payload = await scopedAi.chatCompletionsRaw(body, { modelSnapshot: frozenSnapshot });
      writeJson(res, 200, payload);
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
};
