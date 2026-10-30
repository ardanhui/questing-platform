'use strict';
/**
 * SQLite via sql.js (pure WASM, no native build). The whole database lives in
 * memory and is flushed to disk atomically (tmp file + rename) shortly after
 * every write, and synchronously on shutdown.
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const config = require('./config');
const log = require('./log');

let db = null;
let dirty = false;
let saveTimer = null;

const MIGRATIONS = [
  // v1 — full schema
  `
  CREATE TABLE IF NOT EXISTS quests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    kol_handle TEXT NOT NULL DEFAULT '',
    kol_tweet_url TEXT NOT NULL DEFAULT '',
    cover TEXT NOT NULL DEFAULT '',
    required_keywords TEXT NOT NULL DEFAULT '[]',
    keyword_mode TEXT NOT NULL DEFAULT 'all',
    banned_keywords TEXT NOT NULL DEFAULT '[]',
    must_mention TEXT NOT NULL DEFAULT '[]',
    min_chars INTEGER NOT NULL DEFAULT 0,
    max_chars INTEGER NOT NULL DEFAULT 0,
    require_after_start INTEGER NOT NULL DEFAULT 1,
    reward_type TEXT NOT NULL DEFAULT 'fixed',
    reward_amount REAL NOT NULL DEFAULT 0,
    reward_token TEXT NOT NULL DEFAULT 'ETH',
    reward_token_address TEXT,
    token_decimals INTEGER,
    reward_chain TEXT NOT NULL DEFAULT 'base',
    rpc_url TEXT,
    total_reward_pool REAL NOT NULL DEFAULT 0,
    remaining_pool REAL NOT NULL DEFAULT 0,
    winner_count INTEGER NOT NULL DEFAULT 0,
    max_submissions INTEGER NOT NULL DEFAULT 0,
    max_per_wallet INTEGER NOT NULL DEFAULT 1,
    weight_likes REAL NOT NULL DEFAULT 1,
    weight_retweets REAL NOT NULL DEFAULT 2,
    weight_replies REAL NOT NULL DEFAULT 1.5,
    weight_quotes REAL NOT NULL DEFAULT 3,
    weight_views REAL NOT NULL DEFAULT 0.01,
    auto_distribute INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active',
    starts_at TEXT,
    ends_at TEXT,
    finalized_at TEXT,
    distributed_at TEXT,
    engagement_refreshed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS users (
    wallet TEXT PRIMARY KEY,
    x_user_id TEXT UNIQUE,
    x_handle TEXT,
    x_name TEXT,
    x_avatar TEXT,
    x_access_token TEXT,
    x_refresh_token TEXT,
    x_token_expires_at TEXT,
    x_linked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quest_id INTEGER NOT NULL REFERENCES quests(id),
    wallet TEXT NOT NULL,
    x_handle TEXT,
    x_user_id TEXT,
    tweet_url TEXT NOT NULL,
    tweet_id TEXT NOT NULL,
    tweet_text TEXT NOT NULL DEFAULT '',
    tweet_author TEXT,
    tweet_author_id TEXT,
    tweet_created_at TEXT,
    tweet_chars INTEGER NOT NULL DEFAULT 0,
    provider TEXT NOT NULL DEFAULT '',
    checks TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'rejected',
    reject_reason TEXT,
    likes INTEGER NOT NULL DEFAULT 0,
    retweets INTEGER NOT NULL DEFAULT 0,
    replies INTEGER NOT NULL DEFAULT 0,
    quotes INTEGER NOT NULL DEFAULT 0,
    views INTEGER NOT NULL DEFAULT 0,
    score REAL NOT NULL DEFAULT 0,
    rank INTEGER,
    engagement_updated_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    verified_at TEXT,
    UNIQUE(quest_id, tweet_id)
  );
  CREATE INDEX IF NOT EXISTS idx_sub_quest ON submissions(quest_id, status);
  CREATE INDEX IF NOT EXISTS idx_sub_wallet ON submissions(wallet);
  CREATE TABLE IF NOT EXISTS rewards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL UNIQUE REFERENCES submissions(id),
    quest_id INTEGER NOT NULL REFERENCES quests(id),
    wallet TEXT NOT NULL,
    amount REAL NOT NULL,
    token TEXT NOT NULL,
    token_address TEXT,
    chain TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    tx_hash TEXT,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    sent_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_rewards_status ON rewards(status);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    quest_id INTEGER,
    submission_id INTEGER,
    wallet TEXT,
    message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
  `,
];

function nowIso() {
  return new Date().toISOString();
}

async function open(dbPath = config.dbPath) {
  const SQL = await initSqlJs();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (fs.existsSync(dbPath)) {
    db = new SQL.Database(fs.readFileSync(dbPath));
    log.info(`database loaded from ${dbPath}`);
  } else {
    db = new SQL.Database();
    log.info(`new database at ${dbPath}`);
  }
  db.run('PRAGMA foreign_keys = ON');
  migrate();
  saveNow(dbPath);
  return module.exports;
}

function migrate() {
  db.run('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = get('SELECT version FROM schema_version LIMIT 1');
  let version = row ? row.version : 0;
  if (!row) db.run('INSERT INTO schema_version (version) VALUES (0)');
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i]);
    version = i + 1;
    db.run('UPDATE schema_version SET version = ?', [version]);
    log.info(`migrated database to v${version}`);
  }
}

// ── query helpers ─────────────────────────────────────────
function norm(args) {
  return args.map((a) => {
    if (a === undefined) return null;
    if (typeof a === 'boolean') return a ? 1 : 0;
    return a;
  });
}

function all(sql, ...args) {
  const stmt = db.prepare(sql);
  try {
    if (args.length) stmt.bind(norm(args));
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

function get(sql, ...args) {
  return all(sql, ...args)[0] || null;
}

function run(sql, ...args) {
  db.run(sql, norm(args));
  const changes = db.getRowsModified();
  const idRow = get('SELECT last_insert_rowid() AS id');
  markDirty();
  return { changes, lastId: idRow ? idRow.id : null };
}

function transaction(fn) {
  db.run('BEGIN');
  try {
    const out = fn();
    db.run('COMMIT');
    markDirty();
    return out;
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}

function event(type, { quest_id = null, submission_id = null, wallet = null, message = '' } = {}) {
  run('INSERT INTO events (type, quest_id, submission_id, wallet, message) VALUES (?,?,?,?,?)',
    type, quest_id, submission_id, wallet, message);
}

// ── persistence ───────────────────────────────────────────
function markDirty() {
  dirty = true;
  if (!saveTimer) {
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (dirty) saveNow();
    }, 150);
    if (saveTimer.unref) saveTimer.unref();
  }
}

function saveNow(dbPath = config.dbPath) {
  if (!db) return;
  const data = Buffer.from(db.export());
  const tmp = `${dbPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, dbPath);
  dirty = false;
}

function close() {
  if (saveTimer) clearTimeout(saveTimer);
  if (db) {
    saveNow();
    db.close();
    db = null;
  }
}

module.exports = { open, all, get, run, transaction, event, saveNow, close, nowIso };
