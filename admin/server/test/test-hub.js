'use strict';

/* The Client Portal's /hub/* routes, moved from the hub's own server (merge task
   M2). They run here on a throwaway database and a temporary deliverables
   folder: nothing in this file can reach real data, Bunny or the NAS. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Before anything loads config.js: a throwaway data directory, no real .env values.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-hub-'));
process.env.DATA_DIR = TMP;
process.env.NODE_ENV = 'test';

const REAL_DATA = path.join(__dirname, '..', 'data');
const realDataBefore = fs.existsSync(REAL_DATA) ? fs.readdirSync(REAL_DATA).sort() : null;

const express = require('express');
const { openDatabase, migrate, LATEST_VERSION } = require('../src/db');
const { createHubRouter, normalizeDeliverablePath } = require('../src/hub/routes');
const { createBunny, missingBunnySettings, statusFromVideo } = require('../src/hub/bunny');
const { createUrlSigner } = require('../src/hub/url-signing');
const { createAttemptThrottle } = require('../src/hub/throttle');
const { rateLimit, clientIp } = require('../src/routes/public');
const { createPortalAccess } = require('../src/portal-access');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
/* A studio cookie as billing's login would set: nothing under /hub reads it (test-portal-mount.js runs the real login). */
const STUDIO_COOKIE = 'billing=signed-in';
const PORTAL = 'https://lsccreative.studio';
const BASE = 'https://hub.example';
const BUNNY = {
  libraryId: 'lib1', streamApiKey: 'fake-stream-key', streamReadKey: 'fake-read-key',
  streamCdnHost: 'vz-test.b-cdn.net', storageZone: 'zone', storagePassword: 'fake-storage-pass',
  storageHost: 'storage.example', storageCdnHost: 'cdn.example',
};
const HUB_TABLES = ['records', 'private_auth', 'admin_sessions', 'deliverable_tokens',
  'agreement_evidence', 'bunny_assets', 'bunny_collections'];

const tableNames = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);

/* ── Loading the code touches nothing ──────────────────────────────────── */

test('loading the hub code opens no database and reads no secret', () => {
  // The hub's own modules opened ./data/client-hub.db and threw on a missing
  // secret as they loaded. Requiring them here, with no secrets set, did neither.
  for (const name of ['HUB_SIGNING_SECRET', 'SIGNING_SECRET']) {
    assert.equal(process.env[name], undefined, `${name} leaked into the test`);
  }
  assert.equal(fs.existsSync(path.join(process.cwd(), 'data', 'client-hub.db')), false);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'data', 'client-hub.db')), false);
});

test('the router won’t build without its secrets and settings, and says which', () => {
  const db = openDatabase(path.join(TMP, 'secrets.db'));
  const base = { publicBaseUrl: BASE, deliverablesDir: TMP, rateLimit, clientIp };
  assert.throws(() => createHubRouter(db, base), /HUB_SIGNING_SECRET/);
  const secrets = { signingSecret: 's' };
  assert.throws(() => createHubRouter(db, { ...secrets, ...base, publicBaseUrl: '' }), /HUB_PUBLIC_BASE_URL/);
  assert.throws(() => createHubRouter(db, { ...secrets, ...base, deliverablesDir: '' }), /DELIVERABLES_DIR/);
  assert.throws(() => createHubRouter(db, { ...secrets, ...base, rateLimit: undefined }), /rateLimit/);
  assert.throws(() => createHubRouter(db, { ...secrets, ...base, clientIp: undefined }), /clientIp/);
  db.close();
});

