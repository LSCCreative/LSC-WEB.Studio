'use strict';

/* View as client (merged-admin C8), on the real app with the portal mounted: the
 * studio's header link opens the real portal on a project, read-only. The link
 * works once, within minutes; the preview reads what the client reads; the server
 * refuses every write under it, found from the router itself so a write route
 * added later is covered too; and nothing is logged as the client (no session, no
 * "last seen", no activity). A throwaway database and folder. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-portal-preview-'));
process.env.DATA_DIR = TMP;
process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough-0123456789';
process.env.COOKIE_SECURE = '0';
process.env.NODE_ENV = 'test';

const { openDatabase, nowIso, newId } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');
const { accessStatus, PREVIEW_MS } = require('../src/portal-access');

const PORTAL = 'https://lsccreative.studio';
const PORTAL_URL = 'https://lsccreative.studio/client-hub-app/';
const DELIVERABLES = path.join(TMP, 'deliverables');
fs.mkdirSync(DELIVERABLES, { recursive: true });
const hub = {
  signingSecret: 'test-signing-secret', corsOrigins: [PORTAL], publicBaseUrl: 'https://hub.example', appUrl: 'https://app.example/',
  portalUrl: PORTAL_URL, deliverablesDir: DELIVERABLES, backupDir: path.join(TMP, 'backups'), bunny: {},
  // Each job signs its client in and each preview opens through the sign-in count: room for the file.
  limits: { auth: { max: 1000, windowMs: 10 * 60 * 1000 } },
};

let db;
let app;
let server;
let base;
let admin;

/* Every cookie a reply sets, by name: { lsc_portal: 'lsc_portal=…' | '' when cleared }. */
async function call(url, { method = 'GET', body, cookie, headers = {} } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  const set = {};
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(';')[0];
    const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
    set[name] = value ? pair : '';
  }
  return { status: res.status, body: json, text, set };
}
const both = (...cookies) => cookies.filter(Boolean).join('; ');

