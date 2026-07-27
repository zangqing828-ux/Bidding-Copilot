const crypto = require('node:crypto');

const MAX_OUTLINE_DEPTH = 3;
const MAX_OUTLINE_NODES = 1000;
const MAX_OUTLINE_ID_LENGTH = 256;
const MAX_OUTLINE_TITLE_LENGTH = 2048;
const MAX_OUTLINE_DESCRIPTION_LENGTH = 4096;

const OUTLINE_ERROR_CODE = 'TASK_INVALID_INPUT';

function createError(message) {
  const error = new Error(message);
  error.code = OUTLINE_ERROR_CODE;
  return error;
}

function normalizeMode(mode) {
  if (mode === 'existing' || mode === 'existing-plan') return 'existing';
  return 'standard';
}

function normalizeText(value, fieldName, maxLength) {
  if (value === undefined || value === null) {
    value = '';
  }
  if (typeof value !== 'string') {
    throw createError(`${fieldName} 必须为字符串`);
  }
  const text = value.trim();
  if (!text.length) {
    throw createError(`${fieldName} 不能为空`);
  }
  if (text.length > maxLength) {
    throw createError(`${fieldName} 长度不能超过 ${maxLength}`);
  }
  return text;
}

function normalizeNode(rawNode, path) {
  const raw = rawNode && typeof rawNode === 'object' && !Array.isArray(rawNode) ? rawNode : null;
  if (!raw) {
    throw createError(`${path} 必须是对象`);
  }

  const title = normalizeText(raw.title, `${path}.title`, MAX_OUTLINE_TITLE_LENGTH);
  const description = normalizeText(raw.description, `${path}.description`, MAX_OUTLINE_DESCRIPTION_LENGTH);

  const childNodes = Array.isArray(raw.children) ? raw.children : [];
  return {
    ...(raw.id === undefined ? {} : { id: normalizeText(String(raw.id), `${path}.id`, MAX_OUTLINE_ID_LENGTH) }),
    title,
    description,
    ...(raw.source_requirement_id === undefined ? {} : {
      source_requirement_id: normalizeText(String(raw.source_requirement_id), `${path}.source_requirement_id`, MAX_OUTLINE_DESCRIPTION_LENGTH),
    }),
    ...(raw.source_requirement_title === undefined ? {} : {
      source_requirement_title: normalizeText(String(raw.source_requirement_title), `${path}.source_requirement_title`, MAX_OUTLINE_DESCRIPTION_LENGTH),
    }),
    ...(childNodes.length
      ? { children: childNodes.map((child, index) => normalizeNode(child, `${path}.children[${index}]`)) }
      : {}),
  };
}

function validateIdShape(id, path) {
  if (!id) {
    return;
  }
  if (id.length > MAX_OUTLINE_ID_LENGTH) {
    throw createError(`${path}.id 长度不能超过 ${MAX_OUTLINE_ID_LENGTH}`);
  }
  if (!/^\d+(?:\.\d+){0,2}$/.test(id)) {
    throw createError(`${path}.id 格式非法：${id}`);
  }
}

function collectNodeIds(nodes, context, pathPrefix = 'outline') {
  const { ids, siblingTitleKeys } = context;
  (nodes || []).forEach((node, index) => {
    const path = `${pathPrefix}[${index}]`;
    if (!node || typeof node !== 'object') {
      throw createError(`${path} 必须是对象`);
    }
    const titleKey = node.title.toLowerCase().replace(/\s+/g, '');
    if (!titleKey) {
      throw createError(`${path}.title 不能为空`);
    }
    if (siblingTitleKeys.has(titleKey)) {
      throw createError(`${path}.title 与同级目录重复：${node.title}`);
    }
    siblingTitleKeys.add(titleKey);

    validateIdShape(node.id, path);
    if (node.id) {
      if (ids.has(node.id)) {
        throw createError(`outline id 重复：${node.id}`);
      }
      ids.add(node.id);
    }

    if (node.children && node.children.length) {
      collectNodeIds(node.children, { ids, siblingTitleKeys: new Set() }, `${path}.children`);
    }
  });
}

