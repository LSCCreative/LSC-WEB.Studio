'use strict';

/* The old hub's projects onto billing's records (merged-admin R4), on the real
 * app and a throwaway database. The hub data here is made up. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-hub-adopt-'));
process.env.DATA_DIR = TMP;
process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough-0123456789';
process.env.COOKIE_SECURE = '0';
process.env.NODE_ENV = 'test';

const { openDatabase, nowIso, newId } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');
const { migrateV25 } = require('../src/migrations/v25-hub-adoption');
const { sha256Hex } = require('../src/hub/tokens');

const PASSWORD = 'a-long-test-password';
const IMPORT = '/api/setup/hub-import';
let db;
let server;
let base;
let cookie;

const call = async (method, url, body, headers = { cookie }) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: res.status, body: json, text };
};

test.before(async () => {
  db = openDatabase(path.join(TMP, 'billing.db'));
  db.prepare("INSERT INTO account (id, username, password_hash, created_at, updated_at) VALUES (1, 'tester', ?, ?, ?)")
    .run(await hashPassword(PASSWORD), nowIso(), nowIso());
  // The portal is mounted for real, so "the old publish route is gone" is a 404
  // from it, not the 503 an app without the portal's secret answers.
  const deliverablesDir = path.join(TMP, 'deliverables');
  fs.mkdirSync(deliverablesDir, { recursive: true });
  const app = createApp(db, {
    deliverablesDir,
    hub: {
      signingSecret: 'test-signing-secret', corsOrigins: [], publicBaseUrl: 'https://hub.example',
      deliverablesDir, backupDir: path.join(TMP, 'backups'), bunny: {},
    },
  });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: PASSWORD }),
  });
  cookie = login.headers.getSetCookie()[0].split(';')[0];
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

let serial = 0;
const uniq = (prefix) => { serial += 1; return `${prefix}${serial}`; };

function client(name, email) {
  const id = newId('cl');
  const now = nowIso();
  db.prepare(`INSERT INTO clients (id, business_name, contact_name, email, phone, abn, address, notes, created_at, updated_at)
              VALUES (?, ?, '', ?, '', '', '', '', ?, ?)`).run(id, name, email, now, now);
  return id;
}

/* A hub project as the browser holds it. */
function hubProject(over = {}) {
  const id = over.id || uniq('hub');
  return {
    id, upid: `HUB-${id}`, name: `Job ${id}`, clientName: '', clientEmail: '', message: '',
    invoices: [], assets: [], clientCode: '4821', inviteToken: 'plain-invite-token',
    delivered: false, publishedAt: null, ...over,
  };
}

/* The hub's server rows for a project: what M5 copied across. */
function published(p, { email = p.clientEmail, signed = false } = {}) {
  const now = '2026-09-01T00:00:00.000Z';
  db.prepare('INSERT INTO records (project_id, data, updated_at) VALUES (?, ?, ?)').run(p.id, JSON.stringify({
    id: p.id, upid: p.upid, name: p.name, message: p.message, invoices: p.invoices, delivered: p.delivered, assets: p.assets,
  }), now);
  db.prepare('INSERT INTO private_auth (project_id, client_email, email_hash, code_hash, invite_token, delivered, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .run(p.id, email, email ? sha256Hex(email) : null, sha256Hex('4821'), uniq('invite'), now);
  if (signed) {
    db.prepare(`INSERT INTO agreement_evidence (project_id, signer_name, signed_at, signature_data_url, consent_text,
                  consent_checked, user_agent, verification_token, ip_address, received_at)
                VALUES (?, 'A Signer', '2026-09-02', 'data:image/png;base64,AAAA', 'I agree', 1, 'UA', 'tok', '1.2.3.4', ?)`).run(p.id, now);
  }
}

const rowOf = (reply, id) => reply.body.rows.find((r) => r.id === id);
const run = (projects, decisions) => call('POST', IMPORT, { projects, decisions });
const linkOf = (hubId) => db.prepare('SELECT * FROM hub_imports WHERE hub_id = ?').get(hubId);
const folderOf = (projectId) => call('GET', `/api/projects/${projectId}`);

test('the screen and its calls are behind the login', async () => {
  for (const [method, url] of [['GET', IMPORT], ['POST', `${IMPORT}/read`], ['POST', IMPORT]]) {
    const reply = await call(method, url, method === 'POST' ? { projects: [] } : undefined, {});
    assert.equal(reply.status, 401, `${method} ${url}`);
  }
});

test('a list bigger than the normal body limit is read, because signatures are big', async () => {
  const big = hubProject({ agreement: { accepted: true, signatureDataUrl: `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}` } });
  const reply = await call('POST', `${IMPORT}/read`, { projects: [big] });
  assert.equal(reply.status, 200);
  assert.ok(rowOf(reply, big.id));
});

test('what isn’t the hub’s list is refused, and a read writes nothing', async () => {
  const notAList = await call('POST', `${IMPORT}/read`, { projects: { nope: true } });
  assert.equal(notAList.status, 400);
  assert.equal(notAList.body.error, 'not_hub_data');
  const noIds = await call('POST', `${IMPORT}/read`, { projects: [{ name: 'no id' }] });
  assert.equal(noIds.status, 400);

  const before = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
  const p = hubProject({ clientEmail: 'nobody@example.com' });
  await call('POST', `${IMPORT}/read`, { projects: [p] });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, before);
  assert.equal(linkOf(p.id), undefined);
});

