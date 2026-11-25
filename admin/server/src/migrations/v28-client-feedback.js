'use strict';

/**
 * v28: saved client feedback (merged-admin C4; brief "Revision rounds", "Client
 * feedback", safeguards S8, S10, S16).
 *
 * Client-written state gets tables of its own (S10): nothing the studio writes
 * touches these rows, and nothing here is in a published record.
 *
 * client_notes        One note, saved as the client adds it, on the version they
 *                     were looking at. `seconds` is where the video was paused (or
 *                     NULL), `photo_key` which photo of a library (its review key,
 *                     the same one the portal's links carry, or NULL) and, for the
 *                     studio's eyes only, that photo's file name. The server
 *                     sets `created_at`; the client's clock is never trusted (S8).
 *                     Unsent until `submission_id` is set; an unsent note can be
 *                     removed by its client, a sent one can't. `client_key` is the
 *                     page's own id for it, so a retry after a lost reply finds the
 *                     note it already saved instead of saving it twice.
 * client_submissions  A set of notes sent to the studio: one per version at most,
 *                     because after sending, the version waits for a new one from
 *                     the studio (brief). C5 counts a Final's as rounds. A set can
 *                     carry notes left unsent on an earlier version of the item:
 *                     each note keeps the version it was written on.
 *
 * No cascades: a published version can't be deleted (R3), a project with
 * deliverables can't be (S11), and a client with projects can't be either, so
 * nothing these rows point at goes away under them. Safe to run twice.
 */
function migrateV28(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_submissions (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL REFERENCES projects(id),
      deliverable_id  TEXT NOT NULL REFERENCES deliverables(id),
      version_id      TEXT NOT NULL UNIQUE REFERENCES deliverable_versions(id),
      client_id       TEXT NOT NULL REFERENCES clients(id),
      stage           TEXT NOT NULL CHECK (stage IN ('draft', 'final')),
      note_count      INTEGER NOT NULL CHECK (note_count >= 1),
      submitted_at    TEXT NOT NULL,
      ip              TEXT NOT NULL DEFAULT '',
      user_agent      TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_client_submissions_project ON client_submissions (project_id);

    CREATE TABLE IF NOT EXISTS client_notes (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL REFERENCES projects(id),
      deliverable_id  TEXT NOT NULL REFERENCES deliverables(id),
      version_id      TEXT NOT NULL REFERENCES deliverable_versions(id),
      client_id       TEXT NOT NULL REFERENCES clients(id),
      text            TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
      seconds         REAL CHECK (seconds IS NULL OR (seconds >= 0 AND seconds <= 86400)),
      photo_key       TEXT,
      photo_name      TEXT,
      created_at      TEXT NOT NULL,
      submission_id   TEXT REFERENCES client_submissions(id),
      client_key      TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_client_notes_key ON client_notes (client_id, client_key) WHERE client_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_client_notes_project ON client_notes (project_id);
    CREATE INDEX IF NOT EXISTS idx_client_notes_version ON client_notes (version_id);
  `);
}

module.exports = { migrateV28 };
