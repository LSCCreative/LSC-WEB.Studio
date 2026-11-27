'use strict';

/* A Final video's master to Bunny Edge Storage (Bunny Slice 8), on the real app with
 * the portal mounted, a throwaway database and folder, and a fake Bunny
 * (test/fake-bunny.js):
 *   - publishing a Final to Stream also sends its untouched master, in the
 *     background, under a random master-<tag>/ folder; a Draft Cut never does;
 *   - a failed master is sent again by a plain publish, into the same folder;
 *   - a restart resumes it, and a master Bunny already holds isn't sent twice;
 *   - a file saved over while it goes up is sent again, once;
 *   - a Republish sends the new file to a new folder;
 *   - the link goes only into C10's paid email: never the client's portal reply.
 * Nothing here can reach real data, Bunny or the NAS. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-bunny-masters-'));
process.env.DATA_DIR = TMP;
process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough-0123456789';
process.env.COOKIE_SECURE = '0';
process.env.NODE_ENV = 'test';

const { openDatabase, nowIso, newId } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');
const { releasePlan } = require('../src/files-release');
const { filesReadyEmail, filesSentOwnerEmail } = require('../src/mail');
const { fakeBunny, FAKE_BUNNY_SETTINGS } = require('./fake-bunny');

for (const level of ['log', 'warn', 'error']) console[level] = () => {};

const DIR = path.join(TMP, 'deliverables');
fs.mkdirSync(DIR, { recursive: true });
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
const CDN = `https://${FAKE_BUNNY_SETTINGS.storageCdnHost}`;
const DRIVE = 'https://drive.google.com/file/d/abc123/view';
const hub = {
  signingSecret: 'test-signing-secret', corsOrigins: ['https://lsccreative.studio'], publicBaseUrl: 'https://hub.example',
  appUrl: 'https://app.example/', portalUrl: 'https://lsccreative.studio/client-hub-app/', deliverablesDir: DIR, bunny: FAKE_BUNNY_SETTINGS,
};

let db;
let bunny;
let on;
const servers = [];

/* One running app over the shared database, signed in as the studio: `start` again is a restart. */
async function start() {
  const app = createApp(db, { hub, deliverablesDir: DIR, bunnyFetch: bunny.fetchImpl, videoLookupGapMs: 1 });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (url, { method = 'GET', body, cookie } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
    const set = res.headers.get('set-cookie') || '';
    return { status: res.status, body: json, text, cookie: set ? set.split(';')[0] : null };
  };
  const admin = (await call('/api/login', { method: 'POST', body: { username: 'tester', password: 'a-long-test-password' } })).cookie;
  const publisher = app.locals.bunnyPublisher;
  /* Every master job this app runs, done (a restart's resume starts on the next tick). */
  const settled = async () => { await new Promise((r) => setImmediate(r)); await publisher.masterJobs(); };
  return { app, call, admin, publisher, settled };
}

test.before(async () => {
  db = openDatabase(path.join(TMP, 'billing.db'));
  db.prepare("INSERT INTO account (id, username, password_hash, created_at, updated_at) VALUES (1, 'tester', ?, ?, ?)")
    .run(await hashPassword('a-long-test-password'), nowIso(), nowIso());
  bunny = fakeBunny();
  on = await start();
});

