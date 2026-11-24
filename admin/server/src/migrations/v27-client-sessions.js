'use strict';

/**
 * v27: real client sessions (merged-admin C1; brief "Foundations": client
 * sessions, login rate limiting; IA "Client code: one per client").
 *
 * client_logins    One row per client who has been given a Client code. The
 *                  code is kept only as an HMAC under the portal's secret, so a
 *                  copy of billing.db (a backup) can't be searched for it: a
 *                  plain hash of a short code falls to a loop in seconds. The
 *                  invite is a random token, kept as its SHA-256 (it is long
 *                  enough that a hash is all it needs); `invite_project_id` is
 *                  where the invite lands. A row here is also what retires the
 *                  client's old per-project codes (brief, Defaults 5: "existing
 *                  per-project codes still working until the client's next
 *                  reset").
 * client_sessions  A signed-in client. `id` is the HMAC of the cookie's token,
 *                  as billing's own `sessions` keeps it. `via` says how they
 *                  signed in: their Client code, or an old per-project code.
 *
 * Both go when the client does (a client with projects can't be deleted, S11).
 * Safe to run twice.
 */
function migrateV27(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_logins (
      client_id          TEXT PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
      code_hash          TEXT NOT NULL,
      invite_hash        TEXT,
      invite_project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
      code_set_at        TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_client_logins_invite
      ON client_logins (invite_hash) WHERE invite_hash IS NOT NULL;

    CREATE TABLE IF NOT EXISTS client_sessions (
      id            TEXT PRIMARY KEY,
      client_id     TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      via           TEXT NOT NULL CHECK (via IN ('code', 'legacy')),
      created_at    TEXT NOT NULL,
      expires_at    TEXT NOT NULL,
      last_seen_at  TEXT NOT NULL,
      user_agent    TEXT NOT NULL DEFAULT '',
      ip            TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_client_sessions_client ON client_sessions (client_id);
  `);
}

module.exports = { migrateV27 };
