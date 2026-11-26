'use strict';

/* The client's files, emailed once the job is paid (merged-admin C10), on the real
 * app with the portal mounted and a recording mailer. Whichever comes last of "the
 * whole job is paid" and "every item is approved" sends the Drive links to the
 * client, with a copy to the studio; the same set never goes twice; a deposit alone
 * never sends; a void invoice doesn't count; a deemed approval counts; a client
 * with no email is told to the studio and sent once an address is added; a failed
 * send is retried; a new Final approved afterwards sends an update. A throwaway
 * database and folder. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-files-'));
process.env.DATA_DIR = TMP;
process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough-0123456789';
process.env.COOKIE_SECURE = '0';
process.env.NODE_ENV = 'test';

const { openDatabase, nowIso, newId } = require('../src/db');
const { createApp } = require('../src/app');
const { createMailer } = require('../src/mail');
const { hashPassword } = require('../src/auth');
const { MAX_ATTEMPTS, releasePlan } = require('../src/files-release');
const { migrateV32 } = require('../src/migrations/v32-files-releases');
const { sydneyDay } = require('../src/deemed');

const PORTAL = 'https://lsccreative.studio';
const DELIVERABLES = path.join(TMP, 'deliverables');
fs.mkdirSync(DELIVERABLES, { recursive: true });
const hub = {
  signingSecret: 'test-signing-secret', corsOrigins: [PORTAL], publicBaseUrl: 'https://hub.example',
  appUrl: 'https://app.example/', portalUrl: `${PORTAL}/client-hub-app/`, deliverablesDir: DELIVERABLES,
  backupDir: path.join(TMP, 'backups'), bunny: {},
};

const sent = [];
let failing = 0;
let slowMs = 0;
const transport = {
  async sendMail(mail) {
    if (slowMs) await new Promise((resolve) => setTimeout(resolve, slowMs));
    if (failing > 0) { failing -= 1; throw new Error('SMTP said no'); }
    sent.push(mail);
    return { messageId: `m${sent.length}` };
  },
};
const mailer = createMailer({ mailFrom: 'studio@lsc.test', mailReplyTo: 'owner@lsc.test', smtp: {} }, { transport });

const TODAY = '2026-11-26';
const DRIVE = 'https://drive.google.com/file/d/abc123/view';

let db;
let server;
let base;
let admin;
let release;

async function call(url, { method = 'GET', body, cookie, origin } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(origin ? { origin } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  const set = res.headers.get('set-cookie') || '';
  return { status: res.status, body: json, text, session: set.startsWith('lsc_portal=') ? set.split(';')[0] : null };
}

/* The background checks (an approval, a checklist write) start before the reply
   reaches us; check() joins the one under way (or finds nothing left to do), so
   awaiting it waits for exactly that work, however slow the machine. The studio's
   copy goes after the client's email: one more tick lets it land. */
const settle = async (projectId) => {
  await release.check(projectId);
  await new Promise((resolve) => setImmediate(resolve));
};

