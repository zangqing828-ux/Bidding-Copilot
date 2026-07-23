// POST /api/bridge：统一业务 API 入口。
// Sprint 02 阶段所有业务调用统一返回 501 WEB_CAPABILITY_PENDING，
// 不返回伪造成功结果。后续 Sprint 逐步在此路由分发真实业务。
const express = require('express');

const router = express.Router();

router.post('/bridge', (req, res) => {
  const { namespace, method } = req.body || {};

  res.status(501).json({
    code: 'WEB_CAPABILITY_PENDING',
    message: `该功能尚未在 Web 端提供：${namespace ? `${namespace}.${method || ''}` : '未知接口'}`,
  });
});

module.exports = router;
