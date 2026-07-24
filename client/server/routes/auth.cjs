// Auth 路由：OAuth 登录/回调/用户信息/退出，含 mock 模式。
const express = require('express');
const crypto = require('node:crypto');
const config = require('../config.cjs');
const oauthClient = require('../auth/oauthClient.cjs');
const { upsertAccount } = require('../auth/accountStore.cjs');
const { createSession, deleteSession, getSession, SESSION_COOKIE_NAME, cleanExpiredSessions } = require('../auth/sessionStore.cjs');

const router = express.Router();

// state Cookie 名称：用 HttpOnly Cookie 绑定发起登录的浏览器，防跨浏览器接管（RFC 9700）。
const STATE_COOKIE_NAME = 'yibiao_oauth_state';
const STATE_TTL_MS = 5 * 60 * 1000;

function createState() {
  return crypto.randomBytes(32).toString('hex');
}

function setStateCookie(res, state) {
  res.cookie(STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: config.isHttps,
    sameSite: 'lax',
    maxAge: STATE_TTL_MS,
    path: '/',
  });
}

function clearStateCookie(res) {
  res.clearCookie(STATE_COOKIE_NAME, { path: '/' });
}

function setSessionCookie(res, sessionId) {
  res.cookie(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: config.isHttps,
    sameSite: 'lax',
    maxAge: config.sessionTtlDays * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
}

// 启动时清理过期会话
cleanExpiredSessions();

// GET /api/auth/login — 生成 state（写入 HttpOnly Cookie），跳转 OAuth authorize。
router.get('/auth/login', (req, res) => {
  const state = createState();
  setStateCookie(res, state);
  const authorizeUrl = oauthClient.getAuthorizeUrl(state);
  res.redirect(authorizeUrl);
});

// GET /api/auth/callback — OAuth 回调：校验 state（Cookie + URL 双重匹配）、交换 code、建立会话。
router.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;

  // 不反射 error 参数，防止 XSS。返回固定文案。
  if (error) {
    clearStateCookie(res);
    return res.status(400).type('text').send('登录失败：授权服务返回错误，请重新登录');
  }

  // 双重校验：URL 参数和 Cookie 中的 state 必须一致且非空。
  const cookieState = req.cookies?.[STATE_COOKIE_NAME];
  if (!state || !cookieState || state !== cookieState) {
    clearStateCookie(res);
    return res.status(400).type('text').send('登录失败：state 校验失败，请重新登录');
  }

  clearStateCookie(res);

  if (!code) {
    return res.status(400).type('text').send('登录失败：未收到授权码');
  }

  try {
    const redirectUri = config.oauth.redirectUri;
    const { accessToken } = await oauthClient.exchangeCode(code, redirectUri);
    const userInfo = await oauthClient.getUserInfo(accessToken);

    const account = upsertAccount({
      mqSubject: userInfo.id,
      email: userInfo.email,
      name: userInfo.name,
      companyName: userInfo.companyName,
    });

    const { sessionId } = createSession(account);
    setSessionCookie(res, sessionId);
    res.redirect('/');
  } catch (err) {
    console.error('[auth] OAuth 回调失败', err?.message || String(err));
    res.status(500).type('text').send('登录失败：授权码交换或用户信息获取出错');
  }
});

// GET /api/auth/me — 返回当前登录用户最小展示信息。
router.get('/auth/me', (req, res) => {
  const sessionId = req.cookies?.[SESSION_COOKIE_NAME];
  const session = getSession(sessionId);

  if (!session) {
    return res.status(401).json({ code: 'UNAUTHORIZED', message: '未登录或会话已过期' });
  }

  res.json({
    name: session.name,
    email: session.email,
  });
});

// POST /api/auth/logout — 退出登录，销毁会话。
router.post('/auth/logout', (req, res) => {
  const sessionId = req.cookies?.[SESSION_COOKIE_NAME];
  deleteSession(sessionId);
  clearSessionCookie(res);
  res.json({ success: true });
});

// === Mock OAuth 流程（仅 mock 模式）===

// GET /api/auth/mock-login — 简易登录表单（仅 mock 模式可用）。
router.get('/auth/mock-login', (req, res) => {
  if (!oauthClient.isMockMode()) {
    return res.status(404).end();
  }
  const { state } = req.query;
  // state 来自 Cookie，表单只传一个 hidden 用于回传；Cookie 仍是权威校验源。
  const cookieState = req.cookies?.[STATE_COOKIE_NAME];
  const formState = cookieState || state || '';
  res.type('html').send(`
    <!doctype html>
    <html lang="zh-CN">
    <head><meta charset="utf-8"><title>Mock 登录</title></head>
    <body style="font-family:sans-serif;max-width:400px;margin:80px auto;">
      <h2>Mock 登录（开发模式）</h2>
      <form method="POST" action="/api/auth/mock-callback">
        <input type="hidden" name="state" value="${encodeURIComponent(formState)}">
        <p><label>邮箱<br><input name="email" type="email" required value="test@mainquestai.top"></label></p>
        <p><label>姓名<br><input name="name" type="text" required value="测试用户"></label></p>
        <p><label>公司<br><input name="companyName" type="text" value="测试公司"></label></p>
        <p><button type="submit">登录</button></p>
      </form>
    </body>
    </html>
  `);
});

// POST /api/auth/mock-callback — mock 登录提交，直接建立会话（仅 mock 模式可用）。
router.post('/auth/mock-callback', (req, res) => {
  if (!oauthClient.isMockMode()) {
    return res.status(404).end();
  }
  const { state, email, name, companyName } = req.body || {};

  // 双重校验：表单 state 和 Cookie 中的 state 必须一致。
  const cookieState = req.cookies?.[STATE_COOKIE_NAME];
  if (!state || !cookieState || state !== cookieState) {
    clearStateCookie(res);
    return res.status(400).type('text').send('登录失败：state 校验失败，请重新登录');
  }

  clearStateCookie(res);

  const account = upsertAccount({
    mqSubject: `mock:${email}`,
    email,
    name,
    companyName,
  });

  const { sessionId } = createSession(account);
  setSessionCookie(res, sessionId);
  res.redirect('/');
});

module.exports = router;
