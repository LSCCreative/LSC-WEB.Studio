'use strict';

/**
 * v36: a photo library's files on Bunny Edge Storage (Bunny Slice 6).
 *
 * A photo version's publish is one bunny_assets row (kind 'photos', v33) for the
 * library as a whole: its status and n/total. This table is one row per photo in
 * it, which is what lets a job resume after a restart, and a republish skip what
 * Bunny already has:
 *
 * bunny_photo_files  (version_id, file_name): a photo in the version's NAS folder.
 *                    source_size and source_mtime are the file as it was sent, so
 *                    a photo replaced on the NAS goes again. width and height are
 *                    the original's, after its EXIF rotation. status: 'pending'
 *                    (not sent yet, or to send again), 'done' (the original and
 *                    both sizes are on Bunny) or 'failed' (`error` says why).
 *                    Paths on Bunny are built from the row, never stored:
 *                    /<projectId>/<itemId>/<versionId>/{original-<tag>,600,2400}/<file>,
 *                    the tag being the bunny_assets row's publish_tag.
 *                    No foreign key, as bunny_assets has none: a row names files
 *                    the studio pays Bunny to keep until cleanup (Slice 11).
 *
 * Starts empty: no photo library was ever sent to Bunny. Safe to run twice.
 */
function migrateV36(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bunny_photo_files (
      version_id   TEXT NOT NULL,
      file_name    TEXT NOT NULL,
      source_size  INTEGER NOT NULL,
      source_mtime INTEGER NOT NULL,
      width        INTEGER,
      height       INTEGER,
      status       TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
      error        TEXT,
      updated_at   TEXT NOT NULL,
      PRIMARY KEY (version_id, file_name)
    );
  `);
}

module.exports = { migrateV36 };
