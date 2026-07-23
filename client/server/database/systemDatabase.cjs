// 系统身份库：独立 SQLite，存储账号映射和会话，与业务工作区分离。
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

let dbInstance = null;

function resolveDbPath() {
  const dataDir = process.env.YIBIAO_DATA_DIR || path.resolve(__dirname, '..', '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, 'auth.sqlite');
}

function migrate(db) {
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      mq_subject TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      company_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      mq_subject TEXT NOT NULL,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_account_id ON sessions(account_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
  `);
}

function getSystemDb() {
  if (dbInstance) {
    return dbInstance;
  }

  const dbPath = resolveDbPath();
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  migrate(db);
  dbInstance = db;
  return db;
}

module.exports = { getSystemDb };
