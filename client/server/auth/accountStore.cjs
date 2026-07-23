// 账号映射：按 MainQuest subject 维护本地账号记录。
const crypto = require('node:crypto');
const { getSystemDb } = require('../database/systemDatabase.cjs');

function upsertAccount({ mqSubject, email, name, companyName }) {
  const db = getSystemDb();
  const existing = db.prepare('SELECT id FROM accounts WHERE mq_subject = ?').get(mqSubject);

  if (existing) {
    db.prepare(`
      UPDATE accounts
      SET email = ?, name = ?, company_name = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(email, name, companyName || null, existing.id);
    return getAccountById(existing.id);
  }

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO accounts (id, mq_subject, email, name, company_name)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, mqSubject, email, name, companyName || null);
  return getAccountById(id);
}

function getAccountById(id) {
  const db = getSystemDb();
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    mqSubject: row.mq_subject,
    email: row.email,
    name: row.name,
    companyName: row.company_name,
    // workspaceId 派生自 account id，Sprint 04 使用。
    workspaceId: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = { upsertAccount, getAccountById };
