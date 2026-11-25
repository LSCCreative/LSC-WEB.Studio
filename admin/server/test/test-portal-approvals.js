'use strict';

/* Finals, rounds and approval (merged-admin C5), on the real app with the portal
 * mounted: a Draft Cut then a Final on the same item, keeping its history; two
 * rounds per Final, drafts never counting; the rate from the project's signed
 * agreement; CONFIRM APPROVAL recorded with who, when, from where and which file,
 * first write wins; a new file takes the item out of approved and a new item
 * reopens the checklist (S12); and the old hub's sign-off route is gone. A
 * throwaway database and folder. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-portal-approvals-'));
process.env.DATA_DIR = TMP;
process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough-0123456789';
process.env.COOKIE_SECURE = '0';
process.env.NODE_ENV = 'test';

const { openDatabase, nowIso, newId } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');

const PORTAL = 'https://lsccreative.studio';
const DELIVERABLES = path.join(TMP, 'deliverables');
fs.mkdirSync(DELIVERABLES, { recursive: true });
const BACKUPS = path.join(TMP, 'backups');
const hub = {
  signingSecret: 'test-signing-secret', corsOrigins: [PORTAL], publicBaseUrl: 'https://hub.example', appUrl: 'https://app.example/',
  portalUrl: 'https://lsccreative.studio/client-hub-app/', deliverablesDir: DELIVERABLES, backupDir: BACKUPS, bunny: {},
};
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date()); // the server counts Sydney days

let db;
let server;
let base;
let admin;

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

test.before(async () => {
  db = openDatabase(path.join(TMP, 'billing.db'));
  db.prepare('INSERT INTO account (id, username, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?, ?)')
    .run('tester', await hashPassword('a-long-test-password'), nowIso(), nowIso());
  const app = createApp(db, { hub });
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

/* A client's accepted project, signed with `agreement` as its signed text (or Mark
   accepted when null), holding one film: a published Draft Cut v1. Signed in. */
