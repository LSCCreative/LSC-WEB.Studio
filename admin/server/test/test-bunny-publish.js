'use strict';

/* Publishing a deliverable version to Bunny (Bunny Slice 2): the studio's /api
 * routes, bunny-publish.js and the signed source route Bunny pulls from, on the
 * real app, a throwaway database, a temporary deliverables folder and a fake
 * Bunny (test/fake-bunny.js). Nothing here can reach real data, Bunny or the NAS. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-bunny-publish-'));
process.env.DATA_DIR = TMP;
process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough-0123456789';
process.env.COOKIE_SECURE = '0';
process.env.NODE_ENV = 'test';

const { openDatabase, nowIso, newId } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');
const { UNLISTED_VIDEO_LIMIT_MS, SOURCE_TTL_SECONDS } = require('../src/bunny-publish');
const { fakeBunny, FAKE_BUNNY_SETTINGS } = require('./fake-bunny');

const HUB_HOST = 'hub.example';
const SIGNING_SECRET = 'test-signing-secret-for-bunny';
const DIR = path.join(TMP, 'deliverables');
fs.mkdirSync(path.join(DIR, 'Acme', 'Stills'), { recursive: true });
fs.writeFileSync(path.join(DIR, 'Acme', 'Hero.mp4'), '0123456789');
fs.writeFileSync(path.join(DIR, 'Acme', 'Cut 2.mov'), 'cut two');
fs.writeFileSync(path.join(DIR, 'Acme', 'Notes.pdf'), 'pdf');
fs.writeFileSync(path.join(DIR, 'Loose.mp4'), 'loose');
fs.writeFileSync(path.join(DIR, 'Acme', 'Stills', 'a.jpg'), 'a');

/* Every line the server logs, so the last test can check no key is in one. */
const logged = [];
const realConsole = { log: console.log, warn: console.warn, error: console.error };
for (const level of Object.keys(realConsole)) {
  console[level] = (...args) => { logged.push(args.map(String).join(' ')); };
}

const PASSWORD = 'a-long-test-password';
let clock = Date.parse('2026-11-26T01:00:00.000Z');
let db;
let bunny;

/* One running app over the shared database: `start` again is a server restart. */
async function start({ bunnySettings = FAKE_BUNNY_SETTINGS } = {}) {
  const app = createApp(db, {
    hub: {
      signingSecret: SIGNING_SECRET,
      corsOrigins: ['https://lsccreative.studio'],
      publicBaseUrl: `https://${HUB_HOST}`,
      deliverablesDir: DIR,
      bunny: bunnySettings,
    },
    deliverablesDir: DIR,
    bunnyFetch: bunny.fetchImpl,
    videoLookupGapMs: 1,
    bunnyNow: () => clock,
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const { port } = server.address();
  /* node:http, which lets a test set the Host header: Bunny pulls from hub-api's address. */
  const raw = (p, { method = 'GET', host = `127.0.0.1:${port}`, headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      host, ...(data !== undefined ? { 'content-type': 'application/json' } : {}), ...headers,
    } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* a file */ }
        resolve({ status: res.statusCode, headers: res.headers, text, body: json });
      });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
  const login = await raw('/api/login', { method: 'POST', body: { username: 'tester', password: PASSWORD } });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const call = (method, p, body) => raw(p, { method, body, headers: { cookie } });
  const close = () => new Promise((r) => server.close(r));
  return { raw, call, close };
}

let s;
test.before(async () => {
  db = openDatabase(path.join(TMP, 'billing.db'));
  db.prepare("INSERT INTO account (id, username, password_hash, created_at, updated_at) VALUES (1, 'tester', ?, ?, ?)")
    .run(await hashPassword(PASSWORD), nowIso(), nowIso());
  bunny = fakeBunny();
  s = await start();
});

test.after(async () => {
  await s.close();
  db.close();
  Object.assign(console, realConsole);
  fs.rmSync(TMP, { recursive: true, force: true });
});

/* An accepted project with one quoted item, named as its quote is. */
function project({ name = 'Winter campaign' } = {}) {
  const now = nowIso();
  const id = newId('prj');
  const est = newId('est');
  const item = newId('dlv');
  db.prepare('INSERT INTO projects (id, upid, needs_upid, accepted_at, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)')
    .run(id, `U${id.slice(-4)}`, now, now, now);
  db.prepare("INSERT INTO estimates (id, project_id, upid, name, date, status, client_json, created_at, updated_at) VALUES (?, ?, ?, ?, '2026-10-01', 'accepted', '{}', ?, ?)")
    .run(est, id, id, name, now, now);
  db.prepare("INSERT INTO deliverables (id, project_id, position, title, estimate_id, quote_line_id, created_at, updated_at) VALUES (?, ?, 1, 'Hero film', ?, 'line', ?, ?)")
    .run(item, id, est, now, now);
  return { id, item };
}

const base = (p, versionId) => `/api/projects/${p.id}/deliverables/${p.item}/versions/${versionId}`;
/* A version through the studio's own route, as the Deliverables tab adds one. */
async function addVersion(p, filePath) {
  const r = await s.call('POST', `/api/projects/${p.id}/deliverables/${p.item}/versions`, { path: filePath });
  assert.equal(r.status, 200, r.text);
  const versions = r.body.deliverables.find((d) => d.id === p.item).versions;
  return versions[versions.length - 1].id;
}
const publish = (p, v, body = {}) => s.call('POST', `${base(p, v)}/bunny`, body);
const statusOf = (p, v) => s.call('GET', `${base(p, v)}/bunny`);
const rowOf = (v) => db.prepare("SELECT * FROM bunny_assets WHERE version_id = ? AND kind = 'video'").get(v);
const reset = () => Object.assign(bunny.state, { failFetch: false, listAfter: 0, neverList: false, statusOnFetch: 4 });

test('a video version goes to Bunny once: its project’s collection, a tagged title, a signed source', async () => {
  reset();
  const p = project();
  const v = await addVersion(p, 'Acme/Hero.mp4');
  assert.deepEqual((await statusOf(p, v)).body.status, 'none', 'nothing published yet');

  const fetchesBefore = bunny.fetches();
  const first = await publish(p, v);
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.body, {
    status: 'ready', error: null, sourceChanged: false,
    posterUrl: `https://${FAKE_BUNNY_SETTINGS.streamCdnHost}/${rowOf(v).bunny_video_id}/thumbnail.jpg`,
    progress: { done: 1, total: 1 },
  });
  assert.equal(bunny.fetches(), fetchesBefore + 1);

  const row = rowOf(v);
  assert.deepEqual([row.project_id, row.item_id, row.source_path, row.source_size, row.status], [p.id, p.item, 'Acme/Hero.mp4', 10, 'ready']);
  const collection = db.prepare('SELECT * FROM bunny_collections WHERE project_id = ?').get(p.id);
  assert.equal(collection.name, `${p.id} Winter campaign`, 'named "<projectId> <name>", keyed by the project');
  assert.equal(row.collection_id, collection.collection_id);
  const video = bunny.state.videos.find((x) => x.guid === row.bunny_video_id);
  assert.equal(video.title, `Hero.mp4 [${row.publish_tag}]`);
  assert.match(row.publish_tag, /^lsc-[0-9a-f]{16}$/);
  assert.match(video.source, new RegExp(`^https://${HUB_HOST}/hub/source/${v}/Hero\\.mp4\\?token=[0-9a-f]+&expires=\\d+$`),
    'Bunny pulls from a signed source link, not a permanent /hub/files token');
  assert.equal(db.prepare('SELECT COUNT(*) FROM deliverable_tokens').pluck().get(), 0, 'no file token minted');

  const again = await publish(p, v);
  assert.deepEqual([again.status, again.body.status], [200, 'ready']);
  assert.equal(bunny.fetches(), fetchesBefore + 1, 'publishing again returns the row: no second fetch');
});

test('three publishes at once are one fetch and one collection', async () => {
  reset();
  const p = project({ name: 'Three at once' });
  const v = await addVersion(p, 'Acme/Hero.mp4');
  const fetchesBefore = bunny.fetches();
  const collectionsBefore = bunny.state.collections.length;
  const replies = await Promise.all([publish(p, v), publish(p, v), publish(p, v)]);
  assert.deepEqual(replies.map((r) => r.status), [200, 200, 200]);
  assert.equal(bunny.fetches(), fetchesBefore + 1);
  assert.equal(bunny.state.collections.length, collectionsBefore + 1);
});

