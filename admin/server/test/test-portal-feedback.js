'use strict';

/* Saved client feedback (merged-admin C4), on the real app with the portal
 * mounted: notes save as the client adds them, on the version they're looking
 * at; an unsent one can be removed; Send sends them as one set per version; the
 * studio sees them only once sent (the item's page and Needs you); the server
 * sets every date and checks every field (S8); and a note holding a script is
 * text on the admin's screen. A throwaway database and folder. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-portal-feedback-'));
process.env.DATA_DIR = TMP;
process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough-0123456789';
process.env.COOKIE_SECURE = '0';
process.env.NODE_ENV = 'test';

const { openDatabase, nowIso, newId } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');

const PORTAL = 'https://lsccreative.studio';
const DELIVERABLES = path.join(TMP, 'deliverables');
fs.mkdirSync(DELIVERABLES, { recursive: true });
const hub = {
  signingSecret: 'test-signing-secret', corsOrigins: [PORTAL], publicBaseUrl: 'https://hub.example',
  portalUrl: 'https://lsccreative.studio/client-hub-app/', deliverablesDir: DELIVERABLES, backupDir: path.join(TMP, 'backups'), bunny: {},
};
const TODAY = new Date().toISOString().slice(0, 10);

let db;
let server;
let base;
let admin;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const photoKey = (name) => sha(`photo\n${name}`).slice(0, 16);

async function call(url, { method = 'GET', body, cookie, headers = {} } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  const set = res.headers.get('set-cookie') || '';
  return { status: res.status, body: json, text, session: set.startsWith('lsc_portal=') ? set.split(';')[0] : null };
}

test.before(async () => {
  db = openDatabase(path.join(TMP, 'billing.db'));
  db.prepare('INSERT INTO account (id, username, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?, ?)')
    .run('tester', await hashPassword('a-long-test-password'), nowIso(), nowIso());
  const app = createApp(db, { hub });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'a-long-test-password' }),
  });
  admin = login.headers.getSetCookie()[0].split(';')[0];
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

/* A client with an accepted project: a published video (v1, then an unpublished v2)
   and a published photo library, real files on the throwaway NAS. Signed in. */
let serial = 0;
async function job() {
  serial += 1;
  const now = nowIso();
  const clientId = newId('cl');
  const email = `fb${serial}@salt.example`;
  db.prepare(`INSERT INTO clients (id, business_name, contact_name, email, created_at, updated_at) VALUES (?, ?, 'Priya Nair', ?, ?, ?)`)
    .run(clientId, `Salt ${serial}`, email, now, now);
  const projectId = newId('prj');
  db.prepare(`INSERT INTO projects (id, upid, client_id, needs_upid, accepted_at, name, created_at, updated_at, opened_at)
              VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`).run(projectId, `FB-${serial}`, clientId, now, `Feedback job ${serial}`, now, now, now);
  db.prepare(`INSERT INTO estimates (id, project_id, upid, name, date, status, client_id, client_json, active_rows_json, totals_json, created_at, updated_at)
              VALUES (?, ?, ?, 'Feedback job', '2026-11-01', 'accepted', ?, '{}', '{}', '{}', ?, ?)`).run(newId('est'), projectId, `FB-${serial}`, clientId, now, now);
  const folder = `Job${serial}`;
  fs.mkdirSync(path.join(DELIVERABLES, folder, 'Stills'), { recursive: true });
  fs.writeFileSync(path.join(DELIVERABLES, folder, 'Cut.mp4'), 'video');
  for (const n of ['IMG_0001.jpg', 'IMG_0002.jpg']) fs.writeFileSync(path.join(DELIVERABLES, folder, 'Stills', n), n);
  const item = (title, stage = 'draft') => {
    const id = newId('dlv');
    db.prepare(`INSERT INTO deliverables (id, project_id, position, title, stage, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?)`)
      .run(id, projectId, title, stage, now, now);
    return id;
  };
  const version = (itemId, n, source, kind, published, stage = 'draft') => {
    const id = newId('ver');
    db.prepare(`INSERT INTO deliverable_versions (id, deliverable_id, project_id, n, stage, source_path, file_name, kind, photo_count, created_at, published_at)
                VALUES (?, ?, ?, ?, ?, ?, '', ?, 2, ?, ?)`).run(id, itemId, projectId, n, stage, source, kind, now, published ? now : null);
    return id;
  };
  const film = item('Hero film');
  const v1 = version(film, 1, `${folder}/Cut.mp4`, 'video', true);
  const v2 = version(film, 2, `${folder}/Cut.mp4`, 'video', false);
  const stills = item('Stills');
  const photos = version(stills, 1, `${folder}/Stills`, 'photos', true);

  const issued = await call(`/api/clients/${clientId}/portal`, { method: 'POST', body: {}, cookie: admin });
  const { session } = await call('/hub/auth', { method: 'POST', body: { email, code: issued.body.code } });
  const at = `/hub/projects/${projectId}`;
  return {
    clientId, projectId, film, v1, v2, stills, photos, session,
    add: (itemId, body, cookie = session) => call(`${at}/items/${itemId}/notes`, { method: 'POST', body, cookie }),
    remove: (noteId, cookie = session) => call(`${at}/notes/${noteId}`, { method: 'DELETE', cookie }),
    send: (itemId, versionId, cookie = session) => call(`${at}/items/${itemId}/submit`, { method: 'POST', body: { versionId }, cookie }),
    view: () => call(at, { cookie: session }).then((r) => r.body.project),
    folder: () => call(`/api/projects/${projectId}?today=${TODAY}`, { cookie: admin }).then((r) => r.body),
    publish: (versionId) => db.prepare('UPDATE deliverable_versions SET published_at = ? WHERE id = ?').run(nowIso(), versionId),
  };
}
const itemOf = (view, id) => view.deliverables.find((d) => d.id === id);
const needs = () => call(`/api/needs?today=${TODAY}`, { cookie: admin }).then((r) => r.body.items);