test.before(async () => {
  db = openDatabase(path.join(TMP, 'billing.db'));
  db.prepare('INSERT INTO account (id, username, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?, ?)')
    .run('tester', await hashPassword('a-long-test-password'), nowIso(), nowIso());
  app = createApp(db, { hub });
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

/* A client's accepted project with a published Draft Cut v1 and one unsent note on it,
   and the client signed in with a Client code. `accepted: false` leaves it a quote. */
let serial = 0;
async function job({ accepted = true, client = true } = {}) {
  serial += 1;
  const now = nowIso();
  const clientId = client ? newId('cl') : null;
  const email = `pv${serial}@salt.example`;
  if (client) {
    db.prepare(`INSERT INTO clients (id, business_name, contact_name, email, created_at, updated_at) VALUES (?, ?, 'Priya Nair', ?, ?, ?)`)
      .run(clientId, `Salt ${serial}`, email, now, now);
  }
  const projectId = newId('prj');
  db.prepare(`INSERT INTO projects (id, upid, client_id, needs_upid, accepted_at, name, created_at, updated_at, opened_at)
              VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`).run(projectId, `PV-${serial}`, clientId, accepted ? now : null, `Preview job ${serial}`, now, now, now);
  db.prepare(`INSERT INTO estimates (id, project_id, upid, name, date, status, client_id, client_json, active_rows_json, totals_json, created_at, updated_at)
              VALUES (?, ?, ?, 'Preview job', '2026-11-01', ?, ?, '{}', '{}', '{}', ?, ?)`)
    .run(newId('est'), projectId, `PV-${serial}`, accepted ? 'accepted' : 'sent', clientId, now, now);
  const folder = `Job${serial}`;
  fs.mkdirSync(path.join(DELIVERABLES, folder), { recursive: true });
  fs.writeFileSync(path.join(DELIVERABLES, folder, 'Draft.mp4'), 'video-bytes');
  const film = newId('dlv');
  db.prepare(`INSERT INTO deliverables (id, project_id, position, title, stage, created_at, updated_at) VALUES (?, ?, 1, 'Hero film', 'draft', ?, ?)`)
    .run(film, projectId, now, now);
  const v1 = newId('ver');
  db.prepare(`INSERT INTO deliverable_versions (id, deliverable_id, project_id, n, stage, source_path, file_name, kind, created_at, published_at)
              VALUES (?, ?, ?, 1, 'draft', ?, 'Draft.mp4', 'video', ?, ?)`).run(v1, film, projectId, `${folder}/Draft.mp4`, now, now);

  let session = null;
  let noteId = null;
  if (client && accepted) {
    const issued = await call(`/api/clients/${clientId}/portal`, { method: 'POST', body: {}, cookie: admin });
    session = (await call('/hub/auth', { method: 'POST', body: { email, code: issued.body.code } })).set.lsc_portal;
    const note = await call(`/hub/projects/${projectId}/items/${film}/notes`, { method: 'POST', body: { versionId: v1, text: 'Earlier note' }, cookie: session });
    assert.equal(note.status, 201, note.text);
    noteId = note.body.note.id;
  }
  return { clientId, projectId, film, v1, session, noteId };
}

const mint = (projectId, cookie = admin) => call(`/api/projects/${projectId}/portal-preview`, { method: 'POST', body: {}, cookie });
const linkToken = (url) => decodeURIComponent(url.slice(url.indexOf('#/preview/') + '#/preview/'.length));

/* Opens a preview of the job: the studio mints the link, the portal swaps it for the cookie. */
async function preview(j) {
  const minted = await mint(j.projectId);
  assert.equal(minted.status, 201, minted.text);
  const opened = await call('/hub/preview', { method: 'POST', body: { token: linkToken(minted.body.url) }, headers: { origin: PORTAL } });
  assert.equal(opened.status, 200, opened.text);
  assert.ok(opened.set.lsc_portal_preview, 'the preview has its own cookie');
  return { cookie: opened.set.lsc_portal_preview, opened };
}

/* A call from the preview's page: the portal marks every one (C8). */
const marked = (url) => url + (url.includes('?') ? '&' : '?') + 'preview=1';
/* The review links in a project reply, without the preview's marker. */
const unmarkedBody = (body) => JSON.parse(JSON.stringify(body).replace(/\?preview=1&/g, '?').replace(/\?preview=1/g, ''));

/* What a write would leave behind, for "nothing changed". */
const footprint = (j) => ({
  notes: db.prepare('SELECT id, text, submission_id FROM client_notes WHERE project_id = ? ORDER BY id').all(j.projectId),
  sets: db.prepare('SELECT COUNT(*) AS n FROM client_submissions WHERE deliverable_id = ?').get(j.film).n,
  approvals: db.prepare('SELECT COUNT(*) AS n FROM client_approvals WHERE version_id = ?').get(j.v1).n,
  activity: db.prepare('SELECT COUNT(*) AS n FROM activity WHERE project_id = ?').get(j.projectId).n,
  sessions: db.prepare('SELECT id, last_seen_at FROM client_sessions WHERE client_id = ? ORDER BY id').all(j.clientId),
});

/* The hub router's own routes, read from the mounted app: [{ method, path, signedIn }]. */
function hubRoutes() {
  const stackOf = (layer) => (layer && layer.handle && Array.isArray(layer.handle.stack) ? layer.handle.stack : null);
  const hubLayer = app.router.stack.find((l) => (stackOf(l) || []).some((x) => x.route && x.route.path === '/hub/session'));
  assert.ok(hubLayer, 'the hub router is mounted');
  return stackOf(hubLayer).filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods).map((method) => ({
    method: method.toUpperCase(), path: l.route.path, signedIn: l.route.stack.some((s) => s.name === 'signedIn'),
  })));
}

