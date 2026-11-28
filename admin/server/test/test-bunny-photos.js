'use strict';

/* Photo libraries to Bunny Edge Storage (Bunny Slice 6), on the real app with the
 * portal mounted, a throwaway database and folder, real images made with sharp, and
 * a fake Bunny (test/fake-bunny.js):
 *   - a library goes up in the background: n/total, the untouched original, a grid
 *     and a lightbox size, never upscaled, turned upright;
 *   - publishing again sends only what Bunny hasn't got; a changed folder is told;
 *   - a photo that fails leaves the others, and a publish again sends what's left;
 *   - a restart resumes the job from its rows;
 *   - a photo replaced while it goes up is sent again, once;
 *   - the client's reply gives the sizes and never the original.
 * Nothing here can reach real data, Bunny or the NAS. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-bunny-photos-'));
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
const CDN = `https://${FAKE_BUNNY_SETTINGS.storageCdnHost}`;
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
  /* Every photo job this app runs, done (a restart's resume starts on the next tick). */
  const settled = async () => { await new Promise((r) => setImmediate(r)); await publisher.photoJobs(); };
  return { call, admin, publisher, settled };
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

const resetStorage = () => Object.assign(bunny.state, { failPut: null, onPut: null, listFails: false });

/* Images as a camera or an export would leave them. */
const jpeg = (w, h, background = '#557799') => sharp({ create: { width: w, height: h, channels: 3, background } }).jpeg().toBuffer();
const png = (w, h) => sharp({ create: { width: w, height: h, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0.5 } } }).png().toBuffer();
/* Stored landscape, shown portrait: EXIF orientation 6 is a quarter turn. */
const sideways = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: '#335' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
const sizeOf = async (bytes) => { const m = await sharp(bytes).metadata(); return [m.width, m.height, m.format]; };
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
/* A later modified time, as a file saved over on the NAS would have. */
const touch = (file, secondsLater = 60) => { const t = new Date(Date.now() + secondsLater * 1000); fs.utimesSync(file, t, t); };

/* A client's accepted project with one photo item, its folder on the NAS holding
   three photos (and things that aren't), the client signed in to the portal. */
