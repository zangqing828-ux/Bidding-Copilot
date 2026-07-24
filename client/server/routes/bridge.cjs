// POST /api/bridge：统一业务 API 入口。
// Sprint 04-07：config/tasks/technicalPlan/knowledgeBase/duplicateCheck/rejectionCheck/templates 已实现。
// ai/agent/export 的 Electron 依赖方法返回 501，待 Linux Runtime/渲染/导出适配后实现。
const express = require('express');
const { getWorkspaceContext } = require('../workspace/workspaceRegistry.cjs');
const { methods: bridgeMethods = {} } = require('../../shared/bridgeContract.cjs');

const router = express.Router();
const FORBIDDEN_IDENTIFIERS = new Set(['__proto__', 'constructor', 'prototype', 'toString']);
const ALLOWED_STATUSES = new Set(['implemented', 'pending', 'removed']);

function hasOwnProperty(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function getContractEntry(namespace, method) {
  if (!hasOwnProperty(bridgeMethods, namespace)) {
    return null;
  }
  const ns = bridgeMethods[namespace];
  if (!ns || typeof ns !== 'object') {
    return null;
  }
  const entry = ns[method];
  if (!entry || typeof entry !== 'object' || !hasOwnProperty(ns, method)) {
    return null;
  }
  if (!ALLOWED_STATUSES.has(entry.status)) {
    return null;
  }
  return entry;
}

function createErrorPayload(code, message) {
  return {
    code,
    message,
  };
}

// 通用 dispatcher 构建器：映射接口方法名到 Store 实际方法名。
function buildStoreDispatcher(storeName, methodMap) {
  const dispatcher = {};
  for (const [ifaceMethod, storeMethod] of Object.entries(methodMap)) {
    dispatcher[ifaceMethod] = (ctx, args) => {
      const store = ctx.stores[storeName];
      if (!store || typeof store[storeMethod] !== 'function') {
        throw new Error(`${storeName}.${storeMethod} 不可用`);
      }
      return store[storeMethod](...args);
    };
  }
  return dispatcher;
}

const dispatchers = {
  config: {
    load: (ctx) => ctx.configStore.load(),
    save: (ctx, args) => ctx.configStore.save(args[0]),
    listModels: () => { throw new Error('config.listModels 尚未在 Web 端实现'); },
    openConfigFolder: () => { throw new Error('config.openConfigFolder 尚未在 Web 端实现'); },
  },

  technicalPlan: buildStoreDispatcher('technicalPlanStore', {
    loadState: 'loadTechnicalPlan',
    readTenderMarkdown: 'readTenderMarkdown',
    readTenderSourceMarkdown: 'readTenderSourceMarkdown',
    readOriginalPlanMarkdown: 'readOriginalPlanMarkdown',
    updateStep: 'updateStep',
    setWorkflowKind: 'setWorkflowKind',
    switchWorkflowKind: 'switchWorkflowKind',
    saveBidAnalysisConfig: 'saveBidAnalysisConfig',
    saveOutlineConfig: 'saveOutlineConfig',
    saveOutline: 'saveOutline',
    saveGlobalFacts: 'saveGlobalFacts',
    saveContentGenerationOptions: 'saveContentGenerationOptions',
    saveChapterContent: 'saveChapterContent',
    clear: 'clearTechnicalPlan',
    checkBidSections: 'checkBidSections',
    selectBidSection: 'selectBidSection',
  }),
  // 文件导入方法依赖上传后的 fileId，需要适配层转换
  importTenderDocument: undefined,
  importOriginalPlanDocument: undefined,

  knowledgeBase: buildStoreDispatcher('knowledgeBaseStore', {
    getMigrationStatus: 'getMigrationStatus',
    migrateLegacy: 'migrateLegacy',
    renameFolder: 'renameFolder',
    deleteFolder: 'deleteFolder',
    deleteDocument: 'deleteDocument',
    moveDocument: 'moveDocument',
    retryDocument: 'recoverInterruptedDocuments',
    readMarkdown: 'readMarkdown',
    readItems: 'readItems',
    readAnalysis: 'readAnalysis',
  }),
  // list/createFolder/uploadDocuments/startMatching 依赖 knowledgeBaseService（需要 aiService）

  duplicateCheck: buildStoreDispatcher('duplicateCheckStore', {
    loadState: 'loadDuplicateCheck',
    saveFiles: 'saveFiles',
    saveUiState: 'saveUiState',
    updateState: 'updateDuplicateCheck',
    clear: 'clearDuplicateCheck',
  }),

  rejectionCheck: buildStoreDispatcher('rejectionCheckStore', {
    loadState: 'loadRejectionCheck',
    removeDocument: 'removeDocument',
    saveUiState: 'saveUiState',
    updateState: 'updateRejectionCheck',
    clear: 'clearRejectionCheck',
    importTenderFromTechnicalPlan: 'importTenderFromTechnicalPlan',
  }),

  templates: buildStoreDispatcher('templateStore', {
    list: 'listTemplates',
    get: 'getTemplate',
    create: 'createTemplate',
    update: 'updateTemplate',
    delete: 'deleteTemplate',
  }),

  tasks: {
    getActiveTasks: (ctx) => ctx.taskService.getActiveTasks(),
    startBidSectionExtraction: () => { throw new Error('Web 端任务启动尚未实现（需要真实 AI 服务）'); },
    startBidAnalysis: () => { throw new Error('Web 端任务启动尚未实现（需要真实 AI 服务）'); },
    startOutlineGeneration: () => { throw new Error('Web 端任务启动尚未实现（需要真实 AI 服务）'); },
    startGlobalFactsGeneration: () => { throw new Error('Web 端任务启动尚未实现（需要真实 AI 服务）'); },
    startContentGeneration: () => { throw new Error('Web 端任务启动尚未实现（需要真实 AI 服务）'); },
    pauseContentGeneration: () => { throw new Error('Web 端任务暂停尚未实现'); },
    startRejectionItemsExtraction: () => { throw new Error('Web 端任务启动尚未实现（需要真实 AI 服务）'); },
    startRejectionCheck: () => { throw new Error('Web 端任务启动尚未实现（需要真实 AI 服务）'); },
    startDuplicateAnalysis: () => { throw new Error('Web 端任务启动尚未实现（需要真实 AI 服务）'); },
  },

  file: {
    selectDuplicateCheckFiles: () => { throw new Error('Web 端文件选择尚未实现（需要上传适配）'); },
  },

  // ai/agent/export 的 Electron 依赖方法返回 501（未注册，走 fallback）
};

// 文件导入方法单独注册（抛错说明需要适配）
dispatchers.technicalPlan.importTenderDocument = () => { throw new Error('Web 端文件导入尚未实现（需要上传+解析适配）'); };
dispatchers.technicalPlan.importOriginalPlanDocument = () => { throw new Error('Web 端文件导入尚未实现（需要上传+解析适配）'); };
dispatchers.knowledgeBase.uploadDocuments = () => { throw new Error('Web 端文件上传尚未实现（需要 multipart 上传适配）'); };
dispatchers.knowledgeBase.startMatching = () => { throw new Error('Web 端知识库匹配尚未实现（需要真实 AI 服务）'); };
dispatchers.rejectionCheck.importDocument = () => { throw new Error('Web 端文件导入尚未实现（需要上传+解析适配）'); };

router.post('/bridge', (req, res) => {
  const body = req.body || {};
  if (!hasOwnProperty(body, 'namespace') || !hasOwnProperty(body, 'method')) {
    return res.status(400).json(createErrorPayload('INVALID_BRIDGE_REQUEST', '请求缺少 namespace 或 method'));
  }

  if (typeof body.namespace !== 'string' || typeof body.method !== 'string') {
    return res.status(400).json(createErrorPayload('INVALID_BRIDGE_REQUEST', '请求参数无效'));
  }

  const namespace = body.namespace;
  const method = body.method;
  const args = hasOwnProperty(body, 'args') ? body.args : [];

  if (FORBIDDEN_IDENTIFIERS.has(namespace) || FORBIDDEN_IDENTIFIERS.has(method)) {
    return res.status(400).json(createErrorPayload('INVALID_BRIDGE_IDENTIFIER', '桥接调用标识不允许'));
  }

  if (!Array.isArray(args)) {
    return res.status(400).json(createErrorPayload('INVALID_BRIDGE_ARGUMENTS', 'args 必须为数组'));
  }

  const contract = getContractEntry(namespace, method);
  if (!contract) {
    return res.status(400).json(createErrorPayload('WEB_BRIDGE_UNKNOWN', '该接口未注册为 Web Bridge 能力'));
  }
  if (contract.status === 'removed') {
    return res.status(410).json(createErrorPayload('WEB_BRIDGE_REMOVED', '该能力已下线'));
  }
  if (contract.status === 'pending') {
    return res.status(501).json(createErrorPayload('WEB_CAPABILITY_PENDING', '该能力在 Web 端尚未提供'));
  }
  if (contract.status !== 'implemented') {
    return res.status(500).json(createErrorPayload('BRIDGE_CONTRACT_MISMATCH', '桥接能力配置异常'));
  }

  const workspaceId = req.workspaceId;

  let ctx;
  try {
    ctx = getWorkspaceContext(workspaceId);
  } catch (err) {
    return res.status(500).json({ code: 'WORKSPACE_ERROR', message: '工作区初始化失败' });
  }

  const nsDispatcher = dispatchers[namespace];
  if (!hasOwnProperty(dispatchers, namespace)
    || !nsDispatcher
    || !hasOwnProperty(nsDispatcher, method)
    || typeof nsDispatcher[method] !== 'function') {
    return res.status(500).json(createErrorPayload('BRIDGE_DISPATCHER_MISSING', '桥接能力未正确注册'));
  }

  try {
    const result = nsDispatcher[method](ctx, args);
    Promise.resolve(result).then((data) => {
      res.json({ code: 'OK', data });
    }).catch((err) => {
      console.error(`[bridge] ${namespace}.${method} 执行失败`, err?.message || String(err));
      res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
    });
  } catch (err) {
    console.error(`[bridge] ${namespace}.${method} 执行失败`, err?.message || String(err));
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
  }
});

module.exports = router;