test('email decides the client: one holder matches, anything else waits for a person', async () => {
  const email = `${uniq('solo')}@example.com`;
  const acme = client('Acme Solo', email);
  const shared = `${uniq('shared')}@example.com`;
  client('Shared One', shared);
  client('Shared Two', shared);

  const matched = hubProject({ clientEmail: ` ${email.toUpperCase()} ` });
  const noEmail = hubProject({ clientEmail: '' });
  const unknown = hubProject({ clientEmail: `${uniq('new')}@example.com`, clientName: 'Brand New Co' });
  const sharing = hubProject({ clientEmail: shared });
  const reply = await call('POST', `${IMPORT}/read`, { projects: [matched, noEmail, unknown, sharing] });

  assert.equal(rowOf(reply, matched.id).state, 'ready');
  assert.equal(rowOf(reply, matched.id).client.id, acme);
  assert.equal(rowOf(reply, noEmail.id).state, 'decide');
  assert.equal(rowOf(reply, noEmail.id).reason, 'no_email');
  assert.equal(rowOf(reply, unknown.id).reason, 'no_match');
  assert.equal(rowOf(reply, unknown.id).createAs, 'Brand New Co');
  assert.equal(rowOf(reply, sharing.id).reason, 'shared_email');
  assert.equal(rowOf(reply, sharing.id).canCreate, false, 'a third client on a shared address would make it worse');
  assert.equal(reply.body.rows[0].state, 'decide', 'what needs a person comes first');
});