let serial = 0;
async function job() {
  serial += 1;
  const now = nowIso();
  const clientId = newId('cl');
  const email = `ph${serial}@salt.example`;
  db.prepare("INSERT INTO clients (id, business_name, contact_name, email, created_at, updated_at) VALUES (?, ?, 'Priya Nair', ?, ?, ?)")
    .run(clientId, `Salt ${serial}`, email, now, now);
  const projectId = newId('prj');
  db.prepare(`INSERT INTO projects (id, upid, client_id, needs_upid, accepted_at, name, created_at, updated_at, opened_at)
              VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`).run(projectId, `PH-${serial}`, clientId, now, `Photo job ${serial}`, now, now, now);
  const estimateId = newId('est');
  db.prepare(`INSERT INTO estimates (id, project_id, upid, name, date, status, client_id, client_json, active_rows_json, totals_json, created_at, updated_at)
              VALUES (?, ?, ?, 'Photo job', '2026-11-01', 'accepted', ?, '{}', '{}', '{}', ?, ?)`).run(estimateId, projectId, `PH-${serial}`, clientId, now, now);
  const item = newId('dlv');
  db.prepare("INSERT INTO deliverables (id, project_id, position, title, estimate_id, quote_line_id, created_at, updated_at) VALUES (?, ?, 1, 'Stills', ?, 'line', ?, ?)")
    .run(item, projectId, estimateId, now, now);

  const folder = `Shoot${serial}/Day 1`;
  const dir = path.join(DIR, folder);
  fs.mkdirSync(path.join(dir, 'More'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'wide.jpg'), await jpeg(3000, 2000));
  fs.writeFileSync(path.join(dir, 'small.png'), await png(400, 300));
  fs.writeFileSync(path.join(dir, 'turned.jpg'), await sideways(1200, 800));
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'not a photo');
  fs.writeFileSync(path.join(dir, 'More', 'nested.jpg'), await jpeg(100, 100));

  const issued = await on.call(`/api/clients/${clientId}/portal`, { method: 'POST', body: {}, cookie: on.admin });
  const session = (await on.call('/hub/auth', { method: 'POST', body: { email, code: issued.body.code } })).cookie;
  const studio = `/api/projects/${projectId}/deliverables/${item}`;
  const r = await on.call(`${studio}/versions?today=${TODAY}`, { method: 'POST', body: { path: folder }, cookie: on.admin });
  assert.equal(r.status, 200, r.text);
  const version = r.body.deliverables.find((d) => d.id === item).versions.slice(-1)[0];
  assert.equal(version.kind, 'photos');
  return {
    projectId, item, folder, dir, versionId: version.id,
    base: `${projectId}/${item}/${version.id}`,
    file: (name) => path.join(dir, name),
    toBunny: (body = {}, app = on) => app.call(`${studio}/versions/${version.id}/bunny`, { method: 'POST', body, cookie: app.admin }),
    status: (app = on) => app.call(`${studio}/versions/${version.id}/bunny`, { cookie: app.admin }),
    publish: () => on.call(`${studio}/versions/${version.id}/publish?today=${TODAY}`, { method: 'POST', body: {}, cookie: on.admin }),
    review: async () => {
      const reply = await on.call(`/hub/projects/${projectId}`, { cookie: session });
      assert.equal(reply.status, 200, reply.text);
      return { review: reply.body.project.deliverables.find((d) => d.id === item).versions.slice(-1)[0].review, text: reply.text };
    },
  };
}
const assetOf = (versionId) => db.prepare("SELECT * FROM bunny_assets WHERE version_id = ? AND kind = 'photos'").get(versionId);
const filesOf = (versionId) => db.prepare('SELECT * FROM bunny_photo_files WHERE version_id = ? ORDER BY file_name').all(versionId);
const stored = (p) => bunny.state.storage.get(p);
const putsSince = (n) => bunny.puts().slice(n);

