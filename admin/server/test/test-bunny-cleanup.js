'use strict';

/* Taking files off Bunny (Bunny Slice 11), on the real app with the portal mounted,
 * a throwaway database and folder, and a fake Bunny (test/fake-bunny.js):
 *   - the daily cleanup removes a replaced version once the window has passed, and
 *     a deleted one at once, and leaves the current version (an archived project's
 *     too) and a standing approval's; its rows are kept as `expired`;
 *   - a dry run, the default, removes nothing;
 *   - a Republish's old video is removed as a stray once it's old enough;
 *   - Take offline: archived projects only, rows kept as `offline`, the portal reply
 *     carries no Bunny (or NAS) link and says offline, nothing goes to Bunny or the
 *     client meanwhile, unarchiving keeps it offline;
 *   - Bring back online sends the current versions again and says which NAS files
 *     are missing.
 * Nothing here can reach real data, Bunny or the NAS. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-bunny-cleanup-'));
process.env.DATA_DIR = TMP;
process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough-0123456789';
process.env.COOKIE_SECURE = '0';
process.env.NODE_ENV = 'test';

const { openDatabase, nowIso, newId } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');
const { fakeBunny, FAKE_BUNNY_SETTINGS } = require('./fake-bunny');
const { createBunny } = require('../src/hub/bunny');
const sharp = require('sharp');

for (const level of ['log', 'info', 'warn', 'error']) console[level] = () => {};

const DIR = path.join(TMP, 'deliverables');
fs.mkdirSync(DIR, { recursive: true });
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();
const hub = {
  signingSecret: 'test-signing-secret', corsOrigins: ['https://lsccreative.studio'], publicBaseUrl: 'https://hub.example',
  appUrl: 'https://app.example/', portalUrl: 'https://lsccreative.studio/client-hub-app/', deliverablesDir: DIR, bunny: FAKE_BUNNY_SETTINGS,
};
const BUNNY_HOSTS = [FAKE_BUNNY_SETTINGS.streamCdnHost, FAKE_BUNNY_SETTINGS.storageCdnHost];

let db;
let bunny;
let on;
let server;

test.before(async () => {
  db = openDatabase(path.join(TMP, 'billing.db'));
  db.prepare("INSERT INTO account (id, username, password_hash, created_at, updated_at) VALUES (1, 'tester', ?, ?, ?)")
    .run(await hashPassword('a-long-test-password'), nowIso(), nowIso());
  bunny = fakeBunny();
  const app = createApp(db, {
    hub, deliverablesDir: DIR, bunnyFetch: bunny.fetchImpl, videoLookupGapMs: 1, bunnyCleanup: { mode: 'dry', retentionDays: 90 },
  });
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
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
  on = { call, admin, publisher, settled: () => publisher.masterJobs() };
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

/* A client's accepted project with one item, the client signed in to the portal.
   add(stage) puts a new video on the NAS and adds it as the next version. */