let serial = 0;
async function job({ agreement = 'Further rounds are charged at the Business\'s standard hourly rate of AUD $63.00 following Client approval of a quote.' } = {}) {
  serial += 1;
  const now = nowIso();
  const clientId = newId('cl');
  const email = `ap${serial}@salt.example`;
  db.prepare(`INSERT INTO clients (id, business_name, contact_name, email, created_at, updated_at) VALUES (?, ?, 'Priya Nair', ?, ?, ?)`)
    .run(clientId, `Salt ${serial}`, email, now, now);
  const projectId = newId('prj');
  db.prepare(`INSERT INTO projects (id, upid, client_id, needs_upid, accepted_at, name, created_at, updated_at, opened_at)
              VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`).run(projectId, `AP-${serial}`, clientId, now, `Approval job ${serial}`, now, now, now);
  const estimateId = newId('est');
  db.prepare(`INSERT INTO estimates (id, project_id, upid, name, date, status, client_id, client_json, active_rows_json, totals_json, created_at, updated_at)
              VALUES (?, ?, ?, 'Approval job', '2026-11-01', 'accepted', ?, '{}', '{}', '{}', ?, ?)`).run(estimateId, projectId, `AP-${serial}`, clientId, now, now);
  if (agreement !== null) {
    const ev = newId('ev');
    db.prepare(`INSERT INTO estimate_versions (id, estimate_id, n, snapshot_json, client_view_json, sent_at) VALUES (?, ?, 1, '{}', '{}', ?)`)
      .run(ev, estimateId, now);
    db.prepare(`INSERT INTO signatures (id, version_id, full_name, role, signed_at, agreement_text, agreement_sha256)
                VALUES (?, ?, 'Priya Nair', 'Director', ?, ?, 'x')`).run(newId('sig'), ev, now, agreement);
  }
  const folder = `Job${serial}`;
  fs.mkdirSync(path.join(DELIVERABLES, folder), { recursive: true });
  for (const n of ['Draft.mp4', 'Final.mp4', 'Final2.mp4']) fs.writeFileSync(path.join(DELIVERABLES, folder, n), 'video');
  const film = newId('dlv');
  db.prepare(`INSERT INTO deliverables (id, project_id, position, title, stage, created_at, updated_at) VALUES (?, ?, 1, 'Hero film', 'draft', ?, ?)`)
    .run(film, projectId, now, now);
  const v1 = newId('ver');
  db.prepare(`INSERT INTO deliverable_versions (id, deliverable_id, project_id, n, stage, source_path, file_name, kind, created_at, published_at)
              VALUES (?, ?, ?, 1, 'draft', ?, 'Draft.mp4', 'video', ?, ?)`).run(v1, film, projectId, `${folder}/Draft.mp4`, now, now);

  const issued = await call(`/api/clients/${clientId}/portal`, { method: 'POST', body: {}, cookie: admin });
  const { session } = await call('/hub/auth', { method: 'POST', body: { email, code: issued.body.code } });
  const at = `/hub/projects/${projectId}`;
  const studio = `/api/projects/${projectId}/deliverables/${film}`;
  const folderReply = (r) => {
    assert.equal(r.status, 200, r.text);
    return r.body;
  };
  return {
    clientId, projectId, film, v1, session, folder,
    add: (versionId, text = 'A note', cookie = session) => call(`${at}/items/${film}/notes`, { method: 'POST', body: { versionId, text }, cookie }),
    send: (versionId, cookie = session) => call(`${at}/items/${film}/submit`, { method: 'POST', body: { versionId }, cookie }),
    approve: (versionId, cookie = session, headers = {}) => call(`${at}/items/${film}/approve`, { method: 'POST', body: { versionId }, cookie, headers }),
    view: () => call(at, { cookie: session }).then((r) => r.body.project),
    card: () => call('/hub/projects', { cookie: session }).then((r) => r.body.projects.find((p) => p.id === projectId)),
    studio: () => call(`/api/projects/${projectId}?today=${TODAY}`, { cookie: admin }).then(folderReply),
    /* The studio's own way: flip the item's stage, add the next file, publish it. */
    stage: (stage) => call(`${studio}?today=${TODAY}`, { method: 'PUT', body: { stage }, cookie: admin }).then(folderReply),
    addVersion: (file) => call(`${studio}/versions?today=${TODAY}`, { method: 'POST', body: { path: `${folder}/${file}` }, cookie: admin }).then(folderReply),
    publish: (versionId) => call(`${studio}/versions/${versionId}/publish?today=${TODAY}`, { method: 'POST', body: {}, cookie: admin }).then(folderReply),
    newest: (reply) => reply.deliverables.find((d) => d.id === film).versions.slice(-1)[0],
  };
}
const itemOf = (view, id) => view.deliverables.find((d) => d.id === id);

/* Draft approved, then the studio swaps in the Final: v1 → v2. */
async function toFinal(j) {
  assert.equal((await j.approve(j.v1)).status, 201);
  await j.stage('final');
  const v2 = j.newest(await j.addVersion('Final.mp4')).id;
  await j.publish(v2);
  return v2;
}

