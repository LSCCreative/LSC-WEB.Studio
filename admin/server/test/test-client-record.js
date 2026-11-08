'use strict';

/* The client record (merged-admin R2): the list's search and counts, Live
 * projects by state, Archive and unarchive, the Invoice index, and the one
 * login identity (S13). Run against the real app on a throwaway database. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-client-record-'));
process.env.DATA_DIR = TMP;
process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough-0123456789';
process.env.COOKIE_SECURE = '0';
process.env.NODE_ENV = 'test';

const { openDatabase, migrate, nowIso, newId } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');
const { sha256Hex } = require('../src/hub/tokens');

const PASSWORD = 'a-long-test-password';
let db;
let server;
let base;
let cookie;

const api = (url, options = {}) => fetch(base + url, {
  ...options,
  headers: { 'content-type': 'application/json', cookie, ...(options.headers || {}) },
});
const get = async (url) => {
  const res = await api(url);
  return { status: res.status, body: await res.json() };
};
const send = async (method, url, body) => {
  const res = await api(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const post = (url, body) => send('POST', url, body);
const put = (url, body) => send('PUT', url, body);

test.before(async () => {
  db = openDatabase(path.join(TMP, 'billing.db'));
  db.prepare(`
    INSERT INTO account (id, username, password_hash, created_at, updated_at) VALUES (1, 'tester', ?, ?, ?)
  `).run(await hashPassword(PASSWORD), nowIso(), nowIso());
  const app = createApp(db);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.getSetCookie()[0].split(';')[0];
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const client = async (businessName, email = '') =>
  (await post('/api/clients', { businessName, email })).body.client;

/* A project of `clientId`, straight in the tables: what's under test here is
   how it is read, not how a quote gets accepted. */