test('a matched project imports whole: accepted, checklist, files, and Payment required off', async () => {
  const email = `${uniq('whole')}@example.com`;
  const acme = client('Whole Co', email);
  const p = hubProject({
    clientEmail: email,
    publishedAt: '2026-08-01T00:00:00.000Z',
    assets: [
      { id: 'a1', type: 'video', title: 'Hero', status: 'reviewing', deliverablePath: '/volume4/LSC Creative_Media/Client Deliverables_Media/Whole/Hero.mp4', reviewLink: 'https://x/hub/files/t', comments: [{ text: 'Trim the end', at: '2 Aug', timestamp: 12 }] },
      { id: 'a2', type: 'video', title: 'Teaser', status: 'approved', deliverablePath: 'Whole/Teaser.mp4', downloadLink: 'https://x/d', driveLink: 'https://drive.example/teaser' },
      { id: 'a3', type: 'photo', title: 'Stills', status: 'changes', deliverablePath: 'Whole/Stills', photos: [{ name: 'a.jpg' }, { name: 'b.jpg' }] },
      { id: 'a4', type: 'video', title: '', status: 'reviewing' },
    ],
    invoices: [{ id: 'i', type: 'deposit', name: 'deposit.pdf', url: '' }],
    message: 'Thanks for the shoot',
  });
  // The client's record has all but the browser's newest draft, Hero.
  published({ ...p, assets: p.assets.filter((a) => a.id !== 'a1') });

  const reply = await run([p], [{ id: p.id }]);
  assert.equal(reply.status, 200);
  assert.equal(reply.body.result.imported, 1);
  const link = linkOf(p.id);
  assert.equal(link.outcome, 'imported');
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(link.project_id);
  assert.equal(row.client_id, acme);
  assert.equal(row.upid, p.upid);
  assert.equal(row.name, p.name);
  assert.equal(row.payment_required, 0);
  assert.equal(row.accepted_at, '2026-08-01T00:00:00.000Z');

  const folder = await folderOf(row.id);
  assert.equal(folder.status, 200);
  assert.equal(folder.body.project.name, p.name, 'the name, with no estimate to give it');
  assert.equal(folder.body.project.stage, 'accepted');
  const items = folder.body.deliverables;
  assert.deepEqual(items.map((i) => i.title), ['Hero', 'Teaser', 'Stills', 'Video']);
  assert.equal(items[0].versions[0].sourcePath, 'Whole/Hero.mp4');
  assert.equal(items[0].versions[0].publishedAt, null, 'not in the client’s record');
  assert.equal(items[1].hubStatus, 'approved');
  assert.equal(items[1].stage, 'final');
  assert.equal(items[1].versions[0].driveLink, 'https://drive.example/teaser');
  assert.equal(items[2].hubStatus, 'changes');
  assert.equal(items[2].versions[0].kind, 'photos');
  assert.equal(items[2].versions[0].photoCount, 2);
  assert.deepEqual(items[3].versions, [], 'no file and no link is no version');
  assert.equal(folder.body.project.delivery.badge, 'revisions', 'changes asked on the hub still stand');
  assert.deepEqual(folder.body.hub.invoices, [{ type: 'deposit', name: 'deposit.pdf', url: '' }]);
  assert.equal(folder.body.hub.message, 'Thanks for the shoot');
  assert.equal(folder.body.hub.notes[0].text, 'Trim the end');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE project_id = ?').get(row.id).n, 0, 'no money made');
});

test('a client’s code and invite token never reach the database or a reply', async () => {
  const email = `${uniq('secret')}@example.com`;
  client('Secret Co', email);
  const p = hubProject({ clientEmail: email, clientCode: '9137', inviteToken: 'never-store-this-token' });
  const read = await call('POST', `${IMPORT}/read`, { projects: [p] });
  assert.ok(!read.text.includes('9137') && !read.text.includes('never-store-this-token'));
  const done = await run([p], [{ id: p.id }]);
  assert.ok(!done.text.includes('9137') && !done.text.includes('never-store-this-token'));
  const stored = linkOf(p.id).source_json;
  assert.ok(!stored.includes('9137') && !stored.includes('never-store-this-token'));
  const folder = await folderOf(linkOf(p.id).project_id);
  assert.ok(!folder.text.includes('9137') && !folder.text.includes('never-store-this-token'));
});

test('importing is once: a later copy changes nothing on the record the studio has moved on', async () => {
  const email = `${uniq('once')}@example.com`;
  client('Once Co', email);
  const p = hubProject({ clientEmail: email, assets: [{ id: 'a', type: 'video', title: 'Cut', deliverablePath: 'Once/Cut.mp4', status: 'reviewing' }] });
  await run([p], [{ id: p.id }]);
  const { project_id: projectId } = linkOf(p.id);

  // The studio works on it.
  const [item] = (await folderOf(projectId)).body.deliverables;
  const renamed = await call('PUT', `/api/projects/${projectId}/deliverables/${item.id}`, { title: 'Renamed' });
  assert.equal(renamed.status, 200);
  const before = JSON.stringify((await folderOf(projectId)).body.deliverables);
  const projects = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;

  // An old copy comes back, different.
  const stale = { ...p, name: 'Stale name', assets: [{ id: 'a', type: 'video', title: 'Stale cut', status: 'approved' }] };
  const read = await call('POST', `${IMPORT}/read`, { projects: [stale] });
  assert.equal(rowOf(read, p.id).state, 'done');
  const again = await run([stale], [{ id: p.id }]);
  assert.equal(again.status, 200);
  assert.equal(again.body.result.imported, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, projects);
  assert.equal(JSON.stringify((await folderOf(projectId)).body.deliverables), before);
});