test.after(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const resetStorage = () => Object.assign(bunny.state, { failPut: null, onPut: null, listFails: false, failFetch: false });
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
const touch = (file, secondsLater = 60) => { const t = new Date(Date.now() + secondsLater * 1000); fs.utimesSync(file, t, t); };
const isMaster = (p) => /\/master-[0-9a-f]{24}\//.test(p);

/* A client's accepted project with one item at `stage`, its video on the NAS, the
   client signed in to the portal. */
let serial = 0;
async function job({ stage = 'final', bytes = crypto.randomBytes(256 * 1024) } = {}) {
  serial += 1;
  const now = nowIso();
  const clientId = newId('cl');
  const email = `ms${serial}@salt.example`;
  db.prepare("INSERT INTO clients (id, business_name, contact_name, email, created_at, updated_at) VALUES (?, ?, 'Priya Nair', ?, ?, ?)")
    .run(clientId, `Salt ${serial}`, email, now, now);
  const projectId = newId('prj');
  db.prepare(`INSERT INTO projects (id, upid, client_id, needs_upid, accepted_at, name, created_at, updated_at, opened_at)
              VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`).run(projectId, `MS-${serial}`, clientId, now, `Film ${serial}`, now, now, now);
  const estimateId = newId('est');
  db.prepare(`INSERT INTO estimates (id, project_id, upid, name, date, status, client_id, client_json, active_rows_json, totals_json, created_at, updated_at)
              VALUES (?, ?, ?, 'Film', '2026-11-01', 'accepted', ?, '{}', '{}', '{}', ?, ?)`).run(estimateId, projectId, `MS-${serial}`, clientId, now, now);
  const item = newId('dlv');
  db.prepare(`INSERT INTO deliverables (id, project_id, position, title, stage, estimate_id, quote_line_id, created_at, updated_at)
              VALUES (?, ?, 1, 'Hero film', ?, ?, 'line', ?, ?)`).run(item, projectId, stage, estimateId, now, now);

  const rel = `Film${serial}/Hero 4K.mov`;
  fs.mkdirSync(path.join(DIR, `Film${serial}`), { recursive: true });
  const file = path.join(DIR, rel);
  fs.writeFileSync(file, bytes);

  const issued = await on.call(`/api/clients/${clientId}/portal`, { method: 'POST', body: {}, cookie: on.admin });
  const session = (await on.call('/hub/auth', { method: 'POST', body: { email, code: issued.body.code } })).cookie;
  const studio = `/api/projects/${projectId}/deliverables/${item}`;
  const r = await on.call(`${studio}/versions?today=${TODAY}`, { method: 'POST', body: { path: rel }, cookie: on.admin });
  assert.equal(r.status, 200, r.text);
  const version = r.body.deliverables.find((d) => d.id === item).versions.slice(-1)[0];
  assert.deepEqual([version.kind, version.stage], ['video', stage]);
  return {
    projectId, item, file, versionId: version.id,
    base: `${projectId}/${item}/${version.id}`,
    toBunny: (body = {}, app = on) => app.call(`${studio}/versions/${version.id}/bunny`, { method: 'POST', body, cookie: app.admin }),
    status: (app = on) => app.call(`${studio}/versions/${version.id}/bunny`, { cookie: app.admin }),
    folder: async () => {
      const f = await on.call(`/api/projects/${projectId}?today=${TODAY}`, { cookie: on.admin });
      return f.body.deliverables.find((d) => d.id === item).versions.find((x) => x.id === version.id);
    },
    publish: () => on.call(`${studio}/versions/${version.id}/publish?today=${TODAY}`, { method: 'POST', body: {}, cookie: on.admin }),
    portal: () => on.call(`/hub/projects/${projectId}`, { cookie: session }),
  };
}
const masterRow = (versionId) => db.prepare("SELECT * FROM bunny_assets WHERE version_id = ? AND kind = 'master'").get(versionId);
const masterPath = (j) => { const row = masterRow(j.versionId); return `${j.base}/master-${row.publish_tag}/Hero 4K.mov`; };
const stored = (p) => bunny.state.storage.get(p);
const masterPuts = (since = 0) => bunny.puts().slice(since).filter(isMaster);

test('a Final sent to Bunny also sends its untouched master, in the background; the folder and status say how far', async () => {
  resetStorage();
  const j = await job();
  const size = fs.statSync(j.file).size;
  const first = await j.toBunny();
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.status, 'ready', 'Stream as before');
  assert.equal(first.body.master.status, 'processing', 'the route answers at once; the master goes behind it');
  assert.equal(first.body.master.progress.total, size * 2, 'read once to check it, once going up');
  await on.settled();

  const row = masterRow(j.versionId);
  assert.equal(row.storage_path, j.base, '/<projectId>/<itemId>/<versionId>');
  assert.match(row.publish_tag, /^[0-9a-f]{24}$/, 'a random folder: Bunny’s links are public until Slice 9');
  const put = stored(masterPath(j));
  assert.ok(put.bytes.equals(fs.readFileSync(j.file)), 'the master, byte for byte');
  assert.equal(put.checksum, sha(fs.readFileSync(j.file)), 'sent with its SHA-256, which Bunny checks');
  const call = bunny.calls.find((c) => c.method === 'PUT' && isMaster(c.path));
  assert.equal(call.key, FAKE_BUNNY_SETTINGS.storagePassword, 'the storage zone’s own key, only in its header');

  const status = await j.status();
  assert.deepEqual(status.body.master, { status: 'ready', error: null, progress: { done: size * 2, total: size * 2 } });
  assert.deepEqual((await j.folder()).master, { status: 'ready', error: null, progress: { done: size * 2, total: size * 2 } });
  assert.equal(on.publisher.masterLink(j.versionId), `${CDN}/${j.base}/master-${row.publish_tag}/Hero%204K.mov`);

  // Publishing again changes nothing: the master is there.
  const before = bunny.puts().length;
  assert.equal((await j.toBunny()).body.master.status, 'ready');
  await on.settled();
  assert.deepEqual(masterPuts(before), [], 'not sent twice');

  // The client's reply: the Stream copy to watch, and no download anywhere (C2).
  assert.equal((await j.publish()).status, 200);
  const portal = await j.portal();
  assert.equal(portal.status, 200, portal.text);
  assert.equal(portal.body.project.deliverables[0].versions[0].review.type, 'hls');
  assert.doesNotMatch(portal.text, /master-|storage|cdn\.example|"master"/i, 'the master’s link and state stay with the studio');
});