let serial = 0;
async function job() {
  serial += 1;
  const now = nowIso();
  const clientId = newId('cl');
  const email = `cu${serial}@salt.example`;
  db.prepare("INSERT INTO clients (id, business_name, contact_name, email, created_at, updated_at) VALUES (?, ?, 'Priya Nair', ?, ?, ?)")
    .run(clientId, `Salt ${serial}`, email, now, now);
  const projectId = newId('prj');
  db.prepare(`INSERT INTO projects (id, upid, client_id, needs_upid, accepted_at, name, created_at, updated_at, opened_at)
              VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`).run(projectId, `CU-${serial}`, clientId, now, `Film ${serial}`, now, now, now);
  const estimateId = newId('est');
  db.prepare(`INSERT INTO estimates (id, project_id, upid, name, date, status, client_id, client_json, active_rows_json, totals_json, created_at, updated_at)
              VALUES (?, ?, ?, 'Film', '2026-11-01', 'accepted', ?, '{}', '{}', '{}', ?, ?)`).run(estimateId, projectId, `CU-${serial}`, clientId, now, now);
  const item = newId('dlv');
  db.prepare(`INSERT INTO deliverables (id, project_id, position, title, stage, estimate_id, quote_line_id, created_at, updated_at)
              VALUES (?, ?, 1, 'Hero film', 'draft', ?, 'line', ?, ?)`).run(item, projectId, estimateId, now, now);
  fs.mkdirSync(path.join(DIR, `Film${serial}`), { recursive: true });
  const issued = await on.call(`/api/clients/${clientId}/portal`, { method: 'POST', body: {}, cookie: on.admin });
  const session = (await on.call('/hub/auth', { method: 'POST', body: { email, code: issued.body.code } })).cookie;
  const studio = `/api/projects/${projectId}/deliverables/${item}`;
  let files = 0;
  const j = {
    projectId, item, session,
    /* The next version: a new file on the NAS, added, sent to Bunny, and published unless asked not to. */
    async add({ stage = 'draft', publish = true } = {}) {
      files += 1;
      db.prepare('UPDATE deliverables SET stage = ? WHERE id = ?').run(stage, item);
      const rel = `Film${serial}/Cut ${files}.mp4`;
      fs.writeFileSync(path.join(DIR, rel), crypto.randomBytes(64 * 1024));
      const r = await on.call(`${studio}/versions?today=${TODAY}`, { method: 'POST', body: { path: rel }, cookie: on.admin });
      assert.equal(r.status, 200, r.text);
      const v = r.body.deliverables.find((d) => d.id === item).versions.slice(-1)[0];
      const sent = await on.call(`${studio}/versions/${v.id}/bunny`, { method: 'POST', body: {}, cookie: on.admin });
      assert.equal(sent.body.status, 'ready', sent.text);
      await on.settled();
      if (publish) {
        const p = await on.call(`${studio}/versions/${v.id}/publish?today=${TODAY}`, { method: 'POST', body: {}, cookie: on.admin });
        assert.equal(p.status, 200, p.text);
      }
      return { id: v.id, n: v.n, file: path.join(DIR, rel) };
    },
    row: (versionId, kind = 'video') => db.prepare('SELECT * FROM bunny_assets WHERE version_id = ? AND kind = ?').get(versionId, kind),
    portal: () => on.call(`/hub/projects/${projectId}`, { cookie: session }),
    folder: () => on.call(`/api/projects/${projectId}?today=${TODAY}`, { cookie: on.admin }),
    offline: () => on.call(`/api/projects/${projectId}/files-offline?today=${TODAY}`, { method: 'POST', body: {}, cookie: on.admin }),
    online: () => on.call(`/api/projects/${projectId}/files-online?today=${TODAY}`, { method: 'POST', body: {}, cookie: on.admin }),
    archive: () => db.prepare('UPDATE projects SET archived_at = ? WHERE id = ?').run(nowIso(), projectId),
    unarchive: () => db.prepare('UPDATE projects SET archived_at = NULL WHERE id = ?').run(projectId),
    publishedAt: (versionId, at) => db.prepare('UPDATE deliverable_versions SET published_at = ?, created_at = ? WHERE id = ?').run(at, at, versionId),
    studio,
  };
  return j;
}

const hasVideo = (id) => bunny.state.videos.some((v) => v.guid === id);
const removedIds = (result) => result.versions.filter((v) => v.removed).map((v) => v.versionId);

test('the cleanup removes a draft replaced past the window, keeps the current version, and keeps the row as expired', async () => {
  const j = await job();
  const v1 = await j.add({ stage: 'draft' });
  const v2 = await j.add({ stage: 'final' });
  const video1 = j.row(v1.id).bunny_video_id;

  // Replaced 10 days ago: inside the window, so it stays.
  j.publishedAt(v1.id, daysAgo(120));
  j.publishedAt(v2.id, daysAgo(10));
  assert.ok(!removedIds(await on.publisher.cleanup.run({ dryRun: false })).includes(v1.id));
  assert.ok(hasVideo(video1));

  // Replaced 100 days ago: gone from Bunny, the row kept as a record.
  j.publishedAt(v2.id, daysAgo(100));
  const result = await on.publisher.cleanup.run({ dryRun: false });
  assert.ok(removedIds(result).includes(v1.id));
  assert.ok(!removedIds(result).includes(v2.id), 'the current version stays');
  assert.ok(!hasVideo(video1));
  assert.ok(hasVideo(j.row(v2.id).bunny_video_id));
  const row = j.row(v1.id);
  assert.equal(row.status, 'expired');
  assert.ok(row.removed_at);
  assert.equal(row.bunny_video_id, video1, 'the record says which video it was');

  // The client's reply still lists v1, now from the NAS; the Final plays from Bunny.
  const portal = (await j.portal()).body.project.deliverables[0].versions;
  assert.equal(portal.find((v) => v.id === v1.id).review.type, 'file');
  assert.equal(portal.find((v) => v.id === v2.id).review.type, 'hls');

  // A late webhook about the deleted video changes nothing.
  assert.equal(await on.publisher.applyWebhook({ VideoLibraryId: 'lib1', VideoGuid: video1, Status: 32 }), 'ignored');
  assert.equal(j.row(v1.id).status, 'expired');
});

