'use strict';

/**
 * v29: approvals (merged-admin C5; brief "Approval is the record", safeguards S10, S12).
 *
 * client_approvals  One approval of one version, the record CONFIRM APPROVAL leaves:
 *                   who (the client, and the email and name they had then, since a
 *                   client record can change later), when (the server's clock, S8),
 *                   from where (IP, user agent) and of exactly what (the version, its
 *                   number, stage and file name as they were). First write wins: one
 *                   per version (UNIQUE), so a second click or another tab returns the
 *                   first record and never changes it (S12).
 *
 *                   `kind` is 'client' for the client's own approval, or 'deemed' for
 *                   the studio's Mark approved after 14 business days (C7), which has
 *                   no client session behind it, so its client_id may be empty.
 *
 * An approval belongs to its version and stays on record. An item counts as approved
 * only while its newest version is an approved Final (delivery.js): the studio
 * swapping in a new file takes the item back out of approved without touching this
 * record (S12). A draft's approval is kept too but never signs an item off (brief,
 * Deliverables). Client-written, so a table of its own (S10); no cascades, as in v28:
 * nothing it points at can be deleted while it exists. Safe to run twice.
 */
function migrateV29(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_approvals (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL REFERENCES projects(id),
      deliverable_id  TEXT NOT NULL REFERENCES deliverables(id),
      version_id      TEXT NOT NULL UNIQUE REFERENCES deliverable_versions(id),
      kind            TEXT NOT NULL DEFAULT 'client' CHECK (kind IN ('client', 'deemed')),
      client_id       TEXT REFERENCES clients(id),
      email           TEXT NOT NULL DEFAULT '',
      name            TEXT NOT NULL DEFAULT '',
      stage           TEXT NOT NULL CHECK (stage IN ('draft', 'final')),
      version_n       INTEGER NOT NULL,
      file_name       TEXT NOT NULL DEFAULT '',
      approved_at     TEXT NOT NULL,
      ip              TEXT NOT NULL DEFAULT '',
      user_agent      TEXT NOT NULL DEFAULT '',
      CHECK (kind = 'deemed' OR client_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_client_approvals_project ON client_approvals (project_id);
  `);
}

module.exports = { migrateV29 };
