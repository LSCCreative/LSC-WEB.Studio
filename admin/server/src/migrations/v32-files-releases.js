'use strict';

const crypto = require('crypto');

/**
 * v32: the client's files, emailed once the job is paid (merged-admin C10).
 *
 * files_releases  One row per project: the last set of approved Finals the app
 *                 tried to email the client (`set_key`, the versions in item
 *                 order) and how that went. `status` is sent, failed (tried again
 *                 later, up to a limit), no_email (the client has no address of
 *                 their own yet; sent once they do), gave_up, or baseline (below).
 *                 A new set (a newer Final approved after the files went) replaces
 *                 the row and sends again; the same set never goes twice.
 *                 `owner_told` keeps the studio's notice about a set that can't go.
 *                 Disposable, like v31's previews: it goes with its project
 *                 (ON DELETE CASCADE).
 *
 * THE BASELINE. Every job already paid and approved when this runs finished before
 * the email existed: the client has those files. Each gets a `baseline` row with
 * its set as it stands, so nothing sends for it unless a new set comes later (then
 * as an update). The key is files-release.js setKeyOf's, worked out here from the
 * v31 tables on their own, so a later change to the app's code can't change what
 * this migration does; test-files-release.js checks the two agree today.
 * Safe to run twice: the baseline never replaces a row.
 */
function migrateV32(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS files_releases (
      project_id   TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      set_key      TEXT NOT NULL,
      status       TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'no_email', 'gave_up', 'baseline')),
      to_email     TEXT NOT NULL DEFAULT '',
      attempts     INTEGER NOT NULL DEFAULT 0,
      error        TEXT NOT NULL DEFAULT '',
      owner_told   INTEGER NOT NULL DEFAULT 0,
      sent_at      TEXT,
      updated_at   TEXT NOT NULL
    );
  `);

  // Paid: no live invoice unpaid, and one of them bills the end of the job.
  const paid = db.prepare(`
    SELECT p.id FROM projects p
     WHERE EXISTS (SELECT 1 FROM invoices i WHERE i.project_id = p.id AND i.status != 'void'
                      AND i.kind IN ('final', 'single', 'legacy'))
       AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.project_id = p.id AND i.status NOT IN ('void', 'paid'))
  `).all();
  const itemsOf = db.prepare(`
    SELECT id, hub_status FROM deliverables WHERE project_id = ? AND not_needed_at IS NULL
     ORDER BY position, created_at, id
  `);
  const newestOf = db.prepare('SELECT id, stage, drive_link FROM deliverable_versions WHERE deliverable_id = ? ORDER BY n DESC LIMIT 1');
  const approvedOn = db.prepare('SELECT 1 FROM client_approvals WHERE version_id = ?');
  const add = db.prepare(`
    INSERT OR IGNORE INTO files_releases (project_id, set_key, status, sent_at, updated_at)
    VALUES (?, ?, 'baseline', ?, ?)
  `);
  const now = new Date().toISOString();
  for (const { id } of paid) {
    const items = itemsOf.all(id);
    if (!items.length) continue;
    const files = [];
    let allApproved = true;
    for (const d of items) {
      const v = newestOf.get(d.id) || null;
      // delivery.js itemApproved: the old hub's word, or a newest version that is an approved Final.
      const approved = d.hub_status === 'approved' || d.hub_status === 'delivered' ||
        Boolean(v && v.stage === 'final' && approvedOn.get(v.id));
      if (!approved) { allApproved = false; break; }
      if (d.hub_status !== 'delivered') files.push([d.id, v ? v.id : null, v ? String(v.drive_link || '').trim() : '']);
    }
    if (!allApproved) continue;
    const key = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 32);
    add.run(id, key, now, now);
  }
}

module.exports = { migrateV32 };
