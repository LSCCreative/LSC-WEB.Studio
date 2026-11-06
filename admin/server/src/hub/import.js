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
   - Afterwards every hub row is checked as present in billing.db, every file
     link stored in a record (…/hub/files/<token>) as having its token, and,
     given the share, every token as servable the way GET /hub/files decides.
     A link or file that was already dead on the hub is a warning, not a
     failed import: the import can't mend it, and rerunning won't either.

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

/**
 * Throws unless `hub` looks like the Client Hub's database: some of its tables
 * and nothing else. Needs only the hub, so it runs before billing.db is opened.
 */
function checkHub(hub) {
  const hubTables = tablesOf(hub);
  const known = new Set([...TABLES.map((t) => t.name), ...NOT_COPIED]);
  const unknown = [...hubTables].filter((t) => !known.has(t) && !t.startsWith('sqlite_'));
  if (unknown.length) throw new Error(`The hub database has tables this import doesn't know: ${unknown.join(', ')}. Nothing was copied.`);
  if (!TABLES.some((t) => hubTables.has(t.name))) {
    throw new Error('That isn\'t the Client Hub\'s database: it has none of the hub\'s tables. Nothing was copied.');
  }
  return hubTables;
}

/** The hub's own schema version, or null when it has no meta table. */
function hubVersion(hub) {
  if (!tablesOf(hub).has('meta')) return null;
  return hub.prepare("SELECT value FROM meta WHERE key = 'schema_version'").pluck().get() || null;
}

/** The columns to copy for each table the hub has, or an error naming what billing lacks. */
function plan(hub, billing) {
  const hubTables = checkHub(hub);
  const billingTables = tablesOf(billing);

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
 * One table's hub rows, and how each stands in billing.db: 'missing', 'same'
 * or 'differs'. The one definition of "this hub row is in billing.db
 * unchanged", for the import and the check after it alike.
 */
function compare(hub, billing, step) {
  const cols = step.columns.map(quote).join(', ');
  const rows = hub.prepare(`SELECT ${cols} FROM ${quote(step.name)}`).all();
  const find = billing.prepare(`SELECT ${cols} FROM ${quote(step.name)} WHERE ${step.key.map((c) => `${quote(c)} = ?`).join(' AND ')}`);
  return {
    rows,
    statusOf(row) {
      const there = find.get(...step.key.map((c) => row[c]));
      if (!there) return 'missing';
      return sameRow(row, there, step.columns) ? 'same' : 'differs';
    },
  };
}

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
      const { rows, statusOf } = compare(hub, billing, step);
      const insert = billing.prepare(`INSERT INTO ${quote(step.name)} (${step.columns.map(quote).join(', ')}) VALUES (${step.columns.map(() => '?').join(', ')})`);
      const counts = { name: step.name, hub: rows.length, added: 0, same: 0 };
      for (const row of rows) {
        const status = statusOf(row);
        if (status === 'same') {
          counts.same += 1;
          continue;
        }
        if (status === 'differs') {
          report.conflicts.push({ table: step.name, key: keyOf(row, step.key), reason: 'already in billing.db with different values' });
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
    report.links = checkLinks(billing, hub);
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

const tokensIn = (db) => (tablesOf(db).has('deliverable_tokens')
  ? new Set(db.prepare('SELECT token FROM deliverable_tokens').pluck().all())
  : new Set());

/**
 * Every file link stored in a record, and whether billing.db has its token.
 * `missing` are links the import lost (an error); `dead` were already dead on
 * the hub, whose own tokens didn't include them (a warning).
 */
function checkLinks(billing, hub) {
  const tokens = tokensIn(billing);
  const hubTokens = hub ? tokensIn(hub) : new Set();
  const links = { total: 0, missing: [], dead: [], hosts: new Set() };
  for (const { project_id: id, data } of billing.prepare('SELECT project_id, data FROM records').all()) {
    for (const [, host, token] of data.matchAll(FILE_LINK)) {
      links.total += 1;
      if (!tokens.has(token)) (hubTokens.has(token) || !hub ? links.missing : links.dead).push({ projectId: id, token });
      if (host) links.hosts.add(host);
    }
  }
  links.hosts = [...links.hosts].sort();
  return links;
}

/**
 * Every file token, as GET /hub/files/:token would answer it: billing.db must
 * hold it, and `resolve` (deliverables.js resolveDeliverablePath over the
 * share) must find a real file inside the share for its path.
 * Returns { total, servable, lost: [tokens billing lacks], noFile: [{ token, path }] }.
 */
function checkTokens(billing, hub, resolve) {
  const held = tokensIn(billing);
  const source = tablesOf(hub).has('deliverable_tokens') ? hub : billing;
  const rows = source.prepare('SELECT token, relative_path FROM deliverable_tokens ORDER BY relative_path, token').all();
  const result = { total: rows.length, servable: 0, lost: [], noFile: [] };
  for (const { token, relative_path: rel } of rows) {
    if (!held.has(token)) result.lost.push(token);
    else if (!resolve(rel)) result.noFile.push({ token, path: rel });
    else result.servable += 1;
  }
  return result;
}

/** After an import: every hub row in billing.db, unchanged. Returns the tables that fall short. */
function verifyImport(hub, billing) {
  const short = [];
  for (const step of plan(hub, billing)) {
    if (step.absent) continue;
    const { rows, statusOf } = compare(hub, billing, step);
    const missing = rows.filter((row) => statusOf(row) !== 'same').length;
    if (missing) short.push({ table: step.name, hub: rows.length, missing });
  }
  return short;
}

/** The relative paths behind the file tokens, to check against the deliverables share. */
const tokenPaths = (billing) => billing.prepare('SELECT DISTINCT relative_path FROM deliverable_tokens ORDER BY relative_path').all().map((r) => r.relative_path);

module.exports = { importHub, verifyImport, checkHub, hubVersion, checkLinks, checkTokens, tokenPaths, TABLES, NOT_COPIED };
