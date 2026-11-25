'use strict';

/* Real client sessions (merged-admin C1), on the real app with the portal
 * mounted: the studio issues a Client code, the client signs in with it, the
 * server checks the session on every client route, another client's project
 * is the same "not found" as none, old per-project codes work until a reset,
 * and nothing internal reaches any portal reply (S9). A throwaway database and
 * folder: nothing here reaches real data. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-portal-sessions-'));
process.env.DATA_DIR = TMP;
process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough-0123456789';
process.env.COOKIE_SECURE = '0';
process.env.NODE_ENV = 'test';

const { openDatabase, nowIso, newId } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');

const PASSWORD = 'a-long-test-password';
const PORTAL = 'https://lsccreative.studio';
const PORTAL_URL = 'https://lsccreative.studio/client-hub-app/';
const APP = 'https://app.example/';
const DELIVERABLES = path.join(TMP, 'deliverables');
fs.mkdirSync(DELIVERABLES, { recursive: true });
const hub = {
  signingSecret: 'test-signing-secret',
  corsOrigins: [PORTAL],
  publicBaseUrl: 'https://hub.example',
  portalUrl: PORTAL_URL,
  deliverablesDir: DELIVERABLES,
  backupDir: path.join(TMP, 'backups'),
  bunny: {},
};

let db;
let server;
let base;
let admin;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

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
const studio = (url, opts = {}) => call(url, { ...opts, cookie: admin });
const signIn = (email, code) => call('/hub/auth', { method: 'POST', body: { email, code } });

test.before(async () => {
  db = openDatabase(path.join(TMP, 'billing.db'));
  db.prepare('INSERT INTO account (id, username, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?, ?)')
    .run('tester', await hashPassword(PASSWORD), nowIso(), nowIso());
  const app = createApp(db, { hub, appUrl: APP });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  admin = login.headers.getSetCookie()[0].split(';')[0];
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

/* ── Seeding, with something private in every field the portal mustn't show ── */

let serial = 0;
const uniq = (p) => { serial += 1; return `${p}${serial}`; };

function client(email, name = uniq('Client ')) {
  const id = newId('cl');
  const now = nowIso();
  db.prepare(`INSERT INTO clients (id, business_name, contact_name, email, phone, abn, address, notes, created_at, updated_at)
              VALUES (?, ?, 'Priya Nair', ?, '0400 111 222', '51824753556', '1 SECRET-ADDRESS St', 'INTERNAL-CLIENT-NOTE', ?, ?)`)
    .run(id, name, email, now, now);
  return id;
}

const TOTALS = { floor: 900, taxSetAside: 300, overheadShare: 120, estTakeHome: 480, costBreakdown: { crew: 1 }, totalIncGst: 1650,
  surcharges: 50, margin: 0.3 };
/* An invoice's totals as billing keeps them: the client's amount (1650) beside the internal figures. */
const INVOICE_TOTALS = { ...TOTALS, total: { clientPriceExGst: 1500, gst: 150, totalIncGst: 1650 },
  balance: { clientPriceExGst: 1500, gst: 150, totalIncGst: 1650 } };

function project(clientId, { accepted = true, archived = false, name = uniq('Harbour film '), upid = uniq('U-') } = {}) {
  const id = newId('prj');
  const now = nowIso();
  db.prepare(`INSERT INTO projects (id, upid, client_id, needs_upid, accepted_at, archived_at, no_deliverables_at, created_at, updated_at)
              VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`)
    .run(id, upid, clientId, accepted ? now : null, archived ? now : null, archived ? now : null, now, now);
  db.prepare(`INSERT INTO estimates (id, project_id, upid, name, date, status, client_id, client_json, notes, active_rows_json, totals_json,
                                     surcharges_json, created_at, updated_at)
              VALUES (?, ?, ?, ?, '2026-10-01', ?, ?, ?, 'INTERNAL-NOTE-MARKER', ?, ?, '{"rush":0.25}', ?, ?)`)
    .run(newId('est'), id, upid, name, accepted ? 'accepted' : 'draft', clientId,
      JSON.stringify({ businessName: 'Salt', contactName: 'Priya Nair', email: 'quote-only@salt.example', phone: '0400 111 222', abn: '51824753556' }),
      JSON.stringify({ deliverables: [{ name: 'Hero', qty: 1, rate: 1500, price: 1500 }] }), JSON.stringify(TOTALS), now, now);
  // A sent invoice would make even a draft quote's project invoiced work, so only accepted ones get one.
  if (accepted) {
    db.prepare(`INSERT INTO invoices (id, project_id, kind, number, status, totals_json, estimate_snapshot_json, issued_at, due_at,
                                      public_token, created_at, updated_at)
                VALUES (?, ?, 'single', ?, 'sent', ?, '{"secret":"INVOICE-SNAPSHOT"}', '2026-11-01', '2026-11-15', ?, ?, ?)`)
      .run(newId('inv'), id, uniq('INV-'), JSON.stringify(INVOICE_TOTALS), uniq('invtoken'), now, now);
  }
  return id;
}

/* A checklist: a published Hero (with a newer draft not yet published), and an item marked not needed. */
function checklist(projectId) {
  const now = nowIso();
  const hero = newId('dlv');
  db.prepare(`INSERT INTO deliverables (id, project_id, position, title, format, duration, stage, created_at, updated_at)
              VALUES (?, ?, 1, 'Hero film', 'FORMAT-INTERNAL', '60s', 'draft', ?, ?)`).run(hero, projectId, now, now);
  const version = (n, published) => db.prepare(`
    INSERT INTO deliverable_versions (id, deliverable_id, project_id, n, stage, source_path, file_name, kind, photo_count, drive_link, created_at, published_at)
    VALUES (?, ?, ?, ?, 'draft', 'Acme/SECRET-NAS-PATH/Hero.mp4', 'Hero-v${n}-PRIVATE-FILENAME.mp4', 'video', 0, 'https://drive.example/SECRET-DRIVE', ?, ?)
  `).run(newId('ver'), hero, projectId, n, now, published ? now : null);
  version(1, true);
  version(2, false);
  db.prepare(`INSERT INTO deliverables (id, project_id, position, title, stage, not_needed_at, created_at, updated_at)
              VALUES (?, ?, 2, 'NOT-NEEDED-ITEM', 'draft', ?, ?, ?)`).run(newId('dlv'), projectId, now, now, now);
  return hero;
}

const issue = (clientId, body = {}) => studio(`/api/clients/${clientId}/portal`, { method: 'POST', body });

/* ── The studio issues the code ─────────────────────────────────────────── */

test('the studio issues a Client code and an invite link, once, behind its login', async () => {
  const id = client('issue@salt.example');
  const own = project(id);
  assert.equal((await call(`/api/clients/${id}/portal`, { method: 'POST', body: {} })).status, 401);
  assert.equal((await issue('cl_nobody')).status, 404);

  const r = await issue(id, { projectId: own });
  assert.equal(r.status, 200, r.text);
  assert.match(r.body.code, /^\d{6}$/);
  const invite = r.body.inviteUrl.split('#/invite/')[1];
  assert.equal(r.body.inviteUrl, `${PORTAL_URL}#/invite/${invite}`, 'the token rides in the fragment');
  assert.match(invite, /^[0-9a-f]{48}$/);
  assert.deepEqual([r.body.access.hasCode, r.body.access.inviteProjectId, r.body.access.oldCodes], [true, own, 0]);

  const row = db.prepare('SELECT * FROM client_logins WHERE client_id = ?').get(id);
  assert.ok(!JSON.stringify(row).includes(r.body.code), 'the code isn’t kept');
  assert.ok(!JSON.stringify(row).includes(invite), 'nor the invite');
  const status = await studio(`/api/clients/${id}/portal`);
  assert.ok(!status.text.includes(r.body.code), 'and is never shown again');
  assert.equal(status.body.access.hasCode, true);
});

test('a code needs the client’s own address, and an invite one of their projects (S13)', async () => {
  const none = client('');
  assert.equal((await issue(none)).body.error, 'email_required');
  const a = client('shared@salt.example');
  client('shared@salt.example'); // from before R2's rule
  assert.equal((await issue(a)).body.error, 'email_shared');
  const b = client('own@salt.example');
  const theirs = project(client('else@salt.example'));
  assert.equal((await issue(b, { projectId: theirs })).body.error, 'project_invalid');
  assert.equal(db.prepare('SELECT COUNT(*) FROM client_logins WHERE client_id IN (?, ?, ?)').pluck().get(none, a, b), 0);
});

test('without the portal’s secret the studio can’t issue a code, and says why', async () => {
  const bare = createApp(db, { hub: null });
  const s = await new Promise((resolve) => { const x = bare.listen(0, '127.0.0.1', () => resolve(x)); });
  try {
    const url = `http://127.0.0.1:${s.address().port}`;
    const id = client('nosecret@salt.example');
    const r = await fetch(`${url}/api/clients/${id}/portal`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: admin }, body: '{}' });
    assert.deepEqual([r.status, (await r.json()).error], [503, 'portal_not_set_up']);
  } finally { await new Promise((r) => s.close(r)); }
});

/* ── Signing in ─────────────────────────────────────────────────────────── */

test('the client signs in with their address and Client code; a reset ends every session and the old code', async () => {
  const id = client('sign@salt.example');
  const first = (await issue(id)).body.code;
  const one = await signIn('Sign@Salt.example', first);
  assert.equal(one.status, 200, one.text);
  assert.ok(one.session);
  assert.equal((await call('/hub/session', { cookie: one.session })).status, 200);

  const second = (await issue(id)).body.code;
  assert.equal((await call('/hub/session', { cookie: one.session })).status, 401, 'signed out by the reset');
  assert.equal((await signIn('sign@salt.example', first)).status, first === second ? 200 : 401);
  assert.equal((await signIn('sign@salt.example', second)).status, 200);
});

test('a client’s address change moves their sign-in with it; the code stays theirs', async () => {
  const id = client('before@salt.example', 'Mover Co');
  const { code } = (await issue(id)).body;
  const put = await studio(`/api/clients/${id}`, { method: 'PUT', body: { businessName: 'Mover Co', email: 'after@salt.example' } });
  assert.equal(put.status, 200, put.text);
  assert.equal((await signIn('before@salt.example', code)).status, 401);
  assert.equal((await signIn('after@salt.example', code)).status, 200);
  // A client with a login can't lose their address.
  const empty = await studio(`/api/clients/${id}`, { method: 'PUT', body: { businessName: 'Mover Co', email: '' } });
  assert.equal(empty.body.error, 'email_required');
});

test('an address two clients share signs nobody in, even with a right code (S13)', async () => {
  const a = client('two@salt.example');
  // Issued before the second client took the same address (only possible from before R2).
  const { code } = (await issue(a)).body;
  client('two@salt.example');
  const r = await signIn('two@salt.example', code);
  assert.deepEqual([r.status, r.body], [401, { error: 'wrong_code' }], 'the same refusal as a wrong code');
});

test('old per-project codes and invites work until the client is issued a Client code', async () => {
  const id = client('legacy@salt.example');
  const prj = project(id);
  const now = nowIso();
  // An old hub project brought in by R4: the portal's rows keep the hub's id.
  db.prepare("INSERT INTO records (project_id, data, updated_at) VALUES ('hub_old1', '{}', ?)").run(now);
  db.prepare(`INSERT INTO private_auth (project_id, client_email, email_hash, code_hash, invite_token, delivered, updated_at)
              VALUES ('hub_old1', 'legacy@salt.example', ?, ?, 'old-invite-token', 0, ?)`).run(sha('legacy@salt.example'), sha('4821'), now);
  db.prepare(`INSERT INTO hub_imports (hub_id, project_id, outcome, source_json, imported_at) VALUES ('hub_old1', ?, 'imported', '{}', ?)`).run(prj, now);

  const status = await studio(`/api/clients/${id}/portal`);
  assert.deepEqual([status.body.access.hasCode, status.body.access.oldCodes], [false, 1]);
  assert.equal((await signIn('legacy@salt.example', '4822')).status, 401);
  const old = await signIn('legacy@salt.example', '4821');
  assert.equal(old.status, 200, old.text);
  assert.equal(db.prepare('SELECT via FROM client_sessions WHERE client_id = ?').pluck().get(id), 'legacy');
  const projects = await call('/hub/projects', { cookie: old.session });
  assert.deepEqual(projects.body.projects.map((p) => p.id), [prj], 'the session is the client’s, opening their projects');
  const invite = await call('/hub/invite', { method: 'POST', body: { token: 'old-invite-token' } });
  assert.deepEqual([invite.status, invite.body.projectId, invite.body.email], [200, prj, 'legacy@salt.example']);

  // The old code is for its own address only.
  assert.equal((await signIn('someone@else.example', '4821')).status, 401);

  const { code } = (await issue(id)).body;
  assert.equal((await signIn('legacy@salt.example', '4821')).status, 401, 'retired by the reset');
  assert.equal((await call('/hub/invite', { method: 'POST', body: { token: 'old-invite-token' } })).status, 404);
  assert.equal((await signIn('legacy@salt.example', code)).status, 200);
});

test('a write from another site is refused before anything is read', async () => {
  const id = client('origin@salt.example');
  const { code } = (await issue(id)).body;
  const evil = await call('/hub/auth', { method: 'POST', body: { email: 'origin@salt.example', code }, headers: { origin: 'https://evil.example' } });
  assert.deepEqual([evil.status, evil.session], [403, null]);
  const good = await call('/hub/auth', { method: 'POST', body: { email: 'origin@salt.example', code }, headers: { origin: PORTAL } });
  assert.equal(good.status, 200);
});

/* ── Whose projects ─────────────────────────────────────────────────────── */

test('a client sees their own accepted work, current and past; anyone else’s is the same not found', async () => {
  const mine = client('mine@salt.example');
  const theirs = client('theirs@salt.example');
  const live = project(mine);
  const past = project(mine, { archived: true });
  const quote = project(mine, { accepted: false });
  const other = project(theirs);
  const { code } = (await issue(mine)).body;
  const { session } = await signIn('mine@salt.example', code);

  const list = await call('/hub/projects', { cookie: session });
  assert.deepEqual(list.body.projects.map((p) => [p.id, p.past]).sort(), [[live, false], [past, true]].sort());
  assert.ok(!list.text.includes(quote), 'a quote still being decided isn’t the portal’s');

  const nobody = await call('/hub/projects/prj_nobody', { cookie: session });
  for (const id of [other, quote]) {
    const r = await call(`/hub/projects/${id}`, { cookie: session });
    assert.deepEqual([r.status, r.body], [nobody.status, nobody.body], id);
  }
  assert.deepEqual([nobody.status, nobody.body], [404, { error: 'not_found' }]);
  assert.equal((await call(`/hub/projects/${live}`)).status, 401, 'signed out');
  assert.equal((await call(`/hub/projects/${live}`, { cookie: session })).status, 200);
});

/* ── The review copy (C2) ───────────────────────────────────────────────── */

/* A published video and a published photo library on this throwaway NAS, plus an
   unpublished version and an item marked not needed, both with real files. */
function media(projectId) {
  const now = nowIso();
  const folder = `Media${serial += 1}`;
  fs.mkdirSync(path.join(DELIVERABLES, folder, 'Stills'), { recursive: true });
  fs.writeFileSync(path.join(DELIVERABLES, folder, 'Cut.mp4'), Buffer.from('0123456789abcdefghij'));
  for (const name of ['b.jpg', 'a.jpg', 'notes.txt']) fs.writeFileSync(path.join(DELIVERABLES, folder, 'Stills', name), `image ${name}`);
  const ids = {};
  const item = (key, notNeeded) => {
    ids[key] = newId('dlv');
    db.prepare(`INSERT INTO deliverables (id, project_id, position, title, stage, not_needed_at, created_at, updated_at)
                VALUES (?, ?, 1, ?, 'draft', ?, ?, ?)`).run(ids[key], projectId, key, notNeeded ? now : null, now, now);
  };
  const version = (key, itemKey, n, source, kind, published) => {
    ids[key] = newId('ver');
    db.prepare(`INSERT INTO deliverable_versions (id, deliverable_id, project_id, n, stage, source_path, file_name, kind, photo_count, created_at, published_at)
                VALUES (?, ?, ?, ?, 'draft', ?, '', ?, 2, ?, ?)`).run(ids[key], ids[itemKey], projectId, n, source, kind, now, published ? now : null);
  };
  item('film'); item('stills'); item('dropped', true);
  version('cut', 'film', 1, `${folder}/Cut.mp4`, 'video', true);
  version('unpublished', 'film', 2, `${folder}/Cut.mp4`, 'video', false);
  version('photos', 'stills', 1, `${folder}/Stills`, 'photos', true);
  version('droppedCut', 'dropped', 1, `${folder}/Cut.mp4`, 'video', true);
  ids.folder = folder;
  return ids;
}
const photoKey = (name) => sha(`photo\n${name}`).slice(0, 16);

test('a client plays their own published versions from the NAS, view only, and nothing else (C2)', async () => {
  const id = client('media@salt.example');
  const prj = project(id);
  const ids = media(prj);
  const { code } = (await issue(id)).body;
  const { session } = await signIn('media@salt.example', code);
  const at = (versionId, q = '') => `/hub/projects/${prj}/versions/${versionId}/review${q}`;

  const view = (await call(`/hub/projects/${prj}`, { cookie: session })).body.project;
  const byTitle = Object.fromEntries(view.deliverables.map((d) => [d.title, d]));
  assert.deepEqual(Object.keys(byTitle).sort(), ['film', 'stills']);
  assert.deepEqual(byTitle.film.versions.map((v) => v.review), [{ type: 'file', url: `https://hub.example${at(ids.cut)}` }]);
  assert.deepEqual(byTitle.stills.versions[0].review,
    { type: 'photos', urls: ['a.jpg', 'b.jpg'].map((n) => `https://hub.example${at(ids.photos, `?photo=${photoKey(n)}`)}`) },
    'images only, in order, by a key that names no file');
  assert.ok(!JSON.stringify(view).includes('a.jpg'));

  const whole = await call(at(ids.cut), { cookie: session });
  assert.deepEqual([whole.status, whole.text], [200, '0123456789abcdefghij']);
  const ranged = await fetch(base + at(ids.cut), { headers: { cookie: session, range: 'bytes=5-9' } });
  assert.deepEqual([ranged.status, ranged.headers.get('content-range'), await ranged.text()], [206, 'bytes 5-9/20', '56789']);
  assert.equal(ranged.headers.get('content-disposition'), 'inline', 'plays, never saves');
  assert.equal(ranged.headers.get('cache-control'), 'no-store', 'nothing left to play after signing out');
  const photo = (name) => call(at(ids.photos, `?photo=${photoKey(name)}`), { cookie: session });
  assert.equal((await photo('a.jpg')).text, 'image a.jpg');
  assert.equal((await photo('b.jpg')).text, 'image b.jpg');

  // A photo added to the folder later: every link still opens its own image, and the new one opens too.
  fs.writeFileSync(path.join(DELIVERABLES, ids.folder, 'Stills', 'a0.jpg'), 'image a0.jpg');
  assert.equal((await photo('b.jpg')).text, 'image b.jpg', 'the same link, the same photo');
  assert.equal((await photo('a0.jpg')).text, 'image a0.jpg', 'a new photo is found at once');
  const again = (await call(`/hub/projects/${prj}`, { cookie: session })).body.project;
  assert.equal(again.deliverables.find((d) => d.title === 'stills').versions[0].review.urls.length, 3);

  // Everything else is one not found: past the end, not a number, a path, a video asked for a photo,
  // unpublished, an item not needed, a version from another project, another client's.
  const other = project(client('other@salt.example'));
  const otherIds = media(other);
  const refused = [at(ids.photos, `?photo=${photoKey('missing.jpg')}`), at(ids.photos), at(ids.photos, '?photo=0'),
    at(ids.photos, `?photo=${photoKey('notes.txt')}`), at(ids.photos, '?photo=a.jpg'), at(ids.photos, '?photo=../Cut.mp4'),
    at(ids.cut, `?photo=${photoKey('a.jpg')}`), at(ids.unpublished), at(ids.droppedCut), at('ver_nobody'),
    at(otherIds.cut), `/hub/projects/${other}/versions/${otherIds.cut}/review`];
  for (const url of refused) {
    const r = await call(url, { cookie: session });
    assert.deepEqual([r.status, r.body], [404, { error: 'not_found' }], url);
  }
  assert.equal((await call(at(ids.cut))).status, 401, 'signed out');
});

/* ── The dashboard and project page (C3) ───────────────────────────────── */

test('a project says what to do next, how each item stands, the invoices sent, and the signed agreement (C3)', async () => {
  const id = client('c3@salt.example');
  const prj = project(id);
  const now = nowIso();
  const invoice = (kind, status, extra = {}) => {
    const row = { id: newId('inv'), number: uniq('INV-'), token: uniq('tok'), ...extra };
    db.prepare(`INSERT INTO invoices (id, project_id, kind, number, status, totals_json, issued_at, due_at, paid_at, public_token,
                                      hnry_number, hnry_invoice_id, hnry_pushed_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, '2026-11-01', '2026-11-15', ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, prj, kind, row.number, status, JSON.stringify(INVOICE_TOTALS), status === 'paid' ? '2026-11-10' : null, row.token,
        row.hnry || null, row.hnry ? 'hnry-1' : null, row.pushed || null, now, now);
    return row;
  };
  const paid = invoice('deposit', 'paid');
  invoice('final', 'draft');
  invoice('final', 'scheduled');
  invoice('final', 'void');
  const hnry = invoice('final', 'sent', { hnry: 'HNRY-0042' });
  // Pushed to Hnry, its number not back yet: billing's own is Hnry's PO field, never the client's.
  const pending = invoice('single', 'sent', { pushed: now });

  // Items: one approved on the old hub, one with notes, one published, one not yet.
  const item = (title, hubStatus, published) => {
    const d = newId('dlv');
    db.prepare(`INSERT INTO deliverables (id, project_id, position, title, stage, hub_status, created_at, updated_at)
                VALUES (?, ?, 1, ?, 'draft', ?, ?, ?)`).run(d, prj, title, hubStatus, now, now);
    if (published) {
      db.prepare(`INSERT INTO deliverable_versions (id, deliverable_id, project_id, n, stage, file_name, kind, photo_count, created_at, published_at)
                  VALUES (?, ?, ?, 1, 'draft', '', 'video', 0, ?, ?)`).run(newId('ver'), d, prj, now, now);
    }
  };
  item('approved', 'approved', true); item('changes', 'changes', true); item('review', null, true); item('production', null, false);

  // Signed on the quote page: the agreement is that page.
  const est = db.prepare('SELECT id FROM estimates WHERE project_id = ?').get(prj).id;
  db.prepare("UPDATE estimates SET public_token = 'quote-token-c3' WHERE id = ?").run(est);
  const ver = newId('ev');
  db.prepare(`INSERT INTO estimate_versions (id, estimate_id, n, snapshot_json, client_view_json, sent_at) VALUES (?, ?, 1, '{}', '{"days":[]}', ?)`)
    .run(ver, est, now);
  db.prepare(`INSERT INTO signatures (id, version_id, full_name, role, signed_at, agreement_text, agreement_sha256)
              VALUES (?, ?, 'Priya Nair', 'Director', '2026-10-03T22:00:00.000Z', 'text', 'sha')`).run(newId('sig'), ver);

  const { code } = (await issue(id)).body;
  const { session } = await signIn('c3@salt.example', code);
  const view = (await call(`/hub/projects/${prj}`, { cookie: session })).body.project;

  // Notes with the studio come first in the state model: nothing waits on the client.
  assert.equal(view.status, 'We’re making your changes');
  assert.equal(view.needsYou, false);
  assert.match(view.nextStep, /Nothing to do for now/);
  assert.deepEqual(Object.fromEntries(view.deliverables.map((d) => [d.title, d.status])),
    { approved: 'approved', changes: 'changes', review: 'review', production: 'production' });

  // Sent and paid only, in order; Hnry's number and no page for the one in Hnry.
  const byId = Object.fromEntries(view.invoices.map((i) => [i.id, i]));
  assert.deepEqual([byId[pending.id].number, byId[pending.id].url], ['', null], 'in Hnry without Hnry’s number: none yet');
  const byLabel = Object.fromEntries(view.invoices.filter((i) => i.id !== pending.id).map((i) => [i.label, i]));
  assert.deepEqual(Object.keys(byLabel).sort(), ['Deposit', 'Final invoice', 'Invoice'], 'no draft, scheduled or void one');
  assert.deepEqual([byLabel.Deposit.number, byLabel.Deposit.state, byLabel.Deposit.amount, byLabel.Deposit.paidOn, byLabel.Deposit.url],
    [paid.number, 'paid', 1650, '2026-11-10', `${APP}c/#i/${paid.token}`]);
  assert.deepEqual([byLabel['Final invoice'].number, byLabel['Final invoice'].state, byLabel['Final invoice'].amount, byLabel['Final invoice'].url],
    ['HNRY-0042', 'overdue', 1650, null], 'Hnry’s number, and no billing page');
  assert.equal(byLabel.Invoice.dueOn, '2026-11-15');
  assert.ok(!view.invoices.some((i) => i.url && i.url.includes(hnry.token)), 'billing’s page isn’t offered for an invoice in Hnry');
  // Signed at 8am on 4 October in Sydney (22:00 UTC the day before): Sydney's day, as the quote page says.
  assert.deepEqual(view.agreement, { url: `${APP}c/#e/quote-token-c3`, signedOn: '2026-10-04' });

  // Opening that page from the portal doesn't log the accepted quote as "opened" again.
  const opened = () => db.prepare("SELECT COUNT(*) FROM activity WHERE project_id = ? AND kind = 'opened'").pluck().get(prj);
  const before = opened();
  assert.equal((await call('/public/estimates/quote-token-c3')).status, 200);
  assert.equal(opened(), before, 'an accepted quote’s opens aren’t a sales signal');

  // A later version on that estimate: its page no longer offers the signed agreement, so the portal doesn't either.
  db.prepare(`INSERT INTO estimate_versions (id, estimate_id, n, snapshot_json, client_view_json, sent_at) VALUES (?, ?, 2, '{}', '{}', ?)`)
    .run(newId('ev'), est, now);
  assert.equal((await call(`/hub/projects/${prj}`, { cookie: session })).body.project.agreement, null);

  // A project accepted in the app was never signed here: no agreement to show.
  const other = project(id);
  assert.equal((await call(`/hub/projects/${other}`, { cookie: session })).body.project.agreement, null);
  const list = (await call('/hub/projects', { cookie: session })).body.projects;
  assert.ok(list.every((p) => typeof p.nextStep === 'string' && typeof p.needsYou === 'boolean'));
});

/* ── The leak test (S9) ─────────────────────────────────────────────────── */

/* Since C3 an invoice the client was sent is theirs to see: its number and the amount it asks for
   (1650 here). Everything else about the money stays out: the ex-GST price (1500), the floor,
   tax set-aside, take-home, overhead, surcharges and margin, by name and by value. `hourlyRate`
   (C5) is the rate the client's own signed agreement states, quoted back to them; the studio's
   rate card is still forbidden by name (`rate` on its own). */
const FORBIDDEN = /surcharge|floor|taxSetAside|overheadShare|estTakeHome|costBreakdown|clientPrice|totalIncGst|exGst|\bgst\b|\bprice\b|\brate\b|margin|markup|total/i;
const SECRETS = ['INTERNAL-NOTE-MARKER', 'INTERNAL-CLIENT-NOTE', '0400 111 222', '51824753556', 'SECRET-ADDRESS', 'quote-only@salt.example',
  'SECRET-NAS-PATH', 'PRIVATE-FILENAME', 'SECRET-DRIVE', 'NOT-NEEDED-ITEM', 'FORMAT-INTERNAL', 'INVOICE-SNAPSHOT', '1500', '900', '480'];
function keysOf(v, out = []) {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => { out.push(k); keysOf(x, out); });
  return out;
}

test('the leak test: every portal reply is exactly its allow-list, with nothing priced, private or internal in it (S9)', async () => {
  const id = client('leak@salt.example', 'Salt Studio');
  const prj = project(id, { name: 'Harbour launch' });
  const hero = checklist(prj);
  db.prepare("INSERT INTO records (project_id, data, updated_at) VALUES (?, '{}', ?)").run(prj, nowIso());
  const issued = await issue(id, { projectId: prj });
  const invite = issued.body.inviteUrl.split('#/invite/')[1];

  const auth = await signIn('leak@salt.example', issued.body.code);
  const { session } = auth;
  const replies = {
    auth,
    invite: await call('/hub/invite', { method: 'POST', body: { token: invite } }),
    session: await call('/hub/session', { cookie: session }),
    projects: await call('/hub/projects', { cookie: session }),
    project: await call(`/hub/projects/${prj}`, { cookie: session }),
    wrong: await signIn('leak@salt.example', '000000'),
    missing: await call('/hub/projects/prj_nobody', { cookie: session }),
    signedOut: await call('/hub/projects'),
  };
  // The review copy's link names ids only; its file isn't on this NAS, so it answers not found.
  const reviewUrl = replies.project.body.project.deliverables[0].versions[0].review.url;
  assert.match(reviewUrl, /^https:\/\/hub\.example\/hub\/projects\/[\w-]+\/versions\/[\w-]+\/review$/);
  replies.review = await call(reviewUrl.replace('https://hub.example', ''), { cookie: session });
  assert.equal(replies.review.status, 404);
  // CONFIRM APPROVAL (C5): the reply says when, and nothing of who or from where.
  const shown = replies.project.body.project.deliverables[0];
  replies.approve = await call(`/hub/projects/${prj}/items/${shown.id}/approve`, { method: 'POST', cookie: session, body: { versionId: shown.versions[0].id } });
  assert.equal(replies.approve.status, 201, replies.approve.text);
  replies.signOut = await call('/hub/sign-out', { method: 'POST', cookie: session });

  // Exactly these keys, and no others.
  const CLIENT = ['businessName', 'contactName'];
  const CARD = ['id', 'name', 'needsYou', 'nextStep', 'past', 'status', 'upid'];
  const ITEM = ['deliverables', 'id', 'notes', 'rounds', 'stage', 'status', 'title', 'versions'];
  const INVOICE = ['amount', 'dueOn', 'id', 'issuedOn', 'label', 'number', 'paidOn', 'state', 'url'];
  const VERSION = ['approvedAt', 'deemed', 'id', 'kind', 'n', 'photoCount', 'publishedAt', 'review', 'stage', 'submittedAt'];
  const sorted = (o) => Object.keys(o).sort();
  assert.deepEqual(sorted(replies.auth.body), ['client', 'ok']);
  assert.deepEqual(sorted(replies.auth.body.client), CLIENT);
  assert.deepEqual(sorted(replies.invite.body), ['email', 'ok', 'projectId']);
  assert.deepEqual(sorted(replies.session.body.client), CLIENT);
  replies.projects.body.projects.forEach((p) => assert.deepEqual(sorted(p), CARD));
  const view = replies.project.body.project;
  assert.deepEqual(sorted(view), [...CARD, 'agreement', 'deliverables', 'hourlyRate', 'invoices'].sort());
  assert.deepEqual(sorted(replies.approve.body), ['approval', 'itemStatus', 'ok']);
  assert.deepEqual(sorted(replies.approve.body.approval), ['approvedAt', 'deemed', 'versionId']);
  assert.equal(view.invoices.length, 1);
  view.invoices.forEach((inv) => assert.deepEqual(sorted(inv), INVOICE));
  assert.equal(view.invoices[0].amount, 1650, 'what the invoice asks for');
  assert.deepEqual(view.deliverables.map((d) => d.id), [hero], 'an item marked not needed isn’t shown');
  view.deliverables.forEach((d) => {
    assert.deepEqual(sorted({ ...d, deliverables: 1 }), ITEM);
    assert.deepEqual(d.versions.map((v) => v.n), [1], 'only what has been published');
    d.versions.forEach((v) => assert.deepEqual(sorted(v), VERSION));
    assert.deepEqual(sorted(d.rounds), ['included', 'used']);
  });
  assert.equal(view.name, 'Harbour launch');
  assert.equal(view.status, 'Ready for your review', 'the client’s wording, not the studio’s badge');
  assert.deepEqual([view.needsYou, view.deliverables[0].status], [true, 'review']);

  for (const [name, r] of Object.entries(replies)) {
    assert.ok(r.status < 500, `${name} ${r.status}`);
    assert.doesNotMatch(r.text, FORBIDDEN, `${name}: ${r.text.slice(0, 120)}`);
    keysOf(r.body).forEach((k) => assert.doesNotMatch(k, FORBIDDEN, `${name} key ${k}`));
    for (const s of SECRETS) assert.ok(!r.text.includes(s), `${name} leaked ${s}`);
  }
});

test('a client and their sessions go together; a session for a deleted client opens nothing', async () => {
  const id = client('gone@salt.example');
  const { code } = (await issue(id)).body;
  const { session } = await signIn('gone@salt.example', code);
  assert.equal((await studio(`/api/clients/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) FROM client_sessions WHERE client_id = ?').pluck().get(id), 0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM client_logins WHERE client_id = ?').pluck().get(id), 0);
  assert.equal((await call('/hub/session', { cookie: session })).status, 401);
});
