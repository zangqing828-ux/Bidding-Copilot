const GENERATED_ILLUSTRATION_PATTERN = /<!-- yibiao-illustration:start\b[^>]*-->[\s\S]*?<!-- yibiao-illustration:end -->/gi;

function singleLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function buildIllustrationReference(planItem, contextById, sections) {
  return planItem.section_ids.map((sectionId) => {
    const context = contextById.get(sectionId);
    const item = context?.item || {};
    const content = String(sections?.[sectionId]?.content || item.content || '').trim();
    return `## ${sectionId} ${singleLine(item.title || '未命名章节')}\n\n${content}`;
  }).join('\n\n');
}

function buildIllustrationExecutionContexts(plan, leafContexts, sections) {
  const contextById = new Map((leafContexts || []).map((context) => [context.item.id, context]));
  return (plan?.items || []).map((planItem) => ({
    planItem,
    contexts: planItem.section_ids.map((id) => contextById.get(id)).filter(Boolean),
    reference: buildIllustrationReference(planItem, contextById, sections),
  }));
}

function mapOutlineContent(items, contentById) {
  return (items || []).map((item) => ({
    ...item,
    ...(contentById.has(item.id) ? { content: contentById.get(item.id) } : {}),
    ...(item.children?.length ? { children: mapOutlineContent(item.children, contentById) } : {}),
  }));
}

function stripGeneratedIllustrations(content) {
  return String(content || '').replace(GENERATED_ILLUSTRATION_PATTERN, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripGeneratedIllustrationsFromDocument(outlineData, sections) {
  const nextSections = { ...(sections || {}) };
  const contentById = new Map();
  for (const [itemId, section] of Object.entries(nextSections)) {
    const content = stripGeneratedIllustrations(section?.content || '');
    nextSections[itemId] = { ...section, content };
    contentById.set(itemId, content);
  }
  return {
    sections: nextSections,
    outlineData: outlineData ? { ...outlineData, outline: mapOutlineContent(outlineData.outline, contentById) } : outlineData,
  };
}

function buildGeneratedIllustrationMarkdown(planItem) {
  const generation = planItem.generation || {};
  const caption = singleLine(planItem.title);
  if (!caption) throw new Error(`图片计划缺少 title：${planItem.item_id || 'unknown'}`);
  let body = '';
  if (planItem.kind === 'mermaid' && generation.code) {
    body = ['```mermaid', String(generation.code).trim(), '```', '', `*图：${caption}*`].join('\n');
  } else if (generation.asset_url) {
    body = `![${caption}](${generation.asset_url})\n\n*图：${caption}*`;
  }
  if (!body) return '';
  return `<!-- yibiao-illustration:start id="${planItem.item_id}" -->\n${body}\n<!-- yibiao-illustration:end -->`;
}

function applyGeneratedIllustrationsToDocument(plan, outlineData, sections) {
  const nextSections = { ...(sections || {}) };
  const contentById = new Map();
  for (const [itemId, section] of Object.entries(nextSections)) {
    const content = stripGeneratedIllustrations(section?.content || '');
    nextSections[itemId] = { ...section, content };
    contentById.set(itemId, content);
  }

  for (const planItem of plan?.items || []) {
    if (planItem.generation?.status !== 'success') continue;
    const block = buildGeneratedIllustrationMarkdown(planItem);
    if (!block) continue;
    const targetId = planItem.kind === 'html' && planItem.placement === 'before'
      ? planItem.section_ids[0]
      : planItem.section_ids[planItem.section_ids.length - 1];
    const current = String(nextSections[targetId]?.content || '').trim();
    const content = planItem.placement === 'before' ? `${block}\n\n${current}`.trim() : `${current}\n\n${block}`.trim();
    nextSections[targetId] = { ...nextSections[targetId], content, status: 'success', error: undefined, updated_at: new Date().toISOString() };
    contentById.set(targetId, content);
  }

  return {
    sections: nextSections,
    outlineData: outlineData ? { ...outlineData, outline: mapOutlineContent(outlineData.outline, contentById) } : outlineData,
  };
}

function createUnavailableIllustrationError(kind) {
  const error = new Error(`当前 portable core 只生成 IllustrationPlan，不执行${kind}图片渲染`);
  error.code = 'ILLUSTRATION_RENDERING_UNAVAILABLE';
  return error;
}

async function generateAiIllustration() {
  throw createUnavailableIllustrationError('AI');
}

async function generateHtmlIllustration() {
  throw createUnavailableIllustrationError('HTML');
}

async function generateMermaidIllustration() {
  throw createUnavailableIllustrationError('Mermaid');
}

module.exports = {
  applyGeneratedIllustrationsToDocument,
  buildIllustrationExecutionContexts,
  generateAiIllustration,
  generateHtmlIllustration,
  generateMermaidIllustration,
  stripGeneratedIllustrationsFromDocument,
};
