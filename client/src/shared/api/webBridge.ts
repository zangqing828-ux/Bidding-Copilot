// Web Bridge：在浏览器中实现与 Electron preload 等价的 YibiaoBridge 门面。
// 除 openExternal 浏览器降级外，其余能力走 /api/bridge；事件能力按已知状态直接报错或返回 SSE 退订句柄。
import type { YibiaoBridge } from '../types/ipc';
import { httpClient } from './httpClient';

type ErrorWithCode = Error & { code?: string };

function createWebBridgeError(code: string, message: string): ErrorWithCode {
  const error: ErrorWithCode = new Error(message);
  error.code = code;
  return error;
}

function throwWebBridgeError(code: string, message: string) {
  return () => {
    throw createWebBridgeError(code, message);
  };
}

function throwWebBridgeEventError(code: string, message: string) {
  return () => {
    throw createWebBridgeError(code, message);
  };
}

function bridgeMethod(namespace: string, method: string) {
  return (...args: unknown[]) => httpClient.invoke(namespace, method, args);
}

export const webBridge = {
  appName: '易标投标工具箱',
  platform: 'web',
  getVersion: bridgeMethod('app', 'getVersion'),
  getGpuHardwareAccelerationStatus: bridgeMethod('app', 'getGpuHardwareAccelerationStatus'),
  saveGpuHardwareAccelerationPreference: bridgeMethod('app', 'saveGpuHardwareAccelerationPreference'),
  startGpuHardwareAccelerationTrial: bridgeMethod('app', 'startGpuHardwareAccelerationTrial'),
  relaunchWithGpuHardwareAccelerationDisabled: bridgeMethod('app', 'relaunchWithGpuHardwareAccelerationDisabled'),
  requiredOnlineServices: {
    getStatus: bridgeMethod('requiredOnlineServices', 'getStatus'),
  },
  getLatestVersion: bridgeMethod('app', 'getLatestVersion'),
  getUpdateDownloadUrl: bridgeMethod('app', 'getUpdateDownloadUrl'),
  openExternal: async (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
    return { success: true };
  },
  checkUpdate: bridgeMethod('app', 'checkUpdate'),
  startUpdate: bridgeMethod('app', 'startUpdate'),
  quitAndInstall: bridgeMethod('app', 'quitAndInstall'),
  onUpdateProgress: throwWebBridgeEventError('WEB_BRIDGE_DESKTOP_ONLY', '更新进度事件仅桌面端可用'),
  onUpdateDownloaded: throwWebBridgeEventError('WEB_BRIDGE_DESKTOP_ONLY', '更新下载完成事件仅桌面端可用'),
  onUpdateError: throwWebBridgeEventError('WEB_BRIDGE_DESKTOP_ONLY', '更新错误事件仅桌面端可用'),
  database: {
    getStatus: throwWebBridgeError('WEB_BRIDGE_REMOVED', '桌面数据库能力已下线'),
    onStatus: throwWebBridgeEventError('WEB_BRIDGE_REMOVED', '桌面数据库能力已下线'),
  },
  config: {
    load: bridgeMethod('config', 'load'),
    save: bridgeMethod('config', 'save'),
    listModels: bridgeMethod('config', 'listModels'),
    openConfigFolder: bridgeMethod('config', 'openConfigFolder'),
  },
  license: {
    getStatus: bridgeMethod('license', 'getStatus'),
    refresh: bridgeMethod('license', 'refresh'),
    importOfflineFile: bridgeMethod('license', 'importOfflineFile'),
    activateOfflineCode: bridgeMethod('license', 'activateOfflineCode'),
  },
  ai: {
    chat: bridgeMethod('ai', 'chat'),
    requestJson: bridgeMethod('ai', 'requestJson'),
    testImageModel: bridgeMethod('ai', 'testImageModel'),
    onHttpError: throwWebBridgeEventError('WEB_BRIDGE_REMOVED', 'AI HTTP 错误事件已下线'),
  },
  agent: {
    listRuntimes: bridgeMethod('agent', 'listRuntimes'),
    run: bridgeMethod('agent', 'run'),
    selfCheck: bridgeMethod('agent', 'selfCheck'),
    exportSelfCheckReport: bridgeMethod('agent', 'exportSelfCheckReport'),
    getStatus: bridgeMethod('agent', 'getStatus'),
    restart: bridgeMethod('agent', 'restart'),
    onStatus: throwWebBridgeEventError('WEB_BRIDGE_REMOVED', 'Agent 状态事件已下线'),
  },
  developerTokenStats: {
    openWindow: bridgeMethod('developerTokenStats', 'openWindow'),
    get: bridgeMethod('developerTokenStats', 'get'),
    reset: bridgeMethod('developerTokenStats', 'reset'),
    onChanged: throwWebBridgeEventError('WEB_BRIDGE_REMOVED', '开发者 Token 统计事件已下线'),
  },
  developerExpansionReplaceTest: {
    run: bridgeMethod('developerExpansionReplaceTest', 'run'),
  },
  file: {
    selectDuplicateCheckFiles: bridgeMethod('file', 'selectDuplicateCheckFiles'),
  },
  knowledgeBase: {
    getMigrationStatus: bridgeMethod('knowledgeBase', 'getMigrationStatus'),
    migrateLegacy: bridgeMethod('knowledgeBase', 'migrateLegacy'),
    list: bridgeMethod('knowledgeBase', 'list'),
    createFolder: bridgeMethod('knowledgeBase', 'createFolder'),
    renameFolder: bridgeMethod('knowledgeBase', 'renameFolder'),
    reorderFolder: bridgeMethod('knowledgeBase', 'reorderFolder'),
    deleteFolder: bridgeMethod('knowledgeBase', 'deleteFolder'),
    deleteDocument: bridgeMethod('knowledgeBase', 'deleteDocument'),
    moveDocument: bridgeMethod('knowledgeBase', 'moveDocument'),
    uploadDocuments: bridgeMethod('knowledgeBase', 'uploadDocuments'),
    retryDocument: bridgeMethod('knowledgeBase', 'retryDocument'),
    startMatching: bridgeMethod('knowledgeBase', 'startMatching'),
    readMarkdown: bridgeMethod('knowledgeBase', 'readMarkdown'),
    readItems: bridgeMethod('knowledgeBase', 'readItems'),
    readAnalysis: bridgeMethod('knowledgeBase', 'readAnalysis'),
    onEvent: throwWebBridgeEventError('WEB_BRIDGE_REMOVED', '知识库增量事件已下线'),
  },
  technicalPlan: {
    loadState: bridgeMethod('technicalPlan', 'loadState'),
    importTenderDocument: bridgeMethod('technicalPlan', 'importTenderDocument'),
    importOriginalPlanDocument: bridgeMethod('technicalPlan', 'importOriginalPlanDocument'),
    checkBidSections: bridgeMethod('technicalPlan', 'checkBidSections'),
    selectBidSection: bridgeMethod('technicalPlan', 'selectBidSection'),
    readTenderMarkdown: bridgeMethod('technicalPlan', 'readTenderMarkdown'),
    readTenderSourceMarkdown: bridgeMethod('technicalPlan', 'readTenderSourceMarkdown'),
    readOriginalPlanMarkdown: bridgeMethod('technicalPlan', 'readOriginalPlanMarkdown'),
    updateStep: bridgeMethod('technicalPlan', 'updateStep'),
    setWorkflowKind: bridgeMethod('technicalPlan', 'setWorkflowKind'),
    switchWorkflowKind: bridgeMethod('technicalPlan', 'switchWorkflowKind'),
    saveBidAnalysisConfig: bridgeMethod('technicalPlan', 'saveBidAnalysisConfig'),
    saveOutlineConfig: bridgeMethod('technicalPlan', 'saveOutlineConfig'),
    saveOutline: bridgeMethod('technicalPlan', 'saveOutline'),
    saveGlobalFacts: bridgeMethod('technicalPlan', 'saveGlobalFacts'),
    saveContentGenerationOptions: bridgeMethod('technicalPlan', 'saveContentGenerationOptions'),
    saveChapterContent: bridgeMethod('technicalPlan', 'saveChapterContent'),
    clear: bridgeMethod('technicalPlan', 'clear'),
  },
  duplicateCheck: {
    loadState: bridgeMethod('duplicateCheck', 'loadState'),
    saveFiles: bridgeMethod('duplicateCheck', 'saveFiles'),
    saveUiState: bridgeMethod('duplicateCheck', 'saveUiState'),
    updateState: bridgeMethod('duplicateCheck', 'updateState'),
    clear: bridgeMethod('duplicateCheck', 'clear'),
  },
  rejectionCheck: {
    loadState: bridgeMethod('rejectionCheck', 'loadState'),
    importDocument: bridgeMethod('rejectionCheck', 'importDocument'),
    importTenderFromTechnicalPlan: bridgeMethod('rejectionCheck', 'importTenderFromTechnicalPlan'),
    removeDocument: bridgeMethod('rejectionCheck', 'removeDocument'),
    saveUiState: bridgeMethod('rejectionCheck', 'saveUiState'),
    updateState: bridgeMethod('rejectionCheck', 'updateState'),
    clear: bridgeMethod('rejectionCheck', 'clear'),
  },
  templates: {
    list: bridgeMethod('templates', 'list'),
    get: bridgeMethod('templates', 'get'),
    create: bridgeMethod('templates', 'create'),
    update: bridgeMethod('templates', 'update'),
    delete: bridgeMethod('templates', 'delete'),
  },
  tasks: {
    startBidSectionExtraction: bridgeMethod('tasks', 'startBidSectionExtraction'),
    startBidAnalysis: bridgeMethod('tasks', 'startBidAnalysis'),
    startOutlineGeneration: bridgeMethod('tasks', 'startOutlineGeneration'),
    startGlobalFactsGeneration: bridgeMethod('tasks', 'startGlobalFactsGeneration'),
    startContentGeneration: bridgeMethod('tasks', 'startContentGeneration'),
    pauseContentGeneration: bridgeMethod('tasks', 'pauseContentGeneration'),
    startRejectionItemsExtraction: bridgeMethod('tasks', 'startRejectionItemsExtraction'),
    startRejectionCheck: bridgeMethod('tasks', 'startRejectionCheck'),
    startDuplicateAnalysis: bridgeMethod('tasks', 'startDuplicateAnalysis'),
    getActiveTasks: bridgeMethod('tasks', 'getActiveTasks'),
    onTaskEvent: <TState = unknown, TRejectionCheckState = unknown, TDuplicateCheckState = unknown>(
      callback: (event: { task: unknown; technicalPlanPatch?: Partial<TState>; rejectionCheck?: TRejectionCheckState; duplicateCheck?: TDuplicateCheckState; bidItem?: unknown; outlineData?: unknown; contentSection?: unknown; contentPlan?: unknown; contentRuntime?: unknown }) => void
    ): (() => void) => {
      const eventSource = new EventSource('/api/tasks/events');
      eventSource.onmessage = (messageEvent) => {
        try {
          const event = JSON.parse(messageEvent.data);
          callback(event);
        } catch {
          // 忽略解析错误
        }
      };
      eventSource.onerror = () => {
        // 依赖浏览器自动重连
      };
      return () => {
        eventSource.close();
      };
    },
  },
  export: {
    exportWord: bridgeMethod('export', 'exportWord'),
    openFile: bridgeMethod('export', 'openFile'),
    onWordExportProgress: throwWebBridgeEventError('WEB_BRIDGE_REMOVED', '导出进度事件已下线'),
  },
  systemFonts: {
    list: bridgeMethod('systemFonts', 'list'),
  },
} as YibiaoBridge;