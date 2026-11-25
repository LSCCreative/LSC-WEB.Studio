'use strict';

/* Deemed approval and Complete (merged-admin C7), on the real app with the portal
 * mounted and a recording mailer: the 14-business-day clock from each Final
 * (weekends and holidays skipped, a new version restarting it, notes stopping it);
 * the client's reminder, once, before the last day; Mark approved only on the
 * studio's click and only once the days have run out; and Complete reached on its
 * own when everything is approved, and left again when work is added. A throwaway
 * database and folder; days are fixed, never today's. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-deemed-'));
process.env.DATA_DIR = TMP;
process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough-0123456789';
process.env.COOKIE_SECURE = '0';
process.env.NODE_ENV = 'test';

const { openDatabase, nowIso, newId } = require('../src/db');
const { createApp } = require('../src/app');
const { createMailer } = require('../src/mail');
const { hashPassword } = require('../src/auth');
const { businessDaysAfter, clockOf } = require('../src/deemed');

const DELIVERABLES = path.join(TMP, 'deliverables');
fs.mkdirSync(DELIVERABLES, { recursive: true });
const hub = {
  signingSecret: 'test-signing-secret', corsOrigins: ['https://lsccreative.studio'], publicBaseUrl: 'https://hub.example',
  appUrl: 'https://app.example/', portalUrl: 'https://lsccreative.studio/client-hub-app/', deliverablesDir: DELIVERABLES,
  backupDir: path.join(TMP, 'backups'), bunny: {},
};

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

/* A Final published at 11am Sydney on Tuesday 1 December 2026. Its 14 business
   days run to Monday 21 December; the reminder goes from Wednesday 16 December. */
const PUBLISHED = '2026-12-01T00:00:00.000Z';
const REMIND_ON = '2026-12-16';
const LAST_DAY = '2026-12-21';
const DUE_ON = '2026-12-22';

let db;
let server;
let base;
let admin;
let reminders;

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
  reminders = app.locals.deemedReminders;
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

/* An accepted project with one film whose v1 is a Final published at PUBLISHED.
   `access`: the client has a code (and so a session to read the portal with). */
let serial = 0;
async function job({ access = true, email } = {}) {
  serial += 1;
  const now = nowIso();
  const clientId = newId('cl');
  const address = email || `dm${serial}@kiln.example`;
  db.prepare(`INSERT INTO clients (id, business_name, contact_name, email, created_at, updated_at) VALUES (?, ?, 'Ana Kiln', ?, ?, ?)`)
    .run(clientId, `Kiln ${serial}`, address, now, now);
  const projectId = newId('prj');
  db.prepare(`INSERT INTO projects (id, upid, client_id, needs_upid, accepted_at, name, created_at, updated_at, opened_at)
              VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`).run(projectId, `DM-${serial}`, clientId, now, `Deemed job ${serial}`, now, now, now);
  db.prepare(`INSERT INTO estimates (id, project_id, upid, name, date, status, client_id, client_json, active_rows_json, totals_json, created_at, updated_at)
              VALUES (?, ?, ?, 'Deemed job', '2026-11-01', 'accepted', ?, '{}', '{}', '{}', ?, ?)`).run(newId('est'), projectId, `DM-${serial}`, clientId, now, now);
  const folder = `Deemed${serial}`;
  fs.mkdirSync(path.join(DELIVERABLES, folder), { recursive: true });
  for (const n of ['Final.mp4', 'Final2.mp4']) fs.writeFileSync(path.join(DELIVERABLES, folder, n), 'video');
  const film = newId('dlv');
  db.prepare(`INSERT INTO deliverables (id, project_id, position, title, stage, created_at, updated_at) VALUES (?, ?, 1, 'Hero film', 'final', ?, ?)`)
    .run(film, projectId, now, now);
  const v1 = newId('ver');
  db.prepare(`INSERT INTO deliverable_versions (id, deliverable_id, project_id, n, stage, source_path, file_name, kind, created_at, published_at)
              VALUES (?, ?, ?, 1, 'final', ?, 'Final.mp4', 'video', ?, ?)`).run(v1, film, projectId, `${folder}/Final.mp4`, now, PUBLISHED);
  let session = null;
  if (access) {
    const issued = await call(`/api/clients/${clientId}/portal`, { method: 'POST', body: {}, cookie: admin });
    session = (await call('/hub/auth', { method: 'POST', body: { email: address, code: issued.body.code } })).session;
  }
  const studio = `/api/projects/${projectId}/deliverables/${film}`;
  return {
    clientId, projectId, film, v1, session, folder, email: address,
    folderOn: (today) => call(`/api/projects/${projectId}?today=${today}`, { cookie: admin }).then((r) => r.body),
    needsOn: (today) => call(`/api/needs?today=${today}`, { cookie: admin })
      .then((r) => r.body.items.filter((i) => i.kind === 'deemed_approval' && i.projectId === projectId)),
    deem: (versionId, today) => call(`${studio}/versions/${versionId}/deem?today=${today}`, { method: 'POST', body: {}, cookie: admin }),
    /* A newer version, published at `at`. */
    version: (n, at) => {
      const id = newId('ver');
      db.prepare(`INSERT INTO deliverable_versions (id, deliverable_id, project_id, n, stage, source_path, file_name, kind, created_at, published_at)
                  VALUES (?, ?, ?, ?, 'final', ?, 'Final2.mp4', 'video', ?, ?)`).run(id, film, projectId, n, `${folder}/Final2.mp4`, at, at);
      return id;
    },
  };
}

