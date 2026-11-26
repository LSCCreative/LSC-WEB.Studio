'use strict';

/* Publish from the Deliverables tab, play in the portal (Bunny Slice 4), on the real
 * app with the portal mounted, a throwaway database and folder, and a fake Bunny
 * (test/fake-bunny.js):
 *   - with Bunny on, a video's client publish waits until Bunny has it ready, with
 *     the file the NAS holds now; photo libraries aren't held;
 *   - the portal's reply gives a ready version { type: 'hls', url, poster } built
 *     from its row, and every other video (no row, processing, failed, Bunny off)
 *     its NAS link, so old projects play unchanged;
 *   - the row itself stays with the studio.
 * Nothing here can reach real data, Bunny or the NAS. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-bunny-review-'));
process.env.DATA_DIR = TMP;
process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough-0123456789';
process.env.COOKIE_SECURE = '0';
process.env.NODE_ENV = 'test';

const { openDatabase, nowIso, newId } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');
const { fakeBunny, FAKE_BUNNY_SETTINGS } = require('./fake-bunny');

for (const level of ['log', 'warn', 'error']) console[level] = () => {};

const DIR = path.join(TMP, 'deliverables');
fs.mkdirSync(DIR, { recursive: true });
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
const CDN = `https://${FAKE_BUNNY_SETTINGS.streamCdnHost}`;
const hubWith = (bunny) => ({
  signingSecret: 'test-signing-secret', corsOrigins: ['https://lsccreative.studio'], publicBaseUrl: 'https://hub.example',
  appUrl: 'https://app.example/', portalUrl: 'https://lsccreative.studio/client-hub-app/', deliverablesDir: DIR, bunny,
});

let db;
let bunny;
const servers = [];

/* One running app over the shared database, signed in as the studio. */
async function start(bunnySettings) {
  const app = createApp(db, { hub: hubWith(bunnySettings), deliverablesDir: DIR, bunnyFetch: bunny.fetchImpl, videoLookupGapMs: 1 });
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
  return { call, admin };
}

let on;  // Bunny set up
let off; // the same database, Bunny's settings missing

test.before(async () => {
  db = openDatabase(path.join(TMP, 'billing.db'));
  db.prepare("INSERT INTO account (id, username, password_hash, created_at, updated_at) VALUES (1, 'tester', ?, ?, ?)")
    .run(await hashPassword('a-long-test-password'), nowIso(), nowIso());
  bunny = fakeBunny();
  on = await start(FAKE_BUNNY_SETTINGS);
  off = await start({});
});

