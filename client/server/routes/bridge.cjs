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

function createStoreBinding(storeName, storeMethod, contractRef, { mutation = false } = {}) {
  return Object.freeze({
    type: 'store',
    transport: 'bridge',
    storeName,
    storeMethod,
    mutation,
    contractRef,
  });
}

function pickEditableRejectionState(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const editable = {};
  for (const field of ['rejectionCheckResult', 'typoCheckResult', 'logicCheckResult']) {
    if (hasOwnProperty(source, field)) {
      editable[field] = source[field];
    }
  }
  return editable;
}

function executeWorkspaceMutation(ctx, operation) {
  if (ctx.mutationExecutor && typeof ctx.mutationExecutor.execute === 'function') {
    return ctx.mutationExecutor.execute(operation);
  }
  return operation();
}

function executeWorkspaceStore(ctx, targetName, method, args, fallback, { mutation = false } = {}) {
  const execute = () => {
    if (ctx.storeExecutor && typeof ctx.storeExecutor.execute === 'function') {
      return ctx.storeExecutor.execute(targetName, method, args);
    }
    return fallback();
  };
  if (mutation) return executeWorkspaceMutation(ctx, execute);
  if (ctx.storeExecutor && typeof ctx.storeExecutor.execute === 'function') {
    return ctx.storeExecutor.execute(targetName, method, args);
  }
  return fallback();
}