test('14 business days: weekends and NSW holidays skipped, the publish day never counted', () => {
  assert.equal(businessDaysAfter('2026-12-01', 14, []), '2026-12-21');
  // Christmas, Boxing Day observed (Mon 28) and New Year's Day push it on by three.
  const holidays = [{ date: '2026-12-25' }, { date: '2026-12-28' }, { date: '2027-01-01' }];
  assert.equal(businessDaysAfter('2026-12-18', 14, holidays), '2027-01-12');
  // A holiday the owner hid is a working day again, as everywhere else.
  assert.equal(businessDaysAfter('2026-12-18', 14, [{ date: '2026-12-25', hidden: 1 }, { date: '2026-12-28' }, { date: '2027-01-01' }]), '2027-01-11');
  // Published on a Saturday: Monday is day one.
  assert.equal(businessDaysAfter('2026-12-05', 1, []), '2026-12-07');
  // The Sydney day: 11pm UTC on 30 November is 1 December in Sydney.
  assert.deepEqual(clockOf('2026-11-30T23:00:00.000Z', []), { publishedOn: '2026-12-01', remindOn: REMIND_ON, lastDay: LAST_DAY, dueOn: DUE_ON });
});

test('nothing changes on its own: the row appears after the last day, and only a click records it', async () => {
  const j = await job();
  let folder = await j.folderOn(LAST_DAY);
  assert.deepEqual(folder.deemed[j.film], {
    versionId: j.v1, n: 1, publishedOn: '2026-12-01', remindOn: REMIND_ON, lastDay: LAST_DAY, dueOn: DUE_ON, due: false, reminder: null,
  });
  assert.deepEqual(await j.needsOn(LAST_DAY), [], 'the client still has their last day');
  const early = await j.deem(j.v1, LAST_DAY);
  assert.equal(early.status, 409);
  assert.equal(early.body.error, 'not_due');

  const rows = await j.needsOn(DUE_ON);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].itemId, rows[0].versionId, rows[0].since, rows[0].days], [j.film, j.v1, DUE_ON, 0]);
  // Weeks later, still nothing recorded and the item still waits on the client.
  folder = await j.folderOn('2027-02-01');
  assert.equal(folder.deemed[j.film].due, true);
  assert.equal(folder.project.delivery.badge, 'in_review');
  assert.equal(db.prepare('SELECT COUNT(*) FROM client_approvals WHERE version_id = ?').pluck().get(j.v1), 0);

  const r = await j.deem(j.v1, DUE_ON);
  assert.equal(r.status, 200, r.text);
  const rec = db.prepare('SELECT * FROM client_approvals WHERE version_id = ?').get(j.v1);
  assert.deepEqual([rec.kind, rec.stage, rec.version_n, rec.file_name, rec.email, rec.ip], ['deemed', 'final', 1, 'Final.mp4', '', '']);
  assert.ok(db.prepare("SELECT 1 FROM activity WHERE project_id = ? AND kind = 'deemed_approved'").get(j.projectId));
  assert.equal(r.body.deemed[j.film], undefined, 'the clock is done');
  assert.deepEqual(await j.needsOn(DUE_ON), [], 'and the row is gone');
  assert.equal((await j.deem(j.v1, DUE_ON)).status, 200, 'a second click answers with the record');
  assert.equal(db.prepare('SELECT COUNT(*) FROM client_approvals WHERE version_id = ?').pluck().get(j.v1), 1);

  // The client sees it approved, and that it was deemed.
  const view = (await call(`/hub/projects/${j.projectId}`, { cookie: j.session })).body.project;
  const item = view.deliverables.find((d) => d.id === j.film);
  assert.equal(item.status, 'approved');
  assert.deepEqual([item.versions[0].deemed, Boolean(item.versions[0].approvedAt)], [true, true]);
});