function project(clientId, { name, upid, accepted = true, noDeliverables = false, items = 0 }) {
  const now = nowIso();
  const id = newId('prj');
  db.prepare(`
    INSERT INTO projects (id, upid, client_id, needs_upid, accepted_at, no_deliverables_at, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?, ?, ?)
  `).run(id, upid, clientId, accepted ? now : null, noDeliverables ? now : null, now, now);
  db.prepare(`
    INSERT INTO estimates (id, project_id, upid, name, date, status, client_id, client_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, '2026-10-01', ?, ?, '{}', ?, ?)
  `).run(newId('est'), id, upid, name, accepted ? 'accepted' : 'draft', clientId, now, now);
  for (let i = 1; i <= items; i++) {
    db.prepare(`
      INSERT INTO deliverables (id, project_id, position, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(newId('dlv'), id, i, 'Cut ' + i, now, now);
  }
  return id;
}

function invoice(projectId, { kind = 'single', number, status = 'sent', amount = 1100, issuedAt = '2026-09-01', dueAt = '2026-09-15', paidAt = null }) {
  const id = newId('inv');
  const now = nowIso();
  db.prepare(`
    INSERT INTO invoices (id, project_id, kind, number, status, totals_json, issued_at, due_at, paid_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, projectId, kind, number, status, JSON.stringify({ totalIncGst: amount, balanceDue: amount }), issuedAt, dueAt, paidAt, now, now);
  return id;
}

const list = async (params) => (await get('/api/projects?' + new URLSearchParams({ today: '2026-10-04', ...params }))).body;
const ids = (reply) => reply.projects.map((p) => p.id).sort();
const sorted = (...values) => values.slice().sort();

test('email: one spelling, whichever way it comes in', async () => {
  const a = await client('Spelling Ltd', '  Sam@Spelling.Example ');
  assert.equal(a.email, 'sam@spelling.example');
  const edited = await put(`/api/clients/${a.id}`, { businessName: 'Spelling Ltd', email: ' NEW@spelling.example' });
  assert.equal(edited.body.client.email, 'new@spelling.example');
  const upserted = await post('/api/clients/upsert', { businessName: 'Upsert Ltd', email: 'UP@Spelling.Example' });
  assert.equal(upserted.body.client.email, 'up@spelling.example');
});

test('S13: a second client can\'t take an address, however it is spelled', async () => {
  const a = await client('Holder Ltd', 'one@login.example');
  const taken = await post('/api/clients', { businessName: 'Second Ltd', email: ' ONE@login.example ' });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error, 'email_taken');
  assert.equal(taken.body.holder.id, a.id);
  assert.match(taken.body.message, /Holder Ltd/);

  const b = await client('Third Ltd', 'three@login.example');
  const moved = await put(`/api/clients/${b.id}`, { businessName: 'Third Ltd', email: 'one@login.example' });
  assert.equal(moved.status, 409);
  assert.equal((await get(`/api/clients/${b.id}`)).body.client.email, 'three@login.example');

  const upsert = await post('/api/clients/upsert', { businessName: 'Fourth Ltd', email: 'one@login.example' });
  assert.equal(upsert.status, 409);

  // A client keeps their own, and any number of clients can have none.
  assert.equal((await put(`/api/clients/${a.id}`, { businessName: 'Holder Pty', email: 'ONE@login.example' })).status, 200);
  assert.equal((await post('/api/clients', { businessName: 'No Mail A' })).status, 201);
  assert.equal((await post('/api/clients', { businessName: 'No Mail B' })).status, 201);
});

test('S13: two clients already on one address can still be saved, and each record says so', async () => {
  const now = nowIso();
  const insert = db.prepare(`
    INSERT INTO clients (id, business_name, contact_name, email, phone, abn, address, notes, created_at, updated_at)
    VALUES (?, ?, '', 'shared@old.example', '', '', '', '', ?, ?)
  `);
  insert.run('cl_old_a', 'Old A', now, now);
  insert.run('cl_old_b', 'Old B', now, now);
  const a = await get('/api/clients/cl_old_a');
  assert.deepEqual(a.body.client.emailSharedWith, [{ id: 'cl_old_b', businessName: 'Old B' }]);
  // The list hands its row to the record, so it says the same.
  const row = (await get('/api/clients/summary?q=old a')).body.clients[0];
  assert.deepEqual(row.emailSharedWith, [{ id: 'cl_old_b', businessName: 'Old B' }]);
  const phone = await put('/api/clients/cl_old_a', { businessName: 'Old A', email: 'shared@old.example', phone: '0400' });
  assert.equal(phone.status, 200);
  const fixed = await put('/api/clients/cl_old_a', { businessName: 'Old A', email: 'a@old.example' });
  assert.deepEqual(fixed.body.client.emailSharedWith, []);
});

test('S13: changing a client\'s email moves their portal login with it, and a login needs one', async () => {
  const a = await client('Login Ltd', 'before@login.example');
  const p = project(a.id, { name: 'Login job', upid: 'LOG-1' });
  const now = nowIso();
  db.prepare("INSERT INTO records (project_id, data, updated_at) VALUES (?, '{}', ?)").run(p, now);
  db.prepare(`
    INSERT INTO private_auth (project_id, client_email, email_hash, updated_at) VALUES (?, ?, ?, ?)
  `).run(p, 'before@login.example', sha256Hex('before@login.example'), now);

  assert.equal((await put(`/api/clients/${a.id}`, { businessName: 'Login Ltd', email: 'After@Login.example' })).status, 200);
  const row = db.prepare('SELECT client_email, email_hash FROM private_auth WHERE project_id = ?').get(p);
  assert.deepEqual([row.client_email, row.email_hash], ['after@login.example', sha256Hex('after@login.example')]);

  const empty = await put(`/api/clients/${a.id}`, { businessName: 'Login Ltd', email: '' });
  assert.equal(empty.status, 409);
  assert.equal(empty.body.error, 'email_required');

  // Someone else's login is left alone.
  const other = await client('Other Ltd', 'other@login.example');
  await put(`/api/clients/${other.id}`, { businessName: 'Other Ltd', email: 'moved@login.example' });
  assert.equal(db.prepare('SELECT client_email FROM private_auth WHERE project_id = ?').get(p).client_email, 'after@login.example');
});

test('v23 gives what was already there one spelling, and leaves a shared address alone', () => {
  const now = nowIso();
  db.prepare(`
    INSERT INTO clients (id, business_name, contact_name, email, phone, abn, address, notes, created_at, updated_at)
    VALUES ('cl_v23', 'V23 Ltd', '', '  MiXeD@V23.Example ', '', '', '', '', ?, ?)
  `).run(now, now);
  db.prepare('DELETE FROM schema_version WHERE version >= 23').run();
  migrate(db, { backupDir: false });
  assert.equal(db.prepare("SELECT email FROM clients WHERE id = 'cl_v23'").get().email, 'mixed@v23.example');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM clients WHERE email = 'shared@old.example'").get().n, 1);
});

test('the Clients list counts live projects and finds a client through a project\'s name or UPID', async () => {
  const a = await client('Search Harbour', 'hello@harbour.example');
  const live = project(a.id, { name: 'Lighthouse film', upid: 'SRCH-LIVE', items: 1 });
  const done = project(a.id, { name: 'Old regatta', upid: 'SRCH-DONE', noDeliverables: true });
  project(a.id, { name: 'A quote', upid: 'SRCH-QUOTE', accepted: false });
  const bare = await client('Search Empty');
  assert.ok(live && done);

  const all = (await get('/api/clients/summary')).body;
  const row = all.clients.find((c) => c.id === a.id);
  assert.deepEqual([row.liveCount, row.projectCount], [1, 3]);
  assert.deepEqual(row.matches, []);
  assert.equal(all.clients.find((c) => c.id === bare.id).liveCount, 0);
  assert.equal(all.total, all.clients.length);

  const byName = (await get('/api/clients/summary?q=REGATTA')).body;
  assert.deepEqual(byName.clients.map((c) => c.id), [a.id]);
  assert.deepEqual(byName.clients[0].matches.map((m) => [m.upid, m.name]), [['SRCH-DONE', 'Old regatta']]);
  const byUpid = (await get('/api/clients/summary?q=srch-live')).body;
  assert.deepEqual(byUpid.clients[0].matches.map((m) => m.id), [live]);

  // The client's own fields find it too, naming no project.
  const own = (await get('/api/clients/summary?q=hello@harbour')).body;
  assert.deepEqual([own.clients[0].id, own.clients[0].matches], [a.id, []]);
  const many = (await get('/api/clients/summary?q=srch')).body;
  assert.deepEqual([many.clients[0].matches.length, many.clients[0].moreMatches], [2, 1]);
  assert.equal((await get('/api/clients/summary?q=nothing-called-this')).body.clients.length, 0);
});

test('Live projects is the state model\'s Live group: never Complete or Archived, with its filters', async () => {
  const a = await client('State Co');
  const empty = project(a.id, { name: 'Empty checklist', upid: 'ST-EMPTY' });
  const open = project(a.id, { name: 'Open items', upid: 'ST-OPEN', items: 2 });
  const owing = project(a.id, { name: 'Deposit owed', upid: 'ST-OWE', items: 1 });
  invoice(owing, { kind: 'deposit', number: 'INV-ST-OWE-D' });
  const paidOpen = project(a.id, { name: 'Paid, items open', upid: 'ST-PAIDOPEN', items: 1 });
  invoice(paidOpen, { number: 'INV-ST-PAIDOPEN', status: 'paid', paidAt: '2026-09-02' });
  const complete = project(a.id, { name: 'Done', upid: 'ST-DONE', noDeliverables: true });
  invoice(complete, { number: 'INV-ST-DONE', status: 'paid', paidAt: '2026-09-02' });
  const review = project(a.id, { name: 'In review', upid: 'ST-REVIEW', items: 1 });
  const item = db.prepare('SELECT id FROM deliverables WHERE project_id = ?').get(review).id;
  db.prepare(`
    INSERT INTO deliverable_versions (id, deliverable_id, project_id, n, stage, published_at, created_at)
    VALUES (?, ?, ?, 1, 'draft', ?, ?)
  `).run(newId('ver'), item, review, nowIso(), nowIso());

  const q = 'st-';
  const live = await list({ stage: 'live', q });
  assert.deepEqual(ids(live), sorted(empty, open, owing, paidOpen, review));
  assert.equal(live.projects.find((p) => p.id === open).delivery.label, 'In production');
  assert.deepEqual(ids(await list({ stage: 'in-review', q })), [review]);
  assert.deepEqual(ids(await list({ stage: 'in-production', q })), sorted(empty, open, owing, paidOpen));
  assert.deepEqual(ids(await list({ stage: 'payment-due', q })), [owing]);
  assert.deepEqual(ids(await list({ stage: 'revisions', q })), []);
  assert.deepEqual(ids(await list({ stage: 'complete', q })), [complete]);
  assert.equal(live.counts['payment-due'], 1);
  assert.equal(live.counts.live, 5);

  // A client's page reads one list, and Done isn't under the Dashboard's Open.
  assert.deepEqual(ids(await list({ client: a.id, stage: 'current' })), sorted(empty, open, owing, paidOpen, review, complete));
  assert.ok(!ids(await list({ stage: 'open', q })).includes(complete));
  assert.ok(ids(await list({ stage: 'open', q })).includes(paidOpen));
});

test('archive: Complete only; archived work leaves the client\'s current list and comes back Complete', async () => {
  const a = await client('Archive Co');
  const done = project(a.id, { name: 'Filed job', upid: 'AR-DONE', noDeliverables: true });
  const open = project(a.id, { name: 'Open job', upid: 'AR-OPEN', items: 1 });
  const quote = project(a.id, { name: 'A quote', upid: 'AR-QUOTE', accepted: false });

  const refused = await post(`/api/projects/${open}/archive`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'not_complete');
  assert.match(refused.body.message, /In production/);
  assert.equal((await post(`/api/projects/${quote}/archive`)).status, 409);
  assert.equal(db.prepare('SELECT archived_at FROM projects WHERE id = ?').get(open).archived_at, null);
  assert.equal((await post('/api/projects/nope/archive')).status, 404);

  const archived = await post(`/api/projects/${done}/archive`);
  assert.equal(archived.status, 200);
  assert.equal(archived.body.project.delivery.badge, 'archived');
  assert.ok(archived.body.activity.some((e) => e.kind === 'archived'));
  // Twice is the same as once: no second log row.
  await post(`/api/projects/${done}/archive`);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity WHERE project_id = ? AND kind = 'archived'").get(done).n, 1);

  const current = await list({ client: a.id, stage: 'current' });
  assert.ok(!ids(current).includes(done));
  assert.equal(current.counts.archived, 1);
  assert.deepEqual(ids(await list({ client: a.id, stage: 'archived' })), [done]);
  // Still found by search, and never in Live.
  assert.ok(!ids(await list({ stage: 'live', q: 'ar-done' })).includes(done));
  assert.equal((await get('/api/clients/summary?q=ar-done')).body.clients[0].matches[0].archived, true);

  const back = await post(`/api/projects/${done}/unarchive`);
  assert.equal(back.status, 200);
  assert.equal(back.body.project.delivery.badge, 'complete');
  assert.deepEqual(ids(await list({ client: a.id, stage: 'complete' })), [done]);
});

test('delete refusals point at Archive', async () => {
  const a = await client('Refusal Co');
  const p = project(a.id, { name: 'Held job', upid: 'REF-1', items: 1 });
  const del = await send('DELETE', `/api/projects/${p}`);
  assert.equal(del.status, 409);
  assert.match(del.body.message, /archive/i);
  const clientDel = await send('DELETE', `/api/clients/${a.id}`);
  assert.equal(clientDel.status, 409);
  assert.match(clientDel.body.message, /archive/i);
  assert.equal((await get(`/api/clients/${a.id}`)).body.client.projectCount, 1);
});

test('the Invoice index is the client\'s own invoices, newest first, with what is owed and paid', async () => {
  const a = await client('Invoice Co');
  const b = await client('Someone Else');
  const p = project(a.id, { name: 'Billed job', upid: 'IDX-1' });
  invoice(p, { kind: 'deposit', number: 'INV-IDX-1-D', status: 'paid', amount: 500, issuedAt: '2026-08-01', paidAt: '2026-08-03' });
  invoice(p, { kind: 'final', number: 'INV-IDX-1-F', status: 'sent', amount: 1500.5, issuedAt: '2026-09-01' });
  invoice(p, { kind: 'single', number: 'INV-IDX-1-V', status: 'void', amount: 9000, issuedAt: '2026-07-01' });
  invoice(p, { kind: 'single', number: 'INV-IDX-1-X', status: 'draft', amount: 7000, issuedAt: null, dueAt: null });
  invoice(p, { kind: 'legacy', number: 'OLD-1', status: 'draft', amount: 200, issuedAt: '2026-01-01', dueAt: null });
  const other = project(b.id, { name: 'Not theirs', upid: 'IDX-2' });
  invoice(other, { number: 'INV-IDX-2' });

  const reply = (await get(`/api/clients/${a.id}/invoices`)).body;
  // The draft has no issue date, so its creation date (today) puts it first.
  assert.deepEqual(reply.invoices.map((i) => i.number),
    ['INV-IDX-1-X', 'INV-IDX-1-F', 'INV-IDX-1-D', 'INV-IDX-1-V', 'OLD-1']);
  assert.equal(reply.outstanding, 1700.5);
  assert.equal(reply.paid, 500);
  assert.deepEqual([reply.invoices[1].project.upid, reply.invoices[1].project.name], ['IDX-1', 'Billed job']);
  assert.deepEqual((await get(`/api/clients/${(await client('No Bills')).id}/invoices`)).body.invoices, []);
  assert.equal((await get('/api/clients/nope/invoices')).status, 404);
});