test('Bunny settings: missing ones are named, and the client won’t build without them', () => {
  assert.deepEqual(missingBunnySettings({ ...BUNNY, streamApiKey: '', storageZone: '' }),
    ['BUNNY_STREAM_API_KEY', 'BUNNY_STORAGE_ZONE']);
  assert.equal(missingBunnySettings(undefined).length, 8);
  assert.throws(() => createBunny({}), /Bunny isn't set up/);
  assert.deepEqual([4, 3, 5, 6, 0].map((status) => statusFromVideo({ status })),
    ['ready', 'processing', 'failed', 'failed', 'processing']);
});

test('signed record links: right path and time only', () => {
  let now = 1_000_000_000_000;
  const signer = createUrlSigner('secret', { now: () => now });
  const { token, expires } = signer.signPath('/hub/records/p1', 900);
  assert.equal(signer.verifyPath('/hub/records/p1', token, expires), true);
  assert.equal(signer.verifyPath('/hub/records/p2', token, expires), false, 'another project');
  assert.equal(signer.verifyPath('/hub/records/p1', token, expires + 1), false, 'a stretched expiry');
  assert.equal(signer.verifyPath('/hub/records/p1', '', expires), false);
  now += 901_000;
  assert.equal(signer.verifyPath('/hub/records/p1', token, expires), false, 'expired');
  assert.equal(createUrlSigner('other').verifyPath('/hub/records/p1', token, expires), false, 'another secret');
});

test('paths normalise, so one file can’t be added twice under two names', () => {
  assert.equal(normalizeDeliverablePath(' a/../b/c.mp4 '), 'b/c.mp4');
  assert.equal(normalizeDeliverablePath(''), '');
});

/* ── The tables arrive as migration 21 ─────────────────────────────────── */

test('a fresh database has the hub tables and no forced meta version', () => {
  const db = openDatabase(path.join(TMP, 'fresh.db'));
  const tables = tableNames(db);
  for (const t of HUB_TABLES) assert.ok(tables.includes(t), `missing ${t}`);
  assert.equal(tables.includes('meta'), false, 'the hub’s meta.schema_version stays behind');
  assert.ok(LATEST_VERSION >= 21);
  db.close();
});

test('upgrading a v20 database copies it first, then adds the tables and keeps its data', () => {
  const file = path.join(TMP, 'upgrade.db');
  const backups = path.join(TMP, 'upgrade-backups');
  const old = openDatabase(file, { migrate: false });
  migrate(old, { to: 20 });
  old.prepare("INSERT INTO clients (id, business_name, created_at, updated_at) VALUES ('cl_1', 'Salt', 'x', 'x')").run();
  old.close();

  const db = openDatabase(file, { backupDir: backups });
  assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, LATEST_VERSION);
  for (const t of HUB_TABLES) assert.ok(tableNames(db).includes(t), `missing ${t}`);
  assert.equal(db.prepare('SELECT business_name FROM clients').get().business_name, 'Salt');
  db.close();

  const copies = fs.readdirSync(backups).filter((f) => f.startsWith('premigrate-'));
  assert.equal(copies.length, 1);
  const copy = openDatabase(path.join(backups, copies[0]), { migrate: false });
  assert.equal(copy.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 20, 'the copy is the old version');
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM clients').get().n, 1);
  assert.equal(tableNames(copy).includes('records'), false);
  copy.close();

  // Opening it again: nothing to migrate, so no second copy.
  openDatabase(file, { backupDir: backups }).close();
  assert.equal(fs.readdirSync(backups).filter((f) => f.startsWith('premigrate-')).length, 1);
});

test('opening an old file takes the copy by default, so scripts get it too', () => {
  const dir = path.join(TMP, 'by-default');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'billing.db');
  const old = openDatabase(file, { migrate: false });
  migrate(old, { to: 20 });
  old.close();
  openDatabase(file).close();
  const copies = fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.startsWith('premigrate-'));
  assert.equal(copies.length, 1, 'a copy beside the file, as config.backupDir is beside billing.db');

  const optOut = path.join(TMP, 'opt-out.db');
  const older = openDatabase(optOut, { migrate: false });
  migrate(older, { to: 20 });
  older.close();
  openDatabase(optOut, { backupDir: false }).close();
  assert.equal(fs.existsSync(path.join(TMP, 'backups')), false, 'backupDir: false takes none');
});

test('a fresh database takes no copy', () => {
  const backups = path.join(TMP, 'fresh-backups');
  openDatabase(path.join(TMP, 'fresh-nocopy.db'), { backupDir: backups }).close();
  assert.equal(fs.existsSync(backups) && fs.readdirSync(backups).length, false);
});

