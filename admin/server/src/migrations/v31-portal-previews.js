'use strict';

/**
 * v31: View as client (merged-admin C8).
 *
 * portal_previews  One row per preview the studio opened from a project header. The
 *                  link's token (`link_hash`) works once, for a few minutes, and is
 *                  swapped for the preview's own cookie token (`session_hash`), which
 *                  lasts an hour. Both are kept only as an HMAC under the portal's
 *                  secret. A preview is the studio's, not the client's: it is never a
 *                  client_sessions row, so it is no sign-in, moves no "last seen", and
 *                  can't be told from the client's own activity. Unlike v28-v30's
 *                  client data, a preview is disposable: it goes with its project or
 *                  client (ON DELETE CASCADE), so it never blocks a delete or merge.
 *                  Safe to run twice.
 */
function migrateV31(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS portal_previews (
      id               TEXT PRIMARY KEY,
      client_id        TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      link_hash        TEXT UNIQUE,
      link_expires_at  TEXT NOT NULL,
      session_hash     TEXT UNIQUE,
      expires_at       TEXT,
      created_at       TEXT NOT NULL,
      opened_at        TEXT
    );
  `);
}

module.exports = { migrateV31 };