test('the portal’s rows aren’t touched, and the old editor’s publish route is gone', async () => {
  const email = `${uniq('portal')}@example.com`;
  client('Portal Co', email);
  const p = hubProject({ clientEmail: email, assets: [{ id: 'a', type: 'video', title: 'Cut', status: 'reviewing', reviewLink: 'https://x/v' }] });
  published(p, { signed: true });
  const read = (table) => db.prepare(`SELECT * FROM ${table} WHERE project_id = ?`).get(p.id);
  const before = ['records', 'private_auth', 'agreement_evidence'].map(read);
  await run([p], [{ id: p.id }]);
  assert.deepEqual(['records', 'private_auth', 'agreement_evidence'].map(read), before);

  const publish = await call('POST', '/hub/publish', { record: { id: p.id, name: 'Overwritten' }, priv: { projectId: p.id } });
  assert.equal(publish.status, 404);
  assert.ok(!read('records').data.includes('Overwritten'));
});

test('a sign-off stays readable on its project, and counts as signed', async () => {
  const email = `${uniq('signed')}@example.com`;
  client('Signed Co', email);
  const p = hubProject({ clientEmail: email });
  published(p, { signed: true });
  await run([p], [{ id: p.id }]);
  const folder = await folderOf(linkOf(p.id).project_id);
  assert.equal(folder.body.evidence.signerName, 'A Signer');
  assert.equal(folder.body.evidence.ipAddress, '1.2.3.4');
  assert.ok(!folder.body.project.delivery.flags.includes('no_agreement'));
  const list = await call('GET', `/api/projects?stage=live&q=${encodeURIComponent(p.name)}`);
  assert.ok(!list.body.projects.find((x) => x.id === folder.body.project.id).delivery.flags.includes('no_agreement'));
});

test('a published record the browser doesn’t hold can still be imported', async () => {
  const email = `${uniq('serveronly')}@example.com`;
  const co = client('Server Only Co', email);
  const p = hubProject({ clientEmail: email, assets: [{ id: 'a', type: 'video', title: 'Cut', status: 'reviewing', reviewLink: 'https://hub-api.example/hub/files/tok-server-only' }] });
  db.prepare("INSERT INTO deliverable_tokens (token, relative_path, downloadable, created_at) VALUES ('tok-server-only', 'Server/Cut.mp4', 0, ?)").run(nowIso());
  published(p, { signed: true });

  const listed = await call('GET', IMPORT);
  const row = rowOf(listed, p.id);
  assert.equal(row.inBrowser, false);
  assert.equal(row.onPortal, true);
  assert.equal(row.state, 'ready');
  assert.equal(row.client.id, co);

  await run([], [{ id: p.id }]);
  const folder = await folderOf(linkOf(p.id).project_id);
  assert.equal(folder.body.deliverables[0].versions[0].sourcePath, 'Server/Cut.mp4', 'the file, from its link’s token');
  assert.ok(folder.body.deliverables[0].versions[0].publishedAt, 'the client’s record has it');
  assert.equal(folder.body.project.delivery.badge, 'in_review');
});

test('something unmatched needs a client chosen; new clients are made once, and S13 holds', async () => {
  const email = `${uniq('fresh')}@example.com`;
  const p1 = hubProject({ clientEmail: email, clientName: 'Fresh Co' });
  const p2 = hubProject({ clientEmail: email, clientName: 'Fresh Co' });
  const refused = await run([p1], [{ id: p1.id }]);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'client_needed');
  assert.equal(linkOf(p1.id), undefined, 'nothing written');

  const reply = await run([p1, p2], [{ id: p1.id, client: 'new' }, { id: p2.id, client: 'new' }]);
  assert.equal(reply.status, 200);
  const made = db.prepare('SELECT * FROM clients WHERE email = ?').all(email);
  assert.equal(made.length, 1, 'two projects of one new client make one record');
  assert.equal(made[0].business_name, 'Fresh Co');
  const projects = db.prepare('SELECT client_id FROM projects WHERE id IN (?, ?)').all(linkOf(p1.id).project_id, linkOf(p2.id).project_id);
  assert.ok(projects.every((r) => r.client_id === made[0].id));

  const shared = `${uniq('sharednew')}@example.com`;
  client('Shared A', shared);
  client('Shared B', shared);
  const p3 = hubProject({ clientEmail: shared });
  const third = await run([p3], [{ id: p3.id, client: 'new' }]);
  assert.equal(third.status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM clients WHERE email = ?').get(shared).n, 2);
});

