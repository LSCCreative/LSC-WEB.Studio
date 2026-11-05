'use strict';

/**
 * v21: the Client Hub's tables join billing.db (merge safeguard S15).
 *
 * The hub ran its own client-hub.db, which built these tables on every boot
 * and forced a `meta.schema_version` of 6. Here they come in once, as a
 * numbered migration; `meta` doesn't come across. The names are the hub's,
 * so the data import (merge task M5) copies rows straight over. The shapes
 * are the hub's schema 6, including `deliverable_tokens.downloadable`, so the
 * hub's old in-place rebuild for that column isn't needed.
 *
 * `records` and `private_auth` are the published portal record and its login
 * data; later tasks replace them with billing's own projects and clients.
 *
 * Safe to run twice (the upgrade tests rewind schema_version): every table and
 * index is created only when missing.
 */
function migrateV21(db) {
  db.exec(`
    -- The published record per project: what the portal shows the client.
    CREATE TABLE IF NOT EXISTS records (
      project_id TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- A record's private login data. The email and code are stored hashed;
    -- client_email is kept so the studio can see who the portal is for.
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

    -- The hub editor's PIN sessions, separate from billing's own sessions.
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token      TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    -- A stable, unguessable token per deliverable file. A file can have two:
    -- one to play inline and one to download.
    CREATE TABLE IF NOT EXISTS deliverable_tokens (
      token         TEXT PRIMARY KEY,
      relative_path TEXT NOT NULL,
      downloadable  INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL,
      UNIQUE(relative_path, downloadable)
    );

    -- Evidence for a client's deliverables sign-off, one row per project.
    -- Never sent to the portal. ip_address is the only field the server
    -- records itself rather than taking from the client.
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

    -- Bunny's client-facing copy of a NAS file, keyed by the same relative
    -- path as deliverable_tokens. bunny_video_id stays NULL until Bunny lists
    -- the fetched video, which is found by the publish_tag in its title.
    -- source_size and source_mtime record the file that was published, so a
    -- replaced cut is reported rather than hidden.
    CREATE TABLE IF NOT EXISTS bunny_assets (
      relative_path  TEXT NOT NULL,
      kind           TEXT NOT NULL,
      bunny_video_id TEXT,
      storage_path   TEXT,
      collection_id  TEXT,
      publish_tag    TEXT,
      status         TEXT NOT NULL,
      error          TEXT,
      source_size    INTEGER,
      source_mtime   INTEGER,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      UNIQUE(relative_path, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_bunny_assets_video_id ON bunny_assets(bunny_video_id);

    -- One Stream collection per top-level NAS project folder.
    CREATE TABLE IF NOT EXISTS bunny_collections (
      folder_name   TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );
  `);
  console.log('[db] v21: the Client Hub tables are in; nothing existing changes');
}

module.exports = { migrateV21 };
