'use strict';

/* The Client Hub's data imported into billing.db (merge task M5), on
   throwaway databases: what comes across, that a second run changes nothing,
   that nothing already in billing.db is overwritten, that every stored file
   link keeps its token, and that backups hold every table (S16). */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-hub-import-'));
process.env.DATA_DIR = TMP;
process.env.NODE_ENV = 'test';

const Database = require('better-sqlite3');
const { openDatabase } = require('../src/db');
const { createBackup, snapshotSync } = require('../src/backup');
const { migrateV21 } = require('../src/migrations/v21-hub');
const { importHub, verifyImport } = require('../src/hub/import');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'import-hub.js');
const BASE = 'https://hub-api.lsccreative.studio';
let n = 0;
const file = (name) => path.join(TMP, `${name}-${(n += 1)}.db`);

/** A hub database in the hub's schema 6, with a little of everything. */
function makeHub({ old = false } = {}) {
  const f = file('client-hub');
  const db = new Database(f);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version', '6');");
  migrateV21(db);
  if (old) {
    // Schema 5 and before: no Bunny tables, and file tokens without `downloadable`.
    db.exec(`
      DROP TABLE bunny_assets; DROP TABLE bunny_collections; DROP TABLE deliverable_tokens;
      CREATE TABLE deliverable_tokens (token TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    `);
  }
  const record = (id, tokens) => JSON.stringify({
    id, title: `Project ${id}`,
    deliverables: tokens.map((t) => ({ name: t, url: `${BASE}/hub/files/${t}` })),
  });
  db.prepare('INSERT INTO records VALUES (?, ?, ?)').run('p1', record('p1', ['tokA', 'tokB']), '2026-10-01T02:03:04.000Z');
  db.prepare('INSERT INTO records VALUES (?, ?, ?)').run('p2', record('p2', []), '2026-11-05 23:30:00');
  db.prepare("INSERT INTO private_auth VALUES ('p1', 'client@example.com', 'eh1', 'ch1', 'inv1', 1, '2026-10-01T02:03:04.000Z')").run();
  db.prepare("INSERT INTO private_auth VALUES ('p2', '', NULL, NULL, NULL, 0, '2026-10-02T00:00:00.000Z')").run();
  if (old) {
    db.prepare("INSERT INTO deliverable_tokens VALUES ('tokA', 'Acme/Final.mp4', '2026-10-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO deliverable_tokens VALUES ('tokB', 'Acme/Cut 2.mp4', '2026-10-01T00:00:00.000Z')").run();
  } else {
    db.prepare("INSERT INTO deliverable_tokens VALUES ('tokA', 'Acme/Final.mp4', 0, '2026-10-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO deliverable_tokens VALUES ('tokB', 'Acme/Final.mp4', 1, '2026-10-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO bunny_collections VALUES ('Acme', 'col-1', '2026-10-03T00:00:00.000Z')").run();
    db.prepare("INSERT INTO bunny_assets VALUES ('Acme/Final.mp4', 'video', 'vid-1', NULL, 'col-1', 'tag1', 'ready', NULL, 1234, 5678, '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z')").run();
  }
  db.prepare(`INSERT INTO agreement_evidence VALUES ('p1', 'Pat Client', '2026-10-04T01:00:00.000Z', 'data:image/png;base64,AAAA',
    'I agree', 1, 'Mozilla/5.0', 'vt1', '203.0.113.9', '2026-10-04T01:00:01.000Z')`).run();
  db.prepare("INSERT INTO admin_sessions VALUES ('sess', '2026-10-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')").run();
  db.close();
  return { f, hub: new Database(f, { readonly: true, fileMustExist: true }) };
}

/** Every row of every table, as one hash: "changes nothing" means this stays put. */
function fingerprint(db) {
  const h = crypto.createHash('sha256');
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()) {
    h.update(name);
    for (const row of db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()) h.update(JSON.stringify(row));
  }
  return h.digest('hex');
}

const counts = (report) => Object.fromEntries(report.tables.map((t) => [t.name, t.absent ? 'absent' : [t.hub, t.added, t.same]]));
const count = (db, table) => db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();

