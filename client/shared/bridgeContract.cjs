function createContractEntry(options) {
  const {
    status,
    owner,
    workPackage,
    source = 'webBridge',
    transport = 'bridge',
    contractRef,
    input = [],
    output = null,
    errors = [],
    ...rest
  } = options;

  return {
    status,
    owner,
    workPackage,
    source,
    transport,
    contractRef,
    input,
    output,
    errors,
    ...rest,
  };
}

function isLeafCandidate(entry) {
  return entry !== null
    && typeof entry === 'object'
    && !Array.isArray(entry)
    && Object.prototype.hasOwnProperty.call(entry, 'status');
}

function normalizeNamespace(namespace, defs, basePath) {
  const node = Object.create(null);

  for (const [key, value] of Object.entries(defs)) {
    const methodPath = basePath ? `${basePath}.${key}` : `${namespace}.${key}`;
    if (isLeafCandidate(value)) {
      node[key] = {
        status: value.status,
        owner: value.owner,
        workPackage: value.workPackage,
        source: value.source || 'webBridge',
        transport: value.transport || 'bridge',
        contractRef: value.contractRef || methodPath,
        input: Array.isArray(value.input) ? value.input : [],
        output: value.output === undefined ? null : value.output,
        errors: Array.isArray(value.errors) ? value.errors : [],
      };
      continue;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      node[key] = normalizeNamespace(namespace, value, methodPath);
    }
  }

  return node;
}

