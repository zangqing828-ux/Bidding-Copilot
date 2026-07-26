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
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_MARKDOWN_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_COMPRESSION_RATIO = 100;

function createParseError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createParseError('DOCUMENT_PARSE_ABORTED', '文件解析已取消');
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createParseError('DOCUMENT_PARSE_ABORTED', '文件解析已取消'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
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

async function withTimeout(task, timeoutMs, parentSignal) {
  throwIfAborted(parentSignal);
  const controller = new AbortController();
  const onAbort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener?.('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(createParseError('DOCUMENT_PARSE_TIMEOUT', '文件解析超时，请稍后重试')), timeoutMs);
  timer.unref?.();
  try {
    return await task(controller.signal);
  } catch (error) {
    if (parentSignal?.aborted) throw createParseError('DOCUMENT_PARSE_ABORTED', '文件解析已取消');
    if (controller.signal.aborted) throw createParseError('DOCUMENT_PARSE_TIMEOUT', '文件解析超时，请稍后重试');
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener?.('abort', onAbort);
  }
}

async function parseLocalDocument(filePath, signal) {
  throwIfAborted(signal);
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.txt' || ext === '.md' || ext === '.markdown') {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_MARKDOWN_BYTES) {
      throw createParseError('DOCUMENT_RESPONSE_TOO_LARGE', '文件解析结果过大');
    }
    const content = await fs.readFile(filePath, 'utf-8');
    throwIfAborted(signal);
    return content;
  }
  const { convertPathToMarkdown } = await import('./document/convert.mjs');
  const content = await convertPathToMarkdown(filePath, { includeImages: false });
  throwIfAborted(signal);
  return content;
}

async function readResponseBuffer(response, maxBytes, signal, message) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel?.().catch(() => undefined);
    throw createParseError('DOCUMENT_RESPONSE_TOO_LARGE', `${message}：响应内容过大`);
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw createParseError('DOCUMENT_RESPONSE_TOO_LARGE', `${message}：响应内容过大`);
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, total);
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw createParseError('DOCUMENT_RESPONSE_TOO_LARGE', `${message}：响应内容过大`);
  return buffer;
}

async function readJson(response, message, signal) {
  try {
    const buffer = await readResponseBuffer(response, MAX_JSON_BYTES, signal, message);
    return JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    if (error?.code) throw error;
    throw new Error(`${message}：响应格式无效`);
  }
}

async function putFile(fileUrl, filePath, signal) {
  const body = await fs.readFile(filePath);
  const response = await fetch(fileUrl, { method: 'PUT', body, signal });
  if (!response.ok) throw new Error(`文件上传失败：HTTP ${response.status}`);
  await response.body?.cancel?.().catch(() => undefined);
}

async function downloadText(url, message, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${message}：HTTP ${response.status}`);
  return (await readResponseBuffer(response, MAX_MARKDOWN_BYTES, signal, message)).toString('utf8');
}

async function pollMineruAgent(taskId, fileName, signal) {
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const response = await fetch(`https://mineru.net/api/v1/agent/parse/${taskId}`, { signal });
    const result = await readJson(response, '查询 MinerU-Agent 任务失败', signal);
    if (!response.ok || result.code !== 0) throw new Error(`查询 MinerU-Agent 任务失败：HTTP ${response.status}`);
    if (result.data?.state === 'done') return result.data;
    if (result.data?.state === 'failed') throw new Error(`MinerU-Agent 解析失败：${result.data?.err_msg || '未知错误'}`);
    await sleep(3000, signal);
  }
  throw new Error(`MinerU-Agent 轮询超时，请稍后重试：${fileName}`);
}

async function parseWithMineruAgent(filePath, signal) {
  const fileName = path.basename(filePath);
  const response = await fetch('https://mineru.net/api/v1/agent/parse/file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_name: fileName, language: 'ch', enable_table: true, is_ocr: true, enable_formula: true }),
    signal,
  });
  const result = await readJson(response, '申请 MinerU-Agent 上传链接失败', signal);
  if (!response.ok || result.code !== 0 || !result.data?.task_id || !result.data?.file_url) {
    throw new Error(`申请 MinerU-Agent 上传链接失败：HTTP ${response.status}`);
  }
  await putFile(result.data.file_url, filePath, signal);
  const completed = await pollMineruAgent(result.data.task_id, fileName, signal);
  if (!completed.markdown_url) throw new Error('MinerU-Agent 解析完成但未返回 Markdown');
  return downloadText(completed.markdown_url, '下载 MinerU-Agent Markdown 失败', signal);
}

