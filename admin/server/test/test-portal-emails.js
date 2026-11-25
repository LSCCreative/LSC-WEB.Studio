'use strict';

/* The portal's emails (merged-admin C6), on the real app with a recording
 * mailer: the invite goes with a project's first publish only if the studio
 * says so, once per client, carrying a Client code that really signs in; a
 * failed send hands the code over instead of losing it; a client's set of notes
 * emails the studio with the round it used; and nothing is sent that didn't
 * happen. A throwaway database and folder. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-portal-emails-'));
process.env.DATA_DIR = TMP;
process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough-0123456789';
process.env.COOKIE_SECURE = '0';
process.env.NODE_ENV = 'test';

const { openDatabase, nowIso, newId } = require('../src/db');
const { createApp } = require('../src/app');
const { createMailer } = require('../src/mail');
const { hashPassword } = require('../src/auth');

const DELIVERABLES = path.join(TMP, 'deliverables');
fs.mkdirSync(DELIVERABLES, { recursive: true });
const hub = {
  signingSecret: 'test-signing-secret', corsOrigins: ['https://lsccreative.studio'], publicBaseUrl: 'https://hub.example',
  appUrl: 'https://app.example/', portalUrl: 'https://lsccreative.studio/client-hub-app/', deliverablesDir: DELIVERABLES,
  backupDir: path.join(TMP, 'backups'), bunny: {},
};
const TODAY = new Date().toISOString().slice(0, 10);

const sent = [];
let failNext = false;
const transport = {
  async sendMail(mail) {
    if (failNext) { failNext = false; throw new Error('SMTP said no'); }
    sent.push(mail);
    return { messageId: `m${sent.length}` };
  },
};
const mailer = createMailer({ mailFrom: 'studio@lsc.test', mailReplyTo: 'owner@lsc.test', smtp: {} }, { transport });

let db;
let server;
let base;
let admin;

async function call(url, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
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
  const app = createApp(db, { hub, mailer, appUrl: 'https://app.example/' });
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

let serial = 0;
/* An accepted project holding one unpublished Draft Cut. */
function job({ email = null } = {}) {
  serial += 1;
  const now = nowIso();
  const clientId = newId('cl');
  const address = email === null ? `em${serial}@reed.example` : email;
  db.prepare(`INSERT INTO clients (id, business_name, contact_name, email, created_at, updated_at) VALUES (?, ?, 'Jo Reed', ?, ?, ?)`)
    .run(clientId, `Reed ${serial}`, address, now, now);
  const projectId = newId('prj');
  db.prepare(`INSERT INTO projects (id, upid, client_id, needs_upid, accepted_at, name, created_at, updated_at, opened_at)
              VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`).run(projectId, `EM-${serial}`, clientId, now, `Email job ${serial}`, now, now, now);
  const folder = `Mail${serial}`;
  fs.mkdirSync(path.join(DELIVERABLES, folder), { recursive: true });
  for (const n of ['A.mp4', 'B.mp4']) fs.writeFileSync(path.join(DELIVERABLES, folder, n), 'video');
  const film = newId('dlv');
  db.prepare(`INSERT INTO deliverables (id, project_id, position, title, stage, created_at, updated_at) VALUES (?, ?, 1, 'Hero film', 'draft', ?, ?)`)
    .run(film, projectId, now, now);
  const mkVersion = (n, file) => {
    const id = newId('ver');
    db.prepare(`INSERT INTO deliverable_versions (id, deliverable_id, project_id, n, stage, source_path, file_name, kind, created_at)
                VALUES (?, ?, ?, ?, 'draft', ?, ?, 'video', ?)`).run(id, film, projectId, n, `${folder}/${file}`, file, now);
    return id;
  };
  const v1 = mkVersion(1, 'A.mp4');
  const studio = `/api/projects/${projectId}/deliverables/${film}`;
  return {
    clientId, projectId, film, v1, email: address, mkVersion,
    publish: (versionId, body) => call(`${studio}/versions/${versionId}/publish?today=${TODAY}`, { method: 'POST', body, cookie: admin }),
    invite: () => call(`/api/projects/${projectId}/portal-invite?today=${TODAY}`, { method: 'POST', body: {}, cookie: admin }),
    folder: () => call(`/api/projects/${projectId}?today=${TODAY}`, { cookie: admin }),
  };
}
const codeIn = (mail) => (/Client code: (\d{6})/.exec(mail.text) || [])[1];