test('a note saves as it is added, dated by the server, on the version the client is looking at', async () => {
  const j = await job();
  const before = Date.now();
  const r = await j.add(j.film, { versionId: j.v1, text: '  Hold on the logo a beat longer  ', seconds: 3.4, createdAt: '1999-01-01' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(Object.keys(r.body.note).sort(), ['createdAt', 'id', 'photo', 'seconds', 'submittedAt', 'text', 'versionId']);
  assert.deepEqual([r.body.note.text, r.body.note.seconds, r.body.note.photo, r.body.note.submittedAt], ['Hold on the logo a beat longer', 3.4, null, null]);
  assert.ok(Date.parse(r.body.note.createdAt) >= before - 1000, 'the server’s clock, not the client’s');

  // It survives a reload: the project page gives it back, on its item, to this client.
  const item = itemOf(await j.view(), j.film);
  assert.deepEqual(item.notes.map((n) => n.text), ['Hold on the logo a beat longer']);
  // Still the client's: the studio doesn't see an unsent note.
  const studioItem = (await j.folder()).deliverables.find((d) => d.id === j.film);
  assert.deepEqual(studioItem.notes, []);
});

test('every field is checked: text, time, photo, and which version (S8)', async () => {
  const j = await job();
  const bad = [
    {}, { versionId: j.v1, text: '   ' }, { versionId: j.v1, text: 'x'.repeat(4001) }, { versionId: j.v1, text: 5 },
    { versionId: j.v1, text: 'ok', seconds: '3' }, { versionId: j.v1, text: 'ok', seconds: -1 }, { versionId: j.v1, text: 'ok', seconds: 1e9 },
    { versionId: j.v1, text: 'ok', photo: photoKey('IMG_0001.jpg') },
  ];
  for (const body of bad) assert.equal((await j.add(j.film, body)).status, 400, JSON.stringify(body).slice(0, 80));
  // A photo library's note names one of its photos, by key, and has no time.
  for (const body of [{ versionId: j.photos, text: 'ok' }, { versionId: j.photos, text: 'ok', photo: photoKey('nope.jpg') },
    { versionId: j.photos, text: 'ok', photo: 'IMG_0001.jpg' }, { versionId: j.photos, text: 'ok', photo: photoKey('IMG_0001.jpg'), seconds: 2 }]) {
    assert.equal((await j.add(j.stills, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await j.add(j.stills, { versionId: j.photos, text: 'Warmer', photo: photoKey('IMG_0002.jpg') })).status, 201);
  // Not the newest published version (or an unpublished one): the client is told, nothing saved.
  assert.deepEqual([(await j.add(j.film, { versionId: j.v2, text: 'ok' })).body.error], ['not_current']);
  j.publish(j.v2);
  assert.equal((await j.add(j.film, { versionId: j.v1, text: 'late' })).body.error, 'not_current');
  assert.equal((await j.add(j.film, { versionId: j.v2, text: 'on v2' })).status, 201);
  assert.equal(db.prepare('SELECT COUNT(*) FROM client_notes WHERE project_id = ?').pluck().get(j.projectId), 2);
});

test('only the signed-in client’s own work, from the portal’s own page', async () => {
  const j = await job();
  const other = await job();
  const note = { versionId: j.v1, text: 'mine' };
  assert.equal((await j.add(j.film, note, other.session)).status, 404, 'another client’s project is not found');
  assert.equal((await j.add(j.film, note, '')).status, 401);
  const evil = await call(`/hub/projects/${j.projectId}/items/${j.film}/notes`,
    { method: 'POST', body: note, cookie: j.session, headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  const own = (await j.add(j.film, note)).body.note;
  assert.equal((await call(`/hub/projects/${other.projectId}/notes/${own.id}`, { method: 'DELETE', cookie: other.session })).status, 404);
  assert.equal((await j.remove(own.id, other.session)).status, 404);
  // An archived project is read-only for the client too.
  db.prepare('UPDATE projects SET archived_at = ? WHERE id = ?').run(nowIso(), other.projectId);
  assert.equal((await other.add(other.film, { versionId: other.v1, text: 'x' })).body.error, 'archived');
});

test('an unsent note can be removed; Send sends them all as one set, once per version', async () => {
  const j = await job();
  const a = (await j.add(j.film, { versionId: j.v1, text: 'one', seconds: 1 })).body.note;
  const b = (await j.add(j.film, { versionId: j.v1, text: 'two' })).body.note;
  assert.equal((await j.remove(a.id)).status, 200);
  assert.equal((await j.remove(a.id)).status, 404);
  assert.equal((await j.send(j.stills, j.photos)).body.error, 'no_notes', 'nothing to send on the stills');

  const sent = await j.send(j.film, j.v1);
  assert.deepEqual([sent.status, sent.body.noteCount], [200, 1]);
  assert.equal((await j.send(j.film, j.v1)).body.error, 'sent');
  assert.equal((await j.add(j.film, { versionId: j.v1, text: 'after' })).body.error, 'sent', 'the version waits for the next one');
  assert.equal((await j.remove(b.id)).body.error, 'sent', 'a sent note is the studio’s now');

  // The client sees it sent; the project is with the studio.
  const view = await j.view();
  assert.equal(view.status, 'We’re making your changes');
  const item = itemOf(view, j.film);
  assert.equal(item.status, 'changes');
  assert.ok(item.versions[0].submittedAt);
  assert.ok(item.notes.every((n) => n.submittedAt));

  // The studio sees it: on the item, and in Needs you, opening that item.
  const studio = (await j.folder()).deliverables.find((d) => d.id === j.film);
  assert.deepEqual(studio.notes.map((n) => n.text), ['two']);
  const row = (await needs()).find((n) => n.kind === 'revision_notes' && n.itemId === j.film);
  assert.deepEqual([row.projectId, row.title, row.notes], [j.projectId, 'Hero film', 1]);
  // Sent at 8am in Sydney is 21:00 UTC the day before: the queue counts Sydney's days.
  db.prepare("UPDATE client_submissions SET submitted_at = '2026-11-24T21:00:00.000Z' WHERE version_id = ?").run(j.v1);
  const early = (await call('/api/needs?today=2026-11-25', { cookie: admin })).body.items.find((n) => n.itemId === j.film);
  assert.deepEqual([early.since, early.days], ['2026-11-25', 0]);

  // A new version clears Needs you and opens notes again.
  j.publish(j.v2);
  assert.ok(!(await needs()).some((n) => n.itemId === j.film));
  assert.equal(itemOf(await j.view(), j.film).status, 'review');
  assert.equal((await j.add(j.film, { versionId: j.v2, text: 'on v2' })).status, 201);
});

test('two sends at once make one set', async () => {
  const j = await job();
  await j.add(j.film, { versionId: j.v1, text: 'one' });
  const replies = await Promise.all([j.send(j.film, j.v1), j.send(j.film, j.v1), j.send(j.film, j.v1)]);
  assert.equal(replies.filter((r) => r.status === 200).length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) FROM client_submissions WHERE version_id = ?').pluck().get(j.v1), 1);
});

test('a note holding a script is text on the admin’s screen (S8)', async () => {
  const j = await job();
  const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script> & "quotes"';
  await j.add(j.film, { versionId: j.v1, text: evil, seconds: 65 });
  await j.add(j.stills, { versionId: j.photos, text: 'ok', photo: photoKey('IMG_0001.jpg') });
  await j.send(j.film, j.v1);
  await j.send(j.stills, j.photos);
  const folder = await j.folder();

  // The admin's own view code, run as the browser runs it.
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'js', 'views', 'project-deliverables.js'), 'utf8');
  const PD = vm.runInNewContext(`${src}\nProjectDeliverables`, {
    LSCUtil: { esc, today: () => TODAY }, ProjectCard: { dayMonth: () => '25 Nov' },
  });
  const film = PD.clientSetsMarkup(folder.deliverables.find((d) => d.id === j.film));
  assert.ok(!/<img|<script/i.test(film), film);
  assert.ok(film.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;script&gt;'), 'shown as the text it is');
  assert.match(film, /01:05/, 'the time as mm:ss');
  assert.match(film, /v1 · Draft Cut · 1 note sent 25 Nov/);
  // The studio sees a photo's file name; the client's reply never carries one.
  assert.match(PD.clientSetsMarkup(folder.deliverables.find((d) => d.id === j.stills)), /IMG_0001\.jpg/);
  const portal = await call(`/hub/projects/${j.projectId}`, { cookie: j.session });
  assert.ok(!portal.text.includes('IMG_0001'));
  assert.equal(itemOf(portal.body.project, j.stills).notes[0].photo, photoKey('IMG_0001.jpg'));
});

test('client writes take no backup each (S16): the nightly one covers them', async () => {
  const j = await job();
  const dir = hub.backupDir;
  const count = () => (fs.existsSync(dir) ? fs.readdirSync(dir).length : 0);
  const before = count();
  await j.add(j.film, { versionId: j.v1, text: 'one' });
  await j.send(j.film, j.v1);
  assert.equal(count(), before);
});

test('notes left unsent when the next version arrives go with the next set, each on its own version', async () => {
  const j = await job();
  const stray = (await j.add(j.film, { versionId: j.v1, text: 'on v1, never sent', seconds: 2 })).body.note;
  j.publish(j.v2);
  // Still the client's, still unsent, and still removable.
  const item = itemOf(await j.view(), j.film);
  assert.deepEqual(item.notes.map((n) => [n.text, n.versionId, n.submittedAt]), [['on v1, never sent', j.v1, null]]);
  await j.add(j.film, { versionId: j.v2, text: 'on v2' });
  const sent = await j.send(j.film, j.v2);
  assert.equal(sent.body.noteCount, 2, 'the stray goes too');
  const studio = (await j.folder()).deliverables.find((d) => d.id === j.film);
  assert.deepEqual(studio.notes.map((n) => [n.text, n.versionId]).sort(), [['on v1, never sent', j.v1], ['on v2', j.v2]].sort());
  assert.equal((await j.remove(stray.id)).body.error, 'sent');
});

test('a note saved twice with the same key is saved once (a retry after a lost reply)', async () => {
  const j = await job();
  const body = { versionId: j.v1, text: 'Tighter cut', key: 'k-1234567890' };
  const first = await j.add(j.film, body);
  const again = await j.add(j.film, body);
  assert.deepEqual([first.status, again.status, again.body.note.id], [201, 200, first.body.note.id]);
  assert.equal(db.prepare('SELECT COUNT(*) FROM client_notes WHERE deliverable_id = ?').pluck().get(j.film), 1);
  assert.equal((await j.add(j.stills, { ...body, versionId: j.photos, photo: photoKey('IMG_0001.jpg') })).status, 400, 'a key is one note');
  assert.equal((await j.add(j.film, { ...body, key: 'bad key!' })).status, 400);
});

test('an item holds at most 200 unsent notes from a client', async () => {
  const j = await job();
  const now = nowIso();
  const insert = db.prepare(`INSERT INTO client_notes (id, project_id, deliverable_id, version_id, client_id, text, created_at)
                             VALUES (?, ?, ?, ?, ?, 'n', ?)`);
  db.transaction(() => { for (let i = 0; i < 200; i += 1) insert.run(newId('cn'), j.projectId, j.film, j.v1, j.clientId, now); })();
  assert.equal((await j.add(j.film, { versionId: j.v1, text: 'one more' })).body.error, 'too_many');
  assert.equal((await j.send(j.film, j.v1)).body.noteCount, 200);
});

test('Needs you counts Sydney’s days for every row', async () => {
  const now = nowIso();
  const id = newId('prj');
  // Accepted at 8am on 25 November in Sydney: 21:00 UTC on the 24th.
  db.prepare(`INSERT INTO projects (id, upid, name, accepted_at, created_at, updated_at) VALUES (?, NULL, 'Sydney morning', '2026-11-24T21:00:00.000Z', ?, ?)`)
    .run(id, now, now);
  const items = (await call('/api/needs?today=2026-11-25', { cookie: admin })).body.items.filter((n) => n.projectId === id);
  assert.deepEqual(items.map((n) => [n.kind, n.since]).sort(), [['new_project', '2026-11-25'], ['no_upid', '2026-11-25']]);
});
