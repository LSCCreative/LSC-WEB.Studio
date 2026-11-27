'use strict';

/**
 * v35: wrong portal sign-in codes, kept across restarts.
 *
 * portal_code_failures  One row per wrong code or PIN tried for an address: its
 *                  SHA-256 (never the address or what was typed) and when, in ms.
 *                  The sign-in throttle counts these (10 in 15 minutes, 30 in a day);
 *                  in memory, a restart gave a guesser a fresh count. A right code
 *                  clears the address's rows, and so does the studio issuing a new
 *                  code. Rows older than a day are pruned as new ones come in.
 *
 * Starts empty. Safe to run twice.
 */
function migrateV35(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS portal_code_failures (
      email_hash TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_portal_code_failures_email ON portal_code_failures (email_hash, at);
    CREATE INDEX IF NOT EXISTS idx_portal_code_failures_at ON portal_code_failures (at);
  `);
}

module.exports = { migrateV35 };
