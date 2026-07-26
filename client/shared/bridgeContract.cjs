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
    getMigrationStatus: implementedBridgeContract({
      owner: 'knowledge',
      workPackage: 'WP-A',
      contractRef: 'knowledgeBase.getMigrationStatus',
      input: [],
      output: 'KnowledgeBaseMigrationStatus',
      errors: ['KNOWLEDGE_PATH_OUTSIDE_WORKSPACE'],
    }),
    migrateLegacy: implementedBridgeContract({
      owner: 'knowledge',
      workPackage: 'WP-A',
      contractRef: 'knowledgeBase.migrateLegacy',
      input: [],
      output: 'KnowledgeBaseMigrationResult',
      errors: ['KNOWLEDGE_PATH_OUTSIDE_WORKSPACE'],
    }),
    list: createContractEntry({ status: 'pending', owner: 'knowledge', workPackage: 'WP-C', contractRef: 'knowledgeBase.list' }),
    createFolder: createContractEntry({ status: 'pending', owner: 'knowledge', workPackage: 'WP-C', contractRef: 'knowledgeBase.createFolder' }),
    renameFolder: implementedBridgeContract({
      owner: 'knowledge',
      workPackage: 'WP-A',
      contractRef: 'knowledgeBase.renameFolder',
      input: [
        contractArg('folderId', 'string'),
        contractArg('name', 'string'),
      ],
      output: 'KnowledgeFolder',
    }),
    reorderFolder: createContractEntry({ status: 'pending', owner: 'knowledge', workPackage: 'WP-C', contractRef: 'knowledgeBase.reorderFolder' }),
    deleteFolder: createContractEntry({ status: 'pending', owner: 'knowledge', workPackage: 'WP-C', contractRef: 'knowledgeBase.deleteFolder' }),
    deleteDocument: createContractEntry({ status: 'pending', owner: 'knowledge', workPackage: 'WP-C', contractRef: 'knowledgeBase.deleteDocument' }),
    moveDocument: createContractEntry({ status: 'pending', owner: 'knowledge', workPackage: 'WP-C', contractRef: 'knowledgeBase.moveDocument' }),
    uploadDocuments: createContractEntry({ status: 'pending', owner: 'knowledge', workPackage: 'WP-D', contractRef: 'knowledgeBase.uploadDocuments' }),
    retryDocument: createContractEntry({ status: 'pending', owner: 'knowledge', workPackage: 'WP-C', contractRef: 'knowledgeBase.retryDocument' }),
    startMatching: createContractEntry({ status: 'pending', owner: 'knowledge', workPackage: 'WP-C', contractRef: 'knowledgeBase.startMatching' }),
    readMarkdown: implementedBridgeContract({
      owner: 'knowledge',
      workPackage: 'WP-A',
      contractRef: 'knowledgeBase.readMarkdown',
      input: [contractArg('documentId', 'string')],
      output: 'string',
      errors: ['KNOWLEDGE_PATH_OUTSIDE_WORKSPACE'],
    }),
    readItems: implementedBridgeContract({
      owner: 'knowledge',
      workPackage: 'WP-A',
      contractRef: 'knowledgeBase.readItems',
      input: [contractArg('documentId', 'string')],
      output: 'KnowledgeItem[]',
    }),
    readAnalysis: implementedBridgeContract({
      owner: 'knowledge',
      workPackage: 'WP-A',
      contractRef: 'knowledgeBase.readAnalysis',
      input: [contractArg('documentId', 'string')],
      output: 'KnowledgeAnalysisSnapshot',
      errors: ['KNOWLEDGE_PATH_OUTSIDE_WORKSPACE'],
    }),
  },
  technicalPlan: {
    loadState: implementedBridgeContract({
      owner: 'technical-plan',
      workPackage: 'WP-A',
      contractRef: 'technicalPlan.loadState',
      input: [],
      output: 'TechnicalPlanState',
    }),
    importTenderDocument: createContractEntry({ status: 'pending', owner: 'technical-plan', workPackage: 'WP-D', contractRef: 'technicalPlan.importTenderDocument' }),
    importOriginalPlanDocument: createContractEntry({ status: 'pending', owner: 'technical-plan', workPackage: 'WP-D', contractRef: 'technicalPlan.importOriginalPlanDocument' }),
    checkBidSections: implementedBridgeContract({
      owner: 'technical-plan',
      workPackage: 'WP-A',
      contractRef: 'technicalPlan.checkBidSections',
      input: [],
      output: '{ hasMultiple: boolean; totalDeclared?: number | null }',
    }),
    selectBidSection: implementedBridgeContract({
      owner: 'technical-plan',
      workPackage: 'WP-A',
      contractRef: 'technicalPlan.selectBidSection',
      input: [contractArg('selectedSection', 'DetectedBidSection')],
      output: '{ success: boolean; message?: string; state: TechnicalPlanState; markdown: string }',
    }),
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
    loadState: implementedBridgeContract({
      owner: 'workflow',
      workPackage: 'WP-A',
      contractRef: 'duplicateCheck.loadState',
      input: [],
      output: 'DuplicateCheckWorkspaceState',
    }),
    saveFiles: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-D', contractRef: 'duplicateCheck.saveFiles' }),
    saveUiState: implementedBridgeContract({
      owner: 'workflow',
      workPackage: 'WP-A',
      contractRef: 'duplicateCheck.saveUiState',
      input: [contractArg('payload', 'Partial<Pick<DuplicateCheckWorkspaceState, "step" | "activeAnalysisTab">>')],
      output: 'DuplicateCheckWorkspaceState',
    }),
    updateState: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-D', contractRef: 'duplicateCheck.updateState' }),
    clear: implementedBridgeContract({
      owner: 'workflow',
      workPackage: 'WP-A',
      contractRef: 'duplicateCheck.clear',
      input: [],
      output: '{ success: boolean; message?: string; state: DuplicateCheckWorkspaceState }',
    }),
  },
  rejectionCheck: {
    loadState: implementedBridgeContract({
      owner: 'workflow',
      workPackage: 'WP-A',
      contractRef: 'rejectionCheck.loadState',
      input: [],
      output: 'RejectionCheckWorkspaceState',
    }),
    importDocument: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-D', contractRef: 'rejectionCheck.importDocument' }),
    importTenderFromTechnicalPlan: implementedBridgeContract({
      owner: 'workflow',
      workPackage: 'WP-A',
      contractRef: 'rejectionCheck.importTenderFromTechnicalPlan',
      input: [],
      output: '{ success: boolean; message?: string; state: RejectionCheckWorkspaceState }',
    }),
    removeDocument: implementedBridgeContract({
      owner: 'workflow',
      workPackage: 'WP-A',
      contractRef: 'rejectionCheck.removeDocument',
      input: [
        contractArg('role', 'RejectionDocumentRole', { enum: contractEnums.RejectionDocumentRole }),
        contractArg('documentId', 'string', { required: false }),
      ],
      output: 'RejectionCheckWorkspaceState',
    }),
    saveUiState: implementedBridgeContract({
      owner: 'workflow',
      workPackage: 'WP-A',
      contractRef: 'rejectionCheck.saveUiState',
      input: [contractArg('payload', 'Partial<Pick<RejectionCheckWorkspaceState, "step" | "activeDocumentTab" | "activeResultTab" | "activeCheckResultTab" | "customCheckItems" | "checkOptions">>')],
      output: 'RejectionCheckWorkspaceState',
    }),
    updateState: implementedBridgeContract({
      owner: 'workflow',
      workPackage: 'WP-A',
      contractRef: 'rejectionCheck.updateState',
      input: [contractArg('partial', 'Partial<Pick<RejectionCheckWorkspaceState, "rejectionCheckResult" | "typoCheckResult" | "logicCheckResult">>')],
      output: 'RejectionCheckWorkspaceState',
    }),
    clear: implementedBridgeContract({
      owner: 'workflow',
      workPackage: 'WP-A',
      contractRef: 'rejectionCheck.clear',
      input: [],
      output: '{ success: boolean; message?: string; state: RejectionCheckWorkspaceState }',
    }),
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
    startBidSectionExtraction: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-C', contractRef: 'tasks.startBidSectionExtraction' }),
    startBidAnalysis: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-C', contractRef: 'tasks.startBidAnalysis' }),
    startOutlineGeneration: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-C', contractRef: 'tasks.startOutlineGeneration' }),
    startGlobalFactsGeneration: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-C', contractRef: 'tasks.startGlobalFactsGeneration' }),
    startContentGeneration: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-C', contractRef: 'tasks.startContentGeneration' }),
    pauseContentGeneration: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-C', contractRef: 'tasks.pauseContentGeneration' }),
    startRejectionItemsExtraction: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-C', contractRef: 'tasks.startRejectionItemsExtraction' }),
    startRejectionCheck: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-C', contractRef: 'tasks.startRejectionCheck' }),
    startDuplicateAnalysis: createContractEntry({ status: 'pending', owner: 'workflow', workPackage: 'WP-C', contractRef: 'tasks.startDuplicateAnalysis' }),
    getActiveTasks: implementedBridgeContract({
      owner: 'workflow',
      workPackage: 'WP-A',
      contractRef: 'tasks.getActiveTasks',
      input: [],
      output: 'unknown[]',
    }),
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
  version: 'wp-a-contract-manifest-v2',
  enums: contractEnums,
  methods: Object.freeze(methods),
};