test('a dry run, the default, removes nothing and says what it would', async () => {
  const j = await job();
  const v1 = await j.add();
  const v2 = await j.add({ stage: 'final' });
  j.publishedAt(v1.id, daysAgo(200));
  j.publishedAt(v2.id, daysAgo(150));
  const result = await on.publisher.cleanup.run();
  assert.equal(result.dryRun, true);
  const entry = result.versions.find((v) => v.versionId === v1.id);
  assert.ok(entry, 'it is listed');
  assert.equal(entry.removed, false);
  assert.match(entry.reason, /replaced by v2/);
  assert.equal(j.row(v1.id).status, 'ready');
  assert.ok(hasVideo(j.row(v1.id).bunny_video_id));
});

test('an archived project’s current version stays however old, and so does an approved version the client still has', async () => {
  const archived = await job();
  const only = await archived.add({ stage: 'final' });
  archived.publishedAt(only.id, daysAgo(400));
  archived.archive();

  const approved = await job();
  const draft = await approved.add({ stage: 'draft' });
  const next = await approved.add({ stage: 'final', publish: false });
  approved.publishedAt(draft.id, daysAgo(300));
  db.prepare('UPDATE deliverable_versions SET created_at = ? WHERE id = ?').run(daysAgo(200), next.id);
  db.prepare(`INSERT INTO client_approvals (id, project_id, deliverable_id, version_id, kind, stage, version_n, approved_at)
              VALUES (?, ?, ?, ?, 'deemed', 'draft', ?, ?)`).run(newId('ca'), approved.projectId, approved.item, draft.id, draft.n, daysAgo(290));

  const result = await on.publisher.cleanup.run({ dryRun: false });
  for (const id of [only.id, draft.id, next.id]) assert.ok(!removedIds(result).includes(id), id);
  assert.equal(archived.row(only.id).status, 'ready');
  assert.equal(approved.row(draft.id).status, 'ready');
  const past = (await archived.portal()).body.project;
  assert.equal(past.past, true);
  assert.equal(past.deliverables[0].versions[0].review.type, 'hls', 'Past projects keep their files');
});

test('a version deleted before the client had it comes off Bunny at the next run', async () => {
  const j = await job();
  await j.add();
  const extra = await j.add({ publish: false });
  const video = j.row(extra.id).bunny_video_id;
  const removed = await on.call(`${j.studio}/versions/${extra.id}?today=${TODAY}`, { method: 'DELETE', cookie: on.admin });
  assert.equal(removed.status, 200, removed.text);
  const result = await on.publisher.cleanup.run({ dryRun: false });
  const entry = result.versions.find((v) => v.versionId === extra.id);
  assert.match(entry.reason, /deleted/);
  assert.ok(!hasVideo(video));
  assert.equal(j.row(extra.id).status, 'expired');
});

