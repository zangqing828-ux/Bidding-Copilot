// requireAuth 中间件：校验会话，注入 req.account 和 req.sessionId。
const { getSession, SESSION_COOKIE_NAME } = require('../auth/sessionStore.cjs');
const { getAccountById } = require('../auth/accountStore.cjs');

function requireAuth(req, res, next) {
  const sessionId = req.cookies?.[SESSION_COOKIE_NAME];
  const session = getSession(sessionId);

  if (!session) {
    return res.status(401).json({ code: 'UNAUTHORIZED', message: '未登录或会话已过期' });
  }

  const account = getAccountById(session.accountId);
  if (!account) {
    return res.status(401).json({ code: 'UNAUTHORIZED', message: '账号不存在' });
  }

  req.sessionId = session.sessionId;
  req.account = account;
  req.tenantId = account.workspaceId;
  req.workspaceId = account.workspaceId;
  next();
}

module.exports = { requireAuth };
