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

const PIN = '4821';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ADMIN = 'owner@lsc.example';
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
  for (const name of ['HUB_SIGNING_SECRET', 'HUB_ADMIN_PIN_HASH', 'SIGNING_SECRET', 'ADMIN_PIN_HASH']) {
    assert.equal(process.env[name], undefined, `${name} leaked into the test`);
  }
  assert.equal(fs.existsSync(path.join(process.cwd(), 'data', 'client-hub.db')), false);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'data', 'client-hub.db')), false);
});

test('the router won’t build without its secrets, and says which', () => {
  const db = openDatabase(path.join(TMP, 'secrets.db'));
  assert.throws(() => createHubRouter(db, { adminPinHash: sha(PIN) }), /HUB_SIGNING_SECRET/);
  assert.throws(() => createHubRouter(db, { signingSecret: 's' }), /HUB_ADMIN_PIN_HASH/);
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

test('paths normalise, so one file can’t publish twice under two names', () => {
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

/* A stand-in for Bunny Stream's API: one library, one collection, and a video
   that appears once it has been fetched. */
function fakeBunny() {
  const calls = [];
  const state = { collections: [], videos: [], failFetch: false };
  const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });
  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const method = init.method || 'GET';
    calls.push({ method, path: u.pathname, search: u.search, key: init.headers && init.headers.AccessKey });
    const route = u.pathname.replace('/library/lib1', '');
    if (route === '/collections' && method === 'GET') {
      return reply(200, { items: state.collections.filter((c) => c.name.includes(u.searchParams.get('search'))) });
    }
    if (route === '/collections' && method === 'POST') {
      const c = { guid: `col-${state.collections.length + 1}`, name: JSON.parse(init.body).name };
      state.collections.push(c);
      return reply(200, c);
    }
    if (route === '/videos/fetch') {
      if (state.failFetch) return reply(200, { success: false, message: 'fetch refused' });
      const { title } = JSON.parse(init.body);
      state.videos.push({ guid: `vid-${state.videos.length + 1}`, title, status: 4, dateUploaded: new Date().toISOString(),
        collectionId: u.searchParams.get('collectionId'), source: JSON.parse(init.body).url });
      return reply(200, { success: true });
    }
    if (route === '/videos') {
      return reply(200, { items: state.videos.filter((v) => v.title.includes(u.searchParams.get('search'))) });
    }
    return reply(404, { message: 'no such route' });
  }
  return { fetchImpl, calls, state };
}

async function startHub(overrides = {}) {
  const db = openDatabase(path.join(TMP, `hub-${crypto.randomBytes(4).toString('hex')}.db`));
  const bunny = fakeBunny();
  const router = createHubRouter(db, {
    signingSecret: 'test-signing-secret',
    adminEmail: ADMIN,
    adminPinHash: sha(PIN),
    corsOrigins: [PORTAL],
    publicBaseUrl: BASE,
    deliverablesDir: DELIVERABLES,
    bunny: BUNNY,
    bunnyFetch: bunny.fetchImpl,
    videoLookupGapMs: 1,
    ...overrides,
  });
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(router);
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
  const signIn = async () => {
    const r = await call('/hub/admin-auth', { method: 'POST', body: { email: ADMIN, pin: PIN } });
    assert.equal(r.status, 200);
    return r.headers.get('set-cookie').split(';')[0];
  };
  return { db, bunny, router, url, call, signIn, close: () => new Promise((r) => server.close(r)) };
}

let hub;
let cookie;
test.before(async () => {
  hub = await startHub();
  cookie = await hub.signIn();
});
test.after(async () => {
  await hub.close();
  hub.db.close();
});

test('editor sign-in: right email and PIN only, as an HttpOnly cookie', async () => {
  const fresh = await startHub();
  try {
    const set = (await fresh.call('/hub/admin-auth', { method: 'POST', body: { email: ` ${ADMIN.toUpperCase()} `, pin: PIN } })).headers.get('set-cookie');
    assert.match(set, /^hub_admin_session=[0-9a-f]{64}; HttpOnly; Secure; SameSite=None; Path=\/$/);
    for (const body of [{ email: ADMIN, pin: '0000' }, { email: 'someone@else.example', pin: PIN }, { email: ADMIN, pin: 4821.0 + 'x' }, {}]) {
      assert.equal((await fresh.call('/hub/admin-auth', { method: 'POST', body })).status, 401, JSON.stringify(body));
    }
  } finally { await fresh.close(); fresh.db.close(); }
});

test('editor sign-in is throttled after 5 tries, right or wrong', async () => {
  const fresh = await startHub();
  try {
    for (let i = 0; i < 5; i += 1) await fresh.call('/hub/admin-auth', { method: 'POST', body: { email: ADMIN, pin: '0000' } });
    assert.equal((await fresh.call('/hub/admin-auth', { method: 'POST', body: { email: ADMIN, pin: PIN } })).status, 429);
  } finally { await fresh.close(); fresh.db.close(); }
});

test('editor routes need the session, and an expired one doesn’t count', async () => {
  for (const [p, method] of [['/hub/publish', 'POST'], ['/hub/agreement/p1', 'GET'], ['/hub/deliverable-url', 'POST'],
    ['/hub/deliverable-folder', 'POST'], ['/hub/publish-asset', 'POST'], ['/hub/publish-status?path=x', 'GET'], ['/hub/notify', 'POST']]) {
    assert.equal((await hub.call(p, { method, body: method === 'POST' ? {} : undefined })).status, 401, p);
    assert.equal((await hub.call(p, { method, body: method === 'POST' ? {} : undefined, cookie: 'hub_admin_session=nope' })).status, 401, p);
  }
  const stale = await hub.signIn();
  hub.db.prepare("UPDATE admin_sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token = ?").run(stale.split('=')[1]);
  assert.equal((await hub.call('/hub/notify', { method: 'POST', body: {}, cookie: stale })).status, 401);
});

test('publish, then the client signs in with email and code and reads the record', async () => {
  const record = { id: 'p_pub', name: 'Harbour', deliverables: [{ title: 'Hero' }] };
  assert.equal((await hub.call('/hub/publish', { method: 'POST', cookie, body: { record } })).status, 400);
  const pub = await hub.call('/hub/publish', { method: 'POST', cookie, body: {
    record, priv: { clientEmail: ' Priya@Salt.example ', codeHash: sha('1234'), inviteToken: 'inv-abc', delivered: true },
  } });
  assert.equal(pub.status, 200);
  const priv = hub.db.prepare('SELECT * FROM private_auth WHERE project_id = ?').get('p_pub');
  assert.deepEqual([priv.client_email, priv.email_hash, priv.delivered], ['Priya@Salt.example', sha('priya@salt.example'), 1]);

  const wrong = await hub.call('/hub/auth', { method: 'POST', body: { email: 'priya@salt.example', code: '9999' } });
  assert.deepEqual(wrong.body, { token: null, projectIds: [] });
  assert.equal((await hub.call('/hub/auth', { method: 'POST', body: { email: 'priya@salt.example', code: '12' } })).status, 400);

  const ok = await hub.call('/hub/auth', { method: 'POST', body: { email: 'PRIYA@salt.example', code: '1234' } });
  assert.deepEqual(ok.body.projectIds, ['p_pub']);
  const link = new URL(ok.body.records.p_pub);
  assert.equal(link.origin, BASE, 'links name the public address');
  const read = await hub.call(link.pathname + link.search);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, record);
  assert.equal(read.headers.get('access-control-allow-origin'), '*');

  link.searchParams.set('token', 'f'.repeat(64));
  assert.equal((await hub.call(link.pathname + link.search)).status, 403);
  const other = new URL(ok.body.records.p_pub);
  assert.equal((await hub.call(`/hub/records/p_other${other.search}`)).status, 403, 'a link opens only its own project');

  const invite = await hub.call('/hub/auth', { method: 'POST', body: { invite: 'inv-abc' } });
  assert.deepEqual(invite.body, { projectId: 'p_pub', clientCode: '' });
  assert.equal((await hub.call('/hub/auth', { method: 'POST', body: { invite: 'nope' } })).status, 404);
});