test.before(async () => {
  db = openDatabase(path.join(TMP, 'billing.db'));
  db.prepare('INSERT INTO account (id, username, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?, ?)')
    .run('tester', await hashPassword('a-long-test-password'), nowIso(), nowIso());
  const app = createApp(db, { hub, mailer, appUrl: 'https://app.example/', filesWaitMs: 300 });
  release = app.locals.filesRelease;
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

/* An accepted project with two films, each with a published Final v1 (the second
   with no Drive link unless `links`), and the invoices asked for, all sent. */
let serial = 0;
async function job({ invoices = ['deposit', 'final'], email, links = false } = {}) {
  serial += 1;
  const now = nowIso();
  const clientId = newId('cl');
  const address = email === undefined ? `fr${serial}@kiln.example` : email;
  db.prepare(`INSERT INTO clients (id, business_name, contact_name, email, created_at, updated_at) VALUES (?, ?, 'Ana Kiln', ?, ?, ?)`)
    .run(clientId, `Kiln ${serial}`, address, now, now);
  const projectId = newId('prj');
  db.prepare(`INSERT INTO projects (id, upid, client_id, needs_upid, accepted_at, name, created_at, updated_at, opened_at)
              VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`).run(projectId, `FR-${serial}`, clientId, now, `Files job ${serial}`, now, now, now);
  db.prepare(`INSERT INTO estimates (id, project_id, upid, name, date, status, client_id, client_json, active_rows_json, totals_json, created_at, updated_at)
              VALUES (?, ?, ?, ?, '2026-11-01', 'accepted', ?, '{}', '{}', '{}', ?, ?)`)
    .run(newId('est'), projectId, `FR-${serial}`, `Files job ${serial}`, clientId, now, now);
  const folder = `Files${serial}`;
  fs.mkdirSync(path.join(DELIVERABLES, folder), { recursive: true });
  for (const n of ['Hero.mp4', 'Cut.mp4', 'Hero2.mp4']) fs.writeFileSync(path.join(DELIVERABLES, folder, n), 'video');
  const items = [];
  for (const [i, title, file, link] of [[1, 'Hero film', 'Hero.mp4', DRIVE], [2, 'Cut-down', 'Cut.mp4', links ? `${DRIVE}?2` : '']]) {
    const id = newId('dlv');
    db.prepare(`INSERT INTO deliverables (id, project_id, position, title, stage, created_at, updated_at) VALUES (?, ?, ?, ?, 'final', ?, ?)`)
      .run(id, projectId, i, title, now, now);
    const v = newId('ver');
    db.prepare(`INSERT INTO deliverable_versions (id, deliverable_id, project_id, n, stage, source_path, file_name, kind, drive_link, created_at, published_at)
                VALUES (?, ?, ?, 1, 'final', ?, ?, 'video', ?, ?, ?)`).run(v, id, projectId, `${folder}/${file}`, file, link, now, '2026-11-02T00:00:00.000Z');
    items.push({ id, v });
  }
  const inv = {};
  for (const kind of invoices) {
    inv[kind] = newId('inv');
    db.prepare(`INSERT INTO invoices (id, project_id, kind, number, status, issued_at, due_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'sent', '2026-11-10', '2026-11-24', ?, ?)`)
      .run(inv[kind], projectId, kind, `INV-FR${serial}-${kind}`, now, now);
  }
  let session = null;
  if (address) {
    const issued = await call(`/api/clients/${clientId}/portal`, { method: 'POST', body: {}, cookie: admin });
    session = (await call('/hub/auth', { method: 'POST', body: { email: address, code: issued.body.code } })).session;
  }
  return {
    clientId, projectId, items, inv, email: address, session, folder,
    pay: async (id) => {
      const r = await call(`/api/invoices/${id}/paid?today=${TODAY}`, { method: 'POST', body: { paidAt: '2026-11-25', via: 'bank' }, cookie: admin });
      await new Promise((resolve) => setImmediate(resolve));
      return r;
    },
    approve: async (item) => {
      const r = await call(`/hub/projects/${projectId}/items/${item.id}/approve`,
        { method: 'POST', body: { versionId: item.v }, cookie: session, origin: PORTAL });
      await settle(projectId);
      return r;
    },
    /* The studio's approval, as Mark approved records it, straight into the table. */
    deem: (item) => db.prepare(`INSERT INTO client_approvals (id, project_id, deliverable_id, version_id, kind, client_id, stage, version_n, file_name, approved_at)
                                VALUES (?, ?, ?, ?, 'deemed', ?, 'final', 1, 'x.mp4', ?)`).run(newId('ca'), projectId, item.id, item.v, clientId, nowIso()),
    invoiceView: (id) => call(`/api/invoices/${id}?today=${TODAY}`, { cookie: admin }).then((r) => r.body),
    record: () => db.prepare('SELECT * FROM files_releases WHERE project_id = ?').get(projectId),
  };
}

const filesTo = (to) => sent.filter((m) => m.to === to && /files/i.test(m.subject) && !/not sent/i.test(m.subject));
const ownerMail = (j) => sent.filter((m) => m.to === 'owner@lsc.test' && new RegExp(`Files job ${serialOf(j)}\\b`).test(m.text));
const serialOf = (j) => Number(String(j.folder).replace('Files', ''));

test('approved, then the final paid: the client gets their Drive links once, the studio a copy', async () => {
  const j = await job();
  await j.approve(j.items[0]);
  await j.approve(j.items[1]);
  assert.equal(filesTo(j.email).length, 0, 'nothing goes while the job is unpaid');

  const dep = await j.pay(j.inv.deposit);
  assert.equal(dep.status, 200, dep.text);
  assert.equal(dep.body.files.reason, 'not_paid', 'a paid deposit alone never sends');
  assert.equal(filesTo(j.email).length, 0);

  // The dialog's facts before the last one is marked.
  const before = (await j.invoiceView(j.inv.final)).filesRelease;
  assert.deepEqual([before.unpaid, before.approved, before.email, before.noLink, before.delivered],
    [[j.inv.final], true, j.email, ['Cut-down'], false]);

  const fin = await j.pay(j.inv.final);
  assert.equal(fin.status, 200, fin.text);
  assert.deepEqual(fin.body.files, { sent: true, to: j.email, update: false });
  const mails = filesTo(j.email);
  assert.equal(mails.length, 1);
  assert.match(mails[0].text, /Hero film \(v1\): https:\/\/drive\.google\.com\/file\/d\/abc123\/view/);
  assert.match(mails[0].text, /Cut-down \(v1\): we’ll send this one to you separately/);
  assert.match(mails[0].html, /href="https:\/\/drive\.google\.com\/file\/d\/abc123\/view"/);
  const copy = ownerMail(j).filter((m) => /^Files sent/.test(m.subject));
  assert.equal(copy.length, 1, 'the studio gets its copy');
  assert.match(copy[0].subject, /a link is missing/);
  assert.match(copy[0].text, new RegExp(`went to Kiln ${serialOf(j)} \\(${j.email}\\)`));
  assert.match(copy[0].text, /no Drive backup link.*Cut-down/);
  assert.equal(fin.body.filesRelease.delivered, true);
  assert.equal(fin.body.filesRelease.sentOn, sydneyDay(j.record().sent_at), 'the Sydney day, not UTC');
  assert.ok(db.prepare("SELECT 1 FROM activity WHERE project_id = ? AND kind = 'files_sent'").get(j.projectId));

  // Marking paid again, or another approval write, never re-sends.
  const again = await j.pay(j.inv.final);
  assert.equal(again.body.already, true);
  assert.equal((await release.check(j.projectId)).reason, 'already');
  await j.approve(j.items[0]);
  assert.equal(filesTo(j.email).length, 1);
});

test('paid first, then the last approval sends, once', async () => {
  const j = await job({ invoices: ['single'], links: true });
  await j.approve(j.items[0]);
  const paid = await j.pay(j.inv.single);
  assert.equal(paid.body.files.reason, 'not_approved');
  assert.equal(filesTo(j.email).length, 0);
  await j.approve(j.items[1]);
  assert.equal(filesTo(j.email).length, 1, 'the last approval sent them');
  const copy = ownerMail(j).filter((m) => /^Files sent/.test(m.subject));
  assert.equal(copy.length, 1);
  assert.doesNotMatch(copy[0].subject, /missing/);
  await j.approve(j.items[1]);
  assert.equal(filesTo(j.email).length, 1, 'a second click changes nothing');
});

test('a deemed approval counts, through the studio’s checklist write', async () => {
  const j = await job({ invoices: ['single'], links: true });
  await j.pay(j.inv.single);
  await j.approve(j.items[0]);
  j.deem(j.items[1]);
  assert.equal(filesTo(j.email).length, 0);
  // Any checklist write looks again (here, the second item renamed).
  const r = await call(`/api/projects/${j.projectId}/deliverables/${j.items[1].id}?today=${TODAY}`,
    { method: 'PUT', body: { title: 'Cut-down 30s' }, cookie: admin });
  assert.equal(r.status, 200, r.text);
  await settle(j.projectId);
  // Paid and every item approved: the first set goes, with the new title.
  assert.equal(filesTo(j.email).length, 1);
  assert.match(filesTo(j.email)[0].text, /Cut-down 30s/);
});

test('a void invoice doesn’t count; its replacement does', async () => {
  const j = await job({ invoices: ['deposit', 'final'], links: true });
  await j.approve(j.items[0]);
  await j.approve(j.items[1]);
  await j.pay(j.inv.deposit);
  db.prepare("UPDATE invoices SET status = 'void', voided_at = ? WHERE id = ?").run(nowIso(), j.inv.final);
  // A void final leaves only a deposit: not the whole job.
  assert.equal((await release.check(j.projectId)).reason, 'not_paid');
  const fresh = newId('inv');
  db.prepare(`INSERT INTO invoices (id, project_id, kind, number, status, issued_at, created_at, updated_at, replaces_id)
              VALUES (?, ?, 'final', ?, 'sent', '2026-11-20', ?, ?, ?)`).run(fresh, j.projectId, `INV-FR${serialOf(j)}-F2`, nowIso(), nowIso(), j.inv.final);
  const r = await j.pay(fresh);
  assert.equal(r.body.files.sent, true);
  assert.equal(filesTo(j.email).length, 1);
});

test('no client email: the studio is told once, and the files go once an address is added', async () => {
  const j = await job({ invoices: ['single'], email: '' });
  j.deem(j.items[0]);
  j.deem(j.items[1]);
  const view = (await j.invoiceView(j.inv.single)).filesRelease;
  assert.equal(view.email, '');
  const r = await j.pay(j.inv.single);
  assert.equal(r.body.files.reason, 'no_email');
  const told = ownerMail(j).filter((m) => /^Files not sent/.test(m.subject));
  assert.equal(told.length, 1);
  assert.match(told[0].text, /has no email address/);
  await release.runDue();
  await release.runDue();
  assert.equal(ownerMail(j).filter((m) => /^Files not sent/.test(m.subject)).length, 1, 'told once');

  db.prepare('UPDATE clients SET email = ? WHERE id = ?').run('late@kiln.example', j.clientId);
  const pass = await release.runDue();
  assert.ok(pass.sent >= 1);
  assert.equal(filesTo('late@kiln.example').length, 1);
  assert.equal(j.record().status, 'sent');
});

test('a failed send is recorded, retried, and the studio told when it gives up', async () => {
  const j = await job({ invoices: ['single'], links: true });
  j.deem(j.items[0]);
  j.deem(j.items[1]);
  failing = 1;
  const r = await j.pay(j.inv.single);
  assert.equal(r.status, 200, 'the payment is saved whatever the email does');
  assert.equal(r.body.files.reason, 'failed');
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id = ?').pluck().get(j.inv.single), 'paid');
  assert.deepEqual([j.record().status, j.record().attempts], ['failed', 1]);
  assert.ok(db.prepare("SELECT 1 FROM activity WHERE project_id = ? AND kind = 'files_failed'").get(j.projectId));

  await release.runDue();
  assert.equal(filesTo(j.email).length, 1, 'the hourly pass sent it');
  assert.deepEqual([j.record().status, j.record().attempts], ['sent', 2]);

  // A second job whose every try fails.
  const k = await job({ invoices: ['single'], links: true });
  k.deem(k.items[0]);
  k.deem(k.items[1]);
  failing = 1;
  await k.pay(k.inv.single);
  for (let i = 1; i < MAX_ATTEMPTS; i += 1) {
    failing = 1;
    await release.check(k.projectId);
  }
  assert.deepEqual([k.record().status, k.record().attempts], ['gave_up', MAX_ATTEMPTS]);
  assert.equal(filesTo(k.email).length, 0);
  const told = ownerMail(k).filter((m) => /^Files not sent/.test(m.subject));
  assert.equal(told.length, 1);
  assert.match(told[0].text, new RegExp(`failed ${MAX_ATTEMPTS} times`));
  await release.runDue();
  assert.equal(filesTo(k.email).length, 0, 'a set it gave up on stays given up');
});

test('a new Final approved after the files went sends an update', async () => {
  const j = await job({ invoices: ['single'], links: true });
  await j.approve(j.items[0]);
  await j.approve(j.items[1]);
  await j.pay(j.inv.single);
  assert.equal(filesTo(j.email).length, 1);

  const v2 = newId('ver');
  db.prepare(`INSERT INTO deliverable_versions (id, deliverable_id, project_id, n, stage, source_path, file_name, kind, drive_link, created_at, published_at)
              VALUES (?, ?, ?, 2, 'final', ?, 'Hero2.mp4', 'video', ?, ?, ?)`)
    .run(v2, j.items[0].id, j.projectId, `${j.folder}/Hero2.mp4`, `${DRIVE}?v2`, nowIso(), nowIso());
  // Unapproved, the item isn't done: nothing goes.
  assert.equal((await release.check(j.projectId)).reason, 'not_approved');
  await j.approve({ id: j.items[0].id, v: v2 });
  const mails = filesTo(j.email);
  assert.equal(mails.length, 2);
  assert.match(mails[1].subject, /^Updated files/);
  assert.match(mails[1].text, /Hero film \(v2\): https:\/\/drive\.google\.com\/file\/d\/abc123\/view\?v2/);
});

test('a job finished before C10 never sends on its own', async () => {
  const j = await job({ invoices: ['single'], links: true });
  j.deem(j.items[0]);
  j.deem(j.items[1]);
  db.prepare("UPDATE invoices SET status = 'paid', paid_at = '2026-10-01' WHERE id = ?").run(j.inv.single);
  await release.runDue();
  assert.equal(filesTo(j.email).length, 0, 'the hourly pass only retries, it never sweeps old jobs');
});

test('jobs done before C10 are a baseline: a checklist edit sends nothing; a new set later goes as an update', async () => {
  const j = await job({ invoices: ['single'], links: true });
  j.deem(j.items[0]);
  j.deem(j.items[1]);
  db.prepare("UPDATE invoices SET status = 'paid', paid_at = '2026-10-01' WHERE id = ?").run(j.inv.single);
  // A job not yet approved gets no baseline: it sends when it completes, after C10.
  const open = await job({ invoices: ['single'], links: true });
  db.prepare("UPDATE invoices SET status = 'paid', paid_at = '2026-10-01' WHERE id = ?").run(open.inv.single);
  migrateV32(db);
  assert.equal(j.record().status, 'baseline');
  assert.equal(j.record().set_key, releasePlan(db, j.projectId).setKey, 'the migration’s key is the app’s');
  assert.equal(open.record(), undefined);

  const r = await call(`/api/projects/${j.projectId}/deliverables/${j.items[0].id}?today=${TODAY}`,
    { method: 'PUT', body: { title: 'Hero film (final)' }, cookie: admin });
  assert.equal(r.status, 200, r.text);
  await settle(j.projectId);
  assert.equal(filesTo(j.email).length, 0, 'a rename on an old job sends nothing');
  assert.equal((await j.invoiceView(j.inv.single)).filesRelease.baseline, true);

  // A newer Final, approved: the client gets it as an update.
  const v2 = newId('ver');
  db.prepare(`INSERT INTO deliverable_versions (id, deliverable_id, project_id, n, stage, source_path, file_name, kind, drive_link, created_at, published_at)
              VALUES (?, ?, ?, 2, 'final', ?, 'Hero2.mp4', 'video', ?, ?, ?)`)
    .run(v2, j.items[0].id, j.projectId, `${j.folder}/Hero2.mp4`, `${DRIVE}?new`, nowIso(), nowIso());
  await j.approve({ id: j.items[0].id, v: v2 });
  assert.equal(filesTo(j.email).length, 1);
  assert.match(filesTo(j.email)[0].subject, /^Updated files/);
});

test('what the old hub delivered is never sent again', async () => {
  const j = await job({ invoices: ['legacy'], links: true });
  db.prepare("UPDATE deliverables SET hub_status = 'delivered' WHERE project_id = ?").run(j.projectId);
  const view = (await j.invoiceView(j.inv.legacy)).filesRelease;
  assert.deepEqual([view.approved, view.nothingNew], [true, true]);
  const r = await j.pay(j.inv.legacy);
  assert.equal(r.body.files.reason, 'nothing_new');
  assert.equal(filesTo(j.email).length, 0);

  // One item delivered by the hub, one approved since: only the new one goes.
  const k = await job({ invoices: ['legacy'], links: true });
  db.prepare("UPDATE deliverables SET hub_status = 'delivered' WHERE id = ?").run(k.items[0].id);
  await k.approve(k.items[1]);
  await k.pay(k.inv.legacy);
  const mails = filesTo(k.email);
  assert.equal(mails.length, 1);
  assert.doesNotMatch(mails[0].text, /Hero film/);
  assert.match(mails[0].text, /Cut-down \(v1\)/);
});

test('a slow mail server: Mark paid answers “still sending”, and the send carries on', async () => {
  const j = await job({ invoices: ['single'], links: true });
  j.deem(j.items[0]);
  j.deem(j.items[1]);
  slowMs = 600;
  try {
    const r = await j.pay(j.inv.single);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.files.reason, 'sending');
    assert.equal(db.prepare('SELECT status FROM invoices WHERE id = ?').pluck().get(j.inv.single), 'paid');
    await settle(j.projectId);
  } finally {
    slowMs = 0;
  }
  assert.equal(filesTo(j.email).length, 1);
  assert.equal(j.record().status, 'sent');
});

test('a give-up notice that didn’t reach the studio is tried again', async () => {
  const j = await job({ invoices: ['single'], links: true });
  j.deem(j.items[0]);
  j.deem(j.items[1]);
  failing = 1;
  await j.pay(j.inv.single);
  for (let i = 2; i < MAX_ATTEMPTS; i += 1) {
    failing = 1;
    await release.check(j.projectId);
  }
  failing = 2; // the last client try, and the studio's notice
  await release.check(j.projectId);
  assert.deepEqual([j.record().status, j.record().owner_told], ['gave_up', 0]);
  assert.equal(ownerMail(j).filter((m) => /^Files not sent/.test(m.subject)).length, 0);
  await release.runDue();
  assert.equal(ownerMail(j).filter((m) => /^Files not sent/.test(m.subject)).length, 1);
  assert.equal(j.record().owner_told, 1);
  await release.runDue();
  assert.equal(ownerMail(j).filter((m) => /^Files not sent/.test(m.subject)).length, 1, 'once');
  assert.equal(filesTo(j.email).length, 0, 'the client isn’t tried again');
});

test('a client email that isn’t an address is called that, not missing', async () => {
  const j = await job({ invoices: ['single'], email: 'ana@kiln' });
  j.deem(j.items[0]);
  j.deem(j.items[1]);
  const view = (await j.invoiceView(j.inv.single)).filesRelease;
  assert.deepEqual([view.email, view.badEmail], ['', 'ana@kiln']);
  const r = await j.pay(j.inv.single);
  assert.deepEqual([r.body.files.reason, r.body.files.badEmail], ['no_email', 'ana@kiln']);
  const told = ownerMail(j).filter((m) => /^Files not sent/.test(m.subject));
  assert.equal(told.length, 1);
  assert.match(told[0].text, /email address \(ana@kiln\) isn’t a valid address/);
});

test('a job with no needed items has nothing to send, and the dialog says nothing', async () => {
  const j = await job({ invoices: ['single'] });
  db.prepare('UPDATE deliverables SET not_needed_at = ? WHERE project_id = ?').run(nowIso(), j.projectId);
  const view = (await j.invoiceView(j.inv.single)).filesRelease;
  assert.deepEqual([view.needed, view.approved], [0, false]);
  const r = await j.pay(j.inv.single);
  assert.equal(r.body.files.reason, 'not_approved');
  assert.equal(filesTo(j.email).length, 0);
});