const rawMethods = {
  members: {
    appName: createContractEntry({
      status: 'implemented',
      owner: 'shared',
      workPackage: 'WP-A',
      transport: 'local',
      contractRef: 'members.appName',
      output: { type: 'string' },
    }),
    platform: createContractEntry({
      status: 'implemented',
      owner: 'shared',
      workPackage: 'WP-A',
      transport: 'local',
      contractRef: 'members.platform',
      output: { type: 'string' },
    }),
  },
  locals: {
    openExternal: createContractEntry({
      status: 'implemented',
      owner: 'web-runtime',
      workPackage: 'WP-A',
      transport: 'local',
      contractRef: 'locals.openExternal',
      input: [{ name: 'url', type: 'string', required: true }],
      output: { type: 'object' },
    }),
    database: {
      getStatus: createContractEntry({
        status: 'implemented',
        owner: 'runtime',
        workPackage: 'WP-A',
        transport: 'local',
        contractRef: 'locals.database.getStatus',
        input: [],
        output: {
          phase: 'ready',
          ready: true,
          message: 'string',
          updatedAt: 'string',
        },
      }),
    },
  },
  events: {
    onUpdateProgress: createContractEntry({
      status: 'removed',
      owner: 'desktop',
      workPackage: 'WP-A',
      source: 'desktop-only',
      transport: 'event',
      contractRef: 'events.onUpdateProgress',
      errors: ['WEB_BRIDGE_DESKTOP_ONLY'],
      output: { type: 'void' },
    }),
    onUpdateDownloaded: createContractEntry({
      status: 'removed',
      owner: 'desktop',
      workPackage: 'WP-A',
      source: 'desktop-only',
      transport: 'event',
      contractRef: 'events.onUpdateDownloaded',
      errors: ['WEB_BRIDGE_DESKTOP_ONLY'],
      output: { type: 'void' },
    }),
    onUpdateError: createContractEntry({
      status: 'removed',
      owner: 'desktop',
      workPackage: 'WP-A',
      source: 'desktop-only',
      transport: 'event',
      contractRef: 'events.onUpdateError',
      errors: ['WEB_BRIDGE_DESKTOP_ONLY'],
      output: { type: 'void' },
    }),
    database: {
      onStatus: createContractEntry({
        status: 'pending',
        owner: 'runtime',
        workPackage: 'WP-A',
        transport: 'event',
        contractRef: 'events.database.onStatus',
        output: { type: 'void' },
        errors: ['WEB_CAPABILITY_PENDING'],
      }),
    },
    ai: {
      onHttpError: createContractEntry({
        status: 'pending',
        owner: 'runtime',
        workPackage: 'WP-C',
        transport: 'event',
        contractRef: 'events.ai.onHttpError',
        output: { type: 'void' },
        errors: ['WEB_CAPABILITY_PENDING'],
      }),
    },
    agent: {
      onStatus: createContractEntry({
        status: 'pending',
        owner: 'workflow',
        workPackage: 'WP-E',
        transport: 'event',
        contractRef: 'events.agent.onStatus',
        output: { type: 'void' },
        errors: ['WEB_CAPABILITY_PENDING'],
      }),
    },
    developerTokenStats: {
      onChanged: createContractEntry({
        status: 'pending',
        owner: 'developer',
        workPackage: 'WP-B',
        transport: 'event',
        contractRef: 'events.developerTokenStats.onChanged',
        output: { type: 'void' },
        errors: ['WEB_CAPABILITY_PENDING'],
      }),
    },
    knowledgeBase: {
      onEvent: createContractEntry({
        status: 'pending',
        owner: 'knowledge',
        workPackage: 'WP-A',
        transport: 'event',
        contractRef: 'events.knowledgeBase.onEvent',
        output: { type: 'void' },
        errors: ['WEB_CAPABILITY_PENDING'],
      }),
    },
    tasks: {
      onTaskEvent: createContractEntry({
        status: 'implemented',
        owner: 'workflow',
        workPackage: 'WP-A',
        transport: 'event',
        contractRef: 'events.tasks.onTaskEvent',
        input: [{ type: 'TaskEvent' }],
        output: { type: 'void' },
      }),
    },
    export: {
      onWordExportProgress: createContractEntry({
        status: 'pending',
        owner: 'export',
        workPackage: 'WP-F',
        transport: 'event',
        contractRef: 'events.export.onWordExportProgress',
        output: { type: 'void' },
        errors: ['WEB_CAPABILITY_PENDING'],
      }),
    },
  },
  app: {
    getVersion: createContractEntry({
      status: 'pending',
      owner: 'web-shell',
      workPackage: 'WP-G',
      contractRef: 'app.getVersion',
    }),
    getGpuHardwareAccelerationStatus: createContractEntry({
      status: 'removed',
      owner: 'desktop',
      workPackage: 'WP-A',
      source: 'desktop-only',
      transport: 'bridge',
      contractRef: 'app.getGpuHardwareAccelerationStatus',
      errors: ['WEB_BRIDGE_DESKTOP_ONLY'],
    }),
    saveGpuHardwareAccelerationPreference: createContractEntry({
      status: 'removed',
      owner: 'desktop',
      workPackage: 'WP-A',
      source: 'desktop-only',
      transport: 'bridge',
      contractRef: 'app.saveGpuHardwareAccelerationPreference',
      errors: ['WEB_BRIDGE_DESKTOP_ONLY'],
    }),
    startGpuHardwareAccelerationTrial: createContractEntry({
      status: 'removed',
      owner: 'desktop',
      workPackage: 'WP-A',
      source: 'desktop-only',
      transport: 'bridge',
      contractRef: 'app.startGpuHardwareAccelerationTrial',
      errors: ['WEB_BRIDGE_DESKTOP_ONLY'],
    }),
    relaunchWithGpuHardwareAccelerationDisabled: createContractEntry({
      status: 'removed',
      owner: 'desktop',
      workPackage: 'WP-A',
      source: 'desktop-only',
      transport: 'bridge',
      contractRef: 'app.relaunchWithGpuHardwareAccelerationDisabled',
      errors: ['WEB_BRIDGE_DESKTOP_ONLY'],
    }),
    getLatestVersion: createContractEntry({
      status: 'removed',
      owner: 'desktop',
      workPackage: 'WP-A',
      source: 'desktop-only',
      transport: 'bridge',
      contractRef: 'app.getLatestVersion',
      errors: ['WEB_BRIDGE_DESKTOP_ONLY'],
    }),
    getUpdateDownloadUrl: createContractEntry({
      status: 'removed',
      owner: 'desktop',
      workPackage: 'WP-A',
      source: 'desktop-only',
      transport: 'bridge',
      contractRef: 'app.getUpdateDownloadUrl',
      errors: ['WEB_BRIDGE_DESKTOP_ONLY'],
    }),
    checkUpdate: createContractEntry({
      status: 'removed',
      owner: 'desktop',
      workPackage: 'WP-A',
      source: 'desktop-only',
      transport: 'bridge',
      contractRef: 'app.checkUpdate',
      errors: ['WEB_BRIDGE_DESKTOP_ONLY'],
    }),
    startUpdate: createContractEntry({
      status: 'removed',
      owner: 'desktop',
      workPackage: 'WP-A',
      source: 'desktop-only',
      transport: 'bridge',
      contractRef: 'app.startUpdate',
      errors: ['WEB_BRIDGE_DESKTOP_ONLY'],
    }),
    quitAndInstall: createContractEntry({
      status: 'removed',
      owner: 'desktop',
      workPackage: 'WP-A',
      source: 'desktop-only',
      transport: 'bridge',
      contractRef: 'app.quitAndInstall',
      errors: ['WEB_BRIDGE_DESKTOP_ONLY'],
    }),
  },
  requiredOnlineServices: {
    getStatus: createContractEntry({ status: 'pending', owner: 'runtime', workPackage: 'WP-G', contractRef: 'requiredOnlineServices.getStatus' }),
  },
  config: {
    load: createContractEntry({ status: 'implemented', owner: 'settings', workPackage: 'WP-A', contractRef: 'config.load' }),
    save: createContractEntry({ status: 'implemented', owner: 'settings', workPackage: 'WP-A', contractRef: 'config.save' }),
    listModels: createContractEntry({ status: 'implemented', owner: 'settings', workPackage: 'WP-C', contractRef: 'config.listModels' }),
    openConfigFolder: createContractEntry({
      status: 'removed',
      owner: 'desktop',
      workPackage: 'WP-A',
      source: 'desktop-only',
      contractRef: 'config.openConfigFolder',
      errors: ['WEB_BRIDGE_DESKTOP_ONLY'],
    }),
  },
  license: {
    getStatus: createContractEntry({ status: 'pending', owner: 'settings', workPackage: 'WP-G', contractRef: 'license.getStatus' }),
    refresh: createContractEntry({ status: 'pending', owner: 'settings', workPackage: 'WP-G', contractRef: 'license.refresh' }),
    importOfflineFile: createContractEntry({ status: 'pending', owner: 'settings', workPackage: 'WP-G', contractRef: 'license.importOfflineFile' }),
    activateOfflineCode: createContractEntry({ status: 'pending', owner: 'settings', workPackage: 'WP-G', contractRef: 'license.activateOfflineCode' }),
  },
  ai: {
    chat: createContractEntry({ status: 'pending', owner: 'runtime', workPackage: 'WP-C', contractRef: 'ai.chat' }),
    requestJson: createContractEntry({ status: 'pending', owner: 'runtime', workPackage: 'WP-C', contractRef: 'ai.requestJson' }),
    testImageModel: createContractEntry({ status: 'pending', owner: 'runtime', workPackage: 'WP-C', contractRef: 'ai.testImageModel' }),
  },
  agent: {
    listRuntimes: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-E', contractRef: 'agent.listRuntimes' }),
    run: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-E', contractRef: 'agent.run' }),
    selfCheck: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-E', contractRef: 'agent.selfCheck' }),
    exportSelfCheckReport: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-E', contractRef: 'agent.exportSelfCheckReport' }),
    getStatus: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-E', contractRef: 'agent.getStatus' }),
    restart: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-E', contractRef: 'agent.restart' }),
  },
  developerTokenStats: {
    openWindow: createContractEntry({
      status: 'removed',
      owner: 'desktop',
      workPackage: 'WP-A',
      source: 'desktop-only',
      transport: 'bridge',
      contractRef: 'developerTokenStats.openWindow',
      errors: ['WEB_BRIDGE_DESKTOP_ONLY'],
    }),
    get: createContractEntry({ status: 'pending', owner: 'developer', workPackage: 'WP-B', contractRef: 'developerTokenStats.get' }),
    reset: createContractEntry({ status: 'pending', owner: 'developer', workPackage: 'WP-B', contractRef: 'developerTokenStats.reset' }),
  },
  developerExpansionReplaceTest: {
    run: createContractEntry({ status: 'pending', owner: 'developer', workPackage: 'WP-B', contractRef: 'developerExpansionReplaceTest.run' }),
  },
  file: {
    selectDuplicateCheckFiles: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-D', contractRef: 'file.selectDuplicateCheckFiles' }),
  },
  knowledgeBase: {
    getMigrationStatus: createContractEntry({ status: 'implemented', owner: 'knowledge', workPackage: 'WP-A', contractRef: 'knowledgeBase.getMigrationStatus' }),
    migrateLegacy: createContractEntry({ status: 'implemented', owner: 'knowledge', workPackage: 'WP-A', contractRef: 'knowledgeBase.migrateLegacy' }),
    list: createContractEntry({ status: 'pending', owner: 'knowledge', workPackage: 'WP-C', contractRef: 'knowledgeBase.list' }),
    createFolder: createContractEntry({ status: 'pending', owner: 'knowledge', workPackage: 'WP-C', contractRef: 'knowledgeBase.createFolder' }),
    renameFolder: createContractEntry({ status: 'implemented', owner: 'knowledge', workPackage: 'WP-A', contractRef: 'knowledgeBase.renameFolder' }),
    reorderFolder: createContractEntry({ status: 'pending', owner: 'knowledge', workPackage: 'WP-C', contractRef: 'knowledgeBase.reorderFolder' }),
    deleteFolder: createContractEntry({ status: 'pending', owner: 'knowledge', workPackage: 'WP-C', contractRef: 'knowledgeBase.deleteFolder' }),
    deleteDocument: createContractEntry({ status: 'pending', owner: 'knowledge', workPackage: 'WP-C', contractRef: 'knowledgeBase.deleteDocument' }),
    moveDocument: createContractEntry({ status: 'pending', owner: 'knowledge', workPackage: 'WP-C', contractRef: 'knowledgeBase.moveDocument' }),
    uploadDocuments: createContractEntry({ status: 'pending', owner: 'knowledge', workPackage: 'WP-D', contractRef: 'knowledgeBase.uploadDocuments' }),
    retryDocument: createContractEntry({ status: 'pending', owner: 'knowledge', workPackage: 'WP-C', contractRef: 'knowledgeBase.retryDocument' }),
    startMatching: createContractEntry({ status: 'pending', owner: 'knowledge', workPackage: 'WP-C', contractRef: 'knowledgeBase.startMatching' }),
    readMarkdown: createContractEntry({ status: 'implemented', owner: 'knowledge', workPackage: 'WP-A', contractRef: 'knowledgeBase.readMarkdown' }),
    readItems: createContractEntry({ status: 'implemented', owner: 'knowledge', workPackage: 'WP-A', contractRef: 'knowledgeBase.readItems' }),
    readAnalysis: createContractEntry({ status: 'implemented', owner: 'knowledge', workPackage: 'WP-A', contractRef: 'knowledgeBase.readAnalysis' }),
  },
  technicalPlan: {
    loadState: createContractEntry({ status: 'implemented', owner: 'technical-plan', workPackage: 'WP-A', contractRef: 'technicalPlan.loadState' }),
    importTenderDocument: createContractEntry({ status: 'pending', owner: 'technical-plan', workPackage: 'WP-D', contractRef: 'technicalPlan.importTenderDocument' }),
    importOriginalPlanDocument: createContractEntry({ status: 'pending', owner: 'technical-plan', workPackage: 'WP-D', contractRef: 'technicalPlan.importOriginalPlanDocument' }),
    checkBidSections: createContractEntry({ status: 'implemented', owner: 'technical-plan', workPackage: 'WP-A', contractRef: 'technicalPlan.checkBidSections' }),
    selectBidSection: createContractEntry({ status: 'implemented', owner: 'technical-plan', workPackage: 'WP-A', contractRef: 'technicalPlan.selectBidSection' }),
    readTenderMarkdown: createContractEntry({ status: 'implemented', owner: 'technical-plan', workPackage: 'WP-A', contractRef: 'technicalPlan.readTenderMarkdown' }),
    readTenderSourceMarkdown: createContractEntry({ status: 'implemented', owner: 'technical-plan', workPackage: 'WP-A', contractRef: 'technicalPlan.readTenderSourceMarkdown' }),
    readOriginalPlanMarkdown: createContractEntry({ status: 'implemented', owner: 'technical-plan', workPackage: 'WP-A', contractRef: 'technicalPlan.readOriginalPlanMarkdown' }),
    updateStep: createContractEntry({ status: 'implemented', owner: 'technical-plan', workPackage: 'WP-A', contractRef: 'technicalPlan.updateStep' }),
    setWorkflowKind: createContractEntry({ status: 'implemented', owner: 'technical-plan', workPackage: 'WP-A', contractRef: 'technicalPlan.setWorkflowKind' }),
    switchWorkflowKind: createContractEntry({ status: 'implemented', owner: 'technical-plan', workPackage: 'WP-A', contractRef: 'technicalPlan.switchWorkflowKind' }),
    saveBidAnalysisConfig: createContractEntry({ status: 'implemented', owner: 'technical-plan', workPackage: 'WP-A', contractRef: 'technicalPlan.saveBidAnalysisConfig' }),
    saveOutlineConfig: createContractEntry({ status: 'implemented', owner: 'technical-plan', workPackage: 'WP-A', contractRef: 'technicalPlan.saveOutlineConfig' }),
    saveOutline: createContractEntry({ status: 'implemented', owner: 'technical-plan', workPackage: 'WP-A', contractRef: 'technicalPlan.saveOutline' }),
    saveGlobalFacts: createContractEntry({ status: 'implemented', owner: 'technical-plan', workPackage: 'WP-A', contractRef: 'technicalPlan.saveGlobalFacts' }),
    saveContentGenerationOptions: createContractEntry({ status: 'implemented', owner: 'technical-plan', workPackage: 'WP-A', contractRef: 'technicalPlan.saveContentGenerationOptions' }),
    saveChapterContent: createContractEntry({ status: 'implemented', owner: 'technical-plan', workPackage: 'WP-A', contractRef: 'technicalPlan.saveChapterContent' }),
    clear: createContractEntry({ status: 'implemented', owner: 'technical-plan', workPackage: 'WP-A', contractRef: 'technicalPlan.clear' }),
  },
  duplicateCheck: {
    loadState: createContractEntry({ status: 'implemented', owner: 'workflow', workPackage: 'WP-A', contractRef: 'duplicateCheck.loadState' }),
    saveFiles: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-D', contractRef: 'duplicateCheck.saveFiles' }),
    saveUiState: createContractEntry({ status: 'implemented', owner: 'workflow', workPackage: 'WP-A', contractRef: 'duplicateCheck.saveUiState' }),
    updateState: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-D', contractRef: 'duplicateCheck.updateState' }),
    clear: createContractEntry({ status: 'implemented', owner: 'workflow', workPackage: 'WP-A', contractRef: 'duplicateCheck.clear' }),
  },
  rejectionCheck: {
    loadState: createContractEntry({ status: 'implemented', owner: 'workflow', workPackage: 'WP-A', contractRef: 'rejectionCheck.loadState' }),
    importDocument: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-D', contractRef: 'rejectionCheck.importDocument' }),
    importTenderFromTechnicalPlan: createContractEntry({ status: 'implemented', owner: 'workflow', workPackage: 'WP-A', contractRef: 'rejectionCheck.importTenderFromTechnicalPlan' }),
    removeDocument: createContractEntry({ status: 'implemented', owner: 'workflow', workPackage: 'WP-A', contractRef: 'rejectionCheck.removeDocument' }),
    saveUiState: createContractEntry({ status: 'implemented', owner: 'workflow', workPackage: 'WP-A', contractRef: 'rejectionCheck.saveUiState' }),
    updateState: createContractEntry({ status: 'implemented', owner: 'workflow', workPackage: 'WP-A', contractRef: 'rejectionCheck.updateState' }),
    clear: createContractEntry({ status: 'implemented', owner: 'workflow', workPackage: 'WP-A', contractRef: 'rejectionCheck.clear' }),
  },
  templates: {
    list: createContractEntry({ status: 'implemented', owner: 'workflow', workPackage: 'WP-A', contractRef: 'templates.list' }),
    get: createContractEntry({ status: 'implemented', owner: 'workflow', workPackage: 'WP-A', contractRef: 'templates.get' }),
    create: createContractEntry({ status: 'implemented', owner: 'workflow', workPackage: 'WP-A', contractRef: 'templates.create' }),
    update: createContractEntry({ status: 'implemented', owner: 'workflow', workPackage: 'WP-A', contractRef: 'templates.update' }),
    delete: createContractEntry({ status: 'implemented', owner: 'workflow', workPackage: 'WP-A', contractRef: 'templates.delete' }),
  },
  tasks: {
    startBidSectionExtraction: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-C', contractRef: 'tasks.startBidSectionExtraction' }),
    startBidAnalysis: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-C', contractRef: 'tasks.startBidAnalysis' }),
    startOutlineGeneration: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-C', contractRef: 'tasks.startOutlineGeneration' }),
    startGlobalFactsGeneration: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-C', contractRef: 'tasks.startGlobalFactsGeneration' }),
    startContentGeneration: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-C', contractRef: 'tasks.startContentGeneration' }),
    pauseContentGeneration: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-C', contractRef: 'tasks.pauseContentGeneration' }),
    startRejectionItemsExtraction: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-C', contractRef: 'tasks.startRejectionItemsExtraction' }),
    startRejectionCheck: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-C', contractRef: 'tasks.startRejectionCheck' }),
    startDuplicateAnalysis: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-C', contractRef: 'tasks.startDuplicateAnalysis' }),
    getActiveTasks: createContractEntry({ status: 'implemented', owner: 'workflow', workPackage: 'WP-A', contractRef: 'tasks.getActiveTasks' }),
  },
  export: {
    exportWord: createContractEntry({ status: 'pending', owner: 'export', workPackage: 'WP-F', contractRef: 'export.exportWord' }),
    openFile: createContractEntry({
      status: 'removed',
      owner: 'desktop',
      workPackage: 'WP-A',
      source: 'desktop-only',
      transport: 'bridge',
      contractRef: 'export.openFile',
      errors: ['WEB_BRIDGE_DESKTOP_ONLY'],
    }),
  },
  systemFonts: {
    list: createContractEntry({ status: 'pending', owner: 'web-shell', workPackage: 'WP-F', contractRef: 'systemFonts.list' }),
  },
  resources: {
    list: createContractEntry({
      status: 'removed',
      owner: 'legacy',
      workPackage: 'WP-A',
      source: 'deleted-product',
      transport: 'bridge',
      contractRef: 'resources.list',
      errors: ['WEB_BRIDGE_REMOVED'],
    }),
  },
  tenderOpportunities: {
    list: createContractEntry({
      status: 'removed',
      owner: 'legacy',
      workPackage: 'WP-A',
      source: 'deleted-product',
      transport: 'bridge',
      contractRef: 'tenderOpportunities.list',
      errors: ['WEB_BRIDGE_REMOVED'],
    }),
  },
  plugins: {
    list: createContractEntry({
      status: 'removed',
      owner: 'legacy',
      workPackage: 'WP-A',
      source: 'deleted-product',
      transport: 'bridge',
      contractRef: 'plugins.list',
      errors: ['WEB_BRIDGE_REMOVED'],
    }),
  },
};

const methods = Object.create(null);
for (const [namespace, defs] of Object.entries(rawMethods)) {
  methods[namespace] = normalizeNamespace(namespace, defs);
}

module.exports = {
  version: 'wp-a-contract-manifest-v1',
  methods: Object.freeze(methods),
};