test('force replaces a working video and leaves the old one on Bunny; a refused force keeps it', async () => {
  reset();
  const p = project();
  const v = await addVersion(p, 'Acme/Cut 2.mov');
  await publish(p, v);
  const old = rowOf(v);

  const forced = await publish(p, v, { force: true });
  assert.equal(forced.status, 200);
  const now = rowOf(v);
  assert.notEqual(now.bunny_video_id, old.bunny_video_id);
  assert.notEqual(now.publish_tag, old.publish_tag, 'its own tag, so the lookup can’t find the one it replaces');
  assert.ok(bunny.state.videos.some((x) => x.guid === old.bunny_video_id), 'the old video stays until cleanup');

  bunny.state.failFetch = true;
  const refused = await publish(p, v, { force: true });
  assert.equal(refused.status, 502);
  assert.equal(refused.body.status, 'ready');
  assert.match(refused.body.error, /refused the republish, so the published video stays: .*fetch refused/);
  assert.deepEqual(rowOf(v), now, 'the working row is untouched');
});

test('a refused first publish is failed, and publishing again retries it', async () => {
  reset();
  const p = project();
  const v = await addVersion(p, 'Acme/Hero.mp4');
  bunny.state.failFetch = true;
  const failed = await publish(p, v);
  assert.deepEqual([failed.status, failed.body.status], [502, 'failed']);
  assert.match(failed.body.error, /Bunny refused the publish: .*fetch refused/);

  bunny.state.failFetch = false;
  const fetchesBefore = bunny.fetches();
  const retried = await publish(p, v);
  assert.deepEqual([retried.status, retried.body.status, retried.body.error], [200, 'ready', null]);
  assert.equal(bunny.fetches(), fetchesBefore + 1, 'no force needed: a failed row has nothing to keep');
});

test('a video Bunny lists late is processing, then found; a transcoding one turns ready on a later read', async () => {
  reset();
  const p = project();
  const v = await addVersion(p, 'Acme/Hero.mp4');
  bunny.state.listAfter = 10;
  bunny.state.statusOnFetch = 3;
  const first = await publish(p, v);
  assert.deepEqual([first.status, first.body.status, first.body.posterUrl, first.body.progress], [200, 'processing', null, { done: 0, total: 1 }]);
  assert.equal(rowOf(v).bunny_video_id, null, 'no id until Bunny lists it');

  const video = bunny.state.videos[bunny.state.videos.length - 1];
  video.listAfter = 0;
  const found = await statusOf(p, v);
  assert.equal(found.body.status, 'processing', 'listed, still transcoding');
  assert.equal(rowOf(v).bunny_video_id, video.guid);

  video.status = 4;
  const ready = await statusOf(p, v);
  assert.deepEqual([ready.body.status, ready.body.progress], ['ready', { done: 1, total: 1 }]);
  assert.match(ready.body.posterUrl, new RegExp(`/${video.guid}/thumbnail\\.jpg$`));
});

test('a video Bunny fails to transcode, or no longer has, is failed with a reason', async () => {
  reset();
  const p = project();
  const v = await addVersion(p, 'Acme/Hero.mp4');
  bunny.state.statusOnFetch = 3;
  await publish(p, v);
  const video = bunny.state.videos.find((x) => x.guid === rowOf(v).bunny_video_id);
  video.status = 5;
  const failed = await statusOf(p, v);
  assert.deepEqual([failed.body.status, failed.body.error], ['failed', 'Bunny couldn’t transcode the file. Check it plays, then publish again.']);

  bunny.state.statusOnFetch = 3;
  await publish(p, v);
  bunny.state.videos = bunny.state.videos.filter((x) => x.guid !== rowOf(v).bunny_video_id);
  const gone = await statusOf(p, v);
  assert.deepEqual([gone.body.status, gone.body.error], ['failed', 'Bunny no longer has this video. Publish again.']);
});

test('a video still unlisted after 30 minutes is failed', async () => {
  reset();
  const p = project();
  const v = await addVersion(p, 'Acme/Hero.mp4');
  bunny.state.neverList = true;
  assert.equal((await publish(p, v)).body.status, 'processing');
  clock += UNLISTED_VIDEO_LIMIT_MS - 60_000;
  assert.equal((await statusOf(p, v)).body.status, 'processing', 'still inside the limit');
  clock += 2 * 60_000;
  const late = await statusOf(p, v);
  assert.deepEqual([late.body.status, late.body.error], ['failed', 'Bunny never listed the fetched video. Publish again.']);
});

test('a crash after the fetch adopts that video instead of pulling the file again', async () => {
  reset();
  const p = project();
  const v = await addVersion(p, 'Acme/Hero.mp4');
  await publish(p, v);
  const adopted = rowOf(v);
  // The row is lost, as if the server stopped between Bunny's answer and the write.
  db.prepare('DELETE FROM bunny_assets WHERE version_id = ?').run(v);
  const fetchesBefore = bunny.fetches();
  const again = await publish(p, v);
  assert.deepEqual([again.status, again.body.status], [200, 'ready']);
  assert.equal(bunny.fetches(), fetchesBefore, 'found by its tag: no second pull');
  assert.equal(rowOf(v).bunny_video_id, adopted.bunny_video_id);
});