test('a photo folder goes up in the background: the original untouched, two sizes made, never upscaled, upright', async () => {
  resetStorage();
  const j = await job();
  const before = bunny.puts().length;
  const first = await j.toBunny();
  assert.equal(first.status, 200, first.text);
  assert.deepEqual([first.body.status, first.body.progress, first.body.refused], ['processing', { done: 0, total: 3 }, false],
    'the route answers at once; the job runs behind it');
  await on.settled();

  const done = await j.status();
  assert.deepEqual(done.body, { status: 'ready', error: null, sourceChanged: false, posterUrl: null, progress: { done: 3, total: 3 } });
  const asset = assetOf(j.versionId);
  assert.equal(asset.storage_path, j.base, '/<projectId>/<itemId>/<versionId>');
  assert.match(asset.publish_tag, /^[0-9a-f]{24}$/);
  const originals = `${j.base}/original-${asset.publish_tag}`;

  const sent = putsSince(before).sort();
  assert.deepEqual(sent, [
    `${j.base}/2400/small.png.jpg`, `${j.base}/2400/turned.jpg`, `${j.base}/2400/wide.jpg`,
    `${j.base}/600/small.png.jpg`, `${j.base}/600/turned.jpg`, `${j.base}/600/wide.jpg`,
    `${originals}/small.png`, `${originals}/turned.jpg`, `${originals}/wide.jpg`,
  ].sort(), 'three photos, three files each; not the .txt, not the subfolder');

  for (const name of ['wide.jpg', 'small.png', 'turned.jpg']) {
    assert.ok(stored(`${originals}/${name}`).bytes.equals(fs.readFileSync(j.file(name))), `${name}: the original, byte for byte`);
  }
  assert.deepEqual(await sizeOf(stored(`${j.base}/600/wide.jpg`).bytes), [600, 400, 'jpeg']);
  assert.deepEqual(await sizeOf(stored(`${j.base}/2400/wide.jpg`).bytes), [2400, 1600, 'jpeg']);
  assert.deepEqual(await sizeOf(stored(`${j.base}/600/small.png.jpg`).bytes), [400, 300, 'jpeg'], 'never larger than the original');
  assert.deepEqual(await sizeOf(stored(`${j.base}/2400/small.png.jpg`).bytes), [400, 300, 'jpeg']);
  assert.deepEqual(await sizeOf(stored(`${j.base}/600/turned.jpg`).bytes), [600, 900, 'jpeg'], 'turned upright from its EXIF');
  assert.deepEqual(await sizeOf(stored(`${j.base}/2400/turned.jpg`).bytes), [800, 1200, 'jpeg']);
  assert.equal((await sharp(stored(`${j.base}/600/turned.jpg`).bytes).metadata()).orientation, undefined, 'and no rotation left to apply');
  assert.deepEqual(filesOf(j.versionId).map((f) => [f.file_name, f.status, f.width, f.height]),
    [['small.png', 'done', 400, 300], ['turned.jpg', 'done', 800, 1200], ['wide.jpg', 'done', 3000, 2000]]);
  // The Deliverables tab (Slice 7) reads it from the folder, with n of total.
  const folder = await on.call(`/api/projects/${j.projectId}?today=${TODAY}`, { cookie: on.admin });
  const listed = folder.body.deliverables.find((d) => d.id === j.item).versions.find((x) => x.id === j.versionId);
  assert.deepEqual(listed.bunny, { status: 'ready', error: null, videoId: null, progress: { done: 3, total: 3 } });
  const put = bunny.calls.find((c) => c.method === 'PUT' && c.path.endsWith('/600/wide.jpg'));
  assert.equal(put.key, FAKE_BUNNY_SETTINGS.storagePassword, 'the storage zone’s own key, only in its header');

  // The client: the sizes from Bunny once they have the version, keyed as the NAS links are.
  assert.equal((await j.publish()).status, 200);
  const { review, text } = await j.review();
  assert.equal(review.type, 'photos');
  assert.equal(review.urls.length, 3, 'the NAS links stay until the page moves over (Slice 7)');
  const keys = review.urls.map((u) => new URL(u).searchParams.get('photo'));
  assert.deepEqual(review.photos.map((ph) => ph.key), keys, 'the same photos, in the same order, under the same keys');
  assert.deepEqual(review.photos[2], { key: keys[2], grid: `${CDN}/${j.base}/600/wide.jpg`, review: `${CDN}/${j.base}/2400/wide.jpg` },
    'the key and the two sizes only: no name or size as data, no original');
  assert.ok(review.photos.every((ph) => !('download' in ph)), 'no download: nothing in the reply is one (C2)');
  assert.ok(!text.includes('original-'), 'and nothing points at the originals’ folder');
  assert.doesNotMatch(text, /"bunny"|publish_tag|progress/, 'the row itself stays with the studio');
});