test('the first publish asks before inviting: nothing goes unless the studio said so', async () => {
  const j = job();
  const before = sent.length;
  const r = await j.publish(j.v1, {});
  assert.equal(r.status, 200, r.text);
  assert.equal(sent.length, before, 'publishing alone sends nothing');
  assert.equal(r.body.invite.state, 'ready');
  assert.equal(r.body.invite.to, j.email);
  assert.equal(r.body.inviteResult, undefined);
});

test('publishing with the invite emails the code and link, once, and the code signs in', async () => {
  const j = job();
  const r = await j.publish(j.v1, { invite: true });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.inviteResult.sent, r.body.inviteResult.to], [true, j.email]);
  const mail = sent[sent.length - 1];
  assert.equal(mail.to, j.email);
  assert.match(mail.subject, /Email job/);
  assert.match(mail.text, /#\/invite\/[\w-]+/, 'the link is in the fragment');
  assert.ok(mail.text.includes('https://lsccreative.studio/client-hub-app/#/invite/'));
  const code = codeIn(mail);
  assert.ok(code, 'the code is in the message');
  assert.equal((await call('/hub/auth', { method: 'POST', body: { email: j.email, code } })).status, 200, 'and it works');
  assert.ok(db.prepare("SELECT 1 FROM activity WHERE project_id = ? AND kind = 'portal_invite_sent'").get(j.projectId));
  assert.equal(r.body.invite.state, 'sent');

  // A later publish never re-invites, even if asked, and leaves the code alone.
  const v2 = j.mkVersion(2, 'B.mp4');
  const n = sent.length;
  const again = await j.publish(v2, { invite: true });
  assert.equal(again.status, 200);
  assert.equal(sent.length, n);
  assert.equal(again.body.inviteResult, undefined);
  assert.equal((await call('/hub/auth', { method: 'POST', body: { email: j.email, code } })).status, 200, 'still works');
});

test('a publish that is not the project’s first sends no invite, and the by-hand route covers it', async () => {
  const a = job();
  // The client's first project is published with no invite.
  assert.equal((await a.publish(a.v1, { invite: false })).status, 200);
  assert.equal(sent.filter((m) => m.to === a.email).length, 0);
  const n = sent.length;
  const r = await a.invite();
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.inviteResult.sent, true);
  assert.equal(sent.length, n + 1);
  assert.equal((await a.invite()).body.error, 'invite_sent', 'once per client');
  assert.equal(sent.length, n + 1);
});

test('a failed send hands the studio the code once, logs it, and the publish stands', async () => {
  const j = job();
  failNext = true;
  const r = await j.publish(j.v1, { invite: true });
  assert.equal(r.status, 200, r.text);
  const res = r.body.inviteResult;
  assert.deepEqual([res.sent, res.failed], [false, true]);
  assert.match(res.error, /SMTP said no/);
  assert.match(res.code, /^\d{6}$/);
  assert.ok(res.inviteUrl.includes('#/invite/'));
  assert.equal((await call('/hub/auth', { method: 'POST', body: { email: j.email, code: res.code } })).status, 200, 'the code handed over works');
  assert.ok(db.prepare("SELECT 1 FROM activity WHERE project_id = ? AND kind = 'portal_invite_failed'").get(j.projectId));
  assert.equal(db.prepare("SELECT COUNT(*) FROM activity WHERE project_id = ? AND kind = 'portal_invite_sent'").pluck().get(j.projectId), 0, 'not logged as sent');
  assert.equal(db.prepare('SELECT published_at FROM deliverable_versions WHERE id = ?').pluck().get(j.v1) !== null, true);
  // The client signed in with the code handed over, so sending again would sign them out: not offered.
  assert.equal((await j.folder()).body.invite.state, 'has_access');
});