test('the signed agreement is stored privately, with the address the server saw', async () => {
  await hub.call('/hub/publish', { method: 'POST', cookie, body: { record: { id: 'p_sign' }, priv: {} } });
  const sign = { projectId: 'p_sign', signerName: 'Priya Nair', signedAt: '2026-11-06T01:00:00Z',
    signatureDataUrl: 'data:image/png;base64,AAAA', consentText: 'I agree', consentChecked: true,
    userAgent: 'Test', verificationToken: 'vt', ipAddress: '6.6.6.6' };
  assert.equal((await hub.call('/hub/agreement', { method: 'POST', body: { ...sign, consentChecked: 'true' } })).status, 400);
  assert.equal((await hub.call('/hub/agreement', { method: 'POST', body: { ...sign, signerName: ' ' } })).status, 400);
  assert.equal((await hub.call('/hub/agreement', { method: 'POST', body: { ...sign, projectId: 'p_none' } })).status, 404);
  assert.equal((await hub.call('/hub/agreement', { method: 'POST', body: sign })).status, 200);

  const got = await hub.call('/hub/agreement/p_sign', { cookie });
  assert.equal(got.body.signerName, 'Priya Nair');
  assert.notEqual(got.body.ipAddress, '6.6.6.6', 'the client can’t supply its own address');
  assert.match(got.body.ipAddress, /127\.0\.0\.1/);
  assert.equal((await hub.call('/hub/agreement/p_none', { cookie })).status, 404);
});

