// Web 环境图片渲染端口：playwright-core 渲染器 + aiRuntime 生图 + workspace 资产持久化。
// 与 Electron adapter 行为对齐：Mermaid 生成并校验后返回代码，HTML/AI 渲染落盘后返回 asset_url。
// 提示词与 Mermaid 规范化逻辑复用 core/technical-plan/content/illustrationPromptKit。
const { runWithRemoteImageRetry } = require('../../core/remoteImageRetry.cjs');
const {
  getPlannedTitle,
  buildAiImagePrompt,
  buildHtmlImagePrompt,
  validateHtmlCode,
  generateMermaidIllustrationWith,
} = require('../../core/technical-plan/content/illustrationPromptKit.cjs');

// Web 图片端口工厂：注入渲染器，返回三类生成端口。
function createWebIllustrationPorts({ renderer }) {
  if (!renderer || typeof renderer.renderMermaidToPng !== 'function' || typeof renderer.renderHtmlToPng !== 'function') {
    throw new Error('Web 图片端口需要有效的渲染器');
  }

  // 本地渲染校验 Mermaid 是否可出图（成功产物用于校验，正文只存 Mermaid 代码）。
  async function renderCheck(code) {
    const rendered = await renderer.renderMermaidToPng(code);
    if (!rendered?.buffer?.length) {
      throw new Error('Mermaid 本地渲染失败：未生成有效图片');
    }
  }

  async function generateMermaidIllustration(aiService, execution, isPauseLikeError) {
    return generateMermaidIllustrationWith({ aiService, execution, isPauseLikeError, renderCheck });
  }

  async function generateAiIllustration(aiService, execution, { plan, workspaceStore } = {}) {
    const title = getPlannedTitle(execution);
    const generated = await aiService.generateImage({
      title,
      logTitle: `AI生图-${execution.planItem.item_id}-${title}`,
      prompt: buildAiImagePrompt(execution),
      style: execution.planItem.image_type,
    });
    if (!generated?.buffer?.length) throw new Error('生图模型未返回有效图片数据');
    if (!workspaceStore?.saveIllustrationPng) throw new Error('图片资产持久化服务尚未初始化');
    const saved = workspaceStore.saveIllustrationPng({
      revision: plan.revision,
      itemId: execution.planItem.item_id,
      buffer: generated.buffer,
    });
    return { asset_url: saved.assetUrl, attempts: 1 };
  }

  async function requestHtmlScreenshot(html, onRetry, pauseControl = {}) {
    let requestAttempts = 0;
    const result = await runWithRemoteImageRetry(async (attempt) => {
      requestAttempts = attempt;
      if (pauseControl.isPauseRequested?.()) {
        throw pauseControl.createPauseError?.() || new Error('HTML 转图已暂停');
      }
      const rendered = await renderer.renderHtmlToPng(html, {
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

  return {
    generateAiIllustration,
    generateHtmlIllustration,
    generateMermaidIllustration,
  };
}

module.exports = { createWebIllustrationPorts };
