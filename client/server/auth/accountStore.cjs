// 账号映射：按 MainQuest subject 维护本地账号记录。
const crypto = require('node:crypto');
const config = require('../config.cjs');
const { getSystemDb } = require('../database/systemDatabase.cjs');

function upsertAccount({ mqSubject, email, name, companyName }) {
  const db = getSystemDb();
  const existing = db.prepare('SELECT id FROM accounts WHERE mq_subject = ?').get(mqSubject);

  if (existing) {
    db.prepare(`
      UPDATE accounts
      SET email = ?, name = ?, company_name = ?, workspace_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(email, name, companyName || null, config.tenantId, existing.id);
    return getAccountById(existing.id);
  }

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO accounts (id, mq_subject, email, name, company_name, workspace_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, mqSubject, email, name, companyName || null, config.tenantId);
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
    workspaceId: config.tenantId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = { upsertAccount, getAccountById };