test('an invite whose email failed can be sent again until someone signs in, and that retires its code', async () => {
  const j = job();
  failNext = true;
  const first = (await j.publish(j.v1, { invite: true })).body.inviteResult;
  assert.equal(first.failed, true);
  const offer = (await j.folder()).body.invite;
  assert.deepEqual([offer.state, offer.to], ['retry', j.email]);
  assert.ok(offer.failedAt);
  const n = sent.length;
  const again = await j.invite();
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.inviteResult.sent, true);
  assert.equal(sent.length, n + 1);
  const code = codeIn(sent[sent.length - 1]);
  assert.notEqual(code, first.code);
  assert.notEqual((await call('/hub/auth', { method: 'POST', body: { email: j.email, code: first.code } })).status, 200, 'the handed-over code is retired');
  assert.equal((await call('/hub/auth', { method: 'POST', body: { email: j.email, code } })).status, 200);
  assert.equal(again.body.invite.state, 'sent');
});

test('the invite says what is waiting: a first cut, a Final, or nothing yet', async () => {
  const early = job();
  assert.equal((await early.invite()).body.inviteResult.sent, true);
  let mail = sent[sent.length - 1];
  assert.match(mail.text, /Nothing is up for review yet/);
  assert.doesNotMatch(mail.text, /first cut/);

  const draft = job();
  await draft.publish(draft.v1, { invite: true });
  assert.match(sent[sent.length - 1].text, /the first cut of Email job/);

  const final = job();
  db.prepare("UPDATE deliverables SET stage = 'final' WHERE id = ?").run(final.film);
  db.prepare("UPDATE deliverable_versions SET stage = 'final' WHERE id = ?").run(final.v1);
  await final.publish(final.v1, { invite: true });
  mail = sent[sent.length - 1];
  assert.match(mail.text, /has put Email job \d+ in your Client Portal, where you can review it/);
  assert.doesNotMatch(mail.text, /first cut|Nothing is up/);
});

