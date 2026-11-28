'use strict';

/**
 * v37: cleanup and Take offline (Bunny Slice 11).
 *
 * bunny_assets gains two states, so a row whose files have left Bunny is kept as
 * a record rather than deleted:
 *   expired  the daily cleanup removed it: the version was replaced long enough
 *            ago, or its project or deliverable no longer exists (bunny-cleanup.js)
 *   offline  the studio took the archived project's files offline on purpose
 * and `removed_at`, when that happened. SQLite can't change a CHECK, so the table
 * is rebuilt with every row and both indexes as they were.
 *
 * projects.files_offline_at: the project's files are offline (Take offline). The
 * client sees them as offline wherever they'd be, until Bring back online clears
 * it. Unarchiving leaves it set. projects.files_offline_left: why a Take offline
 * stopped partway (Bunny refusing), so the admin offers to finish it; NULL once
 * everything is off Bunny.
 *
 * Safe to run twice: a table that already has the new states is left as it is.
 */
function migrateV37(db) {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'bunny_assets'").pluck().get() || '';
  if (!sql.includes("'offline'")) {
    db.exec(`
      CREATE TABLE bunny_assets_v37 (
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
        status         TEXT NOT NULL CHECK (status IN ('processing', 'ready', 'failed', 'expired', 'offline')),
        error          TEXT,
        progress_done  INTEGER NOT NULL DEFAULT 0,
        progress_total INTEGER NOT NULL DEFAULT 0,
        last_event_at  TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        removed_at     TEXT,
        PRIMARY KEY (version_id, kind)
      );
      INSERT INTO bunny_assets_v37 (
        version_id, kind, project_id, item_id, source_path, source_size, source_mtime, bunny_video_id, collection_id,
        publish_tag, storage_path, status, error, progress_done, progress_total, last_event_at, created_at, updated_at
      )
      SELECT version_id, kind, project_id, item_id, source_path, source_size, source_mtime, bunny_video_id, collection_id,
             publish_tag, storage_path, status, error, progress_done, progress_total, last_event_at, created_at, updated_at
        FROM bunny_assets;
      DROP TABLE bunny_assets;
      ALTER TABLE bunny_assets_v37 RENAME TO bunny_assets;
      CREATE INDEX idx_bunny_assets_video_id ON bunny_assets (bunny_video_id);
      CREATE INDEX idx_bunny_assets_project ON bunny_assets (project_id);
    `);
  }
  const columns = db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
  if (!columns.includes('files_offline_at')) db.exec('ALTER TABLE projects ADD COLUMN files_offline_at TEXT');
  if (!columns.includes('files_offline_left')) db.exec('ALTER TABLE projects ADD COLUMN files_offline_left TEXT');
}

module.exports = { migrateV37 };
