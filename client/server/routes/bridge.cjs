// POST /api/bridge：统一业务 API 入口。
// 仅 manifest 标记 implemented 且有可执行 dispatcher 的能力才执行后端实现。
// pending / removed 能力统一返回明确错误码，不执行真实业务。
const express = require('express');
const { getWorkspaceContext } = require('../workspace/workspaceRegistry.cjs');
const { methods: bridgeMethods = {} } = require('../../shared/bridgeContract.cjs');

const router = express.Router();
const FORBIDDEN_IDENTIFIERS = new Set([
  '__proto__',
  'prototype',
  ...Object.getOwnPropertyNames(Object.prototype),
]);
const ALLOWED_STATUSES = new Set(['implemented', 'pending', 'removed']);

function hasOwnProperty(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function getContractEntry(namespace, method) {
  if (!hasOwnProperty(bridgeMethods, namespace)) {
    return null;
  }

  const ns = bridgeMethods[namespace];
  if (!ns || typeof ns !== 'object' || Array.isArray(ns)) {
    return null;
  }

  if (!hasOwnProperty(ns, method)) {
    return null;
  }

  const entry = ns[method];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
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

function isDesktopOnlySource(source) {
  return source === 'desktop-only';
}

function isDeletedProductSource(source) {
  return source === 'deleted-product';
}

function createDirectBinding(handler, contractRef) {
  return Object.freeze({
    type: 'direct',
    transport: 'bridge',
    handler,
    contractRef,
  });
}

function createStoreBinding(storeName, storeMethod, contractRef) {
  return Object.freeze({
    type: 'store',
    transport: 'bridge',
    storeName,
    storeMethod,
    contractRef,
  });
}

const bridgeBindingMetadata = Object.freeze({
  config: Object.freeze({
    load: createDirectBinding((ctx) => ctx.configStore.load(), 'config.load'),
    save: createDirectBinding((ctx, args) => ctx.configStore.save(args[0]), 'config.save'),
  }),

  technicalPlan: Object.freeze({
    loadState: createStoreBinding('technicalPlanStore', 'loadTechnicalPlan', 'technicalPlan.loadState'),
    readTenderMarkdown: createStoreBinding('technicalPlanStore', 'readTenderMarkdown', 'technicalPlan.readTenderMarkdown'),
    readTenderSourceMarkdown: createStoreBinding('technicalPlanStore', 'readTenderSourceMarkdown', 'technicalPlan.readTenderSourceMarkdown'),
    readOriginalPlanMarkdown: createStoreBinding('technicalPlanStore', 'readOriginalPlanMarkdown', 'technicalPlan.readOriginalPlanMarkdown'),
    updateStep: createStoreBinding('technicalPlanStore', 'updateStep', 'technicalPlan.updateStep'),
    setWorkflowKind: createStoreBinding('technicalPlanStore', 'setWorkflowKind', 'technicalPlan.setWorkflowKind'),
    switchWorkflowKind: createStoreBinding('technicalPlanStore', 'switchWorkflowKind', 'technicalPlan.switchWorkflowKind'),
    saveBidAnalysisConfig: createStoreBinding('technicalPlanStore', 'saveBidAnalysisConfig', 'technicalPlan.saveBidAnalysisConfig'),
    saveOutlineConfig: createStoreBinding('technicalPlanStore', 'saveOutlineConfig', 'technicalPlan.saveOutlineConfig'),
    saveOutline: createStoreBinding('technicalPlanStore', 'saveOutline', 'technicalPlan.saveOutline'),
    saveGlobalFacts: createStoreBinding('technicalPlanStore', 'saveGlobalFacts', 'technicalPlan.saveGlobalFacts'),
    saveContentGenerationOptions: createStoreBinding('technicalPlanStore', 'saveContentGenerationOptions', 'technicalPlan.saveContentGenerationOptions'),
    saveChapterContent: createStoreBinding('technicalPlanStore', 'saveChapterContent', 'technicalPlan.saveChapterContent'),
    clear: createStoreBinding('technicalPlanStore', 'clearTechnicalPlan', 'technicalPlan.clear'),
    checkBidSections: createStoreBinding('technicalPlanStore', 'checkBidSections', 'technicalPlan.checkBidSections'),
    selectBidSection: createStoreBinding('technicalPlanStore', 'selectBidSection', 'technicalPlan.selectBidSection'),
  }),

  knowledgeBase: Object.freeze({
    getMigrationStatus: createStoreBinding('knowledgeBaseStore', 'getMigrationStatus', 'knowledgeBase.getMigrationStatus'),
    migrateLegacy: createStoreBinding('knowledgeBaseStore', 'migrateLegacy', 'knowledgeBase.migrateLegacy'),
    renameFolder: createStoreBinding('knowledgeBaseStore', 'renameFolder', 'knowledgeBase.renameFolder'),
    readMarkdown: createStoreBinding('knowledgeBaseStore', 'readMarkdown', 'knowledgeBase.readMarkdown'),
    readItems: createStoreBinding('knowledgeBaseStore', 'readItems', 'knowledgeBase.readItems'),
    readAnalysis: createStoreBinding('knowledgeBaseStore', 'readAnalysis', 'knowledgeBase.readAnalysis'),
  }),

  duplicateCheck: Object.freeze({
    loadState: createStoreBinding('duplicateCheckStore', 'loadDuplicateCheck', 'duplicateCheck.loadState'),
    saveFiles: createStoreBinding('duplicateCheckStore', 'saveFiles', 'duplicateCheck.saveFiles'),
    saveUiState: createStoreBinding('duplicateCheckStore', 'saveUiState', 'duplicateCheck.saveUiState'),
    updateState: createStoreBinding('duplicateCheckStore', 'updateDuplicateCheck', 'duplicateCheck.updateState'),
    clear: createStoreBinding('duplicateCheckStore', 'clearDuplicateCheck', 'duplicateCheck.clear'),
  }),

  rejectionCheck: Object.freeze({
    loadState: createStoreBinding('rejectionCheckStore', 'loadRejectionCheck', 'rejectionCheck.loadState'),
    removeDocument: createStoreBinding('rejectionCheckStore', 'removeDocument', 'rejectionCheck.removeDocument'),
    saveUiState: createStoreBinding('rejectionCheckStore', 'saveUiState', 'rejectionCheck.saveUiState'),
    updateState: createStoreBinding('rejectionCheckStore', 'updateRejectionCheck', 'rejectionCheck.updateState'),
    clear: createStoreBinding('rejectionCheckStore', 'clearRejectionCheck', 'rejectionCheck.clear'),
    importTenderFromTechnicalPlan: createStoreBinding('rejectionCheckStore', 'importTenderFromTechnicalPlan', 'rejectionCheck.importTenderFromTechnicalPlan'),
  }),

  templates: Object.freeze({
    list: createStoreBinding('templateStore', 'listTemplates', 'templates.list'),
    get: createStoreBinding('templateStore', 'getTemplate', 'templates.get'),
    create: createStoreBinding('templateStore', 'createTemplate', 'templates.create'),
    update: createStoreBinding('templateStore', 'updateTemplate', 'templates.update'),
    delete: createStoreBinding('templateStore', 'deleteTemplate', 'templates.delete'),
  }),

  tasks: Object.freeze({
    getActiveTasks: createDirectBinding((ctx) => ctx.taskService.getActiveTasks(), 'tasks.getActiveTasks'),
  }),
});

function buildDispatchers(meta) {
  const result = Object.create(null);
  for (const [namespace, members] of Object.entries(meta)) {
    const namespaceDispatchers = Object.create(null);
    for (const [method, spec] of Object.entries(members)) {
      if (!hasOwnProperty(members, method)) {
        continue;
      }

      if (!spec || typeof spec !== 'object') {
        continue;
      }

      if (spec.type === 'store') {
        namespaceDispatchers[method] = (ctx, args) => {
          const store = ctx.stores[spec.storeName];
          if (!store || typeof store[spec.storeMethod] !== 'function') {
            throw new Error(`${spec.storeName}.${spec.storeMethod} 不可用`);
          }
          return store[spec.storeMethod](...args);
        };
      }

      if (spec.type === 'direct' && typeof spec.handler === 'function') {
        namespaceDispatchers[method] = (ctx, args) => spec.handler(ctx, args);
      }
    }

    if (Object.keys(namespaceDispatchers).length > 0) {
      Object.freeze(namespaceDispatchers);
      result[namespace] = namespaceDispatchers;
    }
  }
  return Object.freeze(result);
}

function createReadOnlyDispatcherRegistry(source) {
  const result = Object.create(null);
  for (const [namespace, members] of Object.entries(source)) {
    const namespaceMethods = Object.create(null);
    for (const [method, handler] of Object.entries(members)) {
      if (hasOwnProperty(members, method) && typeof handler === 'function') {
        namespaceMethods[method] = handler;
      }
    }
    if (Object.keys(namespaceMethods).length > 0) {
      Object.freeze(namespaceMethods);
      result[namespace] = namespaceMethods;
    }
  }
  return Object.freeze(result);
}

let workspaceContextResolver = (workspaceId) => getWorkspaceContext(workspaceId);

function setWorkspaceContextResolver(nextResolver) {
  const oldResolver = workspaceContextResolver;
  workspaceContextResolver = nextResolver;
  return oldResolver;
}

const dispatchers = buildDispatchers(bridgeBindingMetadata);
const readOnlyDispatchers = createReadOnlyDispatcherRegistry(dispatchers);
Object.defineProperty(router, '__contractDispatchers', {
  value: readOnlyDispatchers,
  enumerable: false,
  configurable: false,
  writable: false,
});
Object.defineProperty(router, '__contractBindingMetadata', {
  value: bridgeBindingMetadata,
  enumerable: false,
  configurable: false,
  writable: false,
});
Object.defineProperty(router, '__setWorkspaceContextResolver', {
  value: setWorkspaceContextResolver,
  enumerable: false,
  configurable: false,
  writable: false,
});

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
    if (isDesktopOnlySource(contract.source)) {
      return res.status(410).json(createErrorPayload('WEB_BRIDGE_DESKTOP_ONLY', '该能力为桌面端专属能力，当前环境不支持'));
    }

    if (isDeletedProductSource(contract.source)) {
      return res.status(410).json(createErrorPayload('WEB_BRIDGE_REMOVED', '该功能已下线'));
    }

    return res.status(410).json(createErrorPayload('WEB_BRIDGE_REMOVED', '该能力暂不可用，已暂时下线'));
  }
  if (contract.status === 'pending') {
    return res.status(501).json(createErrorPayload('WEB_CAPABILITY_PENDING', '该能力在 Web 端尚未提供'));
  }
  if (contract.status !== 'implemented') {
    return res.status(500).json(createErrorPayload('BRIDGE_CONTRACT_MISMATCH', '桥接能力配置异常'));
  }

  let ctx;
  try {
    ctx = workspaceContextResolver(req.workspaceId);
  } catch (err) {
    console.error('[bridge] getWorkspaceContext 初始化失败', err?.message || String(err));
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