test('a Draft Cut never sends a master', async () => {
  resetStorage();
  const j = await job({ stage: 'draft' });
  const before = bunny.puts().length;
  const sent = await j.toBunny();
  assert.equal(sent.status, 200, sent.text);
  assert.deepEqual(sent.body.master, { status: 'none', error: null, progress: { done: 0, total: 0 } });
  await on.settled();
  assert.equal(masterRow(j.versionId), undefined);
  assert.deepEqual(masterPuts(before), []);
  assert.equal((await j.folder()).master, null);
  assert.equal(on.publisher.masterLink(j.versionId), null);
});

test('a master Bunny refuses fails on its own, Stream untouched; a plain publish sends it again into the same folder', async () => {
  resetStorage();
  bunny.state.failPut = (p) => isMaster(p);
  const j = await job();
  await j.toBunny();
  await on.settled();
  const failed = await j.status();
  assert.equal(failed.body.status, 'ready', 'the video plays from Stream whatever the master did');
  assert.equal(failed.body.master.status, 'failed');
  assert.match(failed.body.master.error, /Bunny Storage refused the upload \(500\)/);
  assert.equal(on.publisher.masterLink(j.versionId), null, 'no link to a master that isn’t there');
  const tag = masterRow(j.versionId).publish_tag;
  // Needs you's Publish failed is about what the client watches: a master isn't counted.
  const needs = await on.call(`/api/needs?today=${TODAY}`, { cookie: on.admin });
  assert.ok(!JSON.stringify(needs.body || {}).includes(`publish_failed:${j.versionId}`));

  resetStorage();
  const again = await j.toBunny();
  assert.equal(again.body.master.status, 'processing');
  await on.settled();
  assert.equal((await j.status()).body.master.status, 'ready');
  assert.equal(masterRow(j.versionId).publish_tag, tag, 'a retry keeps its folder');
  assert.ok(stored(masterPath(j)).bytes.equals(fs.readFileSync(j.file)));
});

test('a restart resumes a master, and one Bunny already holds isn’t sent again', async () => {
  resetStorage();
  const j = await job();
  await j.toBunny();
  await on.settled();
  const held = masterPath(j);

  // As if the server stopped after the master landed but before its row said so.
  db.prepare("UPDATE bunny_assets SET status = 'processing', progress_done = 0 WHERE version_id = ? AND kind = 'master'").run(j.versionId);
  let before = bunny.puts().length;
  const restarted = await start();
  await restarted.settled();
  assert.equal(masterRow(j.versionId).status, 'ready');
  assert.deepEqual(masterPuts(before), [], 'the same bytes are on Bunny: not sent twice');

  // Cut off before it landed: it goes up again, from the start.
  db.prepare("UPDATE bunny_assets SET status = 'processing', progress_done = 0 WHERE version_id = ? AND kind = 'master'").run(j.versionId);
  bunny.state.storage.delete(held);
  before = bunny.puts().length;
  const again = await start();
  await again.settled();
  assert.equal(masterRow(j.versionId).status, 'ready');
  assert.deepEqual(masterPuts(before), [held]);
  assert.ok(stored(held).bytes.equals(fs.readFileSync(j.file)));
});

