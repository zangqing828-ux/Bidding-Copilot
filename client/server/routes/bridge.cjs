// POST /api/bridge：统一业务 API 入口。
// Sprint 04：实现 config 命名空间（加密配置读写），其他 namespace 仍返回 501。
const express = require('express');
const { getWorkspaceContext } = require('../workspace/workspaceRegistry.cjs');

const router = express.Router();

// 已实现的 namespace.method 分发器。
const dispatchers = {
  config: {
    load: (ctx, _args) => {
      return ctx.configStore.load();
    },
    save: (ctx, args) => {
      const [config] = args;
      return ctx.configStore.save(config);
    },
    listModels: () => {
      throw new Error('config.listModels 尚未在 Web 端实现');
    },
    openConfigFolder: () => {
      throw new Error('config.openConfigFolder 尚未在 Web 端实现');
    },
  },
};

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
    // 支持同步和 Promise 返回
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