test('a Republish’s old video is removed as a stray once it is older than the window', async () => {
  const j = await job();
  const v1 = await j.add();
  const v2 = await j.add({ publish: false });
  bunny.state.clock = () => new Date(Date.now() - 100 * DAY);
  const old = j.row(v2.id).bunny_video_id;
  // The old video was uploaded "100 days ago": re-date it, then republish.
  bunny.state.videos.find((v) => v.guid === old).dateUploaded = daysAgo(100);
  bunny.state.clock = () => new Date();
  fs.utimesSync(v2.file, new Date(), new Date(Date.now() + 60_000));
  const again = await on.call(`${j.studio}/versions/${v2.id}/bunny`, { method: 'POST', body: { force: true }, cookie: on.admin });
  assert.equal(again.body.status, 'ready', again.text);
  const now = j.row(v2.id).bunny_video_id;
  assert.notEqual(now, old);
  assert.ok(hasVideo(old), 'a Republish leaves the old video for cleanup');

  const result = await on.publisher.cleanup.run({ dryRun: false });
  assert.ok(result.strays.some((s) => s.removed && s.what.includes(old)));
  assert.ok(!hasVideo(old));
  assert.ok(hasVideo(now));
  assert.ok(hasVideo(j.row(v1.id).bunny_video_id));
});

test('Take offline: archived only; the files leave Bunny, the rows stay, and the client is told they’re offline', async () => {
  const j = await job();
  const v1 = await j.add({ stage: 'draft' });
  const v2 = await j.add({ stage: 'final' });
  await on.settled();
  assert.equal(j.row(v2.id, 'master').status, 'ready', 'a Final’s master is on Bunny Storage');
  const collection = db.prepare('SELECT collection_id FROM bunny_collections WHERE project_id = ?').pluck().get(j.projectId);
  const videos = [j.row(v1.id).bunny_video_id, j.row(v2.id).bunny_video_id];

  const notYet = await j.offline();
  assert.equal(notYet.status, 409);
  assert.equal(notYet.body.error, 'not_archived');

  j.archive();
  const r = await j.offline();
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.offline, { removed: 2, error: null });
  assert.ok(r.body.project.filesOfflineAt);
  for (const id of videos) assert.ok(!hasVideo(id));
  assert.ok(!bunny.state.collections.some((c) => c.guid === collection), 'the collection is gone');
  assert.ok(![...bunny.state.storage.keys()].some((k) => k.startsWith(`${j.projectId}/`)), 'nothing left in storage');
  assert.equal(db.prepare('SELECT COUNT(*) FROM bunny_collections WHERE project_id = ?').pluck().get(j.projectId), 0);
  for (const [id, kind] of [[v1.id, 'video'], [v2.id, 'video'], [v2.id, 'master']]) {
    const row = j.row(id, kind);
    assert.equal(row.status, 'offline', `${id} ${kind}`);
    assert.ok(row.removed_at);
  }
  const logged = db.prepare("SELECT COUNT(*) FROM activity WHERE project_id = ? AND kind = 'files_offline'").pluck().get(j.projectId);
  assert.equal(logged, 1);

  // The portal: still listed under Past projects, every version offline, no link at all.
  const portal = await j.portal();
  assert.equal(portal.body.project.filesOffline, true);
  for (const v of portal.body.project.deliverables[0].versions) assert.deepEqual(v.review, { type: 'offline' });
  for (const host of BUNNY_HOSTS) assert.ok(!portal.text.includes(host), `no ${host} link`);
  assert.ok(!portal.text.includes('/review'), 'no NAS link either');
  const nas = await on.call(`/hub/projects/${j.projectId}/versions/${v2.id}/review`, { cookie: j.session });
  assert.equal(nas.status, 404);

  // Again is safe; unarchived, it stays offline, and nothing goes to Bunny or the client.
  assert.equal((await j.offline()).status, 200);
  j.unarchive();
  assert.equal((await j.portal()).body.project.filesOffline, true);
  const send = await on.call(`${j.studio}/versions/${v2.id}/bunny`, { method: 'POST', body: {}, cookie: on.admin });
  assert.equal(send.status, 409);
  assert.equal(send.body.error, 'files_offline');
  const v3 = await on.call(`${j.studio}/versions?today=${TODAY}`, { method: 'POST', body: { path: path.relative(DIR, v2.file) }, cookie: on.admin });
  const newest = v3.body.deliverables[0].versions.slice(-1)[0];
  const pub = await on.call(`${j.studio}/versions/${newest.id}/publish?today=${TODAY}`, { method: 'POST', body: {}, cookie: on.admin });
  assert.equal(pub.status, 409);
  assert.equal(pub.body.error, 'files_offline');
  await on.call(`${j.studio}/versions/${newest.id}?today=${TODAY}`, { method: 'DELETE', cookie: on.admin });

  // The cleanup leaves an offline project's rows as they are.
  await on.publisher.cleanup.run({ dryRun: false });
  assert.equal(j.row(v2.id).status, 'offline');
});

