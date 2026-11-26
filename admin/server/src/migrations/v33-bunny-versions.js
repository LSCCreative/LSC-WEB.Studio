'use strict';

/**
 * v33: Bunny rows belong to a deliverable version, not a NAS path (Bunny Slice 2).
 *
 * v21 brought the old hub's two Bunny tables across as they were: keyed by the
 * file's NAS path, and one collection per top-level folder. A path is only where a
 * file came from: two versions can share one, and a folder name isn't a project.
 * So both are rebuilt:
 *
 * bunny_assets       One row per (version, kind). Kind is 'video' today; photo
 *                    libraries (Slice 6) and video masters (Slice 8) join it. The
 *                    row keeps the file it was made from (path, size, mtime), so a
 *                    NAS file replaced after publishing is reported, not hidden.
 *                    bunny_video_id is NULL until Bunny lists the fetched video,
 *                    which is found by publish_tag in its title. last_event_at is
 *                    the Timestamp of the newest Bunny webhook applied (Slice 3),
 *                    so an older one arriving late can't undo it.
 *                    No foreign keys, on purpose: a row points at something the
 *                    studio pays Bunny to keep, so it outlives a deleted version
 *                    or project until cleanup (Slice 11) has taken that off Bunny.
 * bunny_collections  One Stream collection per project, keyed by projects.id
 *                    (a UPID can be empty or change). `name` is what it was
 *                    created as on Bunny: "<projectId> <project name>".
 *
 * Nothing real was ever published through the old tables (the publish routes were
 * never set up with Bunny keys), so there is nothing to carry over. If a row is
 * there after all, this stops rather than drop it: that row is a video on Bunny
 * nobody would find again.
 */
function migrateV33(db) {
  for (const table of ['bunny_assets', 'bunny_collections']) {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    const rows = exists ? db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() : 0;
    if (rows) {
      throw new Error(
        `v33 rebuilds ${table}, but it holds ${rows} row(s) from the old hub's publishing. ` +
        'Nothing was changed. Those rows name videos on Bunny: tell the developer before starting this version.'
      );
    }
  }

  db.exec(`
    DROP INDEX IF EXISTS idx_bunny_assets_video_id;
    DROP TABLE IF EXISTS bunny_assets;
    DROP TABLE IF EXISTS bunny_collections;

    CREATE TABLE bunny_assets (
      version_id     TEXT NOT NULL,
      kind           TEXT NOT NULL CHECK (kind IN ('video', 'photos', 'master')),
      project_id     TEXT NOT NULL,
      item_id        TEXT NOT NULL,
      source_path    TEXT NOT NULL,
      source_size    INTEGER,
      source_mtime   INTEGER,
      bunny_video_id TEXT,
      collection_id  TEXT,
      publish_tag    TEXT,
      storage_path   TEXT,
      status         TEXT NOT NULL CHECK (status IN ('processing', 'ready', 'failed')),
      error          TEXT,
      progress_done  INTEGER NOT NULL DEFAULT 0,
      progress_total INTEGER NOT NULL DEFAULT 0,
      last_event_at  TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      PRIMARY KEY (version_id, kind)
    );
    CREATE INDEX idx_bunny_assets_video_id ON bunny_assets (bunny_video_id);
    CREATE INDEX idx_bunny_assets_project ON bunny_assets (project_id);

    CREATE TABLE bunny_collections (
      project_id    TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL,
      name          TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );
  `);
}

module.exports = { migrateV33 };