test.after(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const reset = () => Object.assign(bunny.state, { failFetch: false, listAfter: 0, neverList: false, statusOnFetch: 4, libraryGone: false });

/* A client's accepted project with one quoted film and its folder on the NAS,
   the client signed in to the portal. */
let serial = 0;
async function job() {
  serial += 1;
  const now = nowIso();
  const clientId = newId('cl');
  const email = `rv${serial}@salt.example`;
  db.prepare("INSERT INTO clients (id, business_name, contact_name, email, created_at, updated_at) VALUES (?, ?, 'Priya Nair', ?, ?, ?)")
    .run(clientId, `Salt ${serial}`, email, now, now);
  const projectId = newId('prj');
  db.prepare(`INSERT INTO projects (id, upid, client_id, needs_upid, accepted_at, name, created_at, updated_at, opened_at)
              VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`).run(projectId, `RV-${serial}`, clientId, now, `Review job ${serial}`, now, now, now);
  const estimateId = newId('est');
  db.prepare(`INSERT INTO estimates (id, project_id, upid, name, date, status, client_id, client_json, active_rows_json, totals_json, created_at, updated_at)
              VALUES (?, ?, ?, 'Review job', '2026-11-01', 'accepted', ?, '{}', '{}', '{}', ?, ?)`).run(estimateId, projectId, `RV-${serial}`, clientId, now, now);
  const film = newId('dlv');
  db.prepare("INSERT INTO deliverables (id, project_id, position, title, estimate_id, quote_line_id, created_at, updated_at) VALUES (?, ?, 1, 'Hero film', ?, 'line', ?, ?)")
    .run(film, projectId, estimateId, now, now);
  const folder = `Job${serial}`;
  fs.mkdirSync(path.join(DIR, folder, 'Stills'), { recursive: true });
  fs.writeFileSync(path.join(DIR, folder, 'Hero.mp4'), 'first cut');
  fs.writeFileSync(path.join(DIR, folder, 'Stills', 'a.jpg'), 'a');

  const issued = await on.call(`/api/clients/${clientId}/portal`, { method: 'POST', body: {}, cookie: on.admin });
  const session = (await on.call('/hub/auth', { method: 'POST', body: { email, code: issued.body.code } })).cookie;
  const studio = `/api/projects/${projectId}/deliverables/${film}`;
  const version = (app, id) => `${studio}/versions/${id}`;
  return {
    projectId, film, folder,
    file: (name = 'Hero.mp4') => path.join(DIR, folder, name),
    /* The Deliverables tab's routes, on either app. */
    folderReply: (app = on) => app.call(`/api/projects/${projectId}?today=${TODAY}`, { cookie: app.admin }),
    addVersion: async (file, app = on) => {
      const r = await app.call(`${studio}/versions?today=${TODAY}`, { method: 'POST', body: { path: `${folder}/${file}` }, cookie: app.admin });
      assert.equal(r.status, 200, r.text);
      return r.body.deliverables.find((d) => d.id === film).versions.slice(-1)[0];
    },
    toBunny: (id, body = {}) => on.call(`${version(on, id)}/bunny`, { method: 'POST', body, cookie: on.admin }),
    publish: (id, app = on) => app.call(`${version(app, id)}/publish?today=${TODAY}`, { method: 'POST', body: {}, cookie: app.admin }),
    /* What the client's portal is told about the film's newest version. */
    review: async (app = on) => {
      const r = await app.call(`/hub/projects/${projectId}`, { cookie: session });
      assert.equal(r.status, 200, r.text);
      const item = r.body.project.deliverables.find((d) => d.id === film);
      return { version: item.versions.slice(-1)[0], text: r.text };
    },
  };
}
const fakeVideo = (guid) => bunny.state.videos.find((v) => v.guid === guid);
const rowOf = (versionId) => db.prepare("SELECT * FROM bunny_assets WHERE version_id = ? AND kind = 'video'").get(versionId);

test('with Bunny on, a video goes to the client only once Bunny has it ready', async () => {
  reset();
  const j = await job();
  const v = await j.addVersion('Hero.mp4');
  const folder = (await j.folderReply()).body;
  assert.equal(folder.bunnyOn, true);
  assert.equal(folder.deliverables.find((d) => d.id === j.film).versions[0].bunny, null);

  const first = await j.publish(v.id);
  assert.equal(first.status, 409);
  assert.deepEqual([first.body.error, first.body.message], ['bunny_not_ready', 'Send it to Bunny first: the client watches it from there.']);

  bunny.state.statusOnFetch = 3; // transcoding
  const sent = await j.toBunny(v.id);
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.body.status, 'processing');
  const waiting = await j.publish(v.id);
  assert.deepEqual([waiting.status, waiting.body.error], [409, 'bunny_not_ready']);
  assert.match(waiting.body.message, /still processing/);
  // The folder carries the row's status for the tab: no URL, no key.
  const listed = (await j.folderReply()).body.deliverables.find((d) => d.id === j.film).versions[0].bunny;
  assert.equal(listed.status, 'processing');
  assert.equal(listed.videoId, rowOf(v.id).bunny_video_id);

  // Bunny finishes; the publish's own status read sees it, with no webhook.
  fakeVideo(rowOf(v.id).bunny_video_id).status = 4;
  const published = await j.publish(v.id);
  assert.equal(published.status, 200, published.text);
  assert.ok(published.body.deliverables.find((d) => d.id === j.film).versions[0].publishedAt);

  const { version, text } = await j.review();
  const id = rowOf(v.id).bunny_video_id;
  assert.deepEqual(version.review, { type: 'hls', url: `${CDN}/${id}/playlist.m3u8`, poster: `${CDN}/${id}/thumbnail.jpg` });
  // The row stays the studio's: the portal gets the links built from it, nothing else.
  assert.equal('bunny' in version, false);
  assert.doesNotMatch(text, /"bunny"|videoId|publish_tag|lsc-[0-9a-f]{16}/);
});

test('a failed Bunny publish holds the client publish until it is sent again', async () => {
  reset();
  const j = await job();
  const v = await j.addVersion('Hero.mp4');
  bunny.state.statusOnFetch = 5; // the transcode failed
  const failed = await j.toBunny(v.id);
  assert.deepEqual([failed.status, failed.body.status, failed.body.refused], [200, 'failed', true]);
  const held = await j.publish(v.id);
  assert.deepEqual([held.status, held.body.error], [409, 'bunny_not_ready']);
  assert.match(held.body.message, /Send it to Bunny again/);

  bunny.state.statusOnFetch = 4;
  assert.equal((await j.toBunny(v.id)).body.status, 'ready');
  assert.equal((await j.publish(v.id)).status, 200);
});

