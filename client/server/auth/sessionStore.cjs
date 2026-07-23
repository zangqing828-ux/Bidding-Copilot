// 会话管理：服务端 SQLite 存储，浏览器只持有随机 session ID。
const crypto = require('node:crypto');
const { getSystemDb } = require('../database/systemDatabase.cjs');

const SESSION_COOKIE_NAME = 'yibiao_session';
const DEFAULT_TTL_DAYS = 7;

function getSessionTtlMs() {
  const days = Number(process.env.SESSION_TTL_DAYS) || DEFAULT_TTL_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

function createSession(account) {
  const db = getSystemDb();
  const sessionId = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + getSessionTtlMs()).toISOString();

  db.prepare(`
    INSERT INTO sessions (id, account_id, mq_subject, email, name, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionId, account.id, account.mqSubject, account.email, account.name, expiresAt);

  return { sessionId, expiresAt };
}

function getSession(sessionId) {
  if (!sessionId) {
    return null;
  }

  const db = getSystemDb();
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!row) {
    return null;
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return null;
  }

  return {
    sessionId: row.id,
    accountId: row.account_id,
    mqSubject: row.mq_subject,
    email: row.email,
    name: row.name,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function deleteSession(sessionId) {
  if (!sessionId) {
    return;
  }
  const db = getSystemDb();
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

function cleanExpiredSessions() {
  const db = getSystemDb();
  // expires_at 以 ISO 格式存储（含 T 分隔符），用 datetime() 统一比较避免格式差异。
  db.prepare("DELETE FROM sessions WHERE datetime(expires_at) < datetime('now')").run();
}

module.exports = {
  SESSION_COOKIE_NAME,
  createSession,
  getSession,
  deleteSession,
  cleanExpiredSessions,
};
