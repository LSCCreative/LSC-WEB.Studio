'use strict';

/**
 * v25: bringing the old hub's projects onto billing's records (merged-admin R4;
 * IA "Existing Data").
 *
 * hub_imports   One row per hub project that has been dealt with, keyed by the
 *               hub's own id: `project_id` is the billing project it became, or
 *               NULL when the studio left it out. It is the only link between
 *               the two: the portal's rows (`records`, `private_auth`,
 *               `agreement_evidence`) keep the hub's id, because links already
 *               handed to clients and their logins use it. A row here is what
 *               makes an import once-only. `source_json` keeps what came across
 *               whole, so nothing the hub knew is lost (never a client's code or
 *               invite token: src/hub/adopt.js strips those).
 *
 * projects.name           What a project is called when no estimate names it.
 * deliverables.hub_status Where the old hub left an item: `changes`, `approved`
 *                         or `delivered`. Empty otherwise, and cleared by the
 *                         item's next file (C5's approvals take over from there).
 *
 * THE CLASSIFICATION. v22 settled Payment required and the already-paid; what
 * was left of the IA's table is "accepted project with no client: client created
 * from its quote, by the same rule as acceptance". That runs here, once, through
 * a frozen copy of clientForAcceptance (linkClient below). A quote naming nobody stays without a client, and the
 * import screen lists it. `shared_email` and `email_differs` go on the project's
 * activity, as they do at acceptance.
 *
 * Safe to run twice: everything is created only when missing, and the client
 * step only touches a project that still has none.
 */
const { newId } = require('../db');

/* clientForAcceptance (src/delivery.js) as it stood at v25, frozen here. A
   migration must do the same thing on every database it ever meets, so it never
   calls live code: a later change to acceptance, or a column a later migration
   adds, would otherwise change or break v25 on an old backup. It reads and
   writes only columns v25 has. */
const foldV25 = (s) => String(s == null ? '' : s).trim().toLowerCase();

function linkClient(db, p, estimate, now) {
  let clientId = null;
  let how = null;
  let note = null;
  if (estimate.clientId && db.prepare('SELECT 1 FROM clients WHERE id = ?').get(estimate.clientId)) {
    clientId = estimate.clientId;
    how = 'linked';
  }
  const snap = estimate.client || {};
  if (!clientId) {
    const email = foldV25(snap.email);
    const business = String(snap.businessName || '').trim();
    const contact = String(snap.contactName || '').trim();
    // Oldest first, so a tie goes to the client made first.
    const all = db.prepare('SELECT id, business_name, email FROM clients ORDER BY created_at, id').all();
    const byEmail = email ? all.filter((c) => foldV25(c.email) === email) : [];
    const byName = business ? all.find((c) => foldV25(c.business_name) === foldV25(business)) : null;
    if (byEmail.length) {
      const named = byEmail.length > 1 && byEmail.find((c) => foldV25(c.business_name) === foldV25(business));
      clientId = (named || byEmail[0]).id;
      how = 'matched_email';
      if (byEmail.length > 1 && !named) note = { kind: 'shared_email', among: byEmail.length };
    } else if (byName) {
      clientId = byName.id;
      how = 'matched_name';
      if (email && !String(byName.email || '').trim()) {
        db.prepare('UPDATE clients SET email = ?, updated_at = ? WHERE id = ?').run(email, now, byName.id);
      } else if (email) {
        note = { kind: 'email_differs', quoteEmail: email };
      }
    } else if (business || contact || email) {
      clientId = newId('cl');
      how = 'created';
      db.prepare(`
        INSERT INTO clients (id, business_name, contact_name, email, phone, abn, address, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?)
      `).run(clientId, business || contact || email, contact, email,
        String(snap.phone || '').trim(), String(snap.abn || '').replace(/\s+/g, ''),
        String(snap.address || '').trim(), now, now);
    }
  }
  if (clientId) {
    db.prepare('UPDATE projects SET client_id = ?, updated_at = ? WHERE id = ?').run(clientId, now, p.id);
    db.prepare('UPDATE estimates SET client_id = ? WHERE project_id = ? AND client_id IS NULL').run(clientId, p.id);
  }
  return note ? { clientId, how, note } : { clientId, how };
}

function migrateV25(db, now) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hub_imports (
      hub_id      TEXT PRIMARY KEY,
      project_id  TEXT REFERENCES projects(id),
      outcome     TEXT NOT NULL CHECK (outcome IN ('imported', 'joined', 'left_out')),
      source_json TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      CHECK ((outcome = 'left_out') = (project_id IS NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hub_imports_project ON hub_imports (project_id) WHERE project_id IS NOT NULL;
  `);

  const projectCols = new Set(db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name));
  if (!projectCols.has('name')) db.exec("ALTER TABLE projects ADD COLUMN name TEXT NOT NULL DEFAULT ''");
  const itemCols = new Set(db.prepare('PRAGMA table_info(deliverables)').all().map((c) => c.name));
  if (!itemCols.has('hub_status')) {
    db.exec("ALTER TABLE deliverables ADD COLUMN hub_status TEXT CHECK (hub_status IN ('changes', 'approved', 'delivered'))");
  }

  const waiting = db.prepare(`
    SELECT p.* FROM projects p
     WHERE p.client_id IS NULL AND p.declined_at IS NULL
       AND (p.accepted_at IS NOT NULL
            OR EXISTS (SELECT 1 FROM estimates e WHERE e.project_id = p.id AND e.status = 'accepted')
            OR EXISTS (SELECT 1 FROM invoices i WHERE i.project_id = p.id AND i.status <> 'void'))
  `).all();
  const quoteOf = db.prepare(`
    SELECT id, client_id, client_json FROM estimates WHERE project_id = ?
     ORDER BY status = 'declined', updated_at DESC, id LIMIT 1
  `);
  const log = db.prepare('INSERT INTO activity (id, project_id, at, kind, detail_json) VALUES (?, ?, ?, ?, ?)');
  let linked = 0;
  waiting.forEach((p) => {
    const row = quoteOf.get(p.id);
    if (!row) return;
    let client = {};
    try {
      client = JSON.parse(row.client_json || '{}') || {};
    } catch {
      // A quote whose details can't be read names nobody; the import screen lists the project.
    }
    const made = linkClient(db, p, { clientId: row.client_id, client }, now);
    if (!made.clientId) return;
    linked += 1;
    log.run(newId('act'), p.id, now, 'client_linked', JSON.stringify({
      client: made.how,
      ...(made.note ? { clientNote: made.note } : {}),
    }));
  });
  if (linked) console.log(`[db] v25: ${linked} accepted project(s) now have a client, from their quotes`);
}

module.exports = { migrateV25 };