test('a restart mid-publish picks the row up where it was', async () => {
  reset();
  const p = project();
  const v = await addVersion(p, 'Acme/Hero.mp4');
  bunny.state.listAfter = 10;
  assert.equal((await publish(p, v)).body.status, 'processing');
  await s.close();
  s = await start();
  bunny.state.videos[bunny.state.videos.length - 1].listAfter = 0;
  const after = await statusOf(p, v);
  assert.equal(after.body.status, 'ready');
});

test('a lost collection row finds the project’s collection by its id, even after a rename', async () => {
  reset();
  const p = project({ name: 'Old name' });
  await publish(p, await addVersion(p, 'Acme/Hero.mp4'));
  const made = bunny.state.collections.length;
  db.prepare('DELETE FROM bunny_collections WHERE project_id = ?').run(p.id);
  db.prepare("UPDATE estimates SET name = 'New name' WHERE project_id = ?").run(p.id);
  await publish(p, await addVersion(p, 'Acme/Cut 2.mov'));
  assert.equal(bunny.state.collections.length, made, 'no second collection');
  assert.equal(db.prepare('SELECT name FROM bunny_collections WHERE project_id = ?').pluck().get(p.id), `${p.id} Old name`);
});

test('the NAS file replaced after publishing is reported, and force sends the new cut', async () => {
  reset();
  const p = project();
  const file = path.join(DIR, 'Acme', 'Replaced.mp4');
  fs.writeFileSync(file, 'first cut');
  const v = await addVersion(p, 'Acme/Replaced.mp4');
  await publish(p, v);
  assert.equal((await statusOf(p, v)).body.sourceChanged, false);
  fs.writeFileSync(file, 'a longer second cut');
  assert.equal((await statusOf(p, v)).body.sourceChanged, true);
  assert.equal((await publish(p, v)).body.sourceChanged, true, 'publishing again without force keeps the old cut');
  assert.equal((await publish(p, v, { force: true })).body.sourceChanged, false);
  fs.rmSync(file);
  const gone = await statusOf(p, v);
  assert.deepEqual([gone.status, gone.body.status, gone.body.sourceChanged], [200, 'ready', false], 'a published video outlives its NAS file');
});

test('only a video in a project folder, on a needed item of a workable project, can go', async () => {
  reset();
  const p = project();
  const now = nowIso();
  const addRaw = (n, kind, sourcePath, fileName) => {
    const id = newId('ver');
    db.prepare(`INSERT INTO deliverable_versions (id, deliverable_id, project_id, n, stage, source_path, file_name, created_at, kind)
                VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)`).run(id, p.item, p.id, n, sourcePath, fileName, now, kind);
    return id;
  };
  const cases = [
    [addRaw(101, 'photos', 'Acme/Stills', 'Stills'), 422, 'not_a_video'],
    [addRaw(102, 'video', null, 'Old hub link'), 409, 'no_nas_file'],
    [addRaw(103, 'video', 'Loose.mp4', 'Loose.mp4'), 422, 'not_in_project_folder'],
    [addRaw(104, 'video', 'Acme/Notes.pdf', 'Notes.pdf'), 422, 'not_a_video'],
    [addRaw(105, 'video', 'Acme/Gone.mp4', 'Gone.mp4'), 409, 'file_missing'],
  ];
  for (const [v, status, error] of cases) {
    const r = await publish(p, v);
    assert.deepEqual([r.status, r.body.error], [status, error], error);
    assert.equal(rowOf(v), undefined);
  }

  const ok = addRaw(106, 'video', 'Acme/Hero.mp4', 'Hero.mp4');
  db.prepare('UPDATE deliverables SET not_needed_at = ? WHERE id = ?').run(now, p.item);
  assert.equal((await publish(p, ok)).body.error, 'not_needed');
  db.prepare('UPDATE deliverables SET not_needed_at = NULL WHERE id = ?').run(p.item);
  db.prepare('UPDATE projects SET archived_at = ? WHERE id = ?').run(now, p.id);
  assert.equal((await publish(p, ok)).body.error, 'archived');
  assert.equal(bunny.calls.filter((c) => c.body && c.body.includes(ok)).length, 0, 'nothing refused reached Bunny');
});