test('the link is the studio’s: only behind the admin login, and only for an accepted project with a client', async () => {
  const j = await job();
  assert.equal((await mint(j.projectId, null)).status, 401);
  const minted = await mint(j.projectId);
  assert.equal(minted.status, 201);
  assert.match(minted.body.url, /^https:\/\/lsccreative\.studio\/client-hub-app\/#\/preview\/[A-Za-z0-9_-]{40,}$/);
  assert.equal((await mint('prj_nope')).status, 404);

  const quote = await job({ accepted: false });
  assert.equal((await mint(quote.projectId)).body.error, 'not_accepted');
  const nobody = await job({ client: false });
  assert.equal((await mint(nobody.projectId)).body.error, 'no_client');

  // An archived project still opens, as it does under the client's Past projects.
  db.prepare('UPDATE projects SET archived_at = ? WHERE id = ?').run(nowIso(), j.projectId);
  assert.equal((await mint(j.projectId)).status, 201);
  db.prepare('UPDATE projects SET archived_at = NULL WHERE id = ?').run(j.projectId);
});

test('the link works once, within its minutes, and keeps only a hash', async () => {
  const j = await job();
  const minted = await mint(j.projectId);
  const token = linkToken(minted.body.url);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM portal_previews WHERE link_hash = ? OR session_hash = ?').get(token, token).n, 0);

  const first = await call('/hub/preview', { method: 'POST', body: { token }, headers: { origin: PORTAL } });
  assert.equal(first.status, 200);
  assert.deepEqual([first.body.preview.projectId, first.body.client.businessName], [j.projectId, `Salt ${serial}`]);
  assert.ok(!('lsc_portal' in first.set), 'the client’s own cookie is left alone');
  assert.equal((await call('/hub/preview', { method: 'POST', body: { token } })).status, 404, 'used');

  const late = linkToken((await mint(j.projectId)).body.url);
  db.prepare("UPDATE portal_previews SET link_expires_at = '2000-01-01T00:00:00.000Z' WHERE opened_at IS NULL").run();
  assert.equal((await call('/hub/preview', { method: 'POST', body: { token: late } })).status, 404, 'run out');

  for (const bad of [undefined, '', 'x'.repeat(500), 42]) {
    assert.equal((await call('/hub/preview', { method: 'POST', body: { token: bad } })).status, 404);
  }
  assert.equal((await call('/hub/preview', { method: 'POST', body: { token }, headers: { origin: 'https://evil.example' } })).status, 403);
});

test('a preview reads what the client reads: the session, the projects, the project and its review copy', async () => {
  const j = await job();
  const { cookie } = await preview(j);
  const session = await call(marked('/hub/session'), { cookie });
  assert.equal(session.status, 200);
  assert.equal(session.body.preview.projectId, j.projectId);
  assert.ok(Date.parse(session.body.preview.expiresAt) > Date.now());

  const asClient = await call(`/hub/projects/${j.projectId}`, { cookie: j.session });
  const asPreview = await call(marked(`/hub/projects/${j.projectId}`), { cookie });
  assert.equal(asPreview.status, 200);
  assert.deepEqual(unmarkedBody(asPreview.body), asClient.body, 'the same page the client gets, notes included');
  assert.deepEqual((await call(marked('/hub/projects'), { cookie })).body, (await call('/hub/projects', { cookie: j.session })).body);

  // The review links it is given carry the marker, since a <video> can't add it.
  const link = asPreview.body.project.deliverables[0].versions[0].review.url;
  assert.match(link, /\/review\?preview=1$/);
  const review = await call(link.replace('https://hub.example', ''), { cookie });
  assert.equal(review.status, 200);
  assert.equal(review.text, 'video-bytes');

  // The client's own session says nothing about a preview.
  assert.equal((await call('/hub/session', { cookie: j.session })).body.preview, null);
  // Another client's project is the same not found it is for them.
  const other = await job();
  assert.equal((await call(marked(`/hub/projects/${other.projectId}`), { cookie })).status, 404);
});

test('the server refuses every write under a preview, whatever the route, and nothing changes', async () => {
  const j = await job();
  const { cookie } = await preview(j);
  const routes = hubRoutes();

  // Every hub write either goes through signedIn (so a preview is refused there), or is one
  // of these, none of which acts as a client. A new client write without signedIn fails here.
  const notAsClient = ['/hub/auth', '/hub/invite', '/hub/sign-out', '/hub/preview', '/hub/preview/end', '/hub/publish-asset'];
  const writes = routes.filter((r) => r.method !== 'GET' && r.method !== 'HEAD');
  assert.deepEqual(writes.filter((r) => !r.signedIn && !notAsClient.includes(r.path)), []);
  const clientWrites = writes.filter((r) => r.signedIn);
  for (const want of ['POST /hub/projects/:id/items/:itemId/notes', 'DELETE /hub/projects/:id/notes/:noteId',
    'POST /hub/projects/:id/items/:itemId/submit', 'POST /hub/projects/:id/items/:itemId/approve']) {
    assert.ok(clientWrites.some((r) => `${r.method} ${r.path}` === want), `${want} is found`);
  }

  const fill = (p) => p.replace(':id', j.projectId).replace(':itemId', j.film).replace(':noteId', j.noteId).replace(':versionId', j.v1);
  const before = footprint(j);
  for (const r of clientWrites) {
    const at = fill(r.path);
    const body = { versionId: j.v1, text: 'From a preview' };
    // From the preview's page: from the portal, from nowhere, and with the client's own sign-in beside it.
    for (const [c, headers] of [[cookie, { origin: PORTAL }], [cookie, {}], [both(j.session, cookie), { origin: PORTAL }]]) {
      const res = await call(marked(at), { method: r.method, body, cookie: c, headers });
      assert.equal(res.status, 403, `${r.method} ${r.path}: ${res.text}`);
      assert.equal(res.body.error, 'preview');
    }
    // The preview's cookie alone, unmarked, is no sign-in at all.
    assert.equal((await call(at, { method: r.method, body, cookie })).status, 401, `${r.method} ${r.path} unmarked`);
  }
  assert.deepEqual(footprint(j), before, 'no note, set, approval, activity or session touched');

  // The same client, signed in as themselves, still writes: the refusal is the preview's alone.
  const own = await call(fill('/hub/projects/:id/items/:itemId/notes'), { method: 'POST', body: { versionId: j.v1, text: 'Mine' }, cookie: both(j.session, cookie) });
  assert.equal(own.status, 201);
});

test('a preview that has ended is never answered as whoever else is signed in on the browser', async () => {
  const mine = await job();     // the client signed in on the studio's browser
  const theirs = await job();   // the client being previewed
  const { cookie } = await preview(theirs);
  const jar = both(mine.session, cookie);
  assert.equal((await call(marked('/hub/session'), { cookie: jar })).body.client.businessName, `Salt ${serial}`);

  // Ended (here, or in another tab), or past its hour: marked calls are told so, reads and writes alike.
  await call('/hub/preview/end', { method: 'POST', body: {}, cookie });
  const before = footprint(mine);
  for (const [url, init] of [
    [marked('/hub/session'), {}],
    [marked(`/hub/projects/${mine.projectId}`), {}],
    [marked(`/hub/projects/${mine.projectId}/items/${mine.film}/notes`), { method: 'POST', body: { versionId: mine.v1, text: 'Not as me' } }],
    [marked(`/hub/projects/${mine.projectId}/items/${mine.film}/approve`), { method: 'POST', body: { versionId: mine.v1 } }],
  ]) {
    const res = await call(url, { ...init, cookie: jar });
    assert.deepEqual([res.status, res.body.error], [401, 'preview_ended'], url);
  }
  assert.deepEqual(footprint(mine), before);

  const late = await preview(theirs);
  db.prepare("UPDATE portal_previews SET expires_at = '2000-01-01T00:00:00.000Z' WHERE expires_at IS NOT NULL").run();
  const res = await call(marked(`/hub/projects/${theirs.projectId}`), { cookie: both(mine.session, late.cookie) });
  assert.deepEqual([res.status, res.body.error], [401, 'preview_ended']);
});

test('a client’s own tab beside a live preview stays theirs', async () => {
  const mine = await job();
  const theirs = await job();
  const { cookie } = await preview(theirs);
  const jar = both(mine.session, cookie);
  // Unmarked calls ignore the preview: the client's own session, their projects, their writes.
  const session = await call('/hub/session', { cookie: jar });
  assert.deepEqual([session.body.client.businessName, session.body.preview], [`Salt ${serial - 1}`, null]);
  assert.deepEqual((await call('/hub/projects', { cookie: jar })).body.projects.map((p) => p.id), [mine.projectId]);
  assert.equal((await call(`/hub/projects/${mine.projectId}`, { cookie: jar })).status, 200);
  assert.equal((await call(`/hub/projects/${theirs.projectId}`, { cookie: jar })).status, 404);
  const note = await call(`/hub/projects/${mine.projectId}/items/${mine.film}/notes`,
    { method: 'POST', body: { versionId: mine.v1, text: 'Still mine' }, cookie: jar, headers: { origin: PORTAL } });
  assert.equal(note.status, 201);
});

test('nothing is logged as the client: no session, no sign-in, no "last seen"', async () => {
  const j = await job();
  const status = accessStatus(db, j.clientId);
  db.prepare("UPDATE client_sessions SET last_seen_at = '2026-01-01T00:00:00.000Z' WHERE client_id = ?").run(j.clientId);
  const before = footprint(j);

  const { cookie } = await preview(j);
  for (let i = 0; i < 3; i += 1) {
    await call(marked('/hub/session'), { cookie });
    await call(marked(`/hub/projects/${j.projectId}`), { cookie });
    await call(marked(`/hub/projects/${j.projectId}/versions/${j.v1}/review`), { cookie });
  }
  assert.deepEqual(footprint(j), before);
  assert.deepEqual(accessStatus(db, j.clientId), status, 'the studio’s view of the client’s access is unchanged');
});

test('ending a preview leaves the client’s own sign-in; sign-out ends both; an hour on, it is gone', async () => {
  const j = await job();
  const { cookie } = await preview(j);
  const ended = await call('/hub/preview/end', { method: 'POST', body: {}, cookie: both(j.session, cookie), headers: { origin: PORTAL } });
  assert.equal(ended.status, 200);
  assert.equal(ended.set.lsc_portal_preview, '', 'its cookie is cleared');
  assert.ok(!('lsc_portal' in ended.set));
  assert.equal((await call(marked('/hub/session'), { cookie })).status, 401);
  assert.equal((await call('/hub/session', { cookie: both(j.session, cookie) })).body.preview, null, 'the client’s sign-in carries on');

  const again = await preview(j);
  const out = await call('/hub/sign-out', { method: 'POST', body: {}, cookie: both(j.session, again.cookie), headers: { origin: PORTAL } });
  assert.deepEqual([out.set.lsc_portal, out.set.lsc_portal_preview], ['', '']);
  assert.equal((await call(marked('/hub/session'), { cookie: again.cookie })).status, 401);

  const late = await preview(j);
  assert.ok(PREVIEW_MS <= 60 * 60 * 1000, 'an hour at most');
  db.prepare("UPDATE portal_previews SET expires_at = '2000-01-01T00:00:00.000Z' WHERE expires_at IS NOT NULL").run();
  assert.equal((await call(marked(`/hub/projects/${j.projectId}`), { cookie: late.cookie })).status, 401);
});

test('a preview never holds up deleting its project or client', async () => {
  // A project with no client data (S11 lets it go), previewed, then deleted: its previews go with it.
  const j = await job();
  await preview(j);
  await mint(j.projectId); // and one link never opened
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM portal_previews WHERE project_id = ?').get(j.projectId).n, 2);
  db.prepare('DELETE FROM client_notes WHERE project_id = ?').run(j.projectId);
  db.prepare('DELETE FROM client_sessions WHERE client_id = ?').run(j.clientId);
  db.prepare('DELETE FROM deliverable_versions WHERE project_id = ?').run(j.projectId);
  db.prepare('DELETE FROM deliverables WHERE project_id = ?').run(j.projectId);
  const gone = await call(`/api/projects/${j.projectId}`, { method: 'DELETE', cookie: admin });
  assert.equal(gone.status, 200, gone.text);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM portal_previews WHERE project_id = ?').get(j.projectId).n, 0);
  const client = await call(`/api/clients/${j.clientId}`, { method: 'DELETE', cookie: admin });
  assert.equal(client.status, 200, client.text);
});