test('publishing again sends nothing new; a changed folder is told, and a republish sends only what changed', async () => {
  resetStorage();
  const j = await job();
  await j.toBunny();
  await on.settled();
  const before = bunny.puts().length;
  const again = await j.toBunny();
  assert.deepEqual([again.body.status, again.body.progress], ['ready', { done: 3, total: 3 }]);
  await on.settled();
  assert.equal(bunny.puts().length, before, 'ready, so nothing goes again');

  fs.writeFileSync(j.file('small.png'), await png(500, 300));
  touch(j.file('small.png'));
  fs.writeFileSync(j.file('new.jpg'), await jpeg(800, 600, '#aa3300'));
  fs.rmSync(j.file('turned.jpg'));
  assert.equal((await j.status()).body.sourceChanged, true, 'the studio is told the folder moved on');

  const firstTag = assetOf(j.versionId).publish_tag;
  const forced = await j.toBunny({ force: true });
  assert.deepEqual([forced.body.status, forced.body.progress], ['processing', { done: 1, total: 3 }], 'wide.jpg is kept as it was');
  await on.settled();
  const tag = assetOf(j.versionId).publish_tag;
  assert.equal(tag, firstTag, 'the same originals folder, so the kept photo’s original is still in it');
  assert.ok(stored(`${j.base}/original-${tag}/wide.jpg`), 'wide.jpg’s original is where the tag says');
  assert.deepEqual(putsSince(before).sort(), [
    `${j.base}/2400/new.jpg`, `${j.base}/2400/small.png.jpg`, `${j.base}/600/new.jpg`, `${j.base}/600/small.png.jpg`,
    `${j.base}/original-${tag}/new.jpg`, `${j.base}/original-${tag}/small.png`,
  ].sort(), 'the new photo and the replaced one, nothing else');
  assert.deepEqual(filesOf(j.versionId).map((f) => f.file_name), ['new.jpg', 'small.png', 'wide.jpg'], 'the photo taken out loses its row');
  assert.deepEqual((await j.status()).body, { status: 'ready', error: null, sourceChanged: false, posterUrl: null, progress: { done: 3, total: 3 } });
  assert.deepEqual(await sizeOf(stored(`${j.base}/600/small.png.jpg`).bytes), [500, 300, 'jpeg']);
});

test('a photo that fails leaves the others; a publish again sends only what’s left, and not an original Bunny has', async () => {
  resetStorage();
  const j = await job();
  bunny.state.failPut = (p) => p.endsWith('/2400/wide.jpg');
  await j.toBunny();
  await on.settled();
  const failed = (await j.status()).body;
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.progress, { done: 2, total: 3 });
  assert.equal(failed.error, '1 of 3 photos couldn’t go to Bunny (first, wide.jpg: Bunny Storage refused the upload (500): storage hiccup). Send it to Bunny again to retry them.');
  assert.equal(on.publisher.photosOf(j.versionId), null, 'half a library isn’t shown from Bunny');
  assert.equal((await j.publish()).status, 200, 'photo libraries aren’t held for Bunny');
  const { review } = await j.review();
  assert.deepEqual([review.urls.length, review.photos], [3, undefined], 'the client sees it from the NAS meanwhile');

  bunny.state.failPut = null;
  const before = bunny.puts().length;
  const retry = await j.toBunny();
  assert.deepEqual([retry.body.status, retry.body.progress], ['processing', { done: 2, total: 3 }]);
  await on.settled();
  assert.deepEqual(putsSince(before).sort(), [`${j.base}/2400/wide.jpg`, `${j.base}/600/wide.jpg`],
    'the original was already on Bunny with the same bytes, so only the sizes go');
  assert.equal((await j.status()).body.status, 'ready');
  assert.equal((await j.review()).review.photos.length, 3);
});

test('a restart picks an interrupted library up from its rows', async () => {
  resetStorage();
  const j = await job();
  await j.toBunny();
  await on.settled();
  // As if the server stopped part-way: the library still processing, one photo not done.
  db.prepare("UPDATE bunny_assets SET status = 'processing', progress_done = 2 WHERE version_id = ? AND kind = 'photos'").run(j.versionId);
  db.prepare("UPDATE bunny_photo_files SET status = 'pending' WHERE version_id = ? AND file_name = 'turned.jpg'").run(j.versionId);
  const before = bunny.puts().length;

  const restarted = await start();
  await restarted.settled();
  assert.deepEqual(putsSince(before).sort(), [`${j.base}/2400/turned.jpg`, `${j.base}/600/turned.jpg`],
    'only the photo that wasn’t done, and not its original, which Bunny holds');
  assert.deepEqual((await j.status(restarted)).body.progress, { done: 3, total: 3 });
  assert.equal(assetOf(j.versionId).status, 'ready');
});

