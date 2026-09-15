import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const DATA_DIR = process.env.DATA_DIR || './data';

mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(join(DATA_DIR, 'client-hub.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Safe published record per project (buildPublishedRecord's output) —
  -- mirrors records/<id>.json from the old Bunny Storage layout.
  CREATE TABLE IF NOT EXISTS records (
    project_id TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Private auth data per project — mirrors private/auth/<id>.json.
  -- email_hash/invite_token replace the old email-index.json/invite-index.json
  -- side tables: a plain index on the column does the same lookup.
  CREATE TABLE IF NOT EXISTS private_auth (
    project_id   TEXT PRIMARY KEY REFERENCES records(project_id) ON DELETE CASCADE,
    client_email TEXT NOT NULL DEFAULT '',
    email_hash   TEXT,
    code_hash    TEXT,
    invite_token TEXT,
    delivered    INTEGER NOT NULL DEFAULT 0,
    updated_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_private_auth_email_hash ON private_auth(email_hash);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_private_auth_invite_token
    ON private_auth(invite_token) WHERE invite_token IS NOT NULL AND invite_token != '';

  -- Admin sessions issued by POST /hub/admin-auth, checked by the
  -- requireAdmin middleware gating /hub/publish and /hub/notify.
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token      TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  -- Video URL scheme (Slice 4): a stable, unguessable token per deliverable
  -- file, minted once by POST /hub/deliverable-url and never expiring —
  -- deliberately not the short-lived signed pattern used for records above.
  CREATE TABLE IF NOT EXISTS deliverable_tokens (
    token         TEXT PRIMARY KEY,
    relative_path TEXT NOT NULL UNIQUE,
    created_at    TEXT NOT NULL
  );
`);

db.prepare(`
  INSERT INTO meta (key, value) VALUES ('schema_version', ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run('3');

export function schemaVersion() {
  return db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value;
}