test('every hub table comes across, its times as written, and a second run changes nothing', () => {
  const { hub } = makeHub();
  const billing = openDatabase(file('billing'));
  const first = importHub(hub, billing);
  assert.equal(first.written, true);
  assert.deepEqual(first.conflicts, []);
  assert.deepEqual(counts(first), {
    records: [2, 2, 0], private_auth: [2, 2, 0], deliverable_tokens: [2, 2, 0],
    agreement_evidence: [1, 1, 0], bunny_collections: [1, 1, 0], bunny_assets: [1, 1, 0],
  });
  assert.deepEqual(first.skipped, ['meta', 'admin_sessions']);
  assert.equal(count(billing, 'admin_sessions'), 0, 'the editor signs in again');
  assert.deepEqual(verifyImport(hub, billing), []);
  assert.equal(billing.prepare("SELECT updated_at FROM records WHERE project_id = 'p2'").pluck().get(), '2026-11-05 23:30:00',
    'a time is copied as text, never reparsed (S19)');
  assert.equal(billing.prepare("SELECT ip_address FROM agreement_evidence WHERE project_id = 'p1'").pluck().get(), '203.0.113.9');

  const before = fingerprint(billing);
  const second = importHub(hub, billing);
  assert.deepEqual(counts(second), {
    records: [2, 0, 2], private_auth: [2, 0, 2], deliverable_tokens: [2, 0, 2],
    agreement_evidence: [1, 0, 1], bunny_collections: [1, 0, 1], bunny_assets: [1, 0, 1],
  });
  assert.equal(fingerprint(billing), before, 'nothing changed');
  hub.close(); billing.close();
});

test('every file link stored in a record keeps its token, on the address it was given', () => {
  const { hub } = makeHub();
  const billing = openDatabase(file('billing'));
  const report = importHub(hub, billing);
  assert.deepEqual(report.links, { total: 2, missing: [], hosts: ['hub-api.lsccreative.studio'] });

  // A record pointing at a token the hub never had is reported, not hidden.
  const { f } = makeHub();
  const broken = new Database(f);
  broken.prepare("UPDATE records SET data = ? WHERE project_id = 'p2'").run(JSON.stringify({ url: `${BASE}/hub/files/tokGONE` }));
  broken.close();
  const hub2 = new Database(f, { readonly: true });
  const billing2 = openDatabase(file('billing'));
  const r2 = importHub(hub2, billing2);
  assert.deepEqual(r2.links.missing, [{ projectId: 'p2', token: 'tokGONE' }]);
  hub.close(); billing.close(); hub2.close(); billing2.close();
});

test('nothing already in billing.db is overwritten: a different row undoes the whole import', () => {
  const { hub } = makeHub();
  const billing = openDatabase(file('billing'));
  billing.prepare("INSERT INTO records VALUES ('p2', '{\"newer\":true}', '2026-11-06T00:00:00.000Z')").run();
  const before = fingerprint(billing);
  const report = importHub(hub, billing);
  assert.equal(report.written, false);
  assert.deepEqual(report.conflicts, [{ table: 'records', key: 'p2', reason: 'already in billing.db with different values' }]);
  assert.equal(fingerprint(billing), before, 'not even the rows that would have fitted');

  // A unique rule counts too: the same file already holding another token.
  const billing2 = openDatabase(file('billing'));
  billing2.prepare("INSERT INTO deliverable_tokens VALUES ('other', 'Acme/Final.mp4', 0, '2026-11-01T00:00:00.000Z')").run();
  const r2 = importHub(hub, billing2);
  assert.equal(r2.written, false);
  assert.equal(r2.conflicts.length, 1);
  assert.match(r2.conflicts[0].reason, /UNIQUE/);
  assert.equal(count(billing2, 'records'), 0);
  hub.close(); billing.close(); billing2.close();
});

test('an older hub, without Bunny tables or downloadable links, comes across with the defaults', () => {
  const { hub } = makeHub({ old: true });
  const billing = openDatabase(file('billing'));
  const report = importHub(hub, billing);
  assert.equal(report.written, true);
  assert.equal(counts(report).bunny_assets, 'absent');
  assert.equal(counts(report).bunny_collections, 'absent');
  assert.deepEqual(billing.prepare('SELECT token, downloadable FROM deliverable_tokens ORDER BY token').all(),
    [{ token: 'tokA', downloadable: 0 }, { token: 'tokB', downloadable: 0 }], 'review links, their only kind then');
  assert.deepEqual(verifyImport(hub, billing), []);
  hub.close(); billing.close();
});

