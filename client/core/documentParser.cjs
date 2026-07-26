// 运行时无关的文档解析入口。Electron/Web adapter 只负责提供配置和文件路径。
const fs = require('node:fs/promises');
const path = require('node:path');
const AdmZip = require('adm-zip');

const parserLabels = {
  local: '本地解析',
  'mineru-accurate-api': 'MinerU 精准解析 API',
  'mineru-agent-api': 'MinerU-Agent 轻量解析 API',
};

const localSupportedExtensions = new Set(['.txt', '.md', '.markdown', '.docx', '.pdf', '.doc', '.wps', '.xls', '.xlsx']);
const mineruAgentSupportedExtensions = new Set(['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.png', '.jpg', '.jpeg', '.jp2', '.webp', '.gif', '.bmp']);
const mineruAccurateSupportedExtensions = new Set(['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.png', '.jpg', '.jpeg', '.jp2', '.webp', '.gif', '.bmp', '.html']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripMarkdownImages(markdown) {
  return String(markdown || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<img\b[^>]*>/gi, '');
}

function getSupportedExtensions(provider) {
  if (provider === 'mineru-agent-api') return mineruAgentSupportedExtensions;
  if (provider === 'mineru-accurate-api') return mineruAccurateSupportedExtensions;
  return localSupportedExtensions;
}

function resolveFileParser(config, filePath) {
  const requestedProvider = config?.components?.file_parser?.provider || 'local';
  const ext = path.extname(filePath).toLowerCase();
  if (getSupportedExtensions(requestedProvider).has(ext)) {
    return { provider: requestedProvider, requestedProvider, ext, fallbackToLocal: false };
  }
  if (requestedProvider !== 'local' && localSupportedExtensions.has(ext)) {
    return { provider: 'local', requestedProvider, ext, fallbackToLocal: true };
  }
  const error = new Error(`当前${parserLabels[requestedProvider] || '解析方式'}不支持该文件格式`);
  error.code = 'DOCUMENT_FORMAT_UNSUPPORTED';
  throw error;
}

function withTimeout(task, timeoutMs) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('文件解析超时，请稍后重试');
      error.code = 'DOCUMENT_PARSE_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
}

async function parseLocalDocument(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.txt' || ext === '.md' || ext === '.markdown') {
    return fs.readFile(filePath, 'utf-8');
  }
  const { convertPathToMarkdown } = await import('../electron/services/doc2markdown/convert.mjs');
  return convertPathToMarkdown(filePath, { includeImages: false });
}

async function readJson(response, message) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${message}：响应格式无效`);
  }
}

async function putFile(fileUrl, filePath) {
  const body = await fs.readFile(filePath);
  const response = await fetch(fileUrl, { method: 'PUT', body });
  if (!response.ok) throw new Error(`文件上传失败：HTTP ${response.status}`);
}

async function downloadText(url, message) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${message}：HTTP ${response.status}`);
  return response.text();
}

async function pollMineruAgent(taskId, fileName) {
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const response = await fetch(`https://mineru.net/api/v1/agent/parse/${taskId}`);
    const result = await readJson(response, '查询 MinerU-Agent 任务失败');
    if (!response.ok || result.code !== 0) throw new Error(`查询 MinerU-Agent 任务失败：HTTP ${response.status}`);
    if (result.data?.state === 'done') return result.data;
    if (result.data?.state === 'failed') throw new Error(`MinerU-Agent 解析失败：${result.data?.err_msg || '未知错误'}`);
    await sleep(3000);
  }
  throw new Error(`MinerU-Agent 轮询超时，请稍后重试：${fileName}`);
}