test('one bad decision undoes the whole import', async () => {
  const email = `${uniq('atomic')}@example.com`;
  client('Atomic Co', email);
  const good = hubProject({ clientEmail: email });
  const bad = hubProject({ clientEmail: '' });
  const reply = await run([good, bad], [{ id: good.id }, { id: bad.id, client: 'cl_gone' }]);
  assert.equal(reply.status, 409);
  assert.equal(reply.body.error, 'client_gone');
  assert.equal(reply.body.id, bad.id);
  assert.equal(linkOf(good.id), undefined);
});

test('same UPID and client joins the accepted project; the item the quote made takes the file', async () => {
  const email = `${uniq('join')}@example.com`;
  const co = client('Join Co', email);
  const now = nowIso();
  const projectId = newId('prj');
  const upid = uniq('JOIN-');
  db.prepare('INSERT INTO projects (id, upid, client_id, needs_upid, accepted_at, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)')
    .run(projectId, upid, co, now, now, now);
  db.prepare("INSERT INTO estimates (id, project_id, client_id, upid, name, date, status, client_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'The quote', '2026-10-01', 'accepted', '{}', ?, ?)")
    .run(newId('est'), projectId, co, upid, now, now);
  db.prepare("INSERT INTO deliverables (id, project_id, position, title, created_at, updated_at) VALUES (?, ?, 1, 'Hero film', ?, ?)")
    .run(newId('dlv'), projectId, now, now);

  const p = hubProject({
    upid: upid.toLowerCase(), clientEmail: email,
    assets: [
      { id: 'a', type: 'video', title: ' hero FILM ', status: 'reviewing', deliverablePath: 'Join/Hero.mp4' },
      { id: 'b', type: 'video', title: 'Extra', status: 'reviewing', deliverablePath: 'Join/Extra.mp4' },
    ],
  });
  const read = await call('POST', `${IMPORT}/read`, { projects: [p] });
  assert.equal(rowOf(read, p.id).upidProject.id, projectId);
  assert.equal(rowOf(read, p.id).upidProject.joinable, true);

  const count = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
  const reply = await run([p], [{ id: p.id, join: true }]);
  assert.equal(reply.body.result.joined, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, count, 'no second project');
  assert.equal(linkOf(p.id).project_id, projectId);
  const folder = await folderOf(projectId);
  assert.equal(folder.body.project.name, 'The quote', 'the quote still names it');
  assert.deepEqual(folder.body.deliverables.map((d) => d.title), ['Hero film', 'Extra']);
  assert.equal(folder.body.deliverables[0].versions[0].sourcePath, 'Join/Hero.mp4');
  assert.equal(folder.body.estimates.length, 1);
});

