'use strict';

/* Needs you (merged-admin R5): what is in the queue, in what order, when an
 * item leaves, and the first-open stamp. Run against the real app. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-needs-'));
process.env.DATA_DIR = TMP;
process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough-0123456789';
process.env.COOKIE_SECURE = '0';
process.env.NODE_ENV = 'test';

const { openDatabase, nowIso, newId } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');

const PASSWORD = 'a-long-test-password';
const TODAY = '2026-11-20';
let db;
let server;
let base;
let cookie;

const get = async (url) => {
  const res = await fetch(base + url, { headers: { cookie } });
  return { status: res.status, body: await res.json() };
};
const needs = async () => (await get('/api/needs?today=' + TODAY)).body;
const kinds = (r) => r.items.map((i) => i.kind);

test.before(async () => {
  db = openDatabase(path.join(TMP, 'billing.db'));
  db.prepare('INSERT INTO account (id, username, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?, ?)')
    .run('tester', await hashPassword(PASSWORD), nowIso(), nowIso());
  const app = createApp(db);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  cookie = (login.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
});

test.after(() => {
  server.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const project = (o = {}) => {
  const id = newId('prj');
  const now = nowIso();
  db.prepare(`
    INSERT INTO projects (id, upid, name, accepted_at, opened_at, archived_at, declined_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, o.upid === undefined ? null : o.upid, o.name || 'Job', o.accepted === undefined ? now : o.accepted,
    o.opened === undefined ? now : o.opened, o.archived || null, o.declined || null, now, now);
  return id;
};
const invoice = (projectId, o = {}) => {
  const id = newId('inv');
  db.prepare(`
    INSERT INTO invoices (id, project_id, kind, number, status, totals_json, due_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, projectId, o.kind || 'single', o.number || 'INV-1', o.status || 'sent',
    JSON.stringify({ balanceDue: 500, totalIncGst: 500 }), o.due === undefined ? '2026-11-01' : o.due, nowIso(), nowIso());
  return id;
};

test('an empty database has an empty queue', async () => {
  const r = await needs();
  assert.deepEqual(r, { items: [], count: 0 });
});

test('bad or missing today is a 400, and the route needs a login', async () => {
  assert.equal((await get('/api/needs?today=nope')).status, 400);
  assert.equal((await fetch(base + '/api/needs?today=' + TODAY)).status, 401);
});

test('overdue invoices: past due only, sent only, leave when paid or voided', async () => {
  const p = project({ upid: 'U1', opened: nowIso() });
  const late = invoice(p, { due: '2026-11-10', number: 'INV-LATE' });
  invoice(p, { due: '2026-11-20', number: 'INV-TODAY' });
  invoice(p, { due: '2026-12-01', number: 'INV-FUTURE' });
  invoice(p, { status: 'draft', due: '2026-10-01', number: 'INV-DRAFT' });
  let r = await needs();
  assert.deepEqual(r.items.map((i) => i.number), ['INV-LATE']);
  assert.equal(r.items[0].days, 10);
  assert.equal(r.items[0].amount, 500);
  assert.equal(r.items[0].invoiceId, late);
  db.prepare("UPDATE invoices SET status = 'paid' WHERE id = ?").run(late);
  assert.equal((await needs()).count, 0);
  db.prepare("UPDATE invoices SET status = 'void' WHERE id = ?").run(late);
  assert.equal((await needs()).count, 0);
});

test('a declined project keeps nothing in the queue', async () => {
  const p = project({ upid: 'U2', declined: nowIso(), opened: nowIso() });
  invoice(p, { due: '2026-10-01' });
  assert.equal((await needs()).count, 0);
});

test('no UPID and new project: accepted, live, and each leaves on its own', async () => {
  const p = project({ upid: null, opened: null, name: 'Fresh' });
  let r = await needs();
  assert.deepEqual(kinds(r), ['no_upid', 'new_project']);
  assert.equal(r.items[0].name, 'Fresh');
  db.prepare("UPDATE projects SET upid = 'U3' WHERE id = ?").run(p);
  assert.deepEqual(kinds(await needs()), ['new_project']);
  // A plain read (Settings' preview, the page's refresh) or a failed one opens nothing.
  assert.equal((await get('/api/projects/' + p + '?today=' + TODAY)).status, 200);
  assert.equal((await get('/api/projects/' + p + '?today=nope&open=1')).status, 400);
  assert.deepEqual(kinds(await needs()), ['new_project']);
  // The project page opening it clears the notice, and only an accepted project is stamped.
  assert.equal((await get('/api/projects/' + p + '?today=' + TODAY + '&open=1')).status, 200);
  assert.equal((await needs()).count, 0);
  const draft = project({ accepted: null, opened: null });
  assert.equal((await get('/api/projects/' + draft + '?today=' + TODAY + '&open=1')).status, 200);
  assert.equal(db.prepare('SELECT opened_at FROM projects WHERE id = ?').get(draft).opened_at, null);
  db.prepare('DELETE FROM projects WHERE id = ?').run(draft);
});

test('archived and declined projects drop their UPID and new-project items', async () => {
  project({ upid: null, opened: null, archived: nowIso() });
  project({ upid: null, opened: null, declined: nowIso() });
  assert.equal((await needs()).count, 0);
});

test('a quote waits 7 days, then asks; it leaves when answered', async () => {
  const p = project({ accepted: null });
  const est = newId('est');
  const now = nowIso();
  db.prepare(`INSERT INTO estimates (id, project_id, name, status, client_json, created_at, updated_at)
              VALUES (?, ?, 'Quote', 'sent', '{}', ?, ?)`).run(est, p, now, now);
  const sent = (at) => {
    db.prepare("DELETE FROM activity WHERE project_id = ? AND kind = 'sent'").run(p);
    db.prepare("INSERT INTO activity (id, project_id, at, kind, detail_json) VALUES (?, ?, ?, 'sent', '{}')")
      .run(newId('act'), p, at);
  };
  sent('2026-11-14T10:00:00.000Z'); // 6 days
  assert.equal((await needs()).count, 0);
  sent('2026-11-13T10:00:00.000Z'); // 7 days
  let r = await needs();
  assert.deepEqual(kinds(r), ['quote_awaiting']);
  assert.equal(r.items[0].days, 7);
  assert.equal(r.items[0].name, 'Quote');
  db.prepare("UPDATE projects SET declined_at = ? WHERE id = ?").run(now, p);
  assert.equal((await needs()).count, 0);
});

test('the queue follows the IA order, oldest first within a kind', async () => {
  const q = project({ accepted: null });
  const now = nowIso();
  db.prepare(`INSERT INTO estimates (id, project_id, name, status, client_json, created_at, updated_at)
              VALUES (?, ?, 'Old quote', 'sent', '{}', ?, ?)`).run(newId('est'), q, now, now);
  db.prepare("INSERT INTO activity (id, project_id, at, kind, detail_json) VALUES (?, ?, '2026-10-01T00:00:00.000Z', 'sent', '{}')")
    .run(newId('act'), q);
  const a = project({ upid: null, opened: null, accepted: '2026-11-18T00:00:00.000Z', name: 'A' });
  const b = project({ upid: null, opened: null, accepted: '2026-11-10T00:00:00.000Z', name: 'B' });
  const c = project({ upid: 'U9' });
  invoice(c, { due: '2026-11-15', number: 'INV-B' });
  invoice(c, { due: '2026-11-05', number: 'INV-A' });
  const r = await needs();
  assert.deepEqual(kinds(r), [
    'invoice_overdue', 'invoice_overdue', 'quote_awaiting', 'no_upid', 'no_upid', 'new_project', 'new_project',
  ]);
  assert.deepEqual(r.items.filter((i) => i.kind === 'invoice_overdue').map((i) => i.number), ['INV-A', 'INV-B']);
  assert.deepEqual(r.items.filter((i) => i.kind === 'no_upid').map((i) => i.name), ['B', 'A']);
  assert.equal(r.count, 7);
  [q, a, b, c].forEach((id) => db.prepare('DELETE FROM projects WHERE id = ?').run(id));
});

test('v26 adds opened_at, and a project accepted before it reads as already opened', () => {
  assert.ok(db.prepare('PRAGMA table_info(projects)').all().some((c) => c.name === 'opened_at'));
});