test('a photo replaced while it goes up is sent again; one that keeps changing fails', async () => {
  resetStorage();
  const j = await job();
  const replacement = await jpeg(1600, 1000, '#00aa00');
  let swapped = false;
  bunny.state.onPut = async (p) => {
    if (!swapped && p.includes('/original-') && p.endsWith('/wide.jpg')) {
      swapped = true;
      fs.writeFileSync(j.file('wide.jpg'), replacement);
      touch(j.file('wide.jpg'), 120);
    }
  };
  await j.toBunny();
  await on.settled();
  const tag = assetOf(j.versionId).publish_tag;
  assert.equal((await j.status()).body.status, 'ready');
  assert.ok(stored(`${j.base}/original-${tag}/wide.jpg`).bytes.equals(replacement), 'Bunny ends with the file the NAS has now');
  assert.deepEqual(await sizeOf(stored(`${j.base}/2400/wide.jpg`).bytes), [1600, 1000, 'jpeg']);
  const row = filesOf(j.versionId).find((f) => f.file_name === 'wide.jpg');
  assert.deepEqual([row.source_size, row.width], [replacement.length, 1600]);
  assert.equal((await j.status()).body.sourceChanged, false);

  // Saved over again and again while it goes up: it gives up rather than send a mix.
  const k = await job();
  let n = 0;
  bunny.state.onPut = async (p) => {
    if (p.includes('/original-') && p.endsWith('/wide.jpg')) {
      n += 1;
      fs.writeFileSync(k.file('wide.jpg'), await jpeg(1000 + n * 10, 700));
      touch(k.file('wide.jpg'), 200 + n);
    }
  };
  await k.toBunny();
  await on.settled();
  const status = (await k.status()).body;
  assert.equal(status.status, 'failed');
  assert.match(status.error, /wide\.jpg: It kept changing on the NAS while it was being sent/);
  assert.equal(n, 2, 'two tries, no more');

  // Saved over between its checksum and its upload, so Bunny refuses the bytes: sent again, not failed.
  const m = await job();
  const later = await jpeg(900, 600, '#0000aa');
  let refusedOnce = false;
  bunny.state.onPut = async (p) => {
    if (!refusedOnce && p.includes('/original-') && p.endsWith('/wide.jpg')) {
      fs.writeFileSync(m.file('wide.jpg'), later);
      touch(m.file('wide.jpg'), 300);
    }
  };
  bunny.state.failPut = (p) => {
    if (refusedOnce || !p.includes('/original-') || !p.endsWith('/wide.jpg')) return false;
    refusedOnce = true;
    return true;
  };
  await m.toBunny();
  await on.settled();
  assert.equal((await m.status()).body.status, 'ready');
  assert.ok(stored(`${m.base}/original-${assetOf(m.versionId).publish_tag}/wide.jpg`).bytes.equals(later));
});