function matchesContractType(value, descriptor) {
  if (Array.isArray(descriptor.enum)) {
    return descriptor.enum.includes(value);
  }
  if (descriptor.type === 'string') {
    return typeof value === 'string';
  }
  if (descriptor.type === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  if (descriptor.type === 'boolean') {
    return typeof value === 'boolean';
  }
  if (descriptor.type === 'object') {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
  if (typeof descriptor.type === 'string' && descriptor.type.endsWith('[]')) {
    return Array.isArray(value);
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateContractValue(value, descriptor) {
  if (value === undefined || value === null) {
    return descriptor.required === false;
  }
  if (!matchesContractType(value, descriptor)) {
    return false;
  }
  if (descriptor.properties && typeof descriptor.properties === 'object') {
    for (const [propertyName, propertyDescriptor] of Object.entries(descriptor.properties)) {
      if (!validateContractValue(value[propertyName], propertyDescriptor)) {
        return false;
      }
    }
  }
  return true;
}

function validateContractArguments(contract, args) {
  if (!Array.isArray(contract.input) || args.length > contract.input.length) {
    return false;
  }
  return contract.input.every((descriptor, index) => (
    descriptor
    && typeof descriptor === 'object'
    && typeof descriptor.name === 'string'
    && typeof descriptor.type === 'string'
    && validateContractValue(args[index], descriptor)
  ));
}

const bridgeBindingMetadata = Object.freeze({
  config: Object.freeze({
    load: createDirectBinding(
      (ctx) => executeWorkspaceStore(ctx, 'configStore', 'load', [], () => ctx.configStore.load()),
      'config.load',
    ),
    save: createDirectBinding(
      (ctx, args) => executeWorkspaceStore(ctx, 'configStore', 'save', [args[0]], () => ctx.configStore.save(args[0])),
      'config.save',
    ),
    listModels: createDirectBinding((ctx, args, options) => ctx.aiService.listModels(args[0], options), 'config.listModels'),
  }),

  agent: Object.freeze({
    listRuntimes: createDirectBinding((ctx) => ctx.agentService.listRuntimes(), 'agent.listRuntimes'),
    selfCheck: createDirectBinding((ctx) => ctx.agentService.selfCheck(), 'agent.selfCheck'),
    getStatus: createDirectBinding((ctx) => ctx.agentService.getStatus(), 'agent.getStatus'),
    restart: createDirectBinding((ctx) => ctx.agentService.restart(), 'agent.restart'),
  }),

  tasks: Object.freeze({
    getActiveTasks: createDirectBinding((ctx) => ctx.taskService.getActiveTasks(), 'tasks.getActiveTasks'),
    startBidAnalysis: createDirectBinding((ctx, args) => ctx.taskService.startBidAnalysis(args[0]), 'tasks.startBidAnalysis'),
  }),

  export: Object.freeze({
    exportWord: createDirectBinding((ctx, args) => ctx.exportService.exportWord(args[0]), 'export.exportWord'),
  }),

  technicalPlan: Object.freeze({
    loadState: createStoreBinding('technicalPlanStore', 'loadTechnicalPlan', 'technicalPlan.loadState'),
    importTenderDocument: createDirectBinding(
      (ctx, args, options) => executeWorkspaceMutation(ctx, () => ctx.stores.technicalPlanStore.importTenderDocument(args[0], options)),
      'technicalPlan.importTenderDocument',
    ),
    importOriginalPlanDocument: createDirectBinding(
      (ctx, args, options) => executeWorkspaceMutation(ctx, () => ctx.stores.technicalPlanStore.importOriginalPlanDocument(args[0], options)),
      'technicalPlan.importOriginalPlanDocument',
    ),
    readTenderMarkdown: createStoreBinding('technicalPlanStore', 'readTenderMarkdown', 'technicalPlan.readTenderMarkdown'),
    readTenderSourceMarkdown: createStoreBinding('technicalPlanStore', 'readTenderSourceMarkdown', 'technicalPlan.readTenderSourceMarkdown'),
    readOriginalPlanMarkdown: createStoreBinding('technicalPlanStore', 'readOriginalPlanMarkdown', 'technicalPlan.readOriginalPlanMarkdown'),
    updateStep: createStoreBinding('technicalPlanStore', 'updateStep', 'technicalPlan.updateStep', { mutation: true }),
    setWorkflowKind: createStoreBinding('technicalPlanStore', 'setWorkflowKind', 'technicalPlan.setWorkflowKind', { mutation: true }),
    switchWorkflowKind: createStoreBinding('technicalPlanStore', 'switchWorkflowKind', 'technicalPlan.switchWorkflowKind', { mutation: true }),
    saveBidAnalysisConfig: createStoreBinding('technicalPlanStore', 'saveBidAnalysisConfig', 'technicalPlan.saveBidAnalysisConfig', { mutation: true }),
    saveOutlineConfig: createStoreBinding('technicalPlanStore', 'saveOutlineConfig', 'technicalPlan.saveOutlineConfig', { mutation: true }),
    saveOutline: createStoreBinding('technicalPlanStore', 'saveOutline', 'technicalPlan.saveOutline', { mutation: true }),
    saveGlobalFacts: createStoreBinding('technicalPlanStore', 'saveGlobalFacts', 'technicalPlan.saveGlobalFacts', { mutation: true }),
    saveContentGenerationOptions: createStoreBinding('technicalPlanStore', 'saveContentGenerationOptions', 'technicalPlan.saveContentGenerationOptions', { mutation: true }),
    saveChapterContent: createStoreBinding('technicalPlanStore', 'saveChapterContent', 'technicalPlan.saveChapterContent', { mutation: true }),
    clear: createStoreBinding('technicalPlanStore', 'clearTechnicalPlan', 'technicalPlan.clear', { mutation: true }),
    checkBidSections: createStoreBinding('technicalPlanStore', 'checkBidSections', 'technicalPlan.checkBidSections'),
    selectBidSection: createStoreBinding('technicalPlanStore', 'selectBidSection', 'technicalPlan.selectBidSection', { mutation: true }),
  }),

  knowledgeBase: Object.freeze({
    list: createDirectBinding((ctx) => ctx.knowledgeBaseService.list(), 'knowledgeBase.list'),
    createFolder: createDirectBinding((ctx, args) => ctx.knowledgeBaseService.createFolder(args[0]), 'knowledgeBase.createFolder'),
    uploadDocuments: createDirectBinding((ctx, args, options) => ctx.knowledgeBaseService.uploadDocuments(args[0], args[1], options), 'knowledgeBase.uploadDocuments'),
    getMigrationStatus: createStoreBinding('knowledgeBaseStore', 'getMigrationStatus', 'knowledgeBase.getMigrationStatus'),
    migrateLegacy: createStoreBinding('knowledgeBaseStore', 'migrateLegacy', 'knowledgeBase.migrateLegacy'),
    renameFolder: createStoreBinding('knowledgeBaseStore', 'renameFolder', 'knowledgeBase.renameFolder'),
    readMarkdown: createStoreBinding('knowledgeBaseStore', 'readMarkdown', 'knowledgeBase.readMarkdown'),
    readItems: createStoreBinding('knowledgeBaseStore', 'readItems', 'knowledgeBase.readItems'),
    readAnalysis: createStoreBinding('knowledgeBaseStore', 'readAnalysis', 'knowledgeBase.readAnalysis'),
  }),

  duplicateCheck: Object.freeze({
    loadState: createStoreBinding('duplicateCheckStore', 'loadDuplicateCheck', 'duplicateCheck.loadState'),
    saveFiles: createDirectBinding(
      (ctx, args) => {
        const payload = args[0] || {};
        const tenderFiles = ctx.fileService.resolveDuplicateCheckFiles(payload.tenderFileIds || []);
        const bidFiles = ctx.fileService.resolveDuplicateCheckFiles(payload.bidFileIds || []);
        const normalized = {
          tenderFile: tenderFiles[0] || null,
          tenderFiles,
          bidFiles,
          step: payload.step,
          activeAnalysisTab: payload.activeAnalysisTab,
        };
        return executeWorkspaceStore(
          ctx,
          'duplicateCheckStore',
          'saveFiles',
          [normalized],
          () => ctx.stores.duplicateCheckStore.saveFiles(normalized),
        );
      },
      'duplicateCheck.saveFiles',
    ),
    saveUiState: createStoreBinding('duplicateCheckStore', 'saveUiState', 'duplicateCheck.saveUiState'),
    clear: createStoreBinding('duplicateCheckStore', 'clearDuplicateCheck', 'duplicateCheck.clear'),
  }),

  rejectionCheck: Object.freeze({
    loadState: createStoreBinding('rejectionCheckStore', 'loadRejectionCheck', 'rejectionCheck.loadState'),
    importDocument: createDirectBinding(
      (ctx, args, options) => ctx.stores.rejectionCheckStore.importDocument(args[0], args[1], options),
      'rejectionCheck.importDocument',
    ),
    removeDocument: createStoreBinding('rejectionCheckStore', 'removeDocument', 'rejectionCheck.removeDocument'),
    saveUiState: createStoreBinding('rejectionCheckStore', 'saveUiState', 'rejectionCheck.saveUiState'),
    updateState: createDirectBinding(
      (ctx, args) => {
        const partial = pickEditableRejectionState(args[0]);
        return executeWorkspaceStore(
          ctx,
          'rejectionCheckStore',
          'updateRejectionCheck',
          [partial],
          () => ctx.stores.rejectionCheckStore.updateRejectionCheck(partial),
        );
      },
      'rejectionCheck.updateState',
    ),
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
          return executeWorkspaceStore(
            ctx,
            spec.storeName,
            spec.storeMethod,
            args,
            () => {
              const store = ctx.stores[spec.storeName];
              if (!store || typeof store[spec.storeMethod] !== 'function') {
                throw new Error(`${spec.storeName}.${spec.storeMethod} 不可用`);
              }
              return store[spec.storeMethod](...args);
            },
            { mutation: spec.mutation === true },
          );
        };
      }

      if (spec.type === 'direct' && typeof spec.handler === 'function') {
        namespaceDispatchers[method] = (ctx, args, options) => spec.handler(ctx, args, options);
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

    return res.status(500).json(createErrorPayload('BRIDGE_CONTRACT_MISMATCH', '契约来源配置异常：removed source 未识别'));
  }
  if (contract.status === 'pending') {
    return res.status(501).json(createErrorPayload('WEB_CAPABILITY_PENDING', '该能力在 Web 端尚未提供'));
  }
  if (contract.status !== 'implemented') {
    return res.status(500).json(createErrorPayload('BRIDGE_CONTRACT_MISMATCH', '桥接能力配置异常'));
  }
  if (!validateContractArguments(contract, args)) {
    return res.status(400).json(createErrorPayload('INVALID_BRIDGE_ARGUMENTS', 'Bridge 参数与契约不匹配'));
  }

  let ctx;
  try {
    ctx = workspaceContextResolver(req.workspaceId);
  } catch (err) {
    if (err?.code === 'WORKSPACE_UNAVAILABLE') {
      return res.status(503).json({
        code: 'WORKSPACE_UNAVAILABLE',
        message: '工作区暂时不可用，请稍后重试',
        retryable: true,
      });
    }
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

  const requestController = new AbortController();
  let completed = false;
  res.once('close', () => {
    if (!completed) {
      requestController.abort();
    }
  });

  function sendExecutionError(err) {
    if (err?.code === 'INVALID_BRIDGE_ARGUMENTS') {
      return res.status(400).json({
        code: 'INVALID_BRIDGE_ARGUMENTS',
        message: 'Bridge 参数无效',
        retryable: false,
      });
    }
    if (err?.code === 'CONFIG_INVALID') {
      return res.status(400).json({
        code: 'CONFIG_INVALID',
        message: '配置格式无效',
        retryable: false,
      });
    }
    if (err?.code === 'TASK_INVALID_INPUT' || err?.code === 'TASK_ITEM_NOT_FOUND') {
      return res.status(400).json({
        code: err.code,
        message: err.message || '任务输入无效',
        retryable: false,
      });
    }
    if (err?.code === 'TASK_INPUT_CHANGED') {
      return res.status(409).json({
        code: err.code,
        message: err.message || '任务输入已更新，请重新开始',
        retryable: true,
      });
    }
    if (err?.code === 'AI_QUEUE_OVERLOADED') {
      return res.status(429)
        .set('Retry-After', '5')
        .json({
          code: 'AI_QUEUE_OVERLOADED',
          message: 'AI 请求队列繁忙，请稍后重试',
          retryable: true,
        });
    }
    if (typeof err?.code === 'string' && err.code.startsWith('AGENT_')) {
      const unavailable = err.code === 'AGENT_RUNTIME_UNAVAILABLE' || err.code === 'AGENT_CLOSING';
      return res.status(unavailable ? 503 : 400).json({
        code: err.code,
        message: err.message || 'Agent Runtime 请求失败',
        retryable: unavailable || err.code === 'AGENT_TIMEOUT',
      });
    }
    if (typeof err?.code === 'string' && err.code.startsWith('UPLOAD_FILE_')) {
      return res.status(400).json({
        code: err.code,
        message: err.message || '上传文件无效',
        retryable: false,
      });
    }
    console.error(`[bridge] ${namespace}.${method} 执行失败`, err?.message || String(err));
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
  }

  try {
    const result = nsDispatcher[method](ctx, args, { signal: requestController.signal });
    Promise.resolve(result).then((data) => {
      completed = true;
      if (requestController.signal.aborted || res.destroyed) {
        return;
      }
      res.json({ code: 'OK', data });
    }).catch((err) => {
      completed = true;
      if (requestController.signal.aborted || res.destroyed) {
        return;
      }
      sendExecutionError(err);
    });
  } catch (err) {
    completed = true;
    sendExecutionError(err);
  }
});

module.exports = router;