async function parseWithMineruAgent(filePath) {
  const fileName = path.basename(filePath);
  const response = await fetch('https://mineru.net/api/v1/agent/parse/file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_name: fileName, language: 'ch', enable_table: true, is_ocr: true, enable_formula: true }),
  });
  const result = await readJson(response, '申请 MinerU-Agent 上传链接失败');
  if (!response.ok || result.code !== 0 || !result.data?.task_id || !result.data?.file_url) {
    throw new Error(`申请 MinerU-Agent 上传链接失败：HTTP ${response.status}`);
  }
  await putFile(result.data.file_url, filePath);
  const completed = await pollMineruAgent(result.data.task_id, fileName);
  if (!completed.markdown_url) throw new Error('MinerU-Agent 解析完成但未返回 Markdown');
  return downloadText(completed.markdown_url, '下载 MinerU-Agent Markdown 失败');
}

async function pollMineruAccurate(token, batchId, fileName) {
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    const response = await fetch(`https://mineru.net/api/v4/extract-results/batch/${batchId}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: '*/*' },
    });
    const result = await readJson(response, '查询 MinerU 精准解析任务失败');
    if (!response.ok || result.code !== 0) throw new Error(`查询 MinerU 精准解析任务失败：HTTP ${response.status}`);
    const item = result.data?.extract_result?.find((candidate) => candidate.file_name === fileName) || result.data?.extract_result?.[0];
    if (item?.state === 'done') return item;
    if (item?.state === 'failed') throw new Error(`MinerU 精准解析失败：${item.err_msg || '未知错误'}`);
    await sleep(5000);
  }
  throw new Error(`MinerU 精准解析轮询超时，请稍后重试：${fileName}`);
}

async function parseWithMineruAccurate(filePath, token) {
  if (!token) throw new Error('请先在设置中填写 MinerU Token');
  const fileName = path.basename(filePath);
  const response = await fetch('https://mineru.net/api/v4/file-urls/batch', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [{ name: fileName, data_id: `${Date.now()}-${fileName}`, is_ocr: true }],
      model_version: 'vlm', language: 'ch', enable_table: true, enable_formula: true,
    }),
  });
  const result = await readJson(response, '申请 MinerU 精准解析上传链接失败');
  const fileUrl = result.data?.file_urls?.[0];
  if (!response.ok || result.code !== 0 || !result.data?.batch_id || !fileUrl) {
    throw new Error(`申请 MinerU 精准解析上传链接失败：HTTP ${response.status}`);
  }
  await putFile(fileUrl, filePath);
  const completed = await pollMineruAccurate(token, result.data.batch_id, fileName);
  if (!completed.full_zip_url) throw new Error('MinerU 精准解析完成但未返回结果文件');
  const archive = await fetch(completed.full_zip_url);
  if (!archive.ok) throw new Error(`下载 MinerU 精准解析结果失败：HTTP ${archive.status}`);
  const zip = new AdmZip(Buffer.from(await archive.arrayBuffer()));
  const target = zip.getEntries().find((entry) => /(^|[/\\])full\.md$/i.test(entry.entryName))
    || zip.getEntries().find((entry) => entry.entryName.toLowerCase().endsWith('.md'));
  if (!target) throw new Error('MinerU 精准解析结果中未找到 Markdown 文件');
  return target.getData().toString('utf8');
}

async function parseDocumentWithConfig(filePath, config, { timeoutMs = 10 * 60 * 1000 } = {}) {
  const parser = resolveFileParser(config, filePath);
  const task = parser.provider === 'mineru-agent-api'
    ? parseWithMineruAgent(filePath)
    : parser.provider === 'mineru-accurate-api'
      ? parseWithMineruAccurate(filePath, config?.components?.file_parser?.mineru_token || '')
      : parseLocalDocument(filePath);
  const markdown = await withTimeout(task, timeoutMs);
  return {
    markdown: stripMarkdownImages(markdown).trim(),
    parserLabel: parserLabels[parser.provider] || parserLabels.local,
    fallbackToLocal: parser.fallbackToLocal,
  };
}

module.exports = {
  localSupportedExtensions,
  parseDocumentWithConfig,
  resolveFileParser,
};
