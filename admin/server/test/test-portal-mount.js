'use strict';

/* The Client Portal mounted in billing's app (merge task M3): its own hostname,
   its own CORS, one proxy hop, one /health, and its routes ahead of billing's
   JSON parser. Everything runs on a throwaway database and folder. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Before config.js loads: a throwaway data directory, and the portal's origin
// put in CORS_ORIGINS by mistake, which billing must ignore. The retired
// TRUST_PROXY is cleared, to show the app trusts one hop without it.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-portal-'));
process.env.DATA_DIR = TMP;
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough-0123456789';
process.env.COOKIE_SECURE = '0';
process.env.CORS_ORIGINS = 'https://app.lsccreative.studio,https://lsccreative.studio';
delete process.env.TRUST_PROXY;

const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');
const { createPortalAccess } = require('../src/portal-access');

const PORTAL = 'https://lsccreative.studio';
const ADMIN_ORIGIN = 'https://app.lsccreative.studio';
const HUB_HOST = 'hub.example';
const DELIVERABLES = path.join(TMP, 'deliverables');
fs.mkdirSync(path.join(DELIVERABLES, 'Acme'), { recursive: true });

const hubSettings = (over = {}) => ({
  signingSecret: 'test-signing-secret',
  corsOrigins: [PORTAL],
  publicBaseUrl: `https://${HUB_HOST}`,
  deliverablesDir: DELIVERABLES,
  backupDir: path.join(TMP, 'backups'),
  bunny: {},
  ...over,
});

async function start(opts = {}) {
  const db = openDatabase(path.join(TMP, `app-${crypto.randomBytes(4).toString('hex')}.db`));
  // Portal rows are billing projects (S11).
  db.prepare("INSERT INTO projects (id, created_at, updated_at) VALUES ('p_ip', 'x', 'x')").run();
  const app = createApp(db, { hub: hubSettings(), ...opts });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const { port } = server.address();
  /* node:http rather than fetch, which won't let a test set the Host header. */
  const call = (p, { method = 'GET', host = `127.0.0.1:${port}`, headers = {}, body, raw } = {}) => new Promise((resolve, reject) => {
    const data = raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined);
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      host, ...(data !== undefined ? { 'content-type': 'application/json' } : {}), ...headers,
    } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* text */ }
        resolve({ status: res.statusCode, headers: res.headers, text, body: json });
      });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
  const close = async () => {
    await new Promise((r) => server.close(r));
    db.close();
  };
  return { app, db, call, close };
}

let s;
test.before(async () => { s = await start(); });
test.after(async () => { await s.close(); });

test('trust proxy is exactly one hop, with no setting needed (S7)', () => {
  assert.equal(s.app.get('trust proxy'), 1);
});

test('billing never grants the portal’s origin a credentialed /api call, even listed in CORS_ORIGINS (S5)', async () => {
  for (const method of ['OPTIONS', 'GET']) {
    const r = await s.call('/api/session', { method, headers: { origin: PORTAL } });
    assert.equal(r.headers['access-control-allow-origin'], undefined, method);
    assert.equal(r.headers['access-control-allow-credentials'], undefined, method);
  }
  const admin = await s.call('/api/session', { method: 'OPTIONS', headers: { origin: ADMIN_ORIGIN } });
  assert.deepEqual([admin.headers['access-control-allow-origin'], admin.headers['access-control-allow-credentials']],
    [ADMIN_ORIGIN, 'true'], 'the admin’s own origin still is');
});

test('/hub answers its own CORS, not billing’s (S5)', async () => {
  const fromPortal = await s.call('/hub/auth', { method: 'OPTIONS', headers: { origin: PORTAL } });
  assert.deepEqual([fromPortal.status, fromPortal.headers['access-control-allow-origin'], fromPortal.headers['access-control-allow-credentials']],
    [204, PORTAL, 'true']);
  assert.equal(fromPortal.headers['access-control-expose-headers'], undefined, 'none of billing’s headers');
  const fromAdmin = await s.call('/hub/auth', { method: 'OPTIONS', headers: { origin: ADMIN_ORIGIN } });
  assert.equal(fromAdmin.headers['access-control-allow-origin'], undefined, 'billing’s list doesn’t reach /hub');
});

test('the portal’s hostname serves the portal and /health only (S4)', async () => {
  for (const p of ['/api/session', '/api/login', '/public/estimates/x', '/', '/index.html']) {
    const r = await s.call(p, { host: HUB_HOST, method: p === '/api/login' ? 'POST' : 'GET', body: p === '/api/login' ? {} : undefined });
    assert.deepEqual([r.status, r.body], [404, { error: 'not found' }], p);
  }
  for (const host of [HUB_HOST.toUpperCase(), `${HUB_HOST}.`, `${HUB_HOST}:443`, `${HUB_HOST}.:8443`, `${HUB_HOST}..`]) {
    assert.equal((await s.call('/api/session', { host })).status, 404, `however it is spelt: ${host}`);
  }
  assert.equal((await s.call('/api/session', { host: HUB_HOST, headers: { 'x-forwarded-host': 'app.lsccreative.studio' } })).status, 404,
    'a forwarded host can’t talk it round');
  assert.equal((await s.call('/health', { host: HUB_HOST })).text, 'ok');
  const auth = await s.call('/hub/auth', { host: HUB_HOST, method: 'POST', body: { email: 'a@b.example', code: '1234' } });
  assert.deepEqual([auth.status, auth.body], [401, { error: 'wrong_code' }]);
  assert.equal((await s.call('/api/session')).status, 401, 'other hostnames still reach /api');
});