test('a new version restarts the clock; notes sent stop it; a draft never has one', async () => {
  const j = await job();
  assert.equal((await j.needsOn(DUE_ON)).length, 1);
  // v2 published on 15 December: a fresh 14 business days, to 6 January (no holidays listed here).
  const v2 = j.version(2, '2026-12-15T00:00:00.000Z');
  const clock = (await j.folderOn(DUE_ON)).deemed[j.film];
  assert.deepEqual([clock.versionId, clock.publishedOn, clock.lastDay], [v2, '2026-12-15', '2027-01-04']);
  assert.deepEqual(await j.needsOn(DUE_ON), [], 'the old row goes with the old version');
  assert.equal((await j.deem(j.v1, '2027-02-01')).body.error, 'not_waiting', 'the replaced version can’t be marked');

  // The client sends notes on v2: they answered, so no clock.
  const at = `/hub/projects/${j.projectId}/items/${j.film}`;
  assert.equal((await call(`${at}/notes`, { method: 'POST', body: { versionId: v2, text: 'Shorter', seconds: 2 }, cookie: j.session })).status, 201);
  assert.equal((await j.folderOn('2027-02-01')).deemed[j.film].versionId, v2, 'a note written but not sent is still silence');
  assert.equal((await call(`${at}/submit`, { method: 'POST', body: { versionId: v2 }, cookie: j.session })).status, 200);
  assert.equal((await j.folderOn('2027-02-01')).deemed[j.film], undefined);
  assert.equal((await j.deem(v2, '2027-02-01')).body.error, 'not_waiting');

  // A Draft Cut: no clock however long it waits.
  const d = await job();
  db.prepare("UPDATE deliverable_versions SET stage = 'draft' WHERE id = ?").run(d.v1);
  db.prepare("UPDATE deliverables SET stage = 'draft' WHERE id = ?").run(d.film);
  assert.equal((await d.folderOn('2027-02-01')).deemed[d.film], undefined);
});

test('a listed holiday moves the last day', async () => {
  const j = await job();
  db.prepare("INSERT OR REPLACE INTO holidays (date, name, source, hidden) VALUES ('2026-12-10', 'Test day', 'added', 0)").run();
  try {
    assert.equal((await j.folderOn(DUE_ON)).deemed[j.film].lastDay, '2026-12-22');
    assert.deepEqual(await j.needsOn(DUE_ON), [], 'not due until the 23rd now');
    assert.equal((await j.needsOn('2026-12-23')).length, 1);
  } finally {
    db.prepare("DELETE FROM holidays WHERE date = '2026-12-10'").run();
  }
});