test('another project’s version, or item, is a 404 on both routes', async () => {
  reset();
  const mine = project();
  const theirs = project();
  const v = await addVersion(theirs, 'Acme/Hero.mp4');
  for (const method of ['POST', 'GET']) {
    assert.equal((await s.call(method, `/api/projects/${mine.id}/deliverables/${mine.item}/versions/${v}/bunny`, method === 'POST' ? {} : undefined)).status, 404);
    assert.equal((await s.call(method, `/api/projects/${mine.id}/deliverables/${theirs.item}/versions/${v}/bunny`, method === 'POST' ? {} : undefined)).status, 404);
  }
  assert.equal(rowOf(v), undefined);
});

test('the signed source serves the file, with Range, to the right version until it runs out', async () => {
  reset();
  const p = project();
  const v = await addVersion(p, 'Acme/Hero.mp4');
  await publish(p, v);
  const src = new URL(bunny.state.videos.find((x) => x.guid === rowOf(v).bunny_video_id).source);
  const get = (pathAndQuery, headers = {}) => s.raw(pathAndQuery, { host: HUB_HOST, headers });
  const signed = src.pathname + src.search;

  const whole = await get(signed);
  assert.deepEqual([whole.status, whole.text, whole.headers['cache-control']], [200, '0123456789', 'no-store']);
  const part = await get(signed, { range: 'bytes=2-4' });
  assert.deepEqual([part.status, part.text, part.headers['content-range']], [206, '234', 'bytes 2-4/10']);

  const other = await addVersion(p, 'Acme/Cut 2.mov');
  const token = src.searchParams.get('token');
  const expires = src.searchParams.get('expires');
  for (const [label, url] of [
    ['another version', `/hub/source/${other}/Cut%202.mov?token=${token}&expires=${expires}`],
    ['a tampered token', `${src.pathname}?token=${token.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'))}&expires=${expires}`],
    ['a stretched expiry', `${src.pathname}?token=${token}&expires=${Number(expires) + 60}`],
    ['another name', `/hub/source/${v}/Other.mp4?token=${token}&expires=${expires}`],
    ['no token', src.pathname],
  ]) {
    assert.equal((await get(url)).status, 404, label);
  }

  clock += (SOURCE_TTL_SECONDS + 1) * 1000;
  assert.equal((await get(signed)).status, 404, 'expired after 6 hours');
});

test('without every Bunny setting, both routes say so, and nothing reaches Bunny', async () => {
  const off = await start({ bunnySettings: { ...FAKE_BUNNY_SETTINGS, storagePassword: '' } });
  try {
    const p = project();
    const r = await off.call('POST', `/api/projects/${p.id}/deliverables/${p.item}/versions`, { path: 'Acme/Hero.mp4' });
    const v = r.body.deliverables.find((d) => d.id === p.item).versions[0].id;
    const callsBefore = bunny.calls.length;
    for (const method of ['POST', 'GET']) {
      const refused = await off.call(method, `${base(p, v)}/bunny`, method === 'POST' ? {} : undefined);
      assert.deepEqual([refused.status, refused.body.error], [503, 'bunny_not_set_up'], method);
    }
    assert.equal(bunny.calls.length, callsBefore);
    assert.ok(logged.some((l) => /publishing to Bunny is off until these are set: BUNNY_STORAGE_PASSWORD/.test(l)), 'the start-up log names what is missing');
  } finally { await off.close(); }
});

test('a Bunny key only ever travels as the AccessKey header, never in a URL, a body or a log line', () => {
  assert.ok(bunny.calls.length > 20, 'the tests above talked to Bunny');
  const secrets = [FAKE_BUNNY_SETTINGS.streamApiKey, FAKE_BUNNY_SETTINGS.streamReadKey, FAKE_BUNNY_SETTINGS.storagePassword, SIGNING_SECRET];
  for (const c of bunny.calls) {
    assert.equal(c.key, FAKE_BUNNY_SETTINGS.streamApiKey);
    for (const secret of secrets) {
      assert.ok(!c.path.includes(secret) && !c.search.includes(secret) && !String(c.body || '').includes(secret), 'not in a request');
    }
  }
  assert.ok(logged.some((l) => /\[bunny-publish\] publish failed/.test(l)), 'failures were logged');
  for (const line of logged) {
    for (const secret of secrets) assert.ok(!line.includes(secret), `a log line holds a secret: ${line.slice(0, 80)}`);
    assert.ok(!/token=[0-9a-f]{16,}/.test(line), 'no signed source link in a log line');
  }
});
