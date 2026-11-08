'use strict';

/**
 * v22: a project's checklist (merged-admin R1; IA "Project State Model").
 *
 * deliverables          One checklist item per thing the studio owes the
 *                       client. Accepting a quote makes one per quoted
 *                       deliverable (delivery.js createChecklist); "3 ×
 *                       Cut-down" makes three. `stage` is what the item is
 *                       now (Draft Cut or Final, the brief's asset stage);
 *                       `not_needed_at` marks one the studio says isn't owed.
 * deliverable_versions  Each file an item has had, numbered per item. A
 *                       version keeps the stage it was made as, so swapping a
 *                       draft for a Final keeps the history. Bunny's rows
 *                       (buildplan Slice 2) and approvals (C5) belong to a
 *                       version. `source_path` is the NAS-relative file.
 *
 * projects gains:
 *   archived_at         Filed away by the studio (R2 builds Archive).
 *   no_deliverables_at  The studio says no deliverables are expected, so an
 *                       empty checklist may complete. Also set here, once,
 *                       for every project already fully paid: those were
 *                       finished before checklists existed, and the IA
 *                       classes them Complete ("set once at import, so the
 *                       empty-checklist rule doesn't reopen it").
 *   payment_required    Downloads wait for payment (F4 builds the toggle).
 *                       Off for every project, as the IA's Existing Data says.
 *
 * Neither new table cascades from projects: a project holding a checklist
 * can't be deleted (projects.js CLIENT_DATA, S11), so a cascade would only
 * hide a bug. Safe to run twice: tables, indexes and columns are created
 * only when missing, and the paid-project mark only fills an empty column.
 */
function migrateV22(db, now) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS deliverables (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL REFERENCES projects(id),
      position      INTEGER NOT NULL CHECK (position >= 1),
      title         TEXT NOT NULL CHECK (title <> ''),
      format        TEXT NOT NULL DEFAULT '',
      duration      TEXT NOT NULL DEFAULT '',
      estimate_id   TEXT REFERENCES estimates(id) ON DELETE SET NULL,
      quote_line_id TEXT,
      stage         TEXT NOT NULL DEFAULT 'draft' CHECK (stage IN ('draft', 'final')),
      not_needed_at TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deliverables_project ON deliverables (project_id, position);

    CREATE TABLE IF NOT EXISTS deliverable_versions (
      id             TEXT PRIMARY KEY,
      deliverable_id TEXT NOT NULL REFERENCES deliverables(id),
      project_id     TEXT NOT NULL REFERENCES projects(id),
      n              INTEGER NOT NULL CHECK (n >= 1),
      stage          TEXT NOT NULL CHECK (stage IN ('draft', 'final')),
      source_path    TEXT,
      file_name      TEXT NOT NULL DEFAULT '',
      created_at     TEXT NOT NULL,
      published_at   TEXT,
      UNIQUE (deliverable_id, n)
    );
    CREATE INDEX IF NOT EXISTS idx_deliverable_versions_project ON deliverable_versions (project_id);
  `);

  const cols = new Set(db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name));
  if (!cols.has('archived_at')) db.exec('ALTER TABLE projects ADD COLUMN archived_at TEXT');
  if (!cols.has('no_deliverables_at')) db.exec('ALTER TABLE projects ADD COLUMN no_deliverables_at TEXT');
  if (!cols.has('payment_required')) {
    db.exec(`ALTER TABLE projects ADD COLUMN payment_required INTEGER NOT NULL DEFAULT 0
               CHECK (payment_required IN (0, 1))`);
  }

  // Already paid: projects.js projectStage's 'paid' (not declined; some
  // invoice that isn't void, and every such invoice paid).
  const marked = db.prepare(`
    UPDATE projects SET no_deliverables_at = ?
     WHERE no_deliverables_at IS NULL AND declined_at IS NULL
       AND EXISTS (SELECT 1 FROM invoices i WHERE i.project_id = projects.id AND i.status <> 'void')
       AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.project_id = projects.id AND i.status NOT IN ('void', 'paid'))
  `).run(now).changes;
  if (marked) console.log(`[db] v22: ${marked} project(s) already paid are Complete with no checklist`);
}

module.exports = { migrateV22 };