test('a file that isn’t an image fails on its own; a failed listing still sends every original', async () => {
  resetStorage();
  const j = await job();
  fs.writeFileSync(j.file('broken.jpg'), 'not really a jpeg');
  bunny.state.listFails = true;
  const r = await j.toBunny();
  assert.deepEqual(r.body.progress, { done: 0, total: 4 });
  await on.settled();
  const files = filesOf(j.versionId);
  assert.deepEqual(files.map((f) => [f.file_name, f.status]),
    [['broken.jpg', 'failed'], ['small.png', 'done'], ['turned.jpg', 'done'], ['wide.jpg', 'done']]);
  assert.match(files[0].error, /^It couldn’t be read as an image/);
  const status = (await j.status()).body;
  assert.deepEqual([status.status, status.progress], ['failed', { done: 3, total: 4 }]);
  assert.match(status.error, /^1 of 4 photos couldn’t go to Bunny \(first, broken\.jpg: It couldn’t be read as an image/);
});

test('what can’t go: no photos, too many, a folder gone, and a version the client already has', async () => {
  resetStorage();
  const j = await job();
  // Once the client has it, its photos stay as they were sent.
  await j.toBunny();
  await on.settled();
  assert.equal((await j.publish()).status, 200);
  const forced = await j.toBunny({ force: true });
  assert.deepEqual([forced.status, forced.body.error], [409, 'published']);
  assert.match(forced.body.message, /its photos stay as they were/);
  touch(j.file('small.png'), 3600);
  const changed = await j.toBunny();
  assert.deepEqual([changed.status, changed.body.error], [409, 'changed_since_published']);
  assert.match(changed.body.message, /Photos in the folder changed after v1 went to the client/);

  const now = nowIso();
  const raw = (n, sourcePath) => {
    const id = newId('ver');
    db.prepare(`INSERT INTO deliverable_versions (id, deliverable_id, project_id, n, stage, source_path, file_name, created_at, kind)
                VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, 'photos')`).run(id, j.item, j.projectId, n, sourcePath, path.basename(sourcePath), now);
    return id;
  };
  const studio = `/api/projects/${j.projectId}/deliverables/${j.item}/versions`;
  const toBunny = (id, body = {}) => on.call(`${studio}/${id}/bunny`, { method: 'POST', body, cookie: on.admin });

  fs.mkdirSync(path.join(DIR, `Shoot${serial}`, 'Empty'), { recursive: true });
  fs.writeFileSync(path.join(DIR, `Shoot${serial}`, 'Empty', 'notes.txt'), 'no photos here');
  const many = path.join(DIR, `Shoot${serial}`, 'Many');
  fs.mkdirSync(many, { recursive: true });
  for (let i = 0; i < 201; i += 1) fs.writeFileSync(path.join(many, `p${i}.jpg`), 'x');
  const cases = [
    [raw(201, `Shoot${serial}/Empty`), 422, 'no_photos'],
    [raw(202, `Shoot${serial}/Many`), 422, 'too_many_images'],
    [raw(203, `Shoot${serial}/Gone`), 409, 'folder_missing'],
  ];
  for (const [id, status, error] of cases) {
    const r = await toBunny(id);
    assert.deepEqual([r.status, r.body.error], [status, error], error);
    assert.equal(assetOf(id), undefined, `${error}: nothing written`);
  }

});

test('a Stream webhook never looks up, or fails, a photo library that is still going up', async () => {
  resetStorage();
  const j = await job();
  await j.toBunny();
  await on.settled();
  // A long send, 40 minutes in: past the 30 minutes a video waits to be listed.
  const longAgo = new Date(Date.now() - 40 * 60 * 1000).toISOString();
  db.prepare("UPDATE bunny_assets SET status = 'processing', progress_done = 2, updated_at = ? WHERE version_id = ? AND kind = 'photos'")
    .run(longAgo, j.versionId);
  const lookups = () => bunny.calls.filter((c) => c.path.startsWith('/library/lib1/videos')).length;
  const before = lookups();
  const outcome = await on.publisher.applyWebhook({ VideoLibraryId: 'lib1', VideoGuid: 'some-other-video', Status: 3, Timestamp: new Date().toISOString() });
  assert.equal(outcome, 'unknown');
  await on.publisher.adopted();
  assert.equal(lookups(), before, 'Stream isn’t asked about a photo library');
  const row = assetOf(j.versionId);
  assert.deepEqual([row.status, row.progress_done, row.error], ['processing', 2, null], 'and it isn’t failed');
});

test('a library whose folder moved on after it went to Bunny waits for the changes before the client gets it', async () => {
  resetStorage();
  const j = await job();
  await j.toBunny();
  await on.settled();
  fs.writeFileSync(j.file('wide.jpg'), await jpeg(2000, 1000, '#aa0000'));
  touch(j.file('wide.jpg'));
  const held = await j.publish();
  assert.deepEqual([held.status, held.body.error], [409, 'bunny_stale'], 'published, the old copy would stay on Bunny under the same key');
  assert.match(held.body.message, /Bunny has the old set/);

  await j.toBunny({ force: true });
  await on.settled();
  assert.equal((await j.publish()).status, 200, 'sent again, it goes');
  assert.deepEqual(await sizeOf(stored(`${j.base}/2400/wide.jpg`).bytes), [2000, 1000, 'jpeg']);
});
