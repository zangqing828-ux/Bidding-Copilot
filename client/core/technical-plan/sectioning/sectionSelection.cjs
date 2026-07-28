const SECTION_ERROR_CODE = 'TASK_INVALID_INPUT';

const MAX_SECTION_COUNT = 200;
const MAX_RANGES_PER_SECTION = 200;
const MAX_SECTION_ID_LENGTH = 256;

function createError(message) {
  const error = new Error(message);
  error.code = SECTION_ERROR_CODE;
  return error;
}

function normalizeText(value, fieldName) {
  if (typeof value !== 'string') {
    if (value === undefined || value === null) {
      return '';
    }
    throw createError(`${fieldName} 必须为字符串`);
  }
  return value.trim();
}

function toStrictPositiveInteger(value, fieldName) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw createError(`${fieldName} 必须是正整数`);
  }
  return value;
}

function normalizeIdentifier(value, fieldName) {
  const normalized = normalizeText(value, fieldName);
  if (!normalized) {
    return '';
  }
  if (normalized.length > MAX_SECTION_ID_LENGTH) {
    throw createError(`${fieldName} 长度不能超过 ${MAX_SECTION_ID_LENGTH}`);
  }
  return normalized;
}

function normalizeSectionRange(range, sectionId) {
  if (!range || typeof range !== 'object') {
    throw createError(`标段 ${sectionId} 的 includeRanges 中每个区间必须是对象`);
  }

  const startLine = toStrictPositiveInteger(range.startLine ?? range.start_line, `${sectionId}.startLine`);
  const endLine = toStrictPositiveInteger(range.endLine ?? range.end_line, `${sectionId}.endLine`);
  if (startLine > endLine) {
    throw createError('startLine 不能大于 endLine');
  }

  return {
    startLine,
    endLine,
    ...(range.reason === undefined ? {} : { reason: normalizeText(range.reason, `${sectionId}.reason`) }),
  };
}

function mergeLineRanges(ranges) {
  const merged = [];
  const sorted = [...ranges].sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
  for (const current of sorted) {
    if (!merged.length) {
      merged.push({ ...current });
      continue;
    }
    const previous = merged[merged.length - 1];
    if (current.startLine <= previous.endLine) {
      previous.endLine = Math.max(previous.endLine, current.endLine);
      if (previous.reason && current.reason && current.reason !== previous.reason) {
        previous.reason = `${previous.reason}; ${current.reason}`;
      }
      continue;
    }
    merged.push({ ...current });
  }
  return merged;
}

function normalizeSection(rawSection, index) {
  const raw = rawSection && typeof rawSection === 'object' ? rawSection : null;
  if (!raw) {
    throw createError(`第 ${index + 1} 个标段结构非法`);
  }

  const sectionId = normalizeIdentifier(raw.id, `第 ${index + 1} 个标段 id`);
  if (!sectionId) {
    throw createError(`第 ${index + 1} 个标段缺少 id`);
  }

  const title = normalizeText(raw.title, `标段 ${sectionId} 的标题`);
  if (!title) {
    throw createError(`标段 ${sectionId} 缺少标题`);
  }

  const rawRanges = raw.includeRanges ?? raw.include_ranges;
  if (!Array.isArray(rawRanges) || rawRanges.length === 0) {
    throw createError(`标段 ${sectionId} 缺少 includeRanges`);
  }
  if (rawRanges.length > MAX_RANGES_PER_SECTION) {
    throw createError(`标段 ${sectionId} 的 includeRanges 数量不能超过 ${MAX_RANGES_PER_SECTION}`);
  }

  const includeRanges = mergeLineRanges(rawRanges.map((range) => normalizeSectionRange(range, sectionId)));
  if (!includeRanges.length) {
    throw createError(`标段 ${sectionId} 缺少可用 includeRanges`);
  }

  const indexValue = raw.index === undefined
    ? index + 1
    : toStrictPositiveInteger(raw.index, `标段 ${sectionId} 的 index`);

  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence.map((item) => normalizeText(item, `标段 ${sectionId} 的 evidence`)).filter(Boolean)
    : [];

  return {
    id: sectionId,
    index: indexValue,
    unit: normalizeText(raw.unit, `标段 ${sectionId} 的 unit`) || '标段',
    title,
    headLine: normalizeText(raw.headLine || raw.head_line, `标段 ${sectionId} 的 headLine`),
    description: normalizeText(raw.description, `标段 ${sectionId} 的 description`),
    includeRanges,
    evidence,
  };
}

function normalizeDetectedSections(rawSections) {
  if (!Array.isArray(rawSections) || !rawSections.length) {
    throw createError('检测到的标段列表不能为空');
  }
  if (rawSections.length > MAX_SECTION_COUNT) {
    throw createError(`标段数量不能超过 ${MAX_SECTION_COUNT}`);
  }

  const sections = rawSections.map((section, index) => normalizeSection(section, index));
  const sectionIds = new Set();
  for (const section of sections) {
    if (sectionIds.has(section.id)) {
      throw createError(`标段 id 重复：${section.id}`);
    }
    sectionIds.add(section.id);
  }

  return sections;
}

