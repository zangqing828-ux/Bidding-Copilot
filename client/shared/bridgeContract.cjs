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

const COMMON_IMPLEMENTED_BRIDGE_ERRORS = Object.freeze([
  'UNAUTHORIZED',
  'INVALID_BRIDGE_ARGUMENTS',
  'BRIDGE_DISPATCHER_MISSING',
  'INTERNAL_ERROR',
]);

const REMOVED_BRIDGE_ERRORS = Object.freeze(['WEB_BRIDGE_REMOVED']);
const REMOVED_DESKTOP_ERRORS = Object.freeze(['WEB_BRIDGE_DESKTOP_ONLY']);
const PENDING_ERRORS = Object.freeze(['WEB_CAPABILITY_PENDING']);

const contractEnums = Object.freeze({
  TechnicalPlanStep: Object.freeze([
    'document-analysis',
    'bid-analysis',
    'outline-generation',
    'global-facts',
    'content-edit',
    'expand',
  ]),
  TechnicalPlanWorkflowKind: Object.freeze([
    'technical-plan',
    'existing-plan-expansion',
  ]),
  BidAnalysisMode: Object.freeze(['key', 'full', 'custom']),
  BidSectionMode: Object.freeze(['single', 'multiple']),
  OutlineExpansionMode: Object.freeze(['original-only', 'ai-complement']),
  RejectionDocumentRole: Object.freeze(['tender', 'bid']),
});

function contractArg(name, type, options = {}) {
  const descriptor = {
    name,
    type,
    required: options.required !== false,
  };
  if (Array.isArray(options.enum)) {
    descriptor.enum = [...options.enum];
  }
  if (options.properties && typeof options.properties === 'object') {
    descriptor.properties = options.properties;
  }
  return descriptor;
}

function implementedBridgeContract({
  owner,
  workPackage,
  contractRef,
  input,
  output,
  errors = [],
}) {
  return createContractEntry({
    status: 'implemented',
    owner,
    workPackage,
    contractRef,
    input,
    output: { type: output },
    errors: [...COMMON_IMPLEMENTED_BRIDGE_ERRORS, ...errors],
  });
}

function removedBridgeContract(contractRef, owner, workPackage) {
  return createContractEntry({
    status: 'removed',
    owner,
    workPackage,
    source: 'deleted-product',
    transport: 'bridge',
    contractRef,
    input: [],
    output: null,
    errors: [...REMOVED_BRIDGE_ERRORS],
  });
}

function removedEventContract(contractRef, owner, workPackage) {
  return createContractEntry({
    status: 'removed',
    owner,
    workPackage,
    source: 'deleted-product',
    transport: 'event',
    contractRef,
    input: [],
    output: { type: 'void' },
    errors: [...REMOVED_BRIDGE_ERRORS],
  });
}

function removedLocalContract(contractRef, owner, workPackage) {
  return createContractEntry({
    status: 'removed',
    owner,
    workPackage,
    source: 'deleted-product',
    transport: 'local',
    contractRef,
    input: [],
    output: null,
    errors: [...REMOVED_BRIDGE_ERRORS],
  });
}