async function pollMineruAccurate(token, batchId, fileName, signal) {
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    const response = await fetch(`https://mineru.net/api/v4/extract-results/batch/${batchId}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: '*/*' },
      signal,
    });
    const result = await readJson(response, '查询 MinerU 精准解析任务失败', signal);
    if (!response.ok || result.code !== 0) throw new Error(`查询 MinerU 精准解析任务失败：HTTP ${response.status}`);
    const item = result.data?.extract_result?.find((candidate) => candidate.file_name === fileName) || result.data?.extract_result?.[0];
    if (item?.state === 'done') return item;
    if (item?.state === 'failed') throw new Error(`MinerU 精准解析失败：${item.err_msg || '未知错误'}`);
    await sleep(5000, signal);
  }
  throw new Error(`MinerU 精准解析轮询超时，请稍后重试：${fileName}`);
}

async function parseWithMineruAccurate(filePath, token, signal) {
  if (!token) throw new Error('请先在设置中填写 MinerU Token');
  const fileName = path.basename(filePath);
  const response = await fetch('https://mineru.net/api/v4/file-urls/batch', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [{ name: fileName, data_id: `${Date.now()}-${fileName}`, is_ocr: true }],
      model_version: 'vlm', language: 'ch', enable_table: true, enable_formula: true,
    }),
    signal,
  });
  const result = await readJson(response, '申请 MinerU 精准解析上传链接失败', signal);
  const fileUrl = result.data?.file_urls?.[0];
  if (!response.ok || result.code !== 0 || !result.data?.batch_id || !fileUrl) {
    throw new Error(`申请 MinerU 精准解析上传链接失败：HTTP ${response.status}`);
  }
  await putFile(fileUrl, filePath, signal);
  const completed = await pollMineruAccurate(token, result.data.batch_id, fileName, signal);
  if (!completed.full_zip_url) throw new Error('MinerU 精准解析完成但未返回结果文件');
  const archive = await fetch(completed.full_zip_url, { signal });
  if (!archive.ok) throw new Error(`下载 MinerU 精准解析结果失败：HTTP ${archive.status}`);
  const archiveBuffer = await readResponseBuffer(archive, MAX_ARCHIVE_BYTES, signal, '下载 MinerU 精准解析结果失败');
  const zip = new AdmZip(archiveBuffer);
  const entries = zip.getEntries();
  let expandedBytes = 0;
  for (const entry of entries) {
    const size = Number(entry.header?.size || 0);
    const compressedSize = Number(entry.header?.compressedSize || 0);
    expandedBytes += size;
    if (size > MAX_ARCHIVE_ENTRY_BYTES || expandedBytes > MAX_ARCHIVE_EXPANDED_BYTES) {
      throw createParseError('DOCUMENT_ARCHIVE_TOO_LARGE', 'MinerU 结果压缩包展开内容过大');
    }
    if (compressedSize > 0 && size / compressedSize > MAX_ARCHIVE_COMPRESSION_RATIO) {
      throw createParseError('DOCUMENT_ARCHIVE_UNSAFE', 'MinerU 结果压缩比异常');
    }
  }
  const target = entries.find((entry) => /(^|[/\\])full\.md$/i.test(entry.entryName))
    || entries.find((entry) => entry.entryName.toLowerCase().endsWith('.md'));
  if (!target) throw new Error('MinerU 精准解析结果中未找到 Markdown 文件');
  return target.getData().toString('utf8');
}

async function parseDocumentWithConfig(filePath, config, { timeoutMs = 10 * 60 * 1000, signal } = {}) {
  const parser = resolveFileParser(config, filePath);
  const markdown = await withTimeout((taskSignal) => (
    parser.provider === 'mineru-agent-api'
      ? parseWithMineruAgent(filePath, taskSignal)
      : parser.provider === 'mineru-accurate-api'
        ? parseWithMineruAccurate(filePath, config?.components?.file_parser?.mineru_token || '', taskSignal)
        : parseLocalDocument(filePath, taskSignal)
  ), timeoutMs, signal);
  if (Buffer.byteLength(String(markdown || ''), 'utf8') > MAX_MARKDOWN_BYTES) {
    throw createParseError('DOCUMENT_RESPONSE_TOO_LARGE', '文件解析结果过大');
  }
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