test('Take offline waits while something is still going to Bunny', async () => {
  const j = await job();
  const v1 = await j.add();
  j.archive();
  db.prepare("UPDATE bunny_assets SET status = 'processing' WHERE version_id = ?").run(v1.id);
  const r = await j.offline();
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'bunny_busy');
  assert.equal(db.prepare('SELECT files_offline_at FROM projects WHERE id = ?').pluck().get(j.projectId), null);
  db.prepare("UPDATE bunny_assets SET status = 'ready' WHERE version_id = ?").run(v1.id);
});

test('a Take offline Bunny stops partway says so, and sending it again finishes it', async () => {
  const j = await job();
  const v1 = await j.add();
  j.archive();
  const id = j.row(v1.id).bunny_video_id;
  bunny.state.failDelete = (what) => what === `video:${id}`;
  const r = await j.offline();
  assert.equal(r.status, 200);
  assert.match(r.body.offline.error, /delete hiccup/);
  assert.ok(r.body.project.filesOfflineAt, 'the client already sees it offline');
  assert.equal(j.row(v1.id).status, 'ready', 'not marked offline while its video is still there');
  bunny.state.failDelete = null;
  const again = await j.offline();
  assert.deepEqual(again.body.offline, { removed: 1, error: null });
  assert.equal(j.row(v1.id).status, 'offline');
  assert.ok(!hasVideo(id));
});

test('Bring back online sends the current versions again, and says which NAS files are missing', async () => {
  const j = await job();
  const v1 = await j.add({ stage: 'draft' });
  const v2 = await j.add({ stage: 'final' });
  await on.settled();
  // A second item whose file has since gone from the NAS.
  const now = nowIso();
  const other = newId('dlv');
  db.prepare(`INSERT INTO deliverables (id, project_id, position, title, stage, created_at, updated_at)
              VALUES (?, ?, 2, 'Cutdown', 'final', ?, ?)`).run(other, j.projectId, now, now);
  const rel = path.join(path.dirname(path.relative(DIR, v2.file)), 'Cutdown.mp4');
  fs.writeFileSync(path.join(DIR, rel), crypto.randomBytes(1024));
  const added = await on.call(`/api/projects/${j.projectId}/deliverables/${other}/versions?today=${TODAY}`, { method: 'POST', body: { path: rel }, cookie: on.admin });
  const cut = added.body.deliverables.find((d) => d.id === other).versions[0];
  await on.call(`/api/projects/${j.projectId}/deliverables/${other}/versions/${cut.id}/bunny`, { method: 'POST', body: {}, cookie: on.admin });
  await on.call(`/api/projects/${j.projectId}/deliverables/${other}/versions/${cut.id}/publish?today=${TODAY}`, { method: 'POST', body: {}, cookie: on.admin });
  await on.settled();

  j.archive();
  assert.equal((await j.offline()).status, 200);
  fs.rmSync(path.join(DIR, rel));

  const r = await j.online();
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.project.filesOfflineAt, null);
  assert.deepEqual(r.body.online.sent.map((s) => [s.title, s.n]), [['Hero film', v2.n]]);
  assert.deepEqual(r.body.online.missing.map((s) => [s.title, s.n, s.fileName]), [['Cutdown', 1, 'Cutdown.mp4']]);
  assert.match(r.body.online.missing[0].reason, /isn’t on the NAS/);
  await on.settled();

  // Only the current version went again: the draft it replaced stays offline (the client sees it from the NAS).
  assert.equal(j.row(v2.id).status, 'ready');
  assert.ok(hasVideo(j.row(v2.id).bunny_video_id));
  assert.equal(j.row(v2.id, 'master').status, 'ready', 'the Final’s master goes back too');
  assert.equal(j.row(v1.id).status, 'offline');
  const portal = await j.portal();
  assert.equal(portal.body.project.filesOffline, false);
  const versions = portal.body.project.deliverables.find((d) => d.id === j.item).versions;
  assert.equal(versions.find((v) => v.id === v2.id).review.type, 'hls');
  assert.equal(versions.find((v) => v.id === v1.id).review.type, 'file');
  assert.equal(db.prepare("SELECT COUNT(*) FROM activity WHERE project_id = ? AND kind = 'files_online'").pluck().get(j.projectId), 1);

  // Brought back, it can go offline again.
  assert.deepEqual((await j.offline()).body.offline.error, null);
});

