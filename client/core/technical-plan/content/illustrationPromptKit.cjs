// 图片配图共享纯函数：提示词构建、Mermaid 规范化与校验。
// Electron 与 Web 两个 illustration 适配器共用，渲染器与生图差异留在各自 adapter。
const {
  assertSupportedMermaidDiagramType,
  assertSupportedMermaidSyntax,
  getMermaidDiagramTypeLabel,
} = require('../../mermaidPolicy.cjs');

const MERMAID_REPAIR_ATTEMPTS = 3;
const HTML_DESIGN_WIDTH = 1240;

function singleLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function compactError(value, maxLength = 220) {
  const text = singleLine(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function normalizeMermaidCode(value) {
  return String(value || '').replace(/^```mermaid\s*/i, '').replace(/```$/i, '').trim();
}

function normalizeHtmlCode(value) {
  const text = String(value || '').trim();
  const fenced = /```(?:html)?\s*([\s\S]*?)```/i.exec(text);
  const source = fenced ? fenced[1].trim() : text;
  const start = source.search(/<!doctype\s+html|<html\b/i);
  const document = start >= 0 ? source.slice(start) : source;
  const end = document.toLowerCase().lastIndexOf('</html>');
  return (end >= 0 ? document.slice(0, end + '</html>'.length) : document).trim();
}

function validateHtmlCode(value) {
  const html = normalizeHtmlCode(value);
  if (!/<html\b/i.test(html) || !/<\/html>/i.test(html)) {
    throw new Error('HTML 图片结果必须是完整 HTML 文档');
  }
  return html;
}

function getPlannedTitle(execution) {
  const title = singleLine(execution.planItem.title);
  if (!title) throw new Error(`图片计划缺少 title：${execution.planItem.item_id || 'unknown'}`);
  return title;
}

function buildAiImagePrompt(execution) {
  const styleLabel = execution.planItem.image_type === 'realistic_photo' ? '专业实景图片' : '专业工程图示';
  const title = getPlannedTitle(execution);
  return `阅读并理解以下技术方案正文，生成一张${styleLabel}。
最终图题：${title}
必须围绕最终图题限定的对象、场景和关系重点组织画面，不要生成泛化的章节概览；图题用于限定画面主题，不要求把完整图题作为文字绘制在图片中。
图片需要准确表达正文中的设备、环境、部署关系或实施场景，不要编造正文中没有的关键对象。
不要有太多文字，专业、克制，适合投标技术方案。
参考内容如下：

${execution.reference}`;
}

function buildHtmlImagePrompt(execution) {
  const title = getPlannedTitle(execution);
  return `阅读并理解以下内容，用html绘制一张${execution.planItem.image_type}。
最终图题：${title}
必须围绕最终图题限定的对象、范围和关系重点设计图形，不要生成泛化的章节概览。
不要有太多文字描述，专业商务风格。这是一个类图片的html，所以注意仔细检查显示效果、文字换行、拥挤等问题。宽度固定${HTML_DESIGN_WIDTH}px，高度自适应。参考内容如下：

${execution.reference}`;
}

function buildMermaidGenerationMessages(execution) {
  const type = assertSupportedMermaidDiagramType(execution.planItem.image_type);
  const typeLabel = getMermaidDiagramTypeLabel(type);
  const title = getPlannedTitle(execution);
  return [
    {
      role: 'system',
      content: `你是投标技术方案 Mermaid 图生成助手。请根据最终正文生成一张${typeLabel}。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown。
2. 只能使用 flowchart TD/TB/LR/RL/BT 语法，不得使用 graph 别名或其他 Mermaid 语法族。
3. 中文节点标签必须写成 A["中文标签"]。
4. 不使用 & 多节点连接简写，不使用分号，每行只写一个 Mermaid 语句。
5. 必须围绕指定图题“${title}”限定的对象、范围和关系重点组织节点，不要生成泛化的章节概览。
6. 图表必须忠实于正文，不编造正文中没有的流程、层级、角色或职责。
7. 控制节点数量和文字长度，保证浏览器预览和 Word 导出清晰。
8. code 不包含 Markdown 代码围栏。`,
    },
    {
      role: 'user',
      content: `最终图题：${title}\n\n参考正文：\n${execution.reference}\n\n请返回：\n{\n  "code": "flowchart TD..."\n}`,
    },
  ];
}

function normalizeMermaidGenerationResult(value) {
  const source = value?.result && typeof value.result === 'object' ? value.result : value || {};
  return { code: normalizeMermaidCode(source.code || source.mermaid_code || source.mermaid?.code || '') };
}

function validateMermaidGenerationResult(result) {
  if (!result?.code) throw new Error('Mermaid 生成结果缺少 code');
  if (/```/.test(result.code)) throw new Error('Mermaid 代码不能包含 Markdown 代码围栏');
  assertSupportedMermaidSyntax(result.code);
}

function assertMermaidPreviewCompatible(code) {
  const normalized = normalizeMermaidCode(code);
  if (!normalized) throw new Error('Mermaid 代码为空');
  assertSupportedMermaidSyntax(normalized);
  if (/[;；]/.test(normalized)) throw new Error('Mermaid 代码不能使用分号');
  if (/\s&\s/.test(normalized) && /-->|---|==>/.test(normalized)) throw new Error('Mermaid 代码不能使用多节点 & 连接简写');
  if (/\[[^\]\n"']*[\u3400-\u9fff][^\]\n"']*\]/u.test(normalized)) throw new Error('Mermaid 中文节点标签必须使用双引号');
  if (/^\s*[\u3400-\u9fff][\w\u3400-\u9fff-]*\s*(?:-->|---|==>)/mu.test(normalized)) throw new Error('Mermaid 节点 ID 不能直接使用中文');
}

function buildMermaidRepairMessages(execution, mermaidPlan, errorMessage, attempt) {
  const typeLabel = getMermaidDiagramTypeLabel(execution.planItem.image_type);
  const title = getPlannedTitle(execution);
  return [
    {
      role: 'system',
      content: `你是 Mermaid 图代码修复助手。请根据渲染错误和最终正文修复现有 Mermaid 代码。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown。
2. 保持“${typeLabel}”业务类型，忠实于参考正文。
3. 必须使用 flowchart TD/TB/LR/RL/BT 语法。
4. 中文节点标签必须使用双引号，不使用 & 简写和分号。
5. code 不包含 Markdown 代码围栏。`,
    },
    {
      role: 'user',
      content: `参考正文：\n${execution.reference}\n\n最终图题：${title}\n修复轮次：${attempt}/${MERMAID_REPAIR_ATTEMPTS}\n渲染错误：${errorMessage}\n\n待修复代码：\n${mermaidPlan.code}\n\n请返回：\n{ "code": "修复后的 Mermaid 代码" }`,
    },
  ];
}

function normalizeMermaidRepairResult(value) {
  const source = value?.result && typeof value.result === 'object' ? value.result : value || {};
  return { code: normalizeMermaidCode(source.code || source.fixed_code || source.mermaid_code || '') };
}

function validateMermaidRepairResult(result) {
  if (!result?.code || /```/.test(result.code)) throw new Error('Mermaid 修复结果缺少有效 code');
  assertSupportedMermaidSyntax(result.code);
}

// 生成并按 renderCheck 校验 Mermaid，失败时最多修复 MERMAID_REPAIR_ATTEMPTS 轮。
// renderCheck(code) 由各 adapter 注入（Electron 本地渲染 / Web playwright 渲染）。
async function prepareRenderableMermaid({ aiService, execution, mermaidPlan, isPauseLikeError, renderCheck }) {
  const title = getPlannedTitle(execution);
  let currentPlan = { code: normalizeMermaidCode(mermaidPlan.code) };
  let lastError = null;
  try {
    assertSupportedMermaidDiagramType(execution.planItem.image_type);
    assertMermaidPreviewCompatible(currentPlan.code);
    await renderCheck(currentPlan.code);
    return { code: currentPlan.code, attempts: 0 };
  } catch (error) {
    lastError = error;
  }

  for (let attempt = 1; attempt <= MERMAID_REPAIR_ATTEMPTS; attempt += 1) {
    try {
      const repaired = await aiService.collectJsonResponse({
        messages: buildMermaidRepairMessages(execution, currentPlan, compactError(lastError?.message || lastError), attempt),
        temperature: 0.1,
        logTitle: `Mermaid配图修复-${execution.planItem.item_id}-${title}`,
        progressLabel: 'Mermaid 配图修复',
        failureMessage: '模型返回的 Mermaid 修复结果格式无效',
        normalizer: normalizeMermaidRepairResult,
        validator: validateMermaidRepairResult,
        max_retries: 1,
      });
      currentPlan = { ...currentPlan, code: repaired.code };
      assertMermaidPreviewCompatible(currentPlan.code);
      await renderCheck(currentPlan.code);
      return { code: currentPlan.code, attempts: attempt };
    } catch (error) {
      if (isPauseLikeError?.(error)) throw error;
      lastError = error;
    }
  }
  throw new Error(compactError(lastError?.message || lastError || 'Mermaid 渲染失败'));
}

// 生成 Mermaid 配图代码并完成渲染校验（正文只保存 Mermaid 代码，渲染产物用于校验）。
async function generateMermaidIllustrationWith({ aiService, execution, isPauseLikeError, renderCheck }) {
  const generated = await aiService.collectJsonResponse({
    messages: buildMermaidGenerationMessages(execution),
    temperature: 0.2,
    logTitle: `Mermaid配图-${execution.planItem.item_id}-${getPlannedTitle(execution)}`,
    progressLabel: 'Mermaid 配图生成',
    failureMessage: '模型返回的 Mermaid 配图格式无效',
    normalizer: normalizeMermaidGenerationResult,
    validator: validateMermaidGenerationResult,
  });
  return prepareRenderableMermaid({ aiService, execution, mermaidPlan: generated, isPauseLikeError, renderCheck });
}

module.exports = {
  HTML_DESIGN_WIDTH,
  MERMAID_REPAIR_ATTEMPTS,
  singleLine,
  compactError,
  normalizeMermaidCode,
  normalizeHtmlCode,
  validateHtmlCode,
  getPlannedTitle,
  buildAiImagePrompt,
  buildHtmlImagePrompt,
  buildMermaidGenerationMessages,
  assertMermaidPreviewCompatible,
  buildMermaidRepairMessages,
  prepareRenderableMermaid,
  generateMermaidIllustrationWith,
};
