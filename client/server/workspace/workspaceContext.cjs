// Workspace 上下文：每账号独立的 db、stores 和 configStore。
// 由 workspaceRegistry 按需创建并缓存。
const path = require('node:path');
const fs = require('node:fs');
const { createSqliteDatabase } = require('../../core/sqliteDatabase.cjs');
const { createTechnicalPlanStore } = require('../../electron/services/technicalPlanStore.cjs');
const { createKnowledgeBaseStore } = require('../../electron/services/knowledgeBaseStore.cjs');
const { createDuplicateCheckStore } = require('../../electron/services/duplicateCheckStore.cjs');
const { createRejectionCheckStore } = require('../../electron/services/rejectionCheckStore.cjs');
const { createTemplateStore } = require('../../core/templateStore.cjs');
const { createTaskService } = require('../../electron/services/taskService.cjs');
const { resolveWorkspacePaths } = require('../../core/workspacePaths.cjs');
const { createEncryptedConfigStore } = require('../config/encryptedConfigStore.cjs');
const {
  createWebAiServiceStub,
  createWebAgentServiceStub,
  createWebKnowledgeBaseServiceStub,
  createWebDuplicateCheckServiceStub,
} = require('./webServices.cjs');

function createWorkspaceContext({ workspaceId, dataDir }) {
  const workspaceRoot = path.join(dataDir, 'users', workspaceId, 'workspace');
  const userDir = path.join(dataDir, 'users', workspaceId);
  const paths = resolveWorkspacePaths(workspaceRoot);

  // 创建目录
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(paths.uploadsDir, { recursive: true });

  // 初始化 SQLite（复用 Electron 的 migration 逻辑，不传 app）
  const sqliteDatabase = createSqliteDatabase({ databasePath: paths.databasePath });
  let agentService;

  try {
    // 初始化加密配置
    const configStore = createEncryptedConfigStore({
      configPath: path.join(userDir, 'config.enc.json'),
    });

    // 初始化 Stores（传 workspaceRoot，不传 app）
    const technicalPlanStore = createTechnicalPlanStore({ db: sqliteDatabase.db, workspaceRoot });
    const knowledgeBaseStore = createKnowledgeBaseStore({ db: sqliteDatabase.db, workspaceRoot });
    const duplicateCheckStore = createDuplicateCheckStore({ db: sqliteDatabase.db, workspaceRoot });
    const rejectionCheckStore = createRejectionCheckStore({ db: sqliteDatabase.db, workspaceRoot, technicalPlanStore });
    const templateStore = createTemplateStore({ db: sqliteDatabase.db });

    // 初始化 Web 端占位服务（真实 AI/Agent 留到后续 Sprint）
    const aiService = createWebAiServiceStub();
    agentService = createWebAgentServiceStub();
    const knowledgeBaseService = createWebKnowledgeBaseServiceStub({ knowledgeBaseStore });
    const duplicateCheckService = createWebDuplicateCheckServiceStub({ duplicateCheckStore });

    // 初始化 taskService（复用 Electron 逻辑，per-workspace 独立实例）
    const taskService = createTaskService({
      aiService,
      agentService,
      technicalPlanStore,
      rejectionCheckStore,
      duplicateCheckStore,
      knowledgeBaseService,
      duplicateCheckService,
    });

    return {
      workspaceId,
      workspaceRoot,
      paths,
      db: sqliteDatabase.db,
      sqliteDatabase,
      configStore,
      taskService,
      stores: {
        technicalPlanStore,
        knowledgeBaseStore,
        duplicateCheckStore,
        rejectionCheckStore,
        templateStore,
      },
      close() {
        agentService.close?.();
        sqliteDatabase.close();
      },
    };
  } catch (error) {
    try {
      agentService?.close?.();
    } catch {
      // 保留装配阶段的原始异常。
    }
    try {
      sqliteDatabase.close();
    } catch {
      // 保留装配阶段的原始异常。
    }
    throw error;
  }
}

module.exports = { createWorkspaceContext };