/* Files in the fake's storage under a folder, as their names there. */
const storedUnder = (prefix) => [...bunny.state.storage.keys()].filter((k) => k.startsWith(prefix));
const ageStorage = (prefix, days) => {
  for (const [k, f] of bunny.state.storage) if (k.startsWith(prefix)) f.changedAt = daysAgo(days);
};

test('a Take offline that stops after the versions are off stays unfinished until another try gets the rest', async () => {
  const j = await job();
  const v1 = await j.add();
  j.archive();
  const collection = db.prepare('SELECT collection_id FROM bunny_collections WHERE project_id = ?').pluck().get(j.projectId);
  bunny.state.failDelete = (what) => what === `collection:${collection}`;
  const r = await j.offline();
  assert.match(r.body.offline.error, /delete hiccup/);
  assert.equal(j.row(v1.id).status, 'offline', 'the version itself is off');
  assert.match(r.body.project.filesOfflineLeft, /delete hiccup/, 'the folder says it isn’t finished');
  assert.ok(bunny.state.collections.some((c) => c.guid === collection));
  bunny.state.failDelete = null;
  const again = await j.offline();
  assert.equal(again.body.offline.error, null);
  assert.equal(again.body.project.filesOfflineLeft, null);
  assert.ok(!bunny.state.collections.some((c) => c.guid === collection));
});

test('Take offline and Bring back online never run at once on one project', async () => {
  const j = await job();
  await j.add();
  j.archive();
  assert.equal((await j.offline()).status, 200);
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(j.projectId);
  const back = on.publisher.bringOnline(p); // not awaited: still going
  const twice = await on.publisher.bringOnline(p);
  assert.equal(twice.refusal && twice.refusal[1], 'bunny_busy', 'nor a second Bring back online');
  const meanwhile = await on.publisher.takeOffline(p);
  assert.equal(meanwhile.refusal && meanwhile.refusal[1], 'bunny_busy', 'no Take offline meanwhile');
  assert.equal((await back).sent.length, 1);
  await on.settled();
});

test('Bring back online with the NAS away changes nothing and answers a 409, never a 5xx', async () => {
  const j = await job();
  await j.add();
  j.archive();
  await j.offline();
  fs.chmodSync(DIR, 0o000);
  let r;
  try {
    r = await j.online();
  } finally {
    fs.chmodSync(DIR, 0o755);
  }
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'nas_unreachable');
  assert.ok(db.prepare('SELECT files_offline_at FROM projects WHERE id = ?').pluck().get(j.projectId), 'still offline');
});

test('Take offline with Bunny not set up refuses with a 409', async () => {
  const j = await job();
  j.archive();
  const ready = on.publisher.ready;
  Object.defineProperty(on.publisher, 'ready', { value: false, configurable: true, writable: true });
  try {
    const r = await j.offline();
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'bunny_not_set_up');
  } finally {
    on.publisher.ready = ready;
  }
});

