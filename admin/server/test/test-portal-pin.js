'use strict';

/* The client's own PIN: at their first sign-in the portal asks for one, and it
 * replaces their Client code. On the real app with the portal mounted, in its own
 * file so its sign-ins don't use up the other files' rate limits. A throwaway
 * database and folder: nothing here reaches real data. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-portal-pin-'));
process.env.DATA_DIR = TMP;
process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough-0123456789';
process.env.COOKIE_SECURE = '0';
process.env.NODE_ENV = 'test';

const { openDatabase, nowIso, newId } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');

const PASSWORD = 'a-long-test-password';
const PORTAL = 'https://lsccreative.studio';
const hub = {
  signingSecret: 'test-signing-secret',
  corsOrigins: [PORTAL],
  publicBaseUrl: 'https://hub.example',
  portalUrl: 'https://lsccreative.studio/client-hub-app/',
  deliverablesDir: path.join(TMP, 'deliverables'),
  backupDir: path.join(TMP, 'backups'),
  bunny: {},
};
fs.mkdirSync(hub.deliverablesDir, { recursive: true });

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
const issue = (clientId, body = {}) => studio(`/api/clients/${clientId}/portal`, { method: 'POST', body });

test.before(async () => {
  db = openDatabase(path.join(TMP, 'billing.db'));
  db.prepare('INSERT INTO account (id, username, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?, ?)')
    .run('tester', await hashPassword(PASSWORD), nowIso(), nowIso());
  const app = createApp(db, { hub, appUrl: 'https://app.example/' });
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

function client(email) {
  const id = newId('cl');
  const now = nowIso();
  db.prepare(`INSERT INTO clients (id, business_name, contact_name, email, created_at, updated_at) VALUES (?, 'Salt', 'Priya Nair', ?, ?, ?)`)
    .run(id, email, now, now);
  return id;
}

function project(clientId) {
  const id = newId('prj');
  const now = nowIso();
  db.prepare(`INSERT INTO projects (id, upid, client_id, needs_upid, accepted_at, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)`)
    .run(id, newId('U'), clientId, now, now, now);
  return id;
}

const choosePin = (cookie, pin, headers) => call('/hub/pin', { method: 'POST', body: { pin }, cookie, headers });

test('at their first sign-in the client is asked for a PIN, which replaces their Client code', async () => {
  const id = client('pin@salt.example');
  const { code } = (await issue(id)).body;
  const first = await signIn('pin@salt.example', code);
  assert.equal(first.body.choosePin, true, 'still on the studio’s code');
  assert.equal((await call('/hub/session', { cookie: first.session })).body.choosePin, true, 'asked again after a reload');
  const other = await signIn('pin@salt.example', code); // the same client on another device

  // Four digits (or six, from a page loaded before the change): not three, five or seven, not a number or letters.
  for (const bad of ['', '48261', '482', '48a6', 4826]) {
    const r = await choosePin(first.session, bad);
    assert.deepEqual([r.status, r.body], [400, { error: 'bad_pin' }], JSON.stringify(bad));
  }
  for (const obvious of ['1234', '1212', '1990']) { // the rest: the obviousPin test below
    const r = await choosePin(first.session, obvious);
    assert.deepEqual([r.status, r.body], [400, { error: 'obvious_pin' }], obvious);
  }
  assert.equal((await choosePin(null, '4826')).status, 401, 'signed in only');
  assert.equal((await choosePin(first.session, '4826', { origin: 'https://evil.example' })).status, 403);
  assert.equal(db.prepare('SELECT code_chosen_at FROM client_logins WHERE client_id = ?').pluck().get(id), null, 'nothing saved yet');

  const set = await choosePin(first.session, '4826', { origin: PORTAL });
  assert.deepEqual([set.status, set.body], [200, { ok: true }], set.text);
  const row = db.prepare('SELECT * FROM client_logins WHERE client_id = ?').get(id);
  assert.ok(row.code_chosen_at);
  for (const v of Object.values(row)) assert.ok(v !== '4826' && v !== sha('4826'), 'kept only as its HMAC, as the code is');
  assert.match(row.code_hash, /^[0-9a-f]{64}$/);

  const after = await call('/hub/session', { cookie: first.session });
  assert.deepEqual([after.status, after.body.choosePin], [200, false], 'this session stays, and isn’t asked again');
  assert.equal((await call('/hub/session', { cookie: other.session })).status, 401, 'every other session ends');
  assert.equal((await signIn('pin@salt.example', code)).status, 401, 'the emailed code stops working');
  const withPin = await signIn('pin@salt.example', '4826');
  assert.deepEqual([withPin.status, withPin.body.choosePin], [200, false]);
  assert.equal((await studio(`/api/clients/${id}/portal`)).body.access.pinChosenAt, row.code_chosen_at, 'the studio can see they chose one');

  // Once only: a session can't swap a chosen PIN for another (someone left at a signed-in computer).
  const swap = await choosePin(withPin.session, '9021');
  assert.deepEqual([swap.status, swap.body], [409, { error: 'pin_set' }]);
  assert.equal((await signIn('pin@salt.example', '9021')).status, 401);
  assert.equal((await call('/hub/session', { cookie: withPin.session })).status, 200, 'and it signs nobody out');

  // The studio's reset puts a new code back, and the client is asked again.
  const reset = (await issue(id)).body.code;
  assert.equal((await signIn('pin@salt.example', '4826')).status, 401, 'the PIN goes with the reset');
  const again = await signIn('pin@salt.example', reset);
  assert.deepEqual([again.status, again.body.choosePin], [200, true]);
});

test('a client still on an old per-project code chooses a PIN, which retires the old code', async () => {
  const id = client('oldpin@salt.example');
  const prj = project(id);
  const now = nowIso();
  db.prepare("INSERT INTO records (project_id, data, updated_at) VALUES ('hub_old_pin', '{}', ?)").run(now);
  db.prepare(`INSERT INTO private_auth (project_id, client_email, email_hash, code_hash, invite_token, delivered, updated_at)
              VALUES ('hub_old_pin', 'oldpin@salt.example', ?, ?, 'old-pin-invite', 0, ?)`).run(sha('oldpin@salt.example'), sha('7310'), now);
  db.prepare(`INSERT INTO hub_imports (hub_id, project_id, outcome, source_json, imported_at) VALUES ('hub_old_pin', ?, 'imported', '{}', ?)`).run(prj, now);

  const old = await signIn('oldpin@salt.example', '7310');
  assert.deepEqual([old.status, old.body.choosePin], [200, true]);
  assert.equal((await choosePin(old.session, '5520')).status, 200);
  assert.equal((await call('/hub/session', { cookie: old.session })).body.choosePin, false);
  assert.equal((await signIn('oldpin@salt.example', '7310')).status, 401, 'the old code is retired');
  assert.equal((await call('/hub/invite', { method: 'POST', body: { token: 'old-pin-invite' } })).status, 404, 'and its invite');
  assert.equal((await signIn('oldpin@salt.example', '5520')).status, 200);
  const access = (await studio(`/api/clients/${id}/portal`)).body.access;
  assert.deepEqual([access.hasCode, access.oldCodes], [true, 0]);
});

test('a View as client preview is never asked for a PIN, and can’t set one', async () => {
  const { createPortalAccess } = require('../src/portal-access');
  const id = client('previewpin@salt.example');
  const prj = project(id);
  await issue(id); // still on the studio's code: the client would be asked
  const previews = createPortalAccess(db, { secret: hub.signingSecret });
  const opened = previews.openPreview(previews.createPreview(id, prj).token);
  const cookie = `lsc_portal_preview=${opened.token}`;
  const session = await call('/hub/session?preview=1', { cookie });
  assert.deepEqual([session.status, session.body.choosePin], [200, false]);
  const set = await call('/hub/pin?preview=1', { method: 'POST', body: { pin: '4826' }, cookie });
  assert.deepEqual([set.status, set.body.error], [403, 'preview']);
  assert.equal(db.prepare('SELECT code_chosen_at FROM client_logins WHERE client_id = ?').pluck().get(id), null);
});

test('a client who chose a PIN is never offered a retried invite, which would reset it', async () => {
  const { inviteOffer } = require('../src/portal-invite');
  const id = client('retrypin@salt.example');
  const prj = project(id);
  const { code } = (await issue(id)).body;
  // The invite email failed after the code was set: the studio passed the code on by hand.
  db.prepare('INSERT INTO activity (id, project_id, at, kind, detail_json) VALUES (?, ?, ?, ?, ?)')
    .run(newId('act'), prj, new Date(Date.now() + 1000).toISOString(), 'portal_invite_failed', '{}');
  const row = () => db.prepare('SELECT * FROM projects WHERE id = ?').get(prj);
  const ENV = { portalSecret: hub.signingSecret, mailer: { configured: true } };
  assert.equal(inviteOffer(db, row(), ENV).state, 'retry', 'nobody has signed in with it yet');
  const signed = await signIn('retrypin@salt.example', code);
  assert.equal((await choosePin(signed.session, '4826')).status, 200);
  await call('/hub/sign-out', { method: 'POST', cookie: signed.session }); // no session left, as after 30 days away
  assert.equal(inviteOffer(db, row(), ENV).state, 'has_access', 'their PIN shows they got in');
});

test('obvious PINs: repeats, runs, pairs, doubles, years and keypad lines, at four digits', () => {
  const { obviousPin } = require('../src/portal-access');
  for (const pin of ['0000', '7777', '1234', '9876', '0123', '1212', '9090', '1122', '3344', '1900', '1990', '2024', '2099',
    '2580', '0852', '1004', '6969', '111111', '123456', '987654']) assert.equal(obviousPin(pin), true, pin);
  for (const pin of ['4826', '9021', '5520', '7391', '1899', '2100', '1213', '482619', '902104']) assert.equal(obviousPin(pin), false, pin);
});

test('a PIN from a portal page loaded before the change (6 digits) is still taken, and signs in', async () => {
  const id = client('sixpin@salt.example');
  const { code } = (await issue(id)).body;
  const first = await signIn('sixpin@salt.example', code);
  // An open tab or cached copy of the old page: its dialog can't be skipped and sends 6.
  assert.deepEqual((await choosePin(first.session, '482619')).status, 200);
  assert.equal((await signIn('sixpin@salt.example', '482619')).status, 200);
});

test('a 6-digit PIN chosen before the change keeps signing its client in', async () => {
  const id = client('oldsix@salt.example');
  await issue(id);
  // Written as v34 saved one: the PIN's HMAC in place of the code, and when.
  const hash = crypto.createHmac('sha256', hub.signingSecret).update(`client-code\n${id}\n731946`).digest('hex');
  db.prepare('UPDATE client_logins SET code_hash = ?, code_chosen_at = ? WHERE client_id = ?').run(hash, nowIso(), id);
  const r = await signIn('oldsix@salt.example', '731946');
  assert.deepEqual([r.status, r.body.choosePin], [200, false]);
});
