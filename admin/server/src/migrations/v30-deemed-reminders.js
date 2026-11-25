'use strict';

/**
 * v30: the client's deemed-approval reminders (merged-admin C7).
 *
 * deemed_reminders  One row per Final version a reminder was tried for: whether it
 *                   went (`sent`) or the last try failed (`failed`, tried again on the
 *                   next pass while the client still has days left), to whom, and the
 *                   last day it named. One per version (the PRIMARY KEY), so a
 *                   version is reminded once; a new version has its own clock and
 *                   its own reminder. No cascades, as in v28 and v29. Safe to run twice.
 */
function migrateV30(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS deemed_reminders (
      version_id  TEXT PRIMARY KEY REFERENCES deliverable_versions(id),
      project_id  TEXT NOT NULL REFERENCES projects(id),
      status      TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
      to_email    TEXT NOT NULL DEFAULT '',
      last_day    TEXT NOT NULL,
      attempts    INTEGER NOT NULL DEFAULT 0,
      error       TEXT NOT NULL DEFAULT '',
      sent_at     TEXT,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deemed_reminders_project ON deemed_reminders (project_id);
  `);
}

module.exports = { migrateV30 };