test('a NAS file replaced after it went to Bunny holds the publish until it is republished', async () => {
  reset();
  const j = await job();
  const v = await j.addVersion('Hero.mp4');
  assert.equal((await j.toBunny(v.id)).body.status, 'ready');
  const before = rowOf(v.id).bunny_video_id;
  fs.writeFileSync(j.file(), 'a longer second cut');

  const stale = await j.publish(v.id);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'bunny_stale');
  assert.match(stale.body.message, /Bunny has the old cut/);

  const again = await j.toBunny(v.id, { force: true });
  assert.equal(again.body.status, 'ready');
  assert.equal(again.body.sourceChanged, false);
  assert.notEqual(rowOf(v.id).bunny_video_id, before);
  assert.equal((await j.publish(v.id)).status, 200);
  assert.match((await j.review()).version.review.url, new RegExp(`/${rowOf(v.id).bunny_video_id}/playlist\\.m3u8$`));
});

test('a photo library is not held for Bunny', async () => {
  reset();
  const j = await job();
  const v = await j.addVersion('Stills');
  assert.equal(v.kind, 'photos');
  assert.equal((await j.publish(v.id)).status, 200);
  assert.equal((await j.review()).version.review.type, 'photos');
});

test('a video published before Bunny plays from the NAS until its Bunny copy is ready', async () => {
  reset();
  const j = await job();
  // Published on the server without Bunny, as every video before this slice was.
  const v = await j.addVersion('Hero.mp4', off);
  assert.equal((await j.publish(v.id, off)).status, 200);
  const nas = `https://hub.example/hub/projects/${encodeURIComponent(j.projectId)}/versions/${encodeURIComponent(v.id)}/review`;
  assert.deepEqual((await j.review()).version.review, { type: 'file', url: nas });

  bunny.state.statusOnFetch = 3;
  assert.equal((await j.toBunny(v.id)).body.status, 'processing');
  assert.deepEqual((await j.review()).version.review, { type: 'file', url: nas });

  db.prepare("UPDATE bunny_assets SET status = 'failed', error = 'x' WHERE version_id = ?").run(v.id);
  assert.deepEqual((await j.review()).version.review, { type: 'file', url: nas });

  db.prepare("UPDATE bunny_assets SET status = 'ready', error = NULL WHERE version_id = ?").run(v.id);
  assert.equal((await j.review()).version.review.type, 'hls');
});

test('a published version whose NAS file changed since is not sent to Bunny', async () => {
  reset();
  const j = await job();
  const v = await j.addVersion('Hero.mp4', off);
  assert.equal((await j.publish(v.id, off)).status, 200);
  // The editor overwrites the file the client was given (a minute later, to be clear of the publish).
  fs.writeFileSync(j.file(), 'a different edit');
  const later = new Date(Date.now() + 60 * 1000);
  fs.utimesSync(j.file(), later, later);
  const fetchesBefore = bunny.fetches();

  const refused = await j.toBunny(v.id);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'changed_since_published');
  assert.match(refused.body.message, /isn’t the cut they have\. Add it as a new version\./);
  assert.equal(bunny.fetches(), fetchesBefore, 'nothing was pulled');
  assert.equal(rowOf(v.id), undefined);
  assert.equal((await j.review()).version.review.type, 'file');
});

test('with Bunny off nothing is held, and even a ready row plays from the NAS', async () => {
  reset();
  const j = await job();
  const v = await j.addVersion('Hero.mp4', off);
  assert.equal((await j.folderReply(off)).body.bunnyOn, false);
  assert.equal((await j.publish(v.id, off)).status, 200);
  // A row left from when Bunny was set up: without its settings there's no link to build.
  db.prepare(`INSERT INTO bunny_assets (version_id, kind, project_id, item_id, source_path, bunny_video_id, status, created_at, updated_at)
              VALUES (?, 'video', ?, ?, ?, 'vid-left', 'ready', ?, ?)`).run(v.id, j.projectId, j.film, `${j.folder}/Hero.mp4`, nowIso(), nowIso());
  assert.equal((await j.review(off)).version.review.type, 'file');
  assert.equal((await j.review(on)).version.review.type, 'hls');
});