function pendingContract(contractRef, owner, workPackage) {
  return createContractEntry({
    status: 'pending',
    owner,
    workPackage,
    contractRef,
    input: [],
    output: null,
    errors: [...PENDING_ERRORS],
  });
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
      getStatus: removedLocalContract('locals.database.getStatus', 'runtime', 'WR-01'),
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
      onStatus: removedEventContract('events.database.onStatus', 'runtime', 'WR-01'),
    },
    ai: {
      onHttpError: removedEventContract('events.ai.onHttpError', 'runtime', 'WR-01'),
    },
    agent: {
      onStatus: removedEventContract('events.agent.onStatus', 'workflow', 'WR-01'),
    },
    developerTokenStats: {
      onChanged: removedEventContract('events.developerTokenStats.onChanged', 'developer', 'WR-01'),
    },
    knowledgeBase: {
      onEvent: removedEventContract('events.knowledgeBase.onEvent', 'knowledge', 'WR-01'),
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
      onWordExportProgress: removedEventContract('events.export.onWordExportProgress', 'export', 'WR-01'),
    },
  },
  app: {
    getVersion: pendingContract('app.getVersion', 'web-shell', 'WR-06A'),
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
    getStatus: removedBridgeContract('requiredOnlineServices.getStatus', 'runtime', 'WR-01'),
  },
  config: {
    load: implementedBridgeContract({
      owner: 'settings',
      workPackage: 'WP-A',
      contractRef: 'config.load',
      input: [],
      output: 'ClientConfig',
      errors: ['CONFIG_INVALID'],
    }),
    save: implementedBridgeContract({
      owner: 'settings',
      workPackage: 'WP-A',
      contractRef: 'config.save',
      input: [contractArg('config', 'ClientConfig')],
      output: 'ConfigSaveResult',
      errors: ['CONFIG_INVALID'],
    }),
    listModels: implementedBridgeContract({
      owner: 'settings',
      workPackage: 'WP-C',
      contractRef: 'config.listModels',
      input: [contractArg('config', 'ModelListConfig', { required: false })],
      output: 'ModelListResult',
      errors: [
        'CONFIG_INVALID',
        'AI_CONFIG_INVALID',
        'AI_CONFIG_LOAD_FAILED',
        'AI_ENDPOINT_NOT_ALLOWED',
        'AI_QUEUE_OVERLOADED',
        'AI_REQUEST_ABORTED',
        'AI_REQUEST_TIMEOUT',
        'AI_NETWORK_ERROR',
        'AI_RESPONSE_PARSE_ERROR',
        'AI_REQUEST_FAILED',
      ],
    }),
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
    getStatus: removedBridgeContract('license.getStatus', 'settings', 'WR-01'),
    refresh: removedBridgeContract('license.refresh', 'settings', 'WR-01'),
    importOfflineFile: removedBridgeContract('license.importOfflineFile', 'settings', 'WR-01'),
    activateOfflineCode: removedBridgeContract('license.activateOfflineCode', 'settings', 'WR-01'),
  },
  ai: {
    chat: pendingContract('ai.chat', 'runtime', 'WR-06A'),
    requestJson: removedBridgeContract('ai.requestJson', 'runtime', 'WR-01'),
    testImageModel: pendingContract('ai.testImageModel', 'runtime', 'WR-04'),
  },
  agent: {
    listRuntimes: removedBridgeContract('agent.listRuntimes', 'workflow', 'WR-01'),
    run: removedBridgeContract('agent.run', 'workflow', 'WR-01'),
    selfCheck: removedBridgeContract('agent.selfCheck', 'workflow', 'WR-01'),
    exportSelfCheckReport: removedBridgeContract('agent.exportSelfCheckReport', 'workflow', 'WR-01'),
    getStatus: removedBridgeContract('agent.getStatus', 'workflow', 'WR-01'),
    restart: removedBridgeContract('agent.restart', 'workflow', 'WR-01'),
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
    get: removedBridgeContract('developerTokenStats.get', 'developer', 'WR-01'),
    reset: removedBridgeContract('developerTokenStats.reset', 'developer', 'WR-01'),
  },
  developerExpansionReplaceTest: {
    run: removedBridgeContract('developerExpansionReplaceTest.run', 'developer', 'WR-01'),
  },
  file: {
    selectDuplicateCheckFiles: removedBridgeContract('file.selectDuplicateCheckFiles', 'workflow', 'WR-01'),
  },
  knowledgeBase: {
    getMigrationStatus: removedBridgeContract('knowledgeBase.getMigrationStatus', 'knowledge', 'WR-01'),
    migrateLegacy: removedBridgeContract('knowledgeBase.migrateLegacy', 'knowledge', 'WR-01'),
    list: removedBridgeContract('knowledgeBase.list', 'knowledge', 'WR-01'),
    createFolder: removedBridgeContract('knowledgeBase.createFolder', 'knowledge', 'WR-01'),
    renameFolder: removedBridgeContract('knowledgeBase.renameFolder', 'knowledge', 'WR-01'),
    reorderFolder: removedBridgeContract('knowledgeBase.reorderFolder', 'knowledge', 'WR-01'),
    deleteFolder: removedBridgeContract('knowledgeBase.deleteFolder', 'knowledge', 'WR-01'),
    deleteDocument: removedBridgeContract('knowledgeBase.deleteDocument', 'knowledge', 'WR-01'),
    moveDocument: removedBridgeContract('knowledgeBase.moveDocument', 'knowledge', 'WR-01'),
    uploadDocuments: removedBridgeContract('knowledgeBase.uploadDocuments', 'knowledge', 'WR-01'),
    retryDocument: removedBridgeContract('knowledgeBase.retryDocument', 'knowledge', 'WR-01'),
    startMatching: removedBridgeContract('knowledgeBase.startMatching', 'knowledge', 'WR-01'),
    readMarkdown: removedBridgeContract('knowledgeBase.readMarkdown', 'knowledge', 'WR-01'),
    readItems: removedBridgeContract('knowledgeBase.readItems', 'knowledge', 'WR-01'),
    readAnalysis: removedBridgeContract('knowledgeBase.readAnalysis', 'knowledge', 'WR-01'),
  },
  technicalPlan: {
    loadState: implementedBridgeContract({
      owner: 'technical-plan',
      workPackage: 'WP-A',
      contractRef: 'technicalPlan.loadState',
      input: [],
      output: 'TechnicalPlanState',
    }),
    importTenderDocument: implementedBridgeContract({ owner: 'technical-plan', workPackage: 'WP-D', contractRef: 'technicalPlan.importTenderDocument', input: [contractArg('fileIds', 'string[]', { required: false })], output: 'TechnicalPlanImportResult' }),
    importOriginalPlanDocument: implementedBridgeContract({ owner: 'technical-plan', workPackage: 'WP-D', contractRef: 'technicalPlan.importOriginalPlanDocument', input: [contractArg('fileIds', 'string[]', { required: false })], output: 'TechnicalPlanImportResult' }),
    checkBidSections: removedBridgeContract('technicalPlan.checkBidSections', 'technical-plan', 'WR-01'),
    selectBidSection: removedBridgeContract('technicalPlan.selectBidSection', 'technical-plan', 'WR-01'),
    readTenderMarkdown: implementedBridgeContract({
      owner: 'technical-plan',
      workPackage: 'WP-A',
      contractRef: 'technicalPlan.readTenderMarkdown',
      input: [],
      output: 'string',
    }),
    readTenderSourceMarkdown: implementedBridgeContract({
      owner: 'technical-plan',
      workPackage: 'WP-A',
      contractRef: 'technicalPlan.readTenderSourceMarkdown',
      input: [contractArg('sourceId', 'string')],
      output: 'string',
    }),
    readOriginalPlanMarkdown: implementedBridgeContract({
      owner: 'technical-plan',
      workPackage: 'WP-A',
      contractRef: 'technicalPlan.readOriginalPlanMarkdown',
      input: [],
      output: 'string',
    }),
    updateStep: implementedBridgeContract({
      owner: 'technical-plan',
      workPackage: 'WP-A',
      contractRef: 'technicalPlan.updateStep',
      input: [contractArg('step', 'TechnicalPlanStep', { enum: contractEnums.TechnicalPlanStep })],
      output: 'TechnicalPlanState',
    }),
    setWorkflowKind: implementedBridgeContract({
      owner: 'technical-plan',
      workPackage: 'WP-A',
      contractRef: 'technicalPlan.setWorkflowKind',
      input: [contractArg('workflowKind', 'TechnicalPlanWorkflowKind', { enum: contractEnums.TechnicalPlanWorkflowKind })],
      output: 'TechnicalPlanState',
    }),
    switchWorkflowKind: implementedBridgeContract({
      owner: 'technical-plan',
      workPackage: 'WP-A',
      contractRef: 'technicalPlan.switchWorkflowKind',
      input: [contractArg('workflowKind', 'TechnicalPlanWorkflowKind', { enum: contractEnums.TechnicalPlanWorkflowKind })],
      output: 'TechnicalPlanState',
    }),
    saveBidAnalysisConfig: implementedBridgeContract({
      owner: 'technical-plan',
      workPackage: 'WP-A',
      contractRef: 'technicalPlan.saveBidAnalysisConfig',
      input: [contractArg('payload', '{ mode: BidAnalysisMode; selectedTaskIds: string[]; bidSectionMode?: BidSectionMode }', {
        properties: {
          mode: { type: 'BidAnalysisMode', required: true, enum: contractEnums.BidAnalysisMode },
          selectedTaskIds: { type: 'string[]', required: true },
          bidSectionMode: { type: 'BidSectionMode', required: false, enum: contractEnums.BidSectionMode },
        },
      })],
      output: 'TechnicalPlanState',
    }),
    saveOutlineConfig: implementedBridgeContract({
      owner: 'technical-plan',
      workPackage: 'WP-A',
      contractRef: 'technicalPlan.saveOutlineConfig',
      input: [contractArg('payload', '{ referenceKnowledgeDocumentIds: string[]; outlineExpansionMode?: OutlineExpansionMode; wordControlOptions: OutlineWordControlOptions }', {
        properties: {
          referenceKnowledgeDocumentIds: { type: 'string[]', required: true },
          outlineExpansionMode: { type: 'OutlineExpansionMode', required: false, enum: contractEnums.OutlineExpansionMode },
          wordControlOptions: { type: 'OutlineWordControlOptions', required: true },
        },
      })],
      output: 'TechnicalPlanState',
    }),
    saveOutline: implementedBridgeContract({
      owner: 'technical-plan',
      workPackage: 'WP-A',
      contractRef: 'technicalPlan.saveOutline',
      input: [contractArg('payload', 'SaveOutlineRequest')],
      output: 'TechnicalPlanState',
    }),
    saveGlobalFacts: implementedBridgeContract({
      owner: 'technical-plan',
      workPackage: 'WP-A',
      contractRef: 'technicalPlan.saveGlobalFacts',
      input: [contractArg('globalFacts', 'GlobalFactGroupState[]')],
      output: 'TechnicalPlanState',
    }),
    saveContentGenerationOptions: implementedBridgeContract({
      owner: 'technical-plan',
      workPackage: 'WP-A',
      contractRef: 'technicalPlan.saveContentGenerationOptions',
      input: [contractArg('options', 'ContentGenerationOptions')],
      output: 'TechnicalPlanState',
    }),
    saveChapterContent: implementedBridgeContract({
      owner: 'technical-plan',
      workPackage: 'WP-A',
      contractRef: 'technicalPlan.saveChapterContent',
      input: [contractArg('payload', '{ nodeId: string; content: string }', {
        properties: {
          nodeId: { type: 'string', required: true },
          content: { type: 'string', required: true },
        },
      })],
      output: 'TechnicalPlanState',
    }),
    clear: implementedBridgeContract({
      owner: 'technical-plan',
      workPackage: 'WP-A',
      contractRef: 'technicalPlan.clear',
      input: [],
      output: '{ success: boolean; message?: string; state: TechnicalPlanState }',
    }),
  },
  duplicateCheck: {
    loadState: removedBridgeContract('duplicateCheck.loadState', 'workflow', 'WR-01'),
    saveFiles: removedBridgeContract('duplicateCheck.saveFiles', 'workflow', 'WR-01'),
    saveUiState: removedBridgeContract('duplicateCheck.saveUiState', 'workflow', 'WR-01'),
    updateState: removedBridgeContract('duplicateCheck.updateState', 'workflow', 'WR-01'),
    clear: removedBridgeContract('duplicateCheck.clear', 'workflow', 'WR-01'),
  },
  rejectionCheck: {
    loadState: removedBridgeContract('rejectionCheck.loadState', 'workflow', 'WR-01'),
    importDocument: removedBridgeContract('rejectionCheck.importDocument', 'workflow', 'WR-01'),
    importTenderFromTechnicalPlan: removedBridgeContract('rejectionCheck.importTenderFromTechnicalPlan', 'workflow', 'WR-01'),
    removeDocument: removedBridgeContract('rejectionCheck.removeDocument', 'workflow', 'WR-01'),
    saveUiState: removedBridgeContract('rejectionCheck.saveUiState', 'workflow', 'WR-01'),
    updateState: removedBridgeContract('rejectionCheck.updateState', 'workflow', 'WR-01'),
    clear: removedBridgeContract('rejectionCheck.clear', 'workflow', 'WR-01'),
  },
  templates: {
    list: implementedBridgeContract({
      owner: 'workflow',
      workPackage: 'WP-A',
      contractRef: 'templates.list',
      input: [],
      output: 'ExportTemplateRecord[]',
    }),
    get: implementedBridgeContract({
      owner: 'workflow',
      workPackage: 'WP-A',
      contractRef: 'templates.get',
      input: [contractArg('templateId', 'string')],
      output: 'ExportTemplateRecord | null',
    }),
    create: implementedBridgeContract({
      owner: 'workflow',
      workPackage: 'WP-A',
      contractRef: 'templates.create',
      input: [contractArg('config', 'ExportFormatConfig')],
      output: 'ExportTemplateRecord',
    }),
    update: implementedBridgeContract({
      owner: 'workflow',
      workPackage: 'WP-A',
      contractRef: 'templates.update',
      input: [
        contractArg('templateId', 'string'),
        contractArg('config', 'ExportFormatConfig'),
      ],
      output: 'ExportTemplateRecord',
    }),
    delete: implementedBridgeContract({
      owner: 'workflow',
      workPackage: 'WP-A',
      contractRef: 'templates.delete',
      input: [contractArg('templateId', 'string')],
      output: '{ success: boolean; message: string }',
    }),
  },
  tasks: {
    startBidSectionExtraction: removedBridgeContract('tasks.startBidSectionExtraction', 'workflow', 'WR-01'),
    startBidAnalysis: implementedBridgeContract({
      owner: 'workflow',
      workPackage: 'WP-I',
      contractRef: 'tasks.startBidAnalysis',
      input: [contractArg('payload', 'StartBidAnalysisInput', {
        properties: {
          mode: { type: 'BidAnalysisMode', required: true, enum: contractEnums.BidAnalysisMode },
          selected_task_ids: { type: 'string[]', required: true },
          task_ids: { type: 'string[]', required: false },
          force_rerun: { type: 'boolean', required: false },
        },
      })],
      output: 'BackgroundTaskState',
      errors: ['TASK_INVALID_INPUT', 'TASK_ITEM_NOT_FOUND', 'TASK_INPUT_CHANGED', 'TASK_CONFLICT'],
    }),
    startOutlineGeneration: pendingContract('tasks.startOutlineGeneration', 'workflow', 'WR-03'),
    startGlobalFactsGeneration: pendingContract('tasks.startGlobalFactsGeneration', 'workflow', 'WR-03'),
    startContentGeneration: pendingContract('tasks.startContentGeneration', 'workflow', 'WR-03'),
    pauseContentGeneration: pendingContract('tasks.pauseContentGeneration', 'workflow', 'WR-03'),
    startRejectionItemsExtraction: removedBridgeContract('tasks.startRejectionItemsExtraction', 'workflow', 'WR-01'),
    startRejectionCheck: removedBridgeContract('tasks.startRejectionCheck', 'workflow', 'WR-01'),
    startDuplicateAnalysis: removedBridgeContract('tasks.startDuplicateAnalysis', 'workflow', 'WR-01'),
    getActiveTasks: implementedBridgeContract({
      owner: 'workflow',
      workPackage: 'WP-A',
      contractRef: 'tasks.getActiveTasks',
      input: [],
      output: 'unknown[]',
    }),
  },
  export: {
    exportWord: implementedBridgeContract({ owner: 'export', workPackage: 'WP-F', contractRef: 'export.exportWord', input: [contractArg('payload', 'unknown')], output: 'WordExportResult' }),
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
    list: pendingContract('systemFonts.list', 'web-shell', 'WR-05'),
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
  version: 'wp-a-contract-manifest-v2',
  enums: contractEnums,
  methods: Object.freeze(methods),
};