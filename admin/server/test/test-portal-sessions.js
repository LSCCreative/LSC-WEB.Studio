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
  const app = createApp(db, { hub });
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
    db.prepare(`INSERT INTO invoices (id, project_id, kind, number, status, totals_json, estimate_snapshot_json, created_at, updated_at)
                VALUES (?, ?, 'single', ?, 'sent', ?, '{"secret":"INVOICE-SNAPSHOT"}', ?, ?)`)
      .run(newId('inv'), id, uniq('INV-'), JSON.stringify(TOTALS), now, now);
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

/* ── The leak test (S9) ─────────────────────────────────────────────────── */

const FORBIDDEN = /surcharge|floor|taxSetAside|overheadShare|estTakeHome|costBreakdown|clientPrice|totalIncGst|\bgst\b|\bprice\b|\brate\b|margin|markup|total|amount|invoice/i;
const SECRETS = ['INTERNAL-NOTE-MARKER', 'INTERNAL-CLIENT-NOTE', '0400 111 222', '51824753556', 'SECRET-ADDRESS', 'quote-only@salt.example',
  'SECRET-NAS-PATH', 'PRIVATE-FILENAME', 'SECRET-DRIVE', 'NOT-NEEDED-ITEM', 'FORMAT-INTERNAL', 'INVOICE-SNAPSHOT', 'INV-', '1650', '1500'];
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
    agreement: await call('/hub/agreement', { method: 'POST', cookie: session, body: {
      projectId: prj, signerName: 'Priya', signedAt: 'x', signatureDataUrl: 'data:,', consentText: 'ok', consentChecked: true,
    } }),
    wrong: await signIn('leak@salt.example', '000000'),
    missing: await call('/hub/projects/prj_nobody', { cookie: session }),
    signedOut: await call('/hub/projects'),
    signOut: await call('/hub/sign-out', { method: 'POST', cookie: session }),
  };

  // Exactly these keys, and no others.
  const CLIENT = ['businessName', 'contactName'];
  const CARD = ['id', 'name', 'past', 'status', 'upid'];
  const ITEM = ['deliverables', 'id', 'stage', 'title', 'versions'];
  const VERSION = ['id', 'kind', 'n', 'photoCount', 'publishedAt', 'stage'];
  const sorted = (o) => Object.keys(o).sort();
  assert.deepEqual(sorted(replies.auth.body), ['client', 'ok']);
  assert.deepEqual(sorted(replies.auth.body.client), CLIENT);
  assert.deepEqual(sorted(replies.invite.body), ['email', 'ok', 'projectId']);
  assert.deepEqual(sorted(replies.session.body.client), CLIENT);
  replies.projects.body.projects.forEach((p) => assert.deepEqual(sorted(p), CARD));
  const view = replies.project.body.project;
  assert.deepEqual(sorted(view), [...CARD, 'deliverables'].sort());
  assert.deepEqual(view.deliverables.map((d) => d.id), [hero], 'an item marked not needed isn’t shown');
  view.deliverables.forEach((d) => {
    assert.deepEqual(sorted({ ...d, deliverables: 1 }), ITEM);
    assert.deepEqual(d.versions.map((v) => v.n), [1], 'only what has been published');
    d.versions.forEach((v) => assert.deepEqual(sorted(v), VERSION));
  });
  assert.equal(view.name, 'Harbour launch');
  assert.equal(view.status, 'Ready for your review', 'the client’s wording, not the studio’s badge');

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
