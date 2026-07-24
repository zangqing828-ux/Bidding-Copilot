// POST /api/bridge：统一业务 API 入口。
// Sprint 04-07：config/tasks/technicalPlan/knowledgeBase/duplicateCheck/rejectionCheck/templates 已实现。
// ai/agent/export 的 Electron 依赖方法返回 501，待 Linux Runtime/渲染/导出适配后实现。
const express = require('express');
const { getWorkspaceContext } = require('../workspace/workspaceRegistry.cjs');

const router = express.Router();

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
  const { namespace, method, args } = req.body || {};
  const workspaceId = req.workspaceId;

  let ctx;
  try {
    ctx = getWorkspaceContext(workspaceId);
  } catch (err) {
    return res.status(500).json({ code: 'WORKSPACE_ERROR', message: '工作区初始化失败' });
  }

  const nsDispatcher = dispatchers[namespace];
  if (!nsDispatcher || typeof nsDispatcher[method] !== 'function') {
    return res.status(501).json({
      code: 'WEB_CAPABILITY_PENDING',
      message: `该功能尚未在 Web 端提供：${namespace ? `${namespace}.${method || ''}` : '未知接口'}`,
    });
  }

  try {
    const result = nsDispatcher[method](ctx, args || []);
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