test('a master saved over while it goes up is sent again, once; changing again, it fails', async () => {
  resetStorage();
  const j = await job();
  let saves = 0;
  bunny.state.onPut = async (p) => {
    if (!isMaster(p) || saves >= 1) return;
    saves += 1;
    fs.writeFileSync(j.file, Buffer.from('the fixed cut, saved over the first'));
    touch(j.file, 120);
  };
  await j.toBunny();
  await on.settled();
  assert.equal(masterRow(j.versionId).status, 'ready');
  assert.equal(stored(masterPath(j)).bytes.toString(), 'the fixed cut, saved over the first', 'Bunny has the file as it ended up');
  assert.equal(masterRow(j.versionId).source_size, fs.statSync(j.file).size);

  resetStorage();
  const k = await job();
  let n = 0;
  bunny.state.onPut = async (p) => {
    if (!isMaster(p)) return;
    n += 1;
    fs.writeFileSync(k.file, Buffer.from(`still changing ${n}`));
    touch(k.file, 120 + n * 60);
  };
  await k.toBunny();
  await on.settled();
  const row = masterRow(k.versionId);
  assert.equal(row.status, 'failed');
  assert.match(row.error, /kept changing/);
  assert.equal(n, 2, 'sent twice, then given up');
});

test('a Republish sends the new file to a new folder; the old one stays until cleanup', async () => {
  resetStorage();
  const j = await job();
  await j.toBunny();
  await on.settled();
  const oldPath = masterPath(j);
  fs.writeFileSync(j.file, Buffer.from('a recut, replaced before the client had it'));
  touch(j.file, 300);
  const republished = await j.toBunny({ force: true });
  assert.equal(republished.status, 200, republished.text);
  await on.settled();
  const newPath = masterPath(j);
  assert.notEqual(newPath, oldPath, 'a new address, so the pull zone can’t serve the old file under it');
  assert.equal(stored(newPath).bytes.toString(), 'a recut, replaced before the client had it');
  assert.ok(stored(oldPath), 'the old master stays on Bunny (cleanup, Slice 11)');
});

test('the paid email carries a ready master’s link beside the Drive link; a master landing asks it to look again', async () => {
  resetStorage();
  const j = await job();
  db.prepare('UPDATE deliverable_versions SET drive_link = ? WHERE id = ?').run(DRIVE, j.versionId);
  const plan = () => releasePlan(db, j.projectId, { masterLink: on.publisher.masterLink });
  const keyWithout = plan().setKey;
  assert.equal(releasePlan(db, j.projectId).setKey, keyWithout, 'no master: the set key it had before Slice 8');

  // The paid email's check runs when the master lands.
  const asked = [];
  const real = on.app.locals.filesRelease;
  on.app.locals.filesRelease = { check: (projectId) => { asked.push(projectId); return Promise.resolve({}); } };
  try {
    await j.toBunny();
    await on.settled();
  } finally {
    on.app.locals.filesRelease = real;
  }
  assert.ok(asked.includes(j.projectId), 'the email may now carry the master');

  // Approved, so it is in the plan, with the master's link; the key moves, so an update goes.
  db.prepare(`INSERT INTO client_approvals (id, project_id, deliverable_id, version_id, kind, client_id, stage, version_n, file_name, approved_at)
              SELECT ?, project_id, deliverable_id, id, 'deemed', NULL, stage, n, file_name, ? FROM deliverable_versions WHERE id = ?`)
    .run(newId('ap'), nowIso(), j.versionId);
  db.prepare("UPDATE deliverables SET hub_status = 'approved' WHERE id = ?").run(j.item);
  const files = plan().files;
  assert.equal(files.length, 1);
  assert.equal(files[0].masterLink, on.publisher.masterLink(j.versionId));
  assert.equal(files[0].driveLink, DRIVE);
  assert.notEqual(plan().setKey, releasePlan(db, j.projectId).setKey, 'with the master, a new set');

  const mail = filesReadyEmail({ business: {}, appUrl: '', contactName: 'Priya', projectName: 'Film', files });
  assert.match(mail.text, new RegExp(`Hero film \\(v1\\): ${files[0].masterLink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(mail.text, /Google Drive copy: https:\/\/drive\.google\.com/);
  assert.match(mail.text, /The link downloads the full-quality file\. The Google Drive copy is a backup\./);
  assert.ok(mail.html.includes(`href="${files[0].masterLink}"`) && mail.html.includes(`href="${DRIVE}"`));
  // A master alone is a link: nothing is missing, for the client or the studio.
  const masterOnly = [{ ...files[0], driveLink: '' }];
  assert.doesNotMatch(filesReadyEmail({ business: {}, appUrl: '', files: masterOnly }).text, /separately/);
  assert.doesNotMatch(filesSentOwnerEmail({ business: {}, appUrl: '', to: 'a@b.c', files: masterOnly }).subject, /missing/);
  // Drive only reads as it did before Slice 8.
  assert.match(filesReadyEmail({ business: {}, appUrl: '', files: [{ ...files[0], masterLink: null }] }).text, /The link opens in Google Drive\./);
});
