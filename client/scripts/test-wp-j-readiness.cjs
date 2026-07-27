const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bidmaster-wp-j-readiness-'));
process.env.NODE_ENV = 'test';
process.env.OAUTH_MODE = 'mock';
process.env.YIBIAO_DATA_DIR = dataDir;
process.env.AGENT_QUALITY_ENABLED = '0';

const readinessRouter = require('../server/routes/readiness.cjs');
assert.equal(typeof readinessRouter, 'function', 'readiness 必须默认导出 Express router');
assert.equal(typeof readinessRouter.checkAgentSidecar, 'function', 'helper 应挂在 router 属性');

function requestJson(baseUrl, route) {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${route}`, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
}

async function startApp() {
  const app = express();
  app.use('/api', readinessRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function startHealthySidecar() {
  const server = http.createServer((_req, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ protocol: 'SidecarProtocolV1', version: 1, ready: true }));
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
}

async function main() {
  const { server, baseUrl } = await startApp();
  let sidecar;
  try {
    let result = await requestJson(baseUrl, '/api/readiness');
    assert.equal(result.status, 200, 'disabled 时 J-Core readiness 必须 200');
    assert.equal(result.body.capabilities.agent_quality, 'disabled');
    result = await requestJson(baseUrl, '/api/readiness/agent-quality');
    assert.equal(result.status, 200, 'disabled 时 Agent Quality endpoint 可报告 disabled');
    assert.equal(result.body.status, 'disabled');

    process.env.AGENT_QUALITY_ENABLED = '1';
    process.env.AGENT_SIDECAR_URL = 'http://127.0.0.1:1';
    result = await requestJson(baseUrl, '/api/readiness');
    assert.equal(result.status, 200, 'blocked 时 J-Core readiness 仍必须 200');
    assert.equal(result.body.capabilities.agent_quality, 'blocked');
    result = await requestJson(baseUrl, '/api/readiness/agent-quality');
    assert.equal(result.status, 503, 'blocked 时 Agent Quality endpoint 必须 503');
    assert.equal(result.body.status, 'blocked');

    sidecar = await startHealthySidecar();
    process.env.AGENT_SIDECAR_URL = `http://127.0.0.1:${sidecar.address().port}`;
    result = await requestJson(baseUrl, '/api/readiness');
    assert.equal(result.status, 200, 'ready 时 J-Core readiness 必须 200');
    assert.equal(result.body.capabilities.agent_quality, 'ready');
    result = await requestJson(baseUrl, '/api/readiness/agent-quality');
    assert.equal(result.status, 200, 'ready 时 Agent Quality endpoint 必须 200');
    assert.equal(result.body.status, 'ready');
    console.log('PASS: WP-J readiness disabled/blocked/ready and router export');
  } finally {
    if (sidecar) await new Promise((resolve) => sidecar.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
