'use strict';

/* The Client Hub's data, copied from its own client-hub.db into billing.db
   (merge task M5), into the tables migration 21 made for it.

   What comes across: the published records and their login data
   (private_auth), the file tokens behind every stored file link, the sign-off
   evidence, and the Bunny tables when the hub had them. What doesn't: the
   hub's `meta` (its forced schema_version) and `admin_sessions` (the editor
   signs in again).

   Rules:
   - Rows are copied as they are. Times stay the text the hub wrote: nothing
     is parsed or reformatted, so the timezone the import runs in can't touch
     them (S19).
   - Nothing in billing.db is overwritten. A row already there and identical
     is left alone, so a second run changes nothing. A row there but different,
     or one a unique rule refuses, is a conflict: the whole import is undone and
     the conflicts listed, for a person to settle.
   - A column the hub has and billing doesn't stops the import before anything
     is written, rather than losing it. A column billing has and the hub
     doesn't (an older hub's deliverable_tokens.downloadable) takes billing's
     default.
   - Afterwards every hub row is checked as present in billing.db, and every
     file link stored in a record (…/hub/files/<token>) as having its token.

   Takes open handles (the hub's read-only); the CLI is scripts/import-hub.js. */

/** The tables, parents first, each with the columns that identify a row. */
const TABLES = [
  { name: 'records', key: ['project_id'] },
  { name: 'private_auth', key: ['project_id'] },
  { name: 'deliverable_tokens', key: ['token'] },
  { name: 'agreement_evidence', key: ['project_id'] },
  { name: 'bunny_collections', key: ['folder_name'] },
  { name: 'bunny_assets', key: ['relative_path', 'kind'] },
];
const NOT_COPIED = ['meta', 'admin_sessions'];