function validateRangesBounds(sections, totalLines) {
  if (!Number.isSafeInteger(totalLines) || totalLines <= 0) {
    throw createError('招标正文行数非法');
  }

  const lineBySection = sections.flatMap((section) => section.includeRanges
    .map((range) => ({ ...range, sectionId: section.id })));

  for (const range of lineBySection) {
    if (range.startLine > totalLines || range.endLine > totalLines) {
      throw createError(`标段 ${range.sectionId} 的范围超出招标正文行数边界（endLine=${range.endLine}, totalLines=${totalLines}）`);
    }
  }

  const sorted = [...lineBySection].sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (current.startLine <= previous.endLine && current.sectionId !== previous.sectionId) {
      throw createError(`标段范围重叠：${previous.sectionId} 与 ${current.sectionId}`);
    }
  }
}

function buildLineSet(ranges) {
  const lines = new Set();
  for (const range of ranges) {
    for (let line = range.startLine; line <= range.endLine; line += 1) {
      lines.add(line);
    }
  }
  return lines;
}

function selectSectionLines(linesSource, selectedLines, otherLines) {
  const output = [];
  const selectedLineNumbers = [];
  for (let index = 0; index < linesSource.length; index += 1) {
    const lineNumber = index + 1;
    const shouldKeep = !otherLines.has(lineNumber) || selectedLines.has(lineNumber);
    if (!shouldKeep) {
      continue;
    }
    output.push(linesSource[index]);
    if (selectedLines.has(lineNumber)) {
      selectedLineNumbers.push(lineNumber);
    }
  }
  return {
    markdown: output.join('\n'),
    selectedLineNumbers,
  };
}

function createSectionLineMap(sections, sourceLines) {
  const totalLines = sourceLines.length;
  const sectionLines = sections.map((section) => buildLineSet(section.includeRanges));
  const selectedMarkdownBySection = {};
  const sectionMetadata = [];
  for (let index = 0; index < sections.length; index += 1) {
    const selectedSection = sections[index];
    const selectedLines = sectionLines[index];
    const otherLines = new Set();
    for (let inner = 0; inner < sectionLines.length; inner += 1) {
      if (inner === index) {
        continue;
      }
      for (const line of sectionLines[inner]) {
        otherLines.add(line);
      }
    }

    const { markdown, selectedLineNumbers } = selectSectionLines(sourceLines, selectedLines, otherLines);
    if (!markdown && selectedLineNumbers.length === 0) {
      throw createError(`标段 ${selectedSection.id} 生成正文为空`);
    }

    const invalidLines = [...selectedLineNumbers].filter((lineNumber) => lineNumber < 1 || lineNumber > totalLines);
    if (invalidLines.length) {
      throw createError(`标段 ${selectedSection.id} 选定行号超出边界`);
    }

    selectedMarkdownBySection[selectedSection.id] = markdown;
    sectionMetadata.push({
      sectionId: selectedSection.id,
      selectedLines: selectedLineNumbers,
      sourceLines: totalLines,
    });
  }

  return { selectedMarkdownBySection, sectionMetadata };
}

function applySectionSelection(markdown, sections, selectedSectionId) {
  if (typeof markdown !== 'string') {
    throw createError('源标书内容必须是字符串');
  }
  if (!markdown.trim()) {
    throw createError('源标书内容不能为空');
  }

  const sourceLines = markdown.split(/\r?\n/);
  const normalizedSections = normalizeDetectedSections(sections);
  if (!selectedSectionId) {
    throw createError('缺少所选标段 id');
  }
  if (typeof selectedSectionId !== 'string') {
    throw createError('所选标段 id 必须为字符串');
  }
  const normalizedSelectedSectionId = selectedSectionId.trim();
  if (!normalizedSelectedSectionId) {
    throw createError('所选标段 id 不能为空');
  }

  validateRangesBounds(normalizedSections, sourceLines.length);
  const selectedSection = normalizedSections.find((section) => section.id === normalizedSelectedSectionId);
  if (!selectedSection) {
    throw createError('未找到所选标段');
  }

  const selectedLines = buildLineSet(selectedSection.includeRanges);
  const otherLines = new Set();
  for (const section of normalizedSections) {
    if (section.id === selectedSection.id) {
      continue;
    }
    for (const line of buildLineSet(section.includeRanges)) {
      otherLines.add(line);
    }
  }

  const { markdown: selectedMarkdown, selectedLineNumbers } = selectSectionLines(sourceLines, selectedLines, otherLines);
  if (!selectedMarkdown) {
    throw createError('生成投标范围工作副本失败，请重新识别');
  }

  const { selectedMarkdownBySection, sectionMetadata } = createSectionLineMap(normalizedSections, sourceLines);

  return {
    sections: normalizedSections,
    selectedSection,
    selectedSectionId: selectedSection.id,
    selectedMarkdown,
    selectedMarkdownBySection,
    selectedLineNumbers,
    metadata: {
      sourceLineCount: sourceLines.length,
      selectedLineCount: selectedLineNumbers.length,
      sectionMetadata,
      totalSectionCount: normalizedSections.length,
    },
  };
}

module.exports = {
  normalizeDetectedSections,
  applySectionSelection,
};