test('a UPID on another client’s, or an unaccepted, project is never joined: the import takes none', async () => {
  const email = `${uniq('clash')}@example.com`;
  client('Clash Co', email);
  const other = client('Other Co', `${uniq('other')}@example.com`);
  const now = nowIso();
  const taken = uniq('TAKEN-');
  db.prepare('INSERT INTO projects (id, upid, client_id, needs_upid, accepted_at, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)')
    .run(newId('prj'), taken, other, now, now, now);
  const p = hubProject({ upid: taken, clientEmail: email });
  const reply = await run([p], [{ id: p.id, join: true }]);
  assert.equal(reply.body.result.imported, 1);
  assert.deepEqual(reply.body.result.clashes.map((c) => c.upid), [taken]);
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(linkOf(p.id).project_id);
  assert.equal(row.upid, null);
  const folder = await folderOf(row.id);
  assert.ok(folder.body.project.delivery.flags.includes('no_upid'));

  const draftUpid = uniq('DRAFT-');
  const draftId = newId('prj');
  db.prepare('INSERT INTO projects (id, upid, needs_upid, created_at, updated_at) VALUES (?, ?, 0, ?, ?)').run(draftId, draftUpid, now, now);
  db.prepare("INSERT INTO estimates (id, project_id, upid, name, date, status, client_json, created_at, updated_at) VALUES (?, ?, ?, 'Draft', '2026-10-01', 'draft', '{}', ?, ?)")
    .run(newId('est'), draftId, draftUpid, now, now);
  const q = hubProject({ upid: draftUpid, clientEmail: email });
  const read = await call('POST', `${IMPORT}/read`, { projects: [q] });
  assert.equal(rowOf(read, q.id).upidProject.joinable, false);
  await run([q], [{ id: q.id, join: true }]);
  assert.notEqual(linkOf(q.id).project_id, draftId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deliverables WHERE project_id = ?').get(draftId).n, 0);
});

test('two hub projects can’t join one project', async () => {
  const email = `${uniq('twojoin')}@example.com`;
  const co = client('Two Join Co', email);
  const now = nowIso();
  const upid = uniq('TWO-');
  const projectId = newId('prj');
  db.prepare('INSERT INTO projects (id, upid, client_id, needs_upid, accepted_at, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)')
    .run(projectId, upid, co, now, now, now);
  const a = hubProject({ upid, clientEmail: email });
  const b = hubProject({ upid, clientEmail: email });
  await run([a, b], [{ id: a.id, join: true }, { id: b.id, join: true }]);
  assert.equal(linkOf(a.id).project_id, projectId);
  assert.notEqual(linkOf(b.id).project_id, projectId);
  assert.equal(db.prepare('SELECT upid FROM projects WHERE id = ?').get(linkOf(b.id).project_id).upid, null);
});

test('leaving one out is remembered, and a signed one can’t be left out', async () => {
  const left = hubProject({ clientEmail: '' });
  const reply = await run([left], [{ id: left.id, leaveOut: true }]);
  assert.equal(reply.body.result.leftOut, 1);
  assert.equal(linkOf(left.id).outcome, 'left_out');
  assert.equal(linkOf(left.id).project_id, null);
  assert.equal(rowOf(await call('POST', `${IMPORT}/read`, { projects: [left] }), left.id).state, 'left_out');

  const signed = hubProject({ clientEmail: '' });
  published(signed, { signed: true });
  const refused = await run([], [{ id: signed.id, leaveOut: true }]);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'signed');
  assert.equal(linkOf(signed.id), undefined);
});

test('an imported project the browser alone held is still listed with no list pasted', async () => {
  const email = `${uniq('browseronly')}@example.com`;
  client('Browser Only Co', email);
  const p = hubProject({ clientEmail: email });
  await run([p], [{ id: p.id }]);
  const row = rowOf(await call('GET', IMPORT), p.id);
  assert.equal(row.state, 'done');
  assert.equal(row.title, p.name);
  assert.equal(row.inBrowser, false);
  assert.equal(row.projectId, linkOf(p.id).project_id);
});

test('bringing back a project only the browser held hands its copy back, so it can still be imported', async () => {
  const email = `${uniq('lonely')}@example.com`;
  client('Lonely Co', email);
  const p = hubProject({ clientEmail: email });
  await run([p], [{ id: p.id, leaveOut: true }]);
  const back = await call('POST', `${IMPORT}/restore`, { id: p.id });
  assert.equal(back.status, 200);
  assert.equal(back.body.restored.id, p.id);
  assert.equal(back.body.restored.clientCode, undefined);
  assert.equal(rowOf(back, p.id).state, 'ready');
  const imported = await run([back.body.restored], [{ id: p.id }]);
  assert.equal(imported.body.result.imported, 1);
});

test('a decision naming the same hub project twice is refused whole', async () => {
  const email = `${uniq('twice')}@example.com`;
  client('Twice Co', email);
  const p = hubProject({ clientEmail: email });
  const reply = await run([p], [{ id: p.id }, { id: p.id }]);
  assert.equal(reply.status, 400);
  assert.equal(reply.body.error, 'duplicate');
  assert.equal(linkOf(p.id), undefined);
});