test('a table or column the import doesn’t know stops it before anything is written', () => {
  for (const [label, sql, message] of [
    ['table', 'CREATE TABLE client_notes (id TEXT)', /tables this import doesn't know: client_notes/],
    ['column', "ALTER TABLE records ADD COLUMN archived INTEGER DEFAULT 0", /records has columns billing.db doesn't: archived/],
  ]) {
    const { f } = makeHub();
    const w = new Database(f);
    w.exec(sql);
    w.close();
    const hub = new Database(f, { readonly: true });
    const billing = openDatabase(file('billing'));
    const before = fingerprint(billing);
    assert.throws(() => importHub(hub, billing), message, label);
    assert.equal(fingerprint(billing), before, label);
    hub.close(); billing.close();
  }
});

test('a dry run reports the same and writes nothing', () => {
  const { hub } = makeHub();
  const billing = openDatabase(file('billing'));
  const before = fingerprint(billing);
  const report = importHub(hub, billing, { dryRun: true });
  assert.equal(report.written, false);
  assert.equal(counts(report).records[1], 2, 'it says what it would add');
  assert.equal(report.links.total, 2);
  assert.equal(fingerprint(billing), before);
  hub.close(); billing.close();
});

test('backups hold every table, the portal’s too, row for row (S16)', async () => {
  const { hub } = makeHub();
  const billingFile = file('billing');
  const billing = openDatabase(billingFile);
  importHub(hub, billing);
  const dir = path.join(TMP, `backups-${n}`);
  const copies = [await createBackup(billing, dir, 'nightly'), await createBackup(billing, dir, 'prewrite'),
    snapshotSync(billing, dir, 'premigrate'), snapshotSync(billing, dir, 'preimport')];
  const tables = billing.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all();
  for (const t of ['records', 'private_auth', 'deliverable_tokens', 'agreement_evidence', 'bunny_assets', 'bunny_collections', 'admin_sessions', 'estimates', 'clients']) {
    assert.ok(tables.includes(t), `${t} is a table`);
  }
  for (const copy of copies) {
    const b = new Database(copy, { readonly: true });
    for (const t of tables) assert.equal(count(b, t), count(billing, t), `${path.basename(copy)}: ${t}`);
    b.close();
  }
  hub.close(); billing.close();
});

function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8', env: { ...process.env, DATA_DIR: TMP, NODE_ENV: 'test', ...env },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('the command imports, copies billing.db first, and run again adds nothing', () => {
  const { f, hub } = makeHub();
  hub.close();
  const billingFile = file('billing');
  openDatabase(billingFile).close();

  const dry = cli(['--hub', f, '--billing', billingFile, '--dry-run']);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /Dry run clean\./);
  const backups = path.join(path.dirname(billingFile), 'backups');
  const preimports = () => (fs.existsSync(backups) ? fs.readdirSync(backups).filter((x) => x.startsWith('preimport-')) : []);
  assert.equal(preimports().length, 0, 'a dry run copies nothing');

  const first = cli(['--hub', f, '--billing', billingFile], { TZ: 'America/New_York' });
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /records\s+2\s+2\s+0/);
  assert.match(first.out, /Checked: every hub row is in billing\.db, unchanged\./);
  assert.match(first.out, /File links stored in records: 2, on hub-api\.lsccreative\.studio; tokens missing: 0/);
  assert.match(first.out, /TZ is set \(America\/New_York\)/);
  assert.equal(preimports().length, 1, 'billing.db is copied before writing');

  const again = cli(['--hub', f, '--billing', billingFile]);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /records\s+2\s+0\s+2/);
  assert.match(again.out, /Done\./);

  const listed = cli(['--hub', f, '--list-paths']);
  assert.deepEqual([listed.code, listed.out], [0, 'Acme/Final.mp4\n'], 'only the paths, nothing imported');

  const share = path.join(TMP, `share-${n}`);
  fs.mkdirSync(path.join(share, 'Acme'), { recursive: true });
  fs.writeFileSync(path.join(share, 'Acme', 'Final.mp4'), 'x');
  const checked = cli(['--hub', f, '--billing', billingFile, '--dry-run', '--deliverables', share]);
  assert.equal(checked.code, 0, checked.out);
  assert.match(checked.out, /1 of 1 there/);
  fs.unlinkSync(path.join(share, 'Acme', 'Final.mp4'));
  const gone = cli(['--hub', f, '--billing', billingFile, '--dry-run', '--deliverables', share]);
  assert.equal(gone.code, 1);
  assert.match(gone.out, /not found: Acme\/Final\.mp4/);
});

test('the command exits 1 on a conflict and 2 when it can’t start', () => {
  const { f, hub } = makeHub();
  hub.close();
  const billingFile = file('billing');
  const b = openDatabase(billingFile);
  b.prepare("INSERT INTO records VALUES ('p1', '{}', 'x')").run();
  b.close();
  const conflict = cli(['--hub', f, '--billing', billingFile]);
  assert.equal(conflict.code, 1, conflict.out);
  assert.match(conflict.out, /1 conflict\(s\); nothing was written:\n {2}records p1/);
  assert.equal(cli([]).code, 2);
  assert.equal(cli(['--hub', path.join(TMP, 'nope.db'), '--billing', billingFile]).code, 2);
  assert.equal(cli(['--hub', f, '--billing', path.join(TMP, 'none.db')]).code, 2);
});