test('deliverable links: stable, inside the folder only, and Range-aware', async () => {
  const one = await hub.call('/hub/deliverable-url', { method: 'POST', cookie, body: { path: 'Acme/Hero.mp4' } });
  const again = await hub.call('/hub/deliverable-url', { method: 'POST', cookie, body: { path: 'Acme/Hero.mp4' } });
  const dl = await hub.call('/hub/deliverable-url', { method: 'POST', cookie, body: { path: 'Acme/Hero.mp4', downloadable: true } });
  assert.equal(one.body.url, again.body.url, 'the same link every time');
  assert.notEqual(one.body.url, dl.body.url, 'download is its own link');
  for (const p of ['Acme/Nope.mp4', '../outside.mp4', '/etc/passwd', 'Acme/../../outside.mp4', 'Acme/Stills', 'a\0b']) {
    assert.equal((await hub.call('/hub/deliverable-url', { method: 'POST', cookie, body: { path: p } })).status, 404, p);
  }

  const play = new URL(one.body.url).pathname;
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
  const save = await hub.call(new URL(dl.body.url).pathname);
  assert.equal(save.headers.get('content-disposition'), 'attachment; filename="Hero.mp4"');
  assert.equal((await hub.call('/hub/files/nope')).status, 404);
});

test('a photo folder gives a link pair per image, skipping everything else', async () => {
  const r = await hub.call('/hub/deliverable-folder', { method: 'POST', cookie, body: { path: 'Acme/Stills/' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.photos.map((p) => p.name), ['b2.JPG', 'b10.jpg', 'c.png']);
  assert.ok(r.body.photos.every((p) => p.reviewUrl !== p.downloadUrl && p.reviewUrl.startsWith(`${BASE}/hub/files/`)));
  const again = await hub.call('/hub/deliverable-folder', { method: 'POST', cookie, body: { path: 'Acme/Stills' } });
  assert.deepEqual(again.body.photos, r.body.photos, 'the same links again');
  assert.equal((await hub.call('/hub/deliverable-folder', { method: 'POST', cookie, body: { path: 'Acme/Stills/raw/../../../..' } })).status, 404, 'outside the folder');
  assert.equal((await hub.call('/hub/deliverable-folder', { method: 'POST', cookie, body: { path: 'Acme/Hero.mp4' } })).status, 404);
  fs.mkdirSync(path.join(DELIVERABLES, 'Empty'), { recursive: true });
  assert.equal((await hub.call('/hub/deliverable-folder', { method: 'POST', cookie, body: { path: 'Empty' } })).status, 422);
});

test('publishing a video to Bunny: once per file, found by its tag, ready to play', async () => {
  const bad = async (body) => (await hub.call('/hub/publish-asset', { method: 'POST', cookie, body })).status;
  assert.equal(await bad({ path: 'Acme/Hero.mp4', kind: 'photo' }), 400);
  assert.equal(await bad({ path: 'Acme/Missing.mp4' }), 404);
  assert.equal(await bad({ path: 'Loose.mp4' }), 422, 'must be inside a project folder');
  assert.equal(await bad({ path: 'Acme/Notes.pdf' }), 422, 'not a video');

  const first = await hub.call('/hub/publish-asset', { method: 'POST', cookie, body: { path: 'Acme/./Hero.mp4' } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual([first.body.status, first.body.videoId, first.body.sourceChanged], ['ready', 'vid-1', false]);
  assert.equal(first.body.hlsUrl, 'https://vz-test.b-cdn.net/vid-1/playlist.m3u8');
  assert.equal(hub.bunny.state.collections[0].name, 'Acme', 'one collection per project folder');
  assert.ok(hub.bunny.calls.every((c) => c.key === BUNNY.streamApiKey), 'the key only travels as the AccessKey header');
  assert.ok(hub.bunny.calls.every((c) => !c.search.includes(BUNNY.streamApiKey)));
  assert.match(hub.bunny.state.videos[0].source, new RegExp(`^${BASE}/hub/files/[0-9a-f]{32}$`), 'Bunny pulls the file from its link');

  const fetchesBefore = hub.bunny.calls.filter((c) => c.path.endsWith('/videos/fetch')).length;
  const again = await hub.call('/hub/publish-asset', { method: 'POST', cookie, body: { path: 'Acme/Hero.mp4' } });
  assert.equal(again.body.videoId, 'vid-1');
  assert.equal(hub.bunny.calls.filter((c) => c.path.endsWith('/videos/fetch')).length, fetchesBefore, 'no second fetch');

  const status = await hub.call('/hub/publish-status?path=Acme/Hero.mp4', { cookie });
  assert.deepEqual([status.status, status.body.status, status.body.videoId], [200, 'ready', 'vid-1']);
  assert.equal((await hub.call('/hub/publish-status?path=Acme/Other.mp4', { cookie })).status, 404);

  // A forced republish that Bunny refuses keeps the working video.
  hub.bunny.state.failFetch = true;
  const forced = await hub.call('/hub/publish-asset', { method: 'POST', cookie, body: { path: 'Acme/Hero.mp4', force: true } });
  assert.equal(forced.status, 502);
  assert.deepEqual([forced.body.status, forced.body.videoId], ['ready', 'vid-1']);
  assert.match(forced.body.error, /fetch refused/);
  hub.bunny.state.failFetch = false;
});

test('without Bunny set up, publishing says so and the rest still works', async () => {
  const noBunny = await startHub({ bunny: { ...BUNNY, streamApiKey: '' } });
  try {
    const c = await noBunny.signIn();
    const r = await noBunny.call('/hub/publish-asset', { method: 'POST', cookie: c, body: { path: 'Acme/Hero.mp4' } });
    assert.deepEqual([r.status, r.body], [503, { error: 'bunny not set up' }]);
    assert.equal((await noBunny.call('/hub/publish-status?path=Acme/Hero.mp4', { cookie: c })).status, 503);
    assert.equal((await noBunny.call('/hub/deliverable-url', { method: 'POST', cookie: c, body: { path: 'Acme/Hero.mp4' } })).status, 200);
    assert.equal(noBunny.bunny.calls.length, 0);
  } finally { await noBunny.close(); noBunny.db.close(); }
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

test('notify logs and answers, as on the hub; health reads the deliverables folder', async () => {
  const r = await hub.call('/hub/notify', { method: 'POST', cookie, body: { kind: 'invite' } });
  assert.deepEqual(r.body, { ok: true, dispatched: 'invite' });
  assert.equal(hub.router.deliverablesHealth().ok, true);
  assert.ok(hub.router.deliverablesHealth().projects >= 2);
  const missing = await startHub({ deliverablesDir: path.join(TMP, 'no-such-folder') });
  try {
    assert.deepEqual(missing.router.deliverablesHealth(), { ok: false, error: 'ENOENT' });
  } finally { await missing.close(); missing.db.close(); }
});

test('the real data folder was never touched', () => {
  const after = fs.existsSync(REAL_DATA) ? fs.readdirSync(REAL_DATA).sort() : null;
  assert.deepEqual(after, realDataBefore);
  assert.ok(hub.db.name.startsWith(TMP), 'the routes ran on the throwaway database');
});