test('a forged X-Forwarded-For can’t change the IP an approval records (S7)', async () => {
  s.db.prepare(`INSERT INTO clients (id, business_name, contact_name, email, phone, abn, address, notes, created_at, updated_at)
                VALUES ('cl_ip', 'IP Co', '', 'ip@b.example', '', '', '', '', 'x', 'x')`).run();
  s.db.prepare("UPDATE projects SET client_id = 'cl_ip', accepted_at = 'x' WHERE id = 'p_ip'").run();
  s.db.prepare(`INSERT INTO estimates (id, project_id, name, date, status, client_id, client_json, active_rows_json, totals_json, created_at, updated_at)
                VALUES ('est_ip', 'p_ip', 'IP job', '2026-11-01', 'accepted', 'cl_ip', '{}', '{}', '{}', 'x', 'x')`).run();
  s.db.prepare("INSERT INTO deliverables (id, project_id, position, title, created_at, updated_at) VALUES ('dlv_ip', 'p_ip', 1, 'Film', 'x', 'x')").run();
  s.db.prepare(`INSERT INTO deliverable_versions (id, deliverable_id, project_id, n, stage, source_path, file_name, kind, created_at, published_at)
                VALUES ('ver_ip', 'dlv_ip', 'p_ip', 1, 'draft', 'IP/Film.mp4', 'Film.mp4', 'video', 'x', 'x')`).run();
  const { token } = createPortalAccess(s.db, { secret: 'test-signing-secret' }).startSession('cl_ip', 'code');
  const approved = await s.call('/hub/projects/p_ip/items/dlv_ip/approve', { host: HUB_HOST, method: 'POST',
    headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9', cookie: `lsc_portal=${token}` },
    body: { versionId: 'ver_ip' } });
  assert.equal(approved.status, 201, approved.text);
  const got = s.db.prepare("SELECT ip FROM client_approvals WHERE version_id = 'ver_ip'").get();
  assert.equal(got.ip, '203.0.113.9', 'the hop the tunnel added, not the one the client wrote');
});

test('Bunny publishing is under /api, behind billing’s real login; the old /hub pair is gone (Bunny Slice 2)', async () => {
  const open = await start();
  try {
    open.db.prepare("INSERT INTO account (id, username, password_hash, created_at, updated_at) VALUES (1, 'tester', ?, 'x', 'x')")
      .run(await hashPassword('a-long-test-password'));
    const route = '/api/projects/p_ip/deliverables/d1/versions/v1/bunny';
    for (const method of ['POST', 'GET']) {
      const refused = await open.call(route, { method, body: method === 'POST' ? {} : undefined });
      assert.equal(refused.status, 401, method);
    }
    const login = await open.call('/api/login', { method: 'POST', body: { username: 'tester', password: 'a-long-test-password' } });
    assert.equal(login.status, 200, login.text);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    // Past the login: there is no such item, which is the next thing checked.
    assert.equal((await open.call(route, { method: 'GET', headers: { cookie } })).status, 404);
    for (const [p, method] of [['/hub/publish-asset', 'POST'], ['/hub/publish-status?path=Acme/x.mp4', 'GET']]) {
      const gone = await open.call(p, { method, host: HUB_HOST, headers: { cookie }, body: method === 'POST' ? { path: 'Acme/x.mp4' } : undefined });
      assert.equal(gone.status, 404, p);
    }
    // These settings have no Bunny keys, so no source link can be genuine.
    const source = await open.call('/hub/source/v1/x.mp4?token=abc&expires=9999999999', { host: HUB_HOST });
    assert.equal(source.status, 404);
  } finally { await open.close(); }
});

test('the portal reads its own bodies, ahead of billing’s parser (S20)', async () => {
  const hubBad = await s.call('/hub/auth', { method: 'POST', raw: '{not json' });
  assert.deepEqual([hubBad.status, hubBad.body], [400, { error: 'bad request' }]);
  const unknown = await s.call('/hub/nope');
  assert.deepEqual([unknown.status, unknown.body], [404, { error: 'not found' }]);
  const apiBad = await s.call('/api/login', { method: 'POST', raw: '{not json' });
  assert.equal(apiBad.status, 400, 'billing’s own parser still answers /api');
  assert.notDeepEqual(apiBad.body, { error: 'bad request' }, 'in billing’s shape, not the portal’s');
});

test('one /health: plain ok, saying nothing about the deliverables folder', async () => {
  const r = await s.call('/health');
  assert.deepEqual([r.status, r.text], [200, 'ok']);
  const gone = await start({ hub: hubSettings({ deliverablesDir: path.join(TMP, 'no-such-folder') }) });
  try {
    for (const host of [undefined, HUB_HOST]) {
      const g = await gone.call('/health', { host });
      assert.deepEqual([g.status, g.text], [200, 'ok'], 'a missing share is for the editor and the log, not the public');
    }
  } finally { await gone.close(); }
});

test('without the portal’s secret billing still starts and /hub says so', async () => {
  const none = await start({ hub: hubSettings({ signingSecret: '' }) });
  try {
    const r = await none.call('/hub/auth', { method: 'POST', body: {} });
    assert.deepEqual([r.status, r.body], [503, { error: 'portal not set up' }]);
    assert.equal((await none.call('/api/session', { host: HUB_HOST })).status, 404, 'the hostname rule holds anyway');
    assert.equal((await none.call('/api/session')).status, 401);
  } finally { await none.close(); }
});

test('a test that passes no portal settings never reads the real ones', async () => {
  const plain = await start({ hub: undefined });
  try {
    assert.equal((await plain.call('/hub/auth', { method: 'POST', body: {} })).status, 503);
  } finally { await plain.close(); }
});