test('a new client never lands on a same-named client with another address', async () => {
  const name = uniq('Samename Films ');
  const other = client(name, `${uniq('other')}@example.com`);
  const p = hubProject({ clientName: name, clientEmail: `${uniq('new')}@example.com` });
  await run([p], [{ id: p.id, client: 'new' }]);
  const made = db.prepare('SELECT client_id FROM projects WHERE id = ?').pluck().get(linkOf(p.id).project_id);
  assert.notEqual(made, other);

  // No address on the existing one: it is the same client, and gets the hub's.
  const bare = client(uniq('Bare Films '), '');
  const name2 = db.prepare('SELECT business_name FROM clients WHERE id = ?').pluck().get(bare);
  const email2 = `${uniq('bare')}@example.com`;
  const q = hubProject({ clientName: name2, clientEmail: email2 });
  await run([q], [{ id: q.id, client: 'new' }]);
  assert.equal(db.prepare('SELECT client_id FROM projects WHERE id = ?').pluck().get(linkOf(q.id).project_id), bare);
  assert.equal(db.prepare('SELECT email FROM clients WHERE id = ?').pluck().get(bare), email2);
});

test('a left-out project can be brought back; an imported one can’t be undone that way', async () => {
  const email = `${uniq('restore')}@example.com`;
  client('Restore Co', email);
  const left = hubProject({ clientEmail: email });
  await run([left], [{ id: left.id, leaveOut: true }]);
  const back = await call('POST', `${IMPORT}/restore`, { id: left.id, projects: [left] });
  assert.equal(back.status, 200);
  assert.equal(linkOf(left.id), undefined);
  assert.equal(rowOf(back, left.id).state, 'ready');

  await run([left], [{ id: left.id }]);
  const again = await call('POST', `${IMPORT}/restore`, { id: left.id, projects: [left] });
  assert.equal(again.status, 409);
  assert.equal(linkOf(left.id).outcome, 'imported');
  assert.equal((await call('POST', `${IMPORT}/restore`, { id: 'no-such-hub-id' })).status, 404);
  assert.equal((await call('POST', `${IMPORT}/restore`, { id: left.id }, {})).status, 401);
});

test('delivered on the hub is Complete; a new file reopens an item', async () => {
  const email = `${uniq('delivered')}@example.com`;
  client('Delivered Co', email);
  const p = hubProject({ clientEmail: email, delivered: true, assets: [{ id: 'a', type: 'video', title: 'Film', status: 'reviewing', reviewLink: 'https://x/v' }] });
  const empty = hubProject({ clientEmail: email, delivered: true });
  await run([p, empty], [{ id: p.id }, { id: empty.id }]);
  const folder = await folderOf(linkOf(p.id).project_id);
  assert.equal(folder.body.deliverables[0].hubStatus, 'delivered');
  assert.equal(folder.body.project.delivery.badge, 'complete');
  const emptyFolder = await folderOf(linkOf(empty.id).project_id);
  assert.equal(emptyFolder.body.project.delivery.badge, 'complete', 'delivered with no assets doesn’t ask for a checklist');

  // A link-only version has no file to publish or preview.
  const item = folder.body.deliverables[0];
  const version = item.versions[0];
  assert.equal(version.sourcePath, null);
  const preview = await call('GET', `/api/projects/${linkOf(p.id).project_id}/deliverables/${item.id}/versions/${version.id}/file`);
  assert.equal(preview.status, 404);
});

test('hostile strings come through as text, within the title limit', async () => {
  const email = `${uniq('hostile')}@example.com`;
  client('Hostile Co', email);
  const script = '<script>alert(1)</script>';
  const p = hubProject({
    name: script, clientEmail: email, message: script,
    assets: [{ id: 'a', type: 'video', title: script + 'x'.repeat(300), status: 'bogus', driveLink: 'javascript:alert(1)', reviewLink: 'https://x/v', comments: [{ text: script }] }],
    invoices: [{ type: 'final', name: script, url: 'javascript:alert(1)' }],
  });
  await run([p], [{ id: p.id }]);
  const folder = await folderOf(linkOf(p.id).project_id);
  const [item] = folder.body.deliverables;
  assert.ok(item.title.length <= 200);
  assert.equal(item.hubStatus, null, 'an unknown status is nothing');
  assert.equal(item.versions[0].driveLink, '', 'only a web address is kept as a link');
  assert.equal(folder.body.hub.invoices[0].url, '');
  assert.equal(folder.body.hub.notes[0].text, script, 'the screen escapes it (test-web)');
});