test('if the copy can’t be made, the server won’t start and nothing changes', () => {
  const file = path.join(TMP, 'nocopy.db');
  const old = openDatabase(file, { migrate: false });
  migrate(old, { to: 20 });
  old.close();
  const notADir = path.join(TMP, 'not-a-dir');
  fs.writeFileSync(notADir, 'a file where the backups folder should be');

  assert.throws(() => openDatabase(file, { backupDir: notADir }), /Couldn't back up billing\.db before migrating it from v20.*Nothing was changed/);
  const after = openDatabase(file, { migrate: false });
  assert.equal(after.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 20);
  assert.equal(tableNames(after).includes('records'), false);
  after.close();
});

test('migration 21 is safe to run twice', () => {
  const db = openDatabase(path.join(TMP, 'twice.db'));
  db.prepare("INSERT INTO records (project_id, data, updated_at) VALUES ('p1', '{}', 'x')").run();
  db.prepare('DELETE FROM schema_version WHERE version = 21').run();
  migrate(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM records').get().n, 1);
  db.close();
});

/* ── The routes, end to end ────────────────────────────────────────────── */

const DELIVERABLES = path.join(TMP, 'deliverables');
fs.mkdirSync(path.join(DELIVERABLES, 'Acme', 'Stills', 'raw'), { recursive: true });
fs.writeFileSync(path.join(DELIVERABLES, 'Acme', 'Hero.mp4'), Buffer.from('0123456789'));
fs.writeFileSync(path.join(DELIVERABLES, 'Loose.mp4'), Buffer.from('loose'));
fs.writeFileSync(path.join(DELIVERABLES, 'Acme', 'Notes.pdf'), Buffer.from('%PDF'));
for (const f of ['b10.jpg', 'b2.JPG', 'c.png', 'clip.mp4', 'shot.cr3', '.DS_Store']) {
  fs.writeFileSync(path.join(DELIVERABLES, 'Acme', 'Stills', f), 'x');
}
fs.writeFileSync(path.join(DELIVERABLES, 'Acme', 'Stills', 'raw', 'nested.jpg'), 'x');
fs.writeFileSync(path.join(TMP, 'outside.mp4'), 'secret');

async function startHub(overrides = {}, { trustProxy = 1 } = {}) {
  const db = openDatabase(path.join(TMP, `hub-${crypto.randomBytes(4).toString('hex')}.db`));
  // Portal rows are billing projects (S11), so the ids these tests seed exist.
  const addProject = db.prepare("INSERT INTO projects (id, created_at, updated_at) VALUES (?, 'x', 'x')");
  for (const id of ['p_pub', 'p_sign', 'p_guess', 'p_clear', 'p_cf', 'p_ip', 'p_w']) addProject.run(id);
  const router = createHubRouter(db, {
    signingSecret: 'test-signing-secret',
    corsOrigins: [PORTAL],
    publicBaseUrl: BASE,
    deliverablesDir: DELIVERABLES,
    rateLimit,
    clientIp,
    ...overrides,
  });
  const app = express();
  if (trustProxy !== null) app.set('trust proxy', trustProxy);
  // The router parses its own JSON, so it is mounted here with no parser before it.
  app.use(router);
  app.get('/elsewhere', (_req, res) => res.send('billing'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, { method = 'GET', body, cookie, headers = {} } = {}) => {
    const res = await fetch(url + p, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* a file */ }
    return { status: res.status, headers: res.headers, body: json, text };
  };
  /* A published record and its login, as C1 and C3's routes will write them: nothing
     writes them over HTTP since the hub's editor retired (R3). */
  const seedRecord = (record, priv = {}) => {
    const now = new Date().toISOString();
    const email = priv.clientEmail || '';
    db.prepare('INSERT INTO records (project_id, data, updated_at) VALUES (?, ?, ?)').run(record.id, JSON.stringify(record), now);
    db.prepare(`
      INSERT INTO private_auth (project_id, client_email, email_hash, code_hash, invite_token, delivered, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(record.id, email, email ? sha(email.toLowerCase()) : null, priv.codeHash || null, priv.inviteToken || null, now);
  };
  /* A client holding the given projects, issued a Client code as the studio does (C1). */
  const access = createPortalAccess(db, { secret: 'test-signing-secret' });
  const seedClient = (email, projectIds = [], { code = true } = {}) => {
    const id = `cl_${crypto.randomBytes(4).toString('hex')}`;
    db.prepare(`INSERT INTO clients (id, business_name, contact_name, email, phone, abn, address, notes, created_at, updated_at)
                VALUES (?, ?, '', ?, '', '', '', '', 'x', 'x')`).run(id, `Biz ${id}`, email);
    for (const p of projectIds) db.prepare('UPDATE projects SET client_id = ? WHERE id = ?').run(id, p);
    return { id, ...(code ? access.issue(id) : {}) };
  };
  /* Signs in: the reply, and the cookie to send back. */
  const signIn = async (email, code, headers = {}) => {
    const r = await call('/hub/auth', { method: 'POST', body: { email, code }, headers });
    const set = r.headers.get('set-cookie') || '';
    return { ...r, session: set ? set.split(';')[0] : null, setCookie: set };
  };
  /* A stable /hub/files link, as publishing mints one. */
  const seedToken = (relativePath, downloadable = 0) => {
    const token = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO deliverable_tokens (token, relative_path, downloadable, created_at) VALUES (?, ?, ?, ?)')
      .run(token, relativePath, downloadable, new Date().toISOString());
    return token;
  };
  return {
    db, router, url, call, seedRecord, seedToken, seedClient, signIn, access,
    close: () => new Promise((r) => server.close(r)),
  };
}

let hub;
const cookie = STUDIO_COOKIE;
test.before(async () => {
  hub = await startHub();
});
test.after(async () => {
  await hub.close();
  hub.db.close();
});

test('the studio’s routes are gone from /hub: the hub editor, sign-off and the old Bunny pair (R3, C5, Bunny Slice 2)', async () => {
  // Bunny publishing moved to /api behind the login (Bunny Slice 2): the old pair are gone.
  for (const [p, method] of [['/hub/publish-asset', 'POST'], ['/hub/publish-status?path=x', 'GET'], ['/hub/admin-auth', 'POST'], ['/hub/publish', 'POST'], ['/hub/agreement/p1', 'GET'], ['/hub/agreement', 'POST'], ['/hub/deliverable-url', 'POST'],
    ['/hub/deliverable-folder', 'POST'], ['/hub/notify', 'POST'], ['/hub/deliverables-health', 'GET']]) {
    assert.equal((await hub.call(p, { method, cookie, body: method === 'POST' ? {} : undefined })).status, 404, p);
  }
});

test('the client signs in with email and Client code, and the server checks the session it sets (C1)', async () => {
  const priya = hub.seedClient('priya@salt.example', ['p_pub']);
  assert.match(priya.code, /^\d{6}$/);

  const wrong = await hub.signIn('priya@salt.example', priya.code === '000000' ? '000001' : '000000');
  assert.deepEqual([wrong.status, wrong.body, wrong.session], [401, { error: 'wrong_code' }, null]);
  assert.equal((await hub.signIn('priya@salt.example', '12')).status, 400);
  assert.equal((await hub.signIn('', priya.code)).status, 400);

  const ok = await hub.signIn('  PRIYA@salt.example ', priya.code);
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.body).sort(), ['choosePin', 'client', 'ok']);
  assert.match(ok.setCookie, /^lsc_portal=[\w-]{43}; Max-Age=2592000; Path=\/hub; HttpOnly; Secure; SameSite=Lax$/);
  assert.ok(!ok.text.includes(ok.session.split('=')[1]), 'the token is in the cookie only, never the reply');
  const stored = hub.db.prepare('SELECT id, via FROM client_sessions WHERE client_id = ?').get(priya.id);
  assert.equal(stored.via, 'code');
  assert.notEqual(stored.id, ok.session.split('=')[1], 'only its HMAC is kept');

  const me = await hub.call('/hub/session', { cookie: ok.session });
  assert.deepEqual([me.status, me.body.client.businessName], [200, `Biz ${priya.id}`]);
  assert.equal((await hub.call('/hub/session')).status, 401, 'no cookie');
  assert.equal((await hub.call('/hub/session', { cookie: `lsc_portal=${'x'.repeat(43)}` })).status, 401, 'a made-up one');

  // An expired session is refused and goes.
  const later = await hub.signIn('priya@salt.example', priya.code);
  hub.db.prepare("UPDATE client_sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id <> ?").run(stored.id);
  assert.equal((await hub.call('/hub/session', { cookie: later.session })).status, 401);
  assert.equal(hub.db.prepare('SELECT COUNT(*) FROM client_sessions WHERE client_id = ?').pluck().get(priya.id), 1);

  // Signing out ends it on the server, not just in the browser.
  const out = await hub.call('/hub/sign-out', { method: 'POST', cookie: ok.session });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /^lsc_portal=; Max-Age=0; Path=\/hub/);
  assert.equal((await hub.call('/hub/session', { cookie: ok.session })).status, 401);
});

test('an invite says whose sign-in it is and where it lands, and signs nobody in (C1)', async () => {
  const addProject = hub.db.prepare("INSERT INTO projects (id, created_at, updated_at) VALUES (?, 'x', 'x')");
  addProject.run('p_inv');
  const sam = hub.seedClient('sam@salt.example', ['p_inv'], { code: false });
  const { invite } = hub.access.issue(sam.id, { projectId: 'p_inv' });
  const r = await hub.call('/hub/invite', { method: 'POST', body: { token: invite } });
  assert.deepEqual([r.status, r.body], [200, { ok: true, email: 'sam@salt.example', projectId: 'p_inv' }]);
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal((await hub.call('/hub/invite', { method: 'POST', body: { token: 'nope' } })).status, 404);
  assert.equal((await hub.call('/hub/invite', { method: 'POST', body: {} })).status, 404);
  // A reset replaces it.
  hub.access.issue(sam.id);
  assert.equal((await hub.call('/hub/invite', { method: 'POST', body: { token: invite } })).status, 404);
});

test('a file link stays inside the folder, and is Range-aware', async () => {
  const play = `/hub/files/${hub.seedToken('Acme/Hero.mp4')}`;
  const full = await hub.call(play);
  assert.deepEqual([full.status, full.text, full.headers.get('content-type'), full.headers.get('content-disposition')],
    [200, '0123456789', 'video/mp4', 'inline']);
  const part = await hub.call(play, { headers: { range: 'bytes=2-4' } });
  assert.deepEqual([part.status, part.text, part.headers.get('content-range')], [206, '234', 'bytes 2-4/10']);
  const tail = await hub.call(play, { headers: { range: 'bytes=-3' } });
  assert.deepEqual([tail.status, tail.text], [206, '789']);
  for (const range of ['bytes=5-2', 'bytes=0-10', 'bytes=-', 'items=0-1']) {
    assert.equal((await hub.call(play, { headers: { range } })).status, 416, range);
  }
  const save = await hub.call(`/hub/files/${hub.seedToken('Acme/Hero.mp4', 1)}`);
  assert.equal(save.headers.get('content-disposition'), 'attachment; filename="Hero.mp4"');
  assert.equal((await hub.call('/hub/files/nope')).status, 404);
  for (const p of ['Acme/Nope.mp4', '../outside.mp4', '/etc/passwd', 'Acme/../../outside.mp4', 'Acme/Stills']) {
    assert.equal((await hub.call(`/hub/files/${hub.seedToken(p)}`)).status, 404, p);
  }
});

test('CORS: credentials for the portal’s origin only; open reads for anyone', async () => {
  const fromPortal = await hub.call('/hub/auth', { method: 'OPTIONS', headers: { origin: PORTAL } });
  assert.deepEqual([fromPortal.status, fromPortal.headers.get('access-control-allow-origin'),
    fromPortal.headers.get('access-control-allow-credentials')], [204, PORTAL, 'true']);
  const fromElsewhere = await hub.call('/hub/auth', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
  assert.equal(fromElsewhere.headers.get('access-control-allow-origin'), null);
  assert.equal(fromElsewhere.headers.get('access-control-allow-credentials'), null);
  const files = await hub.call('/hub/files/x', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
  assert.deepEqual([files.status, files.headers.get('access-control-allow-origin')], [204, '*']);
  assert.equal(fromPortal.headers.get('cache-control'), 'no-store');
});

test('the start-up log can read whether the deliverables folder is there', async () => {
  assert.equal((await hub.router.deliverablesHealth()).ok, true);
  const missing = await startHub({ deliverablesDir: path.join(TMP, 'no-such-folder') });
  try {
    assert.deepEqual(await missing.router.deliverablesHealth(), { ok: false, error: 'ENOENT' });
  } finally { await missing.close(); missing.db.close(); }
});

/* ── Fixes from the M1 and M2 review ───────────────────────────────────── */

/* ── Fixes from the M3 review ──────────────────────────────────────────── */

test('client sign-in is limited per address', async () => {
  const fresh = await startHub({ limits: { auth: { max: 3, windowMs: 60_000 } } });
  try {
    const from = (ip) => ({ 'cf-connecting-ip': ip });
    for (let i = 0; i < 3; i += 1) {
      const r = await fresh.call('/hub/auth', { method: 'POST', headers: from('198.51.100.1'), body: { email: `x${i}@b.example`, code: '1234' } });
      assert.equal(r.status, 401);
    }
    const over = await fresh.call('/hub/auth', { method: 'POST', headers: from('198.51.100.1'), body: { email: 'y@b.example', code: '1234' } });
    assert.equal(over.status, 429);
    const viaInvite = await fresh.call('/hub/invite', { method: 'POST', headers: from('198.51.100.1'), body: { token: 'guess' } });
    assert.equal(viaInvite.status, 429, 'guessing invites counts with sign-ins');
    const other = await fresh.call('/hub/auth', { method: 'POST', headers: from('198.51.100.2'), body: { email: 'y@b.example', code: '1234' } });
    assert.equal(other.status, 401, 'another address has its own count');
    assert.equal((await fresh.call('/hub/auth', { method: 'OPTIONS', headers: { origin: PORTAL, ...from('198.51.100.1') } })).status, 204,
      'a preflight isn’t counted or refused');
  } finally { await fresh.close(); fresh.db.close(); }
});

test('one client’s code stops after 10 wrong tries, however many addresses guess', async () => {
  const fresh = await startHub();
  try {
    const priya = fresh.seedClient('priya@salt.example', ['p_guess']);
    const wrongCode = (i) => String((Number(priya.code) + 1 + i) % 1000000).padStart(6, '0');
    const guess = (code, i) => fresh.call('/hub/auth', { method: 'POST',
      headers: { 'cf-connecting-ip': `198.51.100.${i}` }, body: { email: 'Priya@salt.example', code } });
    for (let i = 0; i < 10; i += 1) assert.equal((await guess(wrongCode(i), i)).status, 401);
    const locked = await guess(priya.code, 50);
    assert.deepEqual([locked.status, locked.body], [429, { error: 'too_many_attempts' }], 'even the right code, for now');
    const someoneElse = await fresh.call('/hub/auth', { method: 'POST', body: { email: 'other@salt.example', code: '1111' } });
    assert.equal(someoneElse.status, 401, 'other clients aren’t affected');
  } finally { await fresh.close(); fresh.db.close(); }
});

test('a right code clears the count of wrong ones', async () => {
  const fresh = await startHub();
  try {
    const sam = fresh.seedClient('sam@salt.example', ['p_clear']);
    const wrong = sam.code === '000000' ? '000001' : '000000';
    const tryCode = (code) => fresh.call('/hub/auth', { method: 'POST', body: { email: 'sam@salt.example', code } });
    for (let i = 0; i < 9; i += 1) await tryCode(wrong);
    assert.equal((await tryCode(sam.code)).status, 200);
    for (let i = 0; i < 9; i += 1) await tryCode(wrong);
    assert.equal((await tryCode(sam.code)).status, 200, 'a fresh nine, not eighteen');
  } finally { await fresh.close(); fresh.db.close(); }
});

/* The address an approval records, Cloudflare's or the tunnel's hop and never one the
   client wrote, is tested on the approve route (test-portal-approvals.js): the old
   hub's agreement route that recorded one is gone (C5). */
test('a forged forwarding address can’t dodge the sign-in throttle', async () => {
  const fresh = await startHub();
  try {
    // The tunnel appends the address it saw; a client can only add entries before it.
    const hop = (forged) => ({ 'x-forwarded-for': `${forged}, 203.0.113.9` });
    // Client sign-in is limited per address, so a new forged address is still the same visitor.
    const signInAs = (forged) => fresh.call('/hub/auth', { method: 'POST', headers: hop(forged), body: { email: 'a@b.example', code: '1234' } });
    for (let i = 0; i < 20; i += 1) await signInAs(`10.0.0.${i}`);
    assert.equal((await signInAs('10.0.0.99')).status, 429);
  } finally { await fresh.close(); fresh.db.close(); }
});

/* Signs in on a hub whose throttle is already spent, by going round it. */
function startHubSignIn(h) {
  const token = crypto.randomBytes(32).toString('hex');
  h.db.prepare("INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?, 'x', '2999-01-01T00:00:00.000Z')").run(token);
  return `hub_admin_session=${token}`;
}

test('unknown /hub paths and bad bodies answer in JSON, as the hub’s server did', async () => {
  const missing = await hub.call('/hub/no-such-route');
  assert.deepEqual([missing.status, missing.body], [404, { error: 'not found' }]);
  assert.equal((await hub.call('/hub/auth')).status, 404, 'a GET to a POST route');
  const res = await fetch(`${hub.url}/hub/auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
  assert.deepEqual([res.status, await res.json()], [400, { error: 'bad request' }]);
});

test('the throttle counts every window, survives a restart, and lets go of old tries', () => {
  let t = 1_000_000_000_000;
  const db = openDatabase(path.join(TMP, `throttle-${crypto.randomBytes(4).toString('hex')}.db`));
  const windows = [{ name: 'burst', limit: 3, windowMs: 15 * 60 * 1000 }, { name: 'day', limit: 5, windowMs: 24 * 60 * 60 * 1000 }];
  const make = () => createAttemptThrottle(db, { windows, now: () => t });
  let throttle = make();
  for (let i = 0; i < 3; i += 1) throttle.record('k');
  assert.equal(throttle.limitedBy('k'), 'burst');
  t += 16 * 60 * 1000;
  assert.equal(throttle.limitedBy('k'), null, 'the burst passes');
  throttle = make(); // a restart: the count is in the database, not the process
  for (let i = 0; i < 2; i += 1) throttle.record('k');
  assert.equal(throttle.limitedBy('k'), 'day', 'five in the day, however spread');
  assert.equal(throttle.limitedBy('other'), null, 'each key its own count');
  t += 24 * 60 * 60 * 1000;
  assert.equal(throttle.limitedBy('k'), null, 'a day on, free again');
  throttle.record('fresh');
  assert.equal(throttle.size(), 1, 'tries older than a day are pruned on the next one');
  throttle.clear('fresh');
  assert.equal(throttle.size(), 0);
  assert.throws(() => createAttemptThrottle(db, { windows: [] }));
  db.close();
});

test('an address stops for the day after 30 wrong tries, and a new code from the studio frees it', async () => {
  const fresh = await startHub();
  try {
    const kim = fresh.seedClient('kim@salt.example', ['p_cf']);
    const hash = crypto.createHash('sha256').update('kim@salt.example').digest('hex');
    // 30 wrong tries spread over the day (none in the last 15 minutes), as a patient guesser would.
    const add = fresh.db.prepare('INSERT INTO portal_code_failures (email_hash, at) VALUES (?, ?)');
    for (let i = 0; i < 30; i += 1) add.run(hash, Date.now() - (20 + i * 30) * 60 * 1000);
    const tryCode = (code) => fresh.call('/hub/auth', { method: 'POST', body: { email: 'kim@salt.example', code } });
    const locked = await tryCode(kim.code);
    assert.deepEqual([locked.status, locked.body], [429, { error: 'too_many_today' }], 'even the right code, until tomorrow');
    // The studio issues a new code ("Forgot your code?"): its count starts again.
    const { code } = fresh.access.issue(kim.id);
    assert.equal(fresh.db.prepare('SELECT COUNT(*) FROM portal_code_failures WHERE email_hash = ?').pluck().get(hash), 0);
    assert.equal((await tryCode(code)).status, 200);
  } finally { await fresh.close(); fresh.db.close(); }
});

test('the real data folder was never touched', () => {
  const after = fs.existsSync(REAL_DATA) ? fs.readdirSync(REAL_DATA).sort() : null;
  assert.deepEqual(after, realDataBefore);
  assert.ok(hub.db.name.startsWith(TMP), 'the routes ran on the throwaway database');
});
