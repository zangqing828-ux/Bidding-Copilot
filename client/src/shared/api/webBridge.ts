// Web Bridge：在浏览器中实现与 Electron preload 等价的 YibiaoBridge 门面。
// Sprint 02 阶段：除 openExternal 浏览器降级外，所有业务调用统一走 /api/bridge
// 并由服务端返回 501 WEB_CAPABILITY_PENDING。订阅方法返回 no-op 取消函数，SSE 留到 Sprint 05。
import type { YibiaoBridge } from '../types/ipc';
import { httpClient } from './httpClient';

const noopUnsubscribe = () => {};

// 通用 invoke 包装：透传 namespace.method 调用，未实现的由服务端返回 501。
// 返回 Promise<unknown>；Sprint 02 所有调用最终走 501 reject，运行时不会返回不匹配类型的值。
// 对象用 as YibiaoBridge 断言，因为 httpClient.invoke 的返回类型无法从接口方法签名反向推断。
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
    // 浏览器降级：与 Sidebar 现有 fallback 一致。
    window.open(url, '_blank', 'noopener,noreferrer');
    return { success: true };
  },
  checkUpdate: bridgeMethod('app', 'checkUpdate'),
  startUpdate: bridgeMethod('app', 'startUpdate'),
  quitAndInstall: bridgeMethod('app', 'quitAndInstall'),
  onUpdateProgress: () => noopUnsubscribe,
  onUpdateDownloaded: () => noopUnsubscribe,
  onUpdateError: () => noopUnsubscribe,
  database: {
    // Web 端无本地数据库：直接返回就绪状态，WorkspaceDatabaseGate 放行进入工作台。
    getStatus: async () => ({ phase: 'ready', ready: true, message: '本地数据库已就绪', updatedAt: new Date().toISOString() }),
    onStatus: () => noopUnsubscribe,
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
    onHttpError: () => noopUnsubscribe,
  },
  agent: {
    listRuntimes: bridgeMethod('agent', 'listRuntimes'),
    run: bridgeMethod('agent', 'run'),
    selfCheck: bridgeMethod('agent', 'selfCheck'),
    exportSelfCheckReport: bridgeMethod('agent', 'exportSelfCheckReport'),
    getStatus: bridgeMethod('agent', 'getStatus'),
    restart: bridgeMethod('agent', 'restart'),
    onStatus: () => noopUnsubscribe,
  },
  developerTokenStats: {
    openWindow: bridgeMethod('developerTokenStats', 'openWindow'),
    get: bridgeMethod('developerTokenStats', 'get'),
    reset: bridgeMethod('developerTokenStats', 'reset'),
    onChanged: () => noopUnsubscribe,
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
    onEvent: () => noopUnsubscribe,
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
      // Web 环境：通过 SSE 订阅任务事件
      const eventSource = new EventSource('/api/tasks/events');
      eventSource.onmessage = (messageEvent) => {
        try {
          const event = JSON.parse(messageEvent.data);
          callback(event);
        } catch {
          // 忽略解析错误
        }
      };
      // EventSource error 时浏览器会自动重连（约 3s 间隔）。
      // 重连后 sse.cjs 的 subscribeCallback 会重放 activeTasks 快照，恢复语义成立。
      // 会话过期（401）时 EventSource 会持续重连，由调用方在卸载时 close() 终止。
      eventSource.onerror = () => {
        // 依赖浏览器自动重连，不做额外处理
      };
      return () => {
        eventSource.close();
      };
    },
  },
  export: {
    exportWord: bridgeMethod('export', 'exportWord'),
    openFile: bridgeMethod('export', 'openFile'),
    onWordExportProgress: () => noopUnsubscribe,
  },
  systemFonts: {
    list: bridgeMethod('systemFonts', 'list'),
  },
} as YibiaoBridge;