test('no invite for a client with no email, a shared one, or one who can already sign in', async () => {
  const none = job({ email: '' });
  const r = await none.publish(none.v1, { invite: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.invite.state, 'no_email');
  assert.deepEqual(r.body.inviteResult, { sent: false, state: 'no_email', message: 'Add the client’s email in Client details first.' },
    'asked for, refused, said why');
  assert.equal((await none.invite()).body.error, 'invite_no_email');

  const a = job({ email: 'shared@reed.example' });
  const b = job({ email: 'shared@reed.example' });
  assert.equal((await a.invite()).body.error, 'invite_email_shared');
  void b;

  const has = job();
  await call(`/api/clients/${has.clientId}/portal`, { method: 'POST', body: {}, cookie: admin });
  const n = sent.length;
  const res = await has.publish(has.v1, { invite: true });
  assert.equal(res.body.invite.state, 'has_access');
  assert.equal(sent.length, n, 'their code would have been reset by an invite');
});

test('two invites at once issue one code and send one email', async () => {
  const j = job();
  const n = sent.length;
  const [x, y] = await Promise.all([j.invite(), j.invite()]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  assert.equal(sent.length, n + 1);
});

test('a set of notes emails the studio: the client, the item, the count, and the round a Final used', async () => {
  const j = job();
  await call(`/api/projects/${j.projectId}/deliverables/${j.film}/versions/${j.v1}/publish?today=${TODAY}`, { method: 'POST', body: {}, cookie: admin });
  const code = (await call(`/api/clients/${j.clientId}/portal`, { method: 'POST', body: {}, cookie: admin })).body.code;
  const { session } = await call('/hub/auth', { method: 'POST', body: { email: j.email, code } });
  const at = `/hub/projects/${j.projectId}/items/${j.film}`;
  await call(`${at}/notes`, { method: 'POST', body: { versionId: j.v1, text: 'Cut the intro', seconds: 3 }, cookie: session });
  await call(`${at}/notes`, { method: 'POST', body: { versionId: j.v1, text: 'Louder music', seconds: 9 }, cookie: session });
  const n = sent.length;
  const r = await call(`${at}/submit`, { method: 'POST', body: { versionId: j.v1 }, cookie: session });
  assert.equal(r.status, 200, r.text);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sent.length, n + 1);
  const mail = sent[sent.length - 1];
  assert.equal(mail.to, 'owner@lsc.test');
  assert.match(mail.subject, /sent 2 notes/);
  assert.match(mail.text, /2 notes on v1 of “Hero film”, a Draft Cut/);
  assert.match(mail.text, /don’t use a revision round/);
  assert.ok(mail.text.includes(`https://app.example/#/projects/${j.projectId}`));
  assert.ok(!mail.text.includes('Louder music'), 'the notes themselves stay in the studio');

  // A Final: round 1, then 2, then a third past the included two.
  await call(`/api/projects/${j.projectId}/deliverables/${j.film}?today=${TODAY}`, { method: 'PUT', body: { stage: 'final' }, cookie: admin });
  let last = null;
  for (let round = 1; round <= 3; round += 1) {
    const v = (await call(`/api/projects/${j.projectId}/deliverables/${j.film}/versions?today=${TODAY}`,
      { method: 'POST', body: { path: `Mail${serial}/${round === 2 ? 'B' : 'A'}.mp4` }, cookie: admin })).body.deliverables
      .find((d) => d.id === j.film).versions.slice(-1)[0];
    await call(`/api/projects/${j.projectId}/deliverables/${j.film}/versions/${v.id}/publish?today=${TODAY}`, { method: 'POST', body: {}, cookie: admin });
    await call(`${at}/notes`, { method: 'POST', body: { versionId: v.id, text: `Round ${round}`, seconds: 1 }, cookie: session });
    assert.equal((await call(`${at}/submit`, { method: 'POST', body: { versionId: v.id }, cookie: session })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    last = sent[sent.length - 1];
    if (round === 1) assert.match(last.text, /revision round 1 of the 2 included/);
    if (round === 2) assert.match(last.text, /revision round 2 of the 2 included/);
  }
  assert.match(last.text, /revision round 3, past the 2 included, so it is billable/);

  // With no APP_URL the notice still goes, just without the link.
  const { notesSubmitted } = require('../src/owner-notices');
  const latest = db.prepare('SELECT id FROM client_submissions WHERE project_id = ? ORDER BY submitted_at DESC, id DESC LIMIT 1').pluck().get(j.projectId);
  const m = sent.length;
  assert.equal(await notesSubmitted(db, { mailer, appUrl: '' }, { submissionId: latest }), true);
  assert.equal(sent.length, m + 1);
  assert.doesNotMatch(sent[sent.length - 1].text, /Open the project/);
  assert.doesNotMatch(sent[sent.length - 1].html, /#\/projects\//);
});

test('a notes email that can’t go never fails the client’s send', async () => {
  const j = job();
  await j.publish(j.v1, {});
  const code = (await call(`/api/clients/${j.clientId}/portal`, { method: 'POST', body: {}, cookie: admin })).body.code;
  const { session } = await call('/hub/auth', { method: 'POST', body: { email: j.email, code } });
  const at = `/hub/projects/${j.projectId}/items/${j.film}`;
  await call(`${at}/notes`, { method: 'POST', body: { versionId: j.v1, text: 'x', seconds: 1 }, cookie: session });
  failNext = true;
  const r = await call(`${at}/submit`, { method: 'POST', body: { versionId: j.v1 }, cookie: session });
  assert.equal(r.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 50));
  failNext = false;
});