test('photos taken out of a library sent again are removed as strays once old; the rest stay', async () => {
  const j = await job();
  const folder = path.join(DIR, `Film${serial}`, 'Stills');
  fs.mkdirSync(folder, { recursive: true });
  for (const name of ['a.jpg', 'b.jpg', 'c.png']) {
    const img = sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 120, g: 90, b: 60 } } });
    fs.writeFileSync(path.join(folder, name), await (name.endsWith('.png') ? img.png() : img.jpeg()).toBuffer());
  }
  const rel = path.relative(DIR, folder);
  const added = await on.call(`${j.studio}/versions?today=${TODAY}`, { method: 'POST', body: { path: rel }, cookie: on.admin });
  const v = added.body.deliverables[0].versions.slice(-1)[0];
  const send = (body) => on.call(`${j.studio}/versions/${v.id}/bunny`, { method: 'POST', body, cookie: on.admin });
  await send({});
  await on.publisher.photoJobs();
  const row = j.row(v.id, 'photos');
  assert.equal(row.status, 'ready');
  const base = `${row.storage_path}/`;
  assert.equal(storedUnder(base).length, 9, 'three photos, three copies each');

  fs.rmSync(path.join(folder, 'c.png'));
  fs.utimesSync(folder, new Date(), new Date(Date.now() + 60_000));
  await send({ force: true });
  await on.publisher.photoJobs();
  assert.equal(storedUnder(base).length, 9, 'a photo taken out stays on Bunny until cleanup');
  ageStorage(base, 100);
  const result = await on.publisher.cleanup.run({ dryRun: false });
  const strays = result.strays.filter((x) => x.what.includes(row.storage_path));
  assert.equal(strays.length, 3);
  assert.ok(strays.every((x) => x.removed && x.what.includes('c.png')));
  assert.deepEqual(storedUnder(base).map((k) => k.split('/').pop()).sort(), ['a.jpg', 'a.jpg', 'a.jpg', 'b.jpg', 'b.jpg', 'b.jpg']);
});

test('a Republish’s old master folder is removed as a stray once old; the current one stays', async () => {
  const j = await job();
  const v1 = await j.add({ stage: 'final', publish: false });
  const first = j.row(v1.id, 'master');
  assert.equal(first.status, 'ready');
  fs.utimesSync(v1.file, new Date(), new Date(Date.now() + 60_000));
  const again = await on.call(`${j.studio}/versions/${v1.id}/bunny`, { method: 'POST', body: { force: true }, cookie: on.admin });
  assert.equal(again.status, 200, again.text);
  await on.settled();
  const now = j.row(v1.id, 'master');
  assert.notEqual(now.publish_tag, first.publish_tag);
  const old = `${first.storage_path}/master-${first.publish_tag}/`;
  assert.ok(storedUnder(old).length);
  ageStorage(old, 100);
  const result = await on.publisher.cleanup.run({ dryRun: false });
  assert.ok(result.strays.some((x) => x.removed && x.what.includes(`master-${first.publish_tag}`)));
  assert.equal(storedUnder(old).length, 0);
  assert.ok(storedUnder(`${now.storage_path}/master-${now.publish_tag}/`).length, 'the current master stays');
});

test('a deleted project’s files, collection and storage all come off Bunny', async () => {
  const j = await job();
  const v1 = await j.add({ stage: 'final', publish: false });
  const collection = db.prepare('SELECT collection_id FROM bunny_collections WHERE project_id = ?').pluck().get(j.projectId);
  const video = j.row(v1.id).bunny_video_id;
  assert.ok(storedUnder(`${j.projectId}/`).length, 'its master is in storage');
  // Gone as a project and its checklist would be: the Bunny rows have no foreign keys, so they stay.
  db.pragma('foreign_keys = OFF');
  try {
    db.prepare('DELETE FROM deliverable_versions WHERE deliverable_id = ?').run(j.item);
    db.prepare('DELETE FROM deliverables WHERE id = ?').run(j.item);
    db.prepare('DELETE FROM projects WHERE id = ?').run(j.projectId);
  } finally {
    db.pragma('foreign_keys = ON');
  }
  const result = await on.publisher.cleanup.run({ dryRun: false });
  assert.match(result.versions.find((x) => x.versionId === v1.id).reason, /project was deleted/);
  assert.ok(result.strays.some((x) => x.removed && x.what.includes(j.projectId)));
  assert.ok(!hasVideo(video));
  assert.ok(!bunny.state.collections.some((c) => c.guid === collection));
  assert.equal(storedUnder(`${j.projectId}/`).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM bunny_collections WHERE project_id = ?').pluck().get(j.projectId), 0);
  assert.equal(j.row(v1.id).status, 'expired');
});

test('a storage folder delete never takes the zone root', async () => {
  const client = createBunny(FAKE_BUNNY_SETTINGS, { fetchImpl: bunny.fetchImpl });
  for (const p of ['', '/', '//']) await assert.rejects(client.deleteObject(p, { folder: true }), /root/);
  assert.ok(bunny.state.storage.size > 0, 'nothing was deleted');
});
