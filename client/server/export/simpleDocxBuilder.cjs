// Web 端基础 Word 生成器：只依赖 Node 与 docx，避免 Web runtime 引入 Electron。
const {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} = require('docx');

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

function cleanText(value) {
  return String(value || '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/```(?:mermaid)?\s*([\s\S]*?)```/gi, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .trim();
}

function countOutlineStats(items = []) {
  return items.reduce((stats, item) => {
    if (Array.isArray(item?.children) && item.children.length > 0) {
      const childStats = countOutlineStats(item.children);
      stats.leafCount += childStats.leafCount;
      stats.mermaidCount += childStats.mermaidCount;
      return stats;
    }
    stats.leafCount += 1;
    stats.mermaidCount += (String(item?.content || '').match(/```mermaid[\s\S]*?```/gi) || []).length;
    return stats;
  }, { leafCount: 0, mermaidCount: 0 });
}

function appendOutline(items, children, level, warnings) {
  for (const item of items || []) {
    const title = cleanText(item?.title) || '未命名章节';
    children.push(new Paragraph({
      text: title,
      heading: HEADING_LEVELS[Math.min(level - 1, HEADING_LEVELS.length - 1)],
      spacing: { before: 160, after: 120 },
    }));

    const content = String(item?.content || '');
    if (/```mermaid[\s\S]*?```/i.test(content)) {
      warnings.push(`章节“${title}”中的 Mermaid 图已降级为文本，请在桌面端导出时生成图片。`);
    }
    if (/!\[[^\]]*\]\([^)]*\)/.test(content)) {
      warnings.push(`章节“${title}”中的图片已降级为文本，请在桌面端导出时插入图片。`);
    }

    for (const line of cleanText(content).split(/\n{2,}/).filter(Boolean)) {
      children.push(new Paragraph({
        children: [new TextRun({ text: line, font: '宋体', size: 24 })],
        spacing: { after: 120, line: 360 },
      }));
    }

    if (Array.isArray(item?.children) && item.children.length > 0) {
      appendOutline(item.children, children, level + 1, warnings);
    }
  }
}

async function buildSimpleDocxResult(payload = {}) {
  const warnings = [];
  const children = [
    new Paragraph({
      children: [new TextRun({ text: '内容由 AI 生成', italics: true, size: 18 })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
    }),
    new Paragraph({
      children: [new TextRun({ text: cleanText(payload.project_name) || '投标技术文件', bold: true, size: 34 })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 300 },
    }),
  ];
  appendOutline(payload.outline || [], children, 1, warnings);
  const document = new Document({
    styles: {
      default: {
        document: {
          run: { font: '宋体', size: 24 },
          paragraph: { spacing: { line: 360, after: 120 } },
        },
      },
    },
    sections: [{
      properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      children,
    }],
  });
  return { buffer: await Packer.toBuffer(document), warnings, stats: countOutlineStats(payload.outline || []) };
}

module.exports = { buildSimpleDocxResult };
