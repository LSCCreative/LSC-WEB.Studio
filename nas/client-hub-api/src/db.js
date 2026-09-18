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
  -- downloadable (Slice 14) lets the same file be registered twice — once
  -- for review (inline), once for download (Content-Disposition: attachment)
  -- — hence uniqueness on (relative_path, downloadable) rather than path alone.
  CREATE TABLE IF NOT EXISTS deliverable_tokens (
    token         TEXT PRIMARY KEY,
    relative_path TEXT NOT NULL,
    downloadable  INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    UNIQUE(relative_path, downloadable)
  );

  -- Legal/audit evidence for a client's deliverables sign-off (Slice 5). One
  -- row per project — private, never exposed via the public records table.
  -- ip_address is the only field the client cannot supply itself: it is
  -- stamped by POST /hub/agreement from the request, never client-reported.
  CREATE TABLE IF NOT EXISTS agreement_evidence (
    project_id         TEXT PRIMARY KEY REFERENCES records(project_id) ON DELETE CASCADE,
    signer_name        TEXT NOT NULL,
    signed_at          TEXT NOT NULL,
    signature_data_url TEXT NOT NULL,
    consent_text       TEXT NOT NULL,
    consent_checked    INTEGER NOT NULL,
    user_agent         TEXT NOT NULL DEFAULT '',
    verification_token TEXT NOT NULL DEFAULT '',
    ip_address         TEXT NOT NULL DEFAULT '',
    received_at        TEXT NOT NULL
  );
`);

// Slice 14 migration: a NAS already running Slice 4's schema has
// deliverable_tokens without `downloadable` (and a plain UNIQUE(relative_path)
// baked into the column def, which CREATE TABLE IF NOT EXISTS above can't
// retrofit) — rebuild the table in place rather than dropping it, so any
// already-registered token (real production data, not just test rows)
// survives with downloadable=0 (review, its only mode before this slice).
const deliverableCols = db.prepare(`PRAGMA table_info(deliverable_tokens)`).all();
if (deliverableCols.length && !deliverableCols.some(c => c.name === 'downloadable')) {
  db.exec(`
    ALTER TABLE deliverable_tokens RENAME TO deliverable_tokens_old;
    CREATE TABLE deliverable_tokens (
      token         TEXT PRIMARY KEY,
      relative_path TEXT NOT NULL,
      downloadable  INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL,
      UNIQUE(relative_path, downloadable)
    );
    INSERT INTO deliverable_tokens (token, relative_path, downloadable, created_at)
      SELECT token, relative_path, 0, created_at FROM deliverable_tokens_old;
    DROP TABLE deliverable_tokens_old;
  `);
}

db.prepare(`
  INSERT INTO meta (key, value) VALUES ('schema_version', ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run('5');

export function schemaVersion() {
  return db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value;
}
