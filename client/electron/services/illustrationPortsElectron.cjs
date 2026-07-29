// Electron 环境图片渲染端口：本地渲染服务 + workspace 资产持久化。
// 提示词与 Mermaid 规范化逻辑复用 core/technical-plan/content/illustrationPromptKit。
const { runWithRemoteImageRetry } = require('../utils/remoteImageRetry.cjs');
const { getLocalImageRenderService } = require('./localImageRenderService.cjs');
const {
  getPlannedTitle,
  buildAiImagePrompt,
  buildHtmlImagePrompt,
  validateHtmlCode,
  generateMermaidIllustrationWith,
} = require('../../core/technical-plan/content/illustrationPromptKit.cjs');

// 本地渲染校验 Mermaid 是否可出图。
async function renderCheck(code) {
  const rendered = await getLocalImageRenderService().renderMermaidToPng(code);
  if (!rendered?.buffer?.length) {
    throw new Error('Mermaid 本地渲染失败：未生成有效图片');
  }
}

// 使用生图模型基于最终正文生成 AI 图片。
async function generateAiIllustration(aiService, execution) {
  const title = getPlannedTitle(execution);
  const generated = await aiService.generateImage({
    title,
    logTitle: `AI生图-${execution.planItem.item_id}-${title}`,
    prompt: buildAiImagePrompt(execution),
    style: execution.planItem.image_type,
  });
  if (!generated?.asset_url) throw new Error('生图模型未返回本地图片地址');
  return { asset_url: generated.asset_url, attempts: 1 };
}

// 生成并校验可本地渲染的 Mermaid 配图。
async function generateMermaidIllustration(aiService, execution, isPauseLikeError) {
  return generateMermaidIllustrationWith({ aiService, execution, isPauseLikeError, renderCheck });
}

// 本地将 HTML 截取为 PNG，失败按统一策略重试。
async function requestHtmlScreenshot(html, onRetry, pauseControl = {}) {
  let requestAttempts = 0;
  const result = await runWithRemoteImageRetry(async (attempt) => {
    requestAttempts = attempt;
    if (pauseControl.isPauseRequested?.()) {
      throw pauseControl.createPauseError?.() || new Error('HTML 转图已暂停');
    }
    const rendered = await getLocalImageRenderService().renderHtmlToPng(html, {
      isPauseRequested: pauseControl.isPauseRequested,
      createPauseError: pauseControl.createPauseError,
    });
    if (!rendered?.buffer?.length || rendered.buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
      throw new Error('HTML 本地转图片失败：未生成有效 PNG');
    }
    return { buffer: rendered.buffer, width: rendered.width, height: rendered.height };
  }, {
    onRetry,
    shouldStop: pauseControl.isPauseRequested,
    createStopError: pauseControl.createPauseError,
  });
  return { ...result, attempts: requestAttempts };
}

// 生成 HTML 配图（普通模型生成源码 + 本地截图）。
async function generateHtmlIllustration({ aiService, execution, plan, workspaceStore, onSourceSaved, onRenderRetry, isPauseRequested, createPauseError }) {
  const recordedPath = execution.planItem.generation?.source_path;
  let sourcePath = recordedPath;
  let html = sourcePath ? workspaceStore.readIllustrationHtml(sourcePath) : '';
  if (!html) {
    const recovered = workspaceStore.findIllustrationHtml?.({ revision: plan.revision, itemId: execution.planItem.item_id });
    if (recovered?.content) {
      sourcePath = recovered.relativePath;
      html = recovered.content;
    }
  }
  const sourceAlreadyPersisted = Boolean(html && sourcePath && sourcePath === recordedPath);
  if (!html) {
    const response = await aiService.chat({
      messages: [{ role: 'user', content: `${buildHtmlImagePrompt(execution)}\n\n仅返回html代码，不要返回任何其他内容。` }],
      temperature: 0.2,
      logTitle: `HTML配图-${execution.planItem.item_id}-${getPlannedTitle(execution)}`,
    });
    html = validateHtmlCode(response);
  }

  const savedHtml = workspaceStore.saveIllustrationHtml({ revision: plan.revision, itemId: execution.planItem.item_id, content: html });
  if (!sourceAlreadyPersisted) {
    onSourceSaved?.({ mode: 'normal', source_path: savedHtml.relativePath });
  }
  let screenshot;
  try {
    screenshot = await requestHtmlScreenshot(html, onRenderRetry, { isPauseRequested, createPauseError });
  } catch (error) {
    error.illustrationGeneration = { mode: 'normal', source_path: savedHtml.relativePath };
    throw error;
  }
  const savedPng = workspaceStore.saveIllustrationPng({ revision: plan.revision, itemId: execution.planItem.item_id, buffer: screenshot.buffer });
  return {
    mode: 'normal',
    source_path: savedHtml.relativePath,
    asset_url: savedPng.assetUrl,
    attempts: screenshot.attempts,
  };
}

// Electron 环境的图片渲染端口：本地渲染服务 + workspace 资产持久化。
function createElectronIllustrationPorts() {
  return {
    generateAiIllustration,
    generateHtmlIllustration,
    generateMermaidIllustration,
  };
}

module.exports = { createElectronIllustrationPorts };
