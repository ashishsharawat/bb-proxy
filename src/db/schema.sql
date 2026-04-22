-- bb-proxy SQLite schema. Applied at boot (idempotent).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS devices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash    TEXT NOT NULL UNIQUE,
  label         TEXT,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);

CREATE TABLE IF NOT EXISTS browser_snapshots (
  id            TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  mode          TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  payload       BLOB NOT NULL,
  clickmap_json TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_browser_snapshots_created ON browser_snapshots(created_at);

CREATE TABLE IF NOT EXISTS wa_cache (
  chat_id       TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  author        TEXT,
  body          TEXT,
  media_id      TEXT,
  media_mime    TEXT,
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_wa_cache_ts ON wa_cache(chat_id, ts DESC);

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT
);