test('CONFIRM APPROVAL records who, when, from where and exactly which file; the first write wins', async () => {
  const j = await job();
  await j.stage('final');
  const v2 = j.newest(await j.addVersion('Final.mp4')).id;
  await j.publish(v2);
  const before = Date.now();
  const r = await j.approve(v2, j.session, { 'user-agent': 'TestPhone/1.0', 'x-forwarded-for': '6.6.6.6, 203.0.113.9' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(Object.keys(r.body.approval).sort(), ['approvedAt', 'deemed', 'versionId']);
  assert.ok(Date.parse(r.body.approval.approvedAt) >= before - 1000, 'the server’s clock');
  const rec = db.prepare('SELECT * FROM client_approvals WHERE version_id = ?').get(v2);
  assert.deepEqual(
    [rec.kind, rec.client_id, rec.email, rec.name, rec.stage, rec.version_n, rec.file_name, rec.ip, rec.user_agent],
    ['client', j.clientId, `ap${serial}@salt.example`, 'Priya Nair', 'final', 2, 'Final.mp4', '203.0.113.9', 'TestPhone/1.0'],
    'the hop the tunnel added, never the one the client wrote');

  // Again, from another tab: the same record, unchanged, and still one row.
  const again = await j.approve(v2, j.session, { 'user-agent': 'Other/2.0' });
  assert.deepEqual([again.status, again.body.approval.approvedAt], [200, r.body.approval.approvedAt]);
  assert.equal(db.prepare('SELECT COUNT(*) FROM client_approvals WHERE deliverable_id = ?').pluck().get(j.film), 1);
  assert.equal(db.prepare('SELECT user_agent FROM client_approvals WHERE version_id = ?').pluck().get(v2), 'TestPhone/1.0');
  // An approved version takes no more notes.
  assert.equal((await j.add(v2)).body.error, 'approved');

  // Signed off: the item is approved, and with payment off the project is Complete.
  assert.equal(itemOf(await j.view(), j.film).status, 'approved');
  assert.equal((await j.studio()).project.delivery.badge, 'complete');
  assert.equal((await j.card()).status, 'Complete', 'the dashboard reads it the same way');

  // The studio sees the whole record, and an activity line.
  const studioV = j.newest(await j.studio());
  assert.deepEqual([studioV.approval.email, studioV.approval.fileName, studioV.approval.ip], [`ap${serial}@salt.example`, 'Final.mp4', '203.0.113.9']);
  assert.ok(db.prepare("SELECT 1 FROM activity WHERE project_id = ? AND kind = 'client_approved'").get(j.projectId));
});

test('Cloudflare’s client address is the one recorded, as billing’s signatures do', async () => {
  const j = await job();
  await j.approve(j.v1, j.session, { 'cf-connecting-ip': '198.51.100.77', 'x-forwarded-for': '6.6.6.6' });
  assert.equal(db.prepare('SELECT ip FROM client_approvals WHERE version_id = ?').pluck().get(j.v1), '198.51.100.77');
});

test('approval is refused while notes are unsent, after notes were sent, on an old version, and for anyone else', async () => {
  const j = await job();
  const other = await job();
  assert.equal((await j.approve(j.v1, other.session)).status, 404, 'another client’s is the same not found');
  assert.equal((await j.approve(j.v1, '')).status, 401);
  const evil = await call(`/hub/projects/${j.projectId}/items/${j.film}/approve`,
    { method: 'POST', body: { versionId: j.v1 }, cookie: j.session, headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  assert.equal((await j.approve('ver_nope')).body.error, 'not_current');

  const note = (await j.add(j.v1)).body.note;
  assert.equal((await j.approve(j.v1)).body.error, 'unsent_notes', 'they’d be lost');
  assert.equal((await j.send(j.v1)).status, 200);
  assert.equal((await j.approve(j.v1)).body.error, 'sent', 'the version waits for the studio’s next one');
  assert.ok(note);

  const v2 = j.newest(await j.addVersion('Final.mp4')).id;
  assert.equal((await j.approve(v2)).body.error, 'not_current', 'not published yet');
  await j.publish(v2);
  assert.equal((await j.approve(j.v1)).body.error, 'not_current', 'superseded');
  assert.equal(db.prepare('SELECT COUNT(*) FROM client_approvals WHERE project_id = ?').pluck().get(j.projectId), 0);
});

test('a draft’s approval is kept but signs nothing off; the Final keeps the history and is approved again', async () => {
  const j = await job();
  assert.equal((await j.approve(j.v1)).status, 201);
  // Approved as a draft: with the studio, for the Final; not signed off.
  let item = itemOf(await j.view(), j.film);
  assert.deepEqual([item.status, item.versions[0].approvedAt !== null], ['production', true]);
  assert.equal((await j.studio()).project.delivery.badge, 'in_production');
  assert.equal((await j.studio()).project.delivery.checklist.approved, 0);

  // Draft to Final: the studio flips the stage and swaps in the file. v1 stays a draft.
  await j.stage('final');
  const v2 = j.newest(await j.addVersion('Final.mp4')).id;
  await j.publish(v2);
  item = itemOf(await j.view(), j.film);
  assert.deepEqual(item.versions.map((v) => [v.n, v.stage, Boolean(v.approvedAt)]), [[1, 'draft', true], [2, 'final', false]]);
  assert.equal(item.status, 'review');
  assert.equal((await j.studio()).project.delivery.badge, 'in_review');
});

test('two rounds per Final: drafts never count, the reply and Needs you say which round, a third is flagged', async () => {
  const j = await job();
  await j.add(j.v1, 'draft note');
  assert.deepEqual((await j.send(j.v1)).body.rounds, { included: 2, used: 0 }, 'a draft’s set uses no round');
  await j.stage('final');
  let v = j.newest(await j.addVersion('Final.mp4')).id;
  await j.publish(v);
  assert.deepEqual(itemOf(await j.view(), j.film).rounds, { included: 2, used: 0 });

  const expected = [1, 2, 3];
  for (const n of expected) {
    await j.add(v, `round ${n}`);
    const sent = await j.send(v);
    assert.deepEqual(sent.body.rounds, { included: 2, used: n });
    const row = (await call(`/api/needs?today=${TODAY}`, { cookie: admin })).body.items.find((i) => i.kind === 'revision_notes' && i.itemId === j.film);
    assert.deepEqual([row.round, row.extraRound], [n, n > 2], `round ${n} in Needs you`);
    v = j.newest(await j.addVersion(n % 2 ? 'Final2.mp4' : 'Final.mp4')).id;
    await j.publish(v);
  }
  assert.deepEqual(itemOf(await j.view(), j.film).rounds, { included: 2, used: 3 });
  assert.equal(j.newest(await j.studio()).n, 5);
  assert.equal((await j.studio()).deliverables.find((d) => d.id === j.film).roundsUsed, 3);
});

test('the rate comes from the project’s signed agreement; none signed, none quoted', async () => {
  assert.equal((await (await job()).view()).hourlyRate, '$63.00');
  const reworded = await job({ agreement: 'Extra work: our hourly rate is $1,250.50 per hour, quoted first.' });
  assert.equal((await reworded.view()).hourlyRate, '$1,250.50');
  // Settings' rate today is never used: an agreement that names no amount quotes none.
  assert.equal((await (await job({ agreement: 'No rate is named in this one.' })).view()).hourlyRate, null);
  // Only an amount straight after the words: a travel rate or a deposit nearby is never taken for it.
  const travel = await job({ agreement: 'Charged at our hourly rate, plus travel at $1.20 per km, quoted first.' });
  assert.equal((await travel.view()).hourlyRate, null);
  assert.equal((await (await job({ agreement: null })).view()).hourlyRate, null, 'Mark accepted: no signed agreement');
});

test('a new file takes the item out of approved, and a new item reopens the checklist (S12)', async () => {
  const j = await job();
  const v2 = await toFinal(j);
  assert.equal((await j.approve(v2)).status, 201);
  assert.equal((await j.studio()).project.delivery.badge, 'complete');

  // The studio swaps in another Final: out of approved at once, even before it's published.
  const v3 = j.newest(await j.addVersion('Final2.mp4')).id;
  let studio = await j.studio();
  assert.deepEqual([studio.project.delivery.badge, studio.project.delivery.checklist.approved], ['in_production', 0]);
  // The record of what was approved stays, on its own version.
  assert.ok(db.prepare('SELECT 1 FROM client_approvals WHERE version_id = ?').get(v2));
  // Taking the unpublished file back restores it: the newest is the approved Final again.
  await call(`/api/projects/${j.projectId}/deliverables/${j.film}/versions/${v3}?today=${TODAY}`, { method: 'DELETE', cookie: admin });
  assert.equal((await j.studio()).project.delivery.badge, 'complete');
  const v3b = j.newest(await j.addVersion('Final2.mp4')).id;
  await j.publish(v3b);
  assert.equal((await j.studio()).project.delivery.badge, 'in_review');
  assert.equal(itemOf(await j.view(), j.film).status, 'review');
  assert.equal((await j.approve(v3b)).status, 201, 'the client approves the new file');
  assert.equal((await j.studio()).project.delivery.badge, 'complete');

  // Another deliverable: the checklist is open again.
  await call(`/api/projects/${j.projectId}/deliverables?today=${TODAY}`, { method: 'POST', body: { title: 'Cut-down' }, cookie: admin });
  studio = await j.studio();
  assert.deepEqual([studio.project.delivery.badge, studio.project.delivery.checklist.open], ['in_production', 1]);
});

test('Needs you asks for the final invoice once everything is approved, until one is sent', async () => {
  const j = await job();
  const row = async () => (await call(`/api/needs?today=${TODAY}`, { cookie: admin })).body.items
    .find((i) => i.kind === 'final_invoice' && i.projectId === j.projectId);
  const v2 = await toFinal(j);
  assert.equal(await row(), undefined, 'a draft’s approval isn’t everything approved');
  assert.equal((await j.approve(v2)).status, 201);
  const invoice = (status) => {
    const id = newId('inv');
    db.prepare(`INSERT INTO invoices (id, project_id, kind, number, status, totals_json, created_at, updated_at)
                VALUES (?, ?, 'final', ?, ?, '{}', ?, ?)`).run(id, j.projectId, `AP-F-${id}`, status, nowIso(), nowIso());
    return id;
  };
  let item = await row();
  assert.ok(item, 'everything approved, no final invoice yet');
  assert.deepEqual([item.days, item.invoiceId], [0, undefined]);
  const draft = invoice('draft');
  item = await row();
  assert.equal(item.invoiceId, draft, 'opens the draft final to send');
  db.prepare("UPDATE invoices SET status = 'sent' WHERE id = ?").run(draft);
  assert.equal(await row(), undefined, 'sent: nothing to ask');
  db.prepare("UPDATE invoices SET status = 'void' WHERE id = ?").run(draft);
  assert.ok(await row(), 'a voided one asks again');
  // A new file reopens the checklist: no longer everything approved.
  await j.addVersion('Final2.mp4');
  assert.equal(await row(), undefined);
});

test('the approve reply carries the item’s status as the server reads it', async () => {
  const j = await job();
  const draft = await j.approve(j.v1);
  assert.equal(draft.body.itemStatus, 'production', 'a draft’s approval doesn’t sign the item off');
  await j.stage('final');
  const v2 = j.newest(await j.addVersion('Final.mp4')).id;
  await j.publish(v2);
  // The studio adds a newer file, unpublished, while the client is on v2.
  await j.addVersion('Final2.mp4');
  const r = await j.approve(v2);
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.itemStatus, 'production', 'a newer file means the item isn’t signed off');
  assert.equal(itemOf(await j.view(), j.film).status, r.body.itemStatus, 'the same as a fresh read');
  assert.equal((await j.approve(v2)).body.itemStatus, 'production', 'and on a repeat');
});

test('the final-invoice row is dated by the Final approvals that sign items off, never "today" without one', async () => {
  const j = await job();
  const row = async () => (await call(`/api/needs?today=${TODAY}`, { cookie: admin })).body.items
    .find((i) => i.kind === 'final_invoice' && i.projectId === j.projectId);
  // Signed off on the old hub (R4): no date to give.
  db.prepare("UPDATE deliverables SET hub_status = 'approved' WHERE id = ?").run(j.film);
  const item = await row();
  assert.ok(item);
  assert.deepEqual([item.since, item.days], [null, null]);
});

test('approvals take no backup per write (S16), and the old hub’s sign-off route is gone', async () => {
  const j = await job();
  const backups = () => (fs.existsSync(BACKUPS) ? fs.readdirSync(BACKUPS).length : 0);
  const had = backups();
  assert.equal((await j.approve(j.v1)).status, 201);
  assert.equal(backups(), had);
  const old = await call('/hub/agreement', { method: 'POST', cookie: j.session, body: { projectId: j.projectId } });
  assert.equal(old.status, 404);
});

test('the studio’s record renders every client-written field as text (S8)', async () => {
  const j = await job();
  const evil = '<img src=x onerror="window.__pwned=1">';
  db.prepare('UPDATE clients SET contact_name = ? WHERE id = ?').run(evil, j.clientId);
  await j.approve(j.v1, j.session, { 'user-agent': '<script>window.__pwned=2</script>' });
  const item = (await j.studio()).deliverables.find((d) => d.id === j.film);
  // The admin's own render code, run as the browser runs it (as test-portal-feedback.js does).
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'js', 'views', 'project-deliverables.js'), 'utf8');
  const PD = vm.runInNewContext(`${src}\nProjectDeliverables`, {
    LSCUtil: { esc, today: () => TODAY }, ProjectCard: { dayMonth: () => '25 Nov' },
  });
  const html = PD.clientSetsMarkup(item);
  assert.match(html, /&lt;img src=x onerror=&quot;window.__pwned=1&quot;&gt;/);
  assert.match(html, /&lt;script&gt;window.__pwned=2&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /Draft\.mp4/);
  assert.match(html, /A Draft Cut’s approval: the Final still needs its own\./);
});