test('a project linked to the hub can’t be deleted', async () => {
  const email = `${uniq('nodelete')}@example.com`;
  client('No Delete Co', email);
  const p = hubProject({ clientEmail: email });
  await run([p], [{ id: p.id }]);
  const reply = await call('DELETE', `/api/projects/${linkOf(p.id).project_id}`);
  assert.equal(reply.status, 409);
  assert.equal(reply.body.error, 'has_client_data');
});

test('changing a client’s email moves the login of a project imported from the hub', async () => {
  const email = `${uniq('moves')}@example.com`;
  const co = client('Moves Co', email);
  const p = hubProject({ clientEmail: email });
  published(p);
  await run([p], [{ id: p.id }]);
  const next = `${uniq('moved')}@example.com`;
  const saved = await call('PUT', `/api/clients/${co}`, { businessName: 'Moves Co', email: next });
  assert.equal(saved.status, 200);
  const auth = db.prepare('SELECT * FROM private_auth WHERE project_id = ?').get(p.id);
  assert.equal(auth.client_email, next);
  assert.equal(auth.email_hash, sha256Hex(next));
});

test('the screen reports where billing’s own projects landed', async () => {
  const now = nowIso();
  const orphan = newId('prj');
  db.prepare('INSERT INTO projects (id, upid, needs_upid, accepted_at, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)')
    .run(orphan, uniq('ORPHAN-'), now, now, now);
  const reply = await call('GET', IMPORT);
  assert.equal(reply.status, 200);
  assert.ok(reply.body.classified.live >= 1);
  assert.ok(reply.body.classified.noClient.some((x) => x.id === orphan));
  assert.ok(!reply.body.clients.some((c) => 'notes' in c), 'names and emails only');
});

test('v25: an accepted project with no client gets one from its quote; twice changes nothing', () => {
  const now = nowIso();
  const addProject = (over = {}) => {
    const id = newId('prj');
    db.prepare('INSERT INTO projects (id, upid, needs_upid, accepted_at, declined_at, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?)')
      .run(id, uniq('V25-'), over.accepted === false ? null : now, over.declined ? now : null, now, now);
    db.prepare("INSERT INTO estimates (id, project_id, upid, name, date, status, client_json, created_at, updated_at) VALUES (?, ?, ?, 'Q', '2026-10-01', ?, ?, ?, ?)")
      .run(newId('est'), id, uniq('E-'), over.status || 'accepted', JSON.stringify(over.client || {}), now, now);
    return id;
  };
  const email = `${uniq('v25')}@example.com`;
  const existing = client('V25 Existing', email);
  const byEmail = addProject({ client: { email: email.toUpperCase() } });
  const fresh = addProject({ client: { businessName: uniq('V25 Fresh '), email: `${uniq('v25fresh')}@example.com` } });
  const nobody = addProject({ client: {} });
  const notAccepted = addProject({ accepted: false, status: 'draft', client: { businessName: 'Never Made' } });
  const declined = addProject({ declined: true, client: { businessName: 'Never Made Either' } });

  migrateV25(db, now);
  const clientOf = (id) => db.prepare('SELECT client_id FROM projects WHERE id = ?').pluck().get(id);
  assert.equal(clientOf(byEmail), existing);
  assert.ok(clientOf(fresh));
  assert.equal(clientOf(nobody), null);
  assert.equal(clientOf(notAccepted), null);
  assert.equal(clientOf(declined), null);
  assert.equal(db.prepare("SELECT kind FROM activity WHERE project_id = ?").pluck().get(fresh), 'client_linked');

  const clients = db.prepare('SELECT COUNT(*) AS n FROM clients').get().n;
  const activity = db.prepare('SELECT COUNT(*) AS n FROM activity').get().n;
  migrateV25(db, now);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM clients').get().n, clients);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM activity').get().n, activity);
});