test('the reminder goes once, from its day to the last day, only to a client who can open the portal', async () => {
  const j = await job();
  const nobody = await job({ access: false });
  const mine = () => sent.filter((m) => m.to === j.email);
  await reminders.runDue('2026-12-15');
  assert.equal(mine().length, 0, 'not before its day');
  await reminders.runDue(REMIND_ON);
  assert.equal(mine().length, 1);
  const mail = mine()[0];
  assert.match(mail.subject, /Reminder: Hero film is waiting for your review/);
  assert.match(mail.text, /since Tuesday 1 December/);
  assert.match(mail.text, /by the end of Monday 21 December/);
  assert.match(mail.text, /taken as approved/);
  assert.ok(mail.text.includes('https://lsccreative.studio/client-hub-app/'));
  assert.equal(sent.filter((m) => m.to === nobody.email).length, 0, 'no way into the portal: no reminder');
  await reminders.runDue('2026-12-17');
  assert.equal(mine().length, 1, 'once');
  const folder = await j.folderOn('2026-12-17');
  assert.deepEqual([folder.deemed[j.film].reminder.status, folder.deemed[j.film].reminder.to], ['sent', j.email]);
  assert.ok(db.prepare("SELECT 1 FROM activity WHERE project_id = ? AND kind = 'deemed_reminder_sent'").get(j.projectId));

  // Too late: past the last day nothing goes, since it would name a day already gone.
  const late = await job();
  await reminders.runDue(DUE_ON);
  assert.equal(sent.filter((m) => m.to === late.email).length, 0);

  // A client who already answered gets none.
  const answered = await job();
  assert.equal((await call(`/hub/projects/${answered.projectId}/items/${answered.film}/approve`,
    { method: 'POST', body: { versionId: answered.v1 }, cookie: answered.session })).status, 201);
  await reminders.runDue(REMIND_ON);
  assert.equal(sent.filter((m) => m.to === answered.email).length, 0);
});

test('a reminder that fails is recorded and tried again on the next pass', async () => {
  const j = await job();
  const n = sent.length;
  failNext = true;
  // Earlier jobs' reminders already went, so this pass tries only this one.
  await reminders.runDue(REMIND_ON);
  let r = db.prepare('SELECT * FROM deemed_reminders WHERE version_id = ?').get(j.v1);
  assert.deepEqual([r.status, r.attempts], ['failed', 1]);
  assert.match(r.error, /SMTP said no/);
  assert.equal((await j.folderOn(REMIND_ON)).deemed[j.film].reminder.status, 'failed');
  await reminders.runDue(REMIND_ON);
  r = db.prepare('SELECT * FROM deemed_reminders WHERE version_id = ?').get(j.v1);
  assert.deepEqual([r.status, r.attempts], ['sent', 2]);
  assert.equal(sent.length, n + 1);
});

test('Complete on its own once everything is approved, and back to live when work is added', async () => {
  const j = await job();
  assert.equal((await j.deem(j.v1, DUE_ON)).status, 200);
  assert.equal((await j.folderOn(DUE_ON)).project.delivery.badge, 'complete', 'payment not required: approval is enough');
  // A new file on the item reopens it, and its clock starts again.
  const v2 = j.version(2, '2027-01-05T00:00:00.000Z');
  let folder = await j.folderOn('2027-01-06');
  assert.equal(folder.project.delivery.badge, 'in_review');
  assert.equal(folder.deemed[j.film].versionId, v2);
  assert.equal((await call(`/hub/projects/${j.projectId}/items/${j.film}/approve`,
    { method: 'POST', body: { versionId: v2 }, cookie: j.session })).status, 201);
  assert.equal((await j.folderOn('2027-01-06')).project.delivery.badge, 'complete');
  // Another deliverable: back in production.
  await call(`/api/projects/${j.projectId}/deliverables?today=2027-01-06`, { method: 'POST', body: { title: 'Cut-down' }, cookie: admin });
  folder = await j.folderOn('2027-01-06');
  assert.equal(folder.project.delivery.badge, 'in_production');
});

test('an archived project has no clock and can’t be marked', async () => {
  const j = await job();
  db.prepare('UPDATE projects SET archived_at = ? WHERE id = ?').run(nowIso(), j.projectId);
  assert.deepEqual(await j.needsOn(DUE_ON), []);
  assert.equal((await j.deem(j.v1, DUE_ON)).body.error, 'archived');
});