/** A stored file link, as hub/routes.js writes them: [https://<host>]/hub/files/<token>. */
const FILE_LINK = /(?:https?:\/\/([^/"\s]+))?\/hub\/files\/([A-Za-z0-9_-]+)/g;

const quote = (name) => `"${name.replace(/"/g, '""')}"`;
const columnsOf = (db, table) => db.prepare(`PRAGMA table_info(${quote(table)})`).all().map((c) => c.name);
const tablesOf = (db) => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));

/** The columns to copy for each table the hub has, or an error naming what billing lacks. */
function plan(hub, billing) {
  const hubTables = tablesOf(hub);
  const billingTables = tablesOf(billing);
  const known = new Set([...TABLES.map((t) => t.name), ...NOT_COPIED]);
  const unknown = [...hubTables].filter((t) => !known.has(t) && !t.startsWith('sqlite_'));
  if (unknown.length) throw new Error(`The hub database has tables this import doesn't know: ${unknown.join(', ')}. Nothing was copied.`);

  const steps = [];
  for (const table of TABLES) {
    if (!hubTables.has(table.name)) {
      steps.push({ ...table, absent: true });
      continue;
    }
    if (!billingTables.has(table.name)) {
      throw new Error(`billing.db has no ${table.name} table: it needs schema v21 (open it with the server once). Nothing was copied.`);
    }
    const target = new Set(columnsOf(billing, table.name));
    const source = columnsOf(hub, table.name);
    const lost = source.filter((c) => !target.has(c));
    if (lost.length) {
      throw new Error(`The hub's ${table.name} has columns billing.db doesn't: ${lost.join(', ')}. Nothing was copied.`);
    }
    steps.push({ ...table, columns: source });
  }
  return steps;
}

const sameRow = (a, b, columns) => columns.every((c) => a[c] === b[c]);
const keyOf = (row, key) => key.map((c) => row[c]).join(' / ');

/**
 * Copies the hub's rows into billing.db in one transaction.
 * opts.dryRun: work it all out, then undo it.
 * Returns { tables: [{ name, absent, hub, added, same }], conflicts, links, skipped, written }.
 * Throws before writing anything if the schemas don't line up.
 */
function importHub(hub, billing, { dryRun = false } = {}) {
  const steps = plan(hub, billing);
  const report = { tables: [], conflicts: [], links: null, skipped: NOT_COPIED.filter((t) => tablesOf(hub).has(t)), written: false };

  const run = billing.transaction(() => {
    for (const step of steps) {
      if (step.absent) {
        report.tables.push({ name: step.name, absent: true, hub: 0, added: 0, same: 0 });
        continue;
      }
      const cols = step.columns.map(quote).join(', ');
      const rows = hub.prepare(`SELECT ${cols} FROM ${quote(step.name)}`).all();
      const find = billing.prepare(`SELECT ${cols} FROM ${quote(step.name)} WHERE ${step.key.map((c) => `${quote(c)} = ?`).join(' AND ')}`);
      const insert = billing.prepare(`INSERT INTO ${quote(step.name)} (${cols}) VALUES (${step.columns.map(() => '?').join(', ')})`);
      const counts = { name: step.name, hub: rows.length, added: 0, same: 0 };
      for (const row of rows) {
        const there = find.get(...step.key.map((c) => row[c]));
        if (there) {
          if (sameRow(row, there, step.columns)) counts.same += 1;
          else report.conflicts.push({ table: step.name, key: keyOf(row, step.key), reason: 'already in billing.db with different values' });
          continue;
        }
        try {
          insert.run(...step.columns.map((c) => row[c]));
          counts.added += 1;
        } catch (err) {
          if (!/^SQLITE_CONSTRAINT/.test(err.code || '')) throw err;
          report.conflicts.push({ table: step.name, key: keyOf(row, step.key), reason: err.message });
        }
      }
      report.tables.push(counts);
    }
    report.links = checkLinks(billing);
    if (report.conflicts.length || dryRun) throw new Undo();
  });

  try {
    run();
    report.written = true;
  } catch (err) {
    if (!(err instanceof Undo)) throw err;
  }
  return report;
}

class Undo extends Error {}

/** Every file link stored in a record, and whether billing.db has its token. */
function checkLinks(billing) {
  const tokens = new Set(billing.prepare('SELECT token FROM deliverable_tokens').all().map((r) => r.token));
  const links = { total: 0, missing: [], hosts: new Set() };
  for (const { project_id: id, data } of billing.prepare('SELECT project_id, data FROM records').all()) {
    for (const [, host, token] of data.matchAll(FILE_LINK)) {
      links.total += 1;
      if (!tokens.has(token)) links.missing.push({ projectId: id, token });
      if (host) links.hosts.add(host);
    }
  }
  links.hosts = [...links.hosts].sort();
  return links;
}

/** After an import: every hub row in billing.db, unchanged. Returns the tables that fall short. */
function verifyImport(hub, billing) {
  const short = [];
  for (const step of plan(hub, billing)) {
    if (step.absent) continue;
    const cols = step.columns.map(quote).join(', ');
    const find = billing.prepare(`SELECT ${cols} FROM ${quote(step.name)} WHERE ${step.key.map((c) => `${quote(c)} = ?`).join(' AND ')}`);
    let missing = 0;
    const rows = hub.prepare(`SELECT ${cols} FROM ${quote(step.name)}`).all();
    for (const row of rows) {
      const there = find.get(...step.key.map((c) => row[c]));
      if (!there || !sameRow(row, there, step.columns)) missing += 1;
    }
    if (missing) short.push({ table: step.name, hub: rows.length, missing });
  }
  return short;
}

/** The relative paths behind the file tokens, to check against the deliverables share. */
const tokenPaths = (billing) => billing.prepare('SELECT DISTINCT relative_path FROM deliverable_tokens ORDER BY relative_path').all().map((r) => r.relative_path);

module.exports = { importHub, verifyImport, checkLinks, tokenPaths, TABLES, NOT_COPIED };