function validateDepth(nodes, depth = 1, path = 'outline') {
  if (!nodes.length) {
    return;
  }
  if (depth > MAX_OUTLINE_DEPTH) {
    throw createError(`目录层级超过最大值 ${MAX_OUTLINE_DEPTH}：${path}`);
  }

  for (const node of nodes) {
    if (!node.children || !node.children.length) {
      continue;
    }
    validateDepth(node.children, depth + 1, `${path}.children`);
  }
}

function countOutlineNodes(nodes) {
  const stack = [...(Array.isArray(nodes) ? nodes : [])];
  let count = 0;
  while (stack.length) {
    const node = stack.pop();
    count += 1;
    if (count > MAX_OUTLINE_NODES) return count;
    if (Array.isArray(node?.children) && node.children.length) {
      stack.push(...node.children);
    }
  }
  return count;
}

function assertOutlineNodeLimit(nodes) {
  const nodeCount = countOutlineNodes(nodes);
  if (nodeCount > MAX_OUTLINE_NODES) {
    throw createError(`目录节点数量不能超过 ${MAX_OUTLINE_NODES}`);
  }
  return nodeCount;
}

function normalizeOutlineTree(rawOutline, options = {}) {
  const mode = normalizeMode(options.mode);
  const rawNodes = Array.isArray(rawOutline) ? rawOutline : [];
  assertOutlineNodeLimit(rawNodes);
  const nodes = rawNodes.map((node, index) => normalizeNode(node, `outline[${index}]`));
  if (!nodes.length) {
    throw createError('目录不能为空');
  }

  const ids = new Set();
  collectNodeIds(nodes, { ids, siblingTitleKeys: new Set() }, 'outline');

  validateDepth(nodes, 1, 'outline');

  if (mode === 'standard') {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (!node.source_requirement_id) {
        throw createError(`标准方案第 ${index + 1} 个一级目录缺少 source_requirement_id`);
      }
      if (!node.source_requirement_title) {
        throw createError(`标准方案第 ${index + 1} 个一级目录缺少 source_requirement_title`);
      }
    }
  }

  return nodes;
}

function validateOutlineTree(rawOutline, options = {}) {
  return normalizeOutlineTree(rawOutline, options);
}

function renumberOutlineTree(nodes, parentId = '') {
  return nodes.map((node, index) => {
    const id = parentId ? `${parentId}.${index + 1}` : `${index + 1}`;
    const next = {
      ...node,
      id,
      ...(node.children && node.children.length ? { children: renumberOutlineTree(node.children, id) } : {}),
    };
    return next;
  });
}

function countOutlineLeafNodes(nodes) {
  return (nodes || []).reduce((sum, node) => (
    node.children && node.children.length
      ? sum + countOutlineLeafNodes(node.children)
      : sum + 1
  ), 0);
}

function stripSemanticFields(node) {
  const sanitized = {
    id: String(node.id).trim(),
    title: String(node.title).trim(),
    description: String(node.description).trim(),
  };
  if (node.source_requirement_id !== undefined) {
    sanitized.source_requirement_id = String(node.source_requirement_id).trim();
  }
  if (node.source_requirement_title !== undefined) {
    sanitized.source_requirement_title = String(node.source_requirement_title).trim();
  }
  if (node.children && node.children.length) {
    sanitized.children = node.children.map(stripSemanticFields);
  }
  return sanitized;
}

function buildOutlineSemanticHash(nodes, options = {}) {
  const normalized = normalizeOutlineTree(nodes, options);
  const renumbered = renumberOutlineTree(normalized);
  const payload = JSON.stringify({ outline: renumbered.map(stripSemanticFields) }, null, 0);
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function buildOutlineStructure(nodes, options = {}) {
  const normalized = normalizeOutlineTree(nodes, options);
  const renumbered = renumberOutlineTree(normalized);
  return {
    outline: renumbered,
    leafCount: countOutlineLeafNodes(renumbered),
    semanticHash: buildOutlineSemanticHash(renumbered, options),
    mode: normalizeMode(options.mode),
  };
}

module.exports = {
  normalizeOutlineTree,
  validateOutlineTree,
  assertOutlineNodeLimit,
  countOutlineNodes,
  renumberOutlineTree,
  countOutlineLeafNodes,
  buildOutlineSemanticHash,
  buildOutlineStructure,
};
