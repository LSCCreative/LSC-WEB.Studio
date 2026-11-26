'use strict';

/* Bunny Stream's webhook (Bunny Slice 3): POST /hub/bunny-webhook on hub-api,
 * signed over the raw body (merge safeguard S20), on the real app, a throwaway
 * database and a fake Bunny. Signatures follow Bunny's docs ("Webhooks"):
 * lowercase hex HMAC-SHA256 of the body as sent, keyed with the library's
 * read-only key, with v1 / hmac-sha256 headers. Nothing here reaches Bunny. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-bunny-webhook-'));
process.env.DATA_DIR = TMP;
process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough-0123456789';
process.env.COOKIE_SECURE = '0';
process.env.NODE_ENV = 'test';

const express = require('express');
const { openDatabase, nowIso, newId } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');
const { fakeBunny, FAKE_BUNNY_SETTINGS } = require('./fake-bunny');

const HUB_HOST = 'hub.example';
const TODAY = '2026-11-26';
const DIR = path.join(TMP, 'deliverables');
fs.mkdirSync(path.join(DIR, 'Acme'), { recursive: true });
fs.writeFileSync(path.join(DIR, 'Acme', 'Hero.mp4'), '0123456789');

const logged = [];
const realError = console.error;
console.error = (...args) => { logged.push(args.map(String).join(' ')); };

const PASSWORD = 'a-long-test-password';
let db;
let bunny;
let app;
let server;
let port;
let cookie;

const settings = (over = {}) => ({
  signingSecret: 'test-signing-secret-for-webhooks',
  corsOrigins: ['https://lsccreative.studio'],
  publicBaseUrl: `https://${HUB_HOST}`,
  deliverablesDir: DIR,
  bunny: FAKE_BUNNY_SETTINGS,
  ...over,
});

/* node:http, which sends exactly the bytes given and lets a test set Host. */
const send = (p, { method = 'GET', host = HUB_HOST, headers = {}, raw, on = port } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: on, path: p, method, headers: { host, ...headers } }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { text += c; });
    res.on('end', () => {
      let body = null;
      try { body = JSON.parse(text); } catch (_) { /* text */ }
      resolve({ status: res.statusCode, headers: res.headers, text, body });
    });
  });
  req.on('error', reject);
  if (raw !== undefined) req.write(raw);
  req.end();
});
const api = (method, p, body) => send(p, {
  method, host: `127.0.0.1:${port}`,
  headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
  raw: body !== undefined ? JSON.stringify(body) : undefined,
});

const sign = (raw, key = FAKE_BUNNY_SETTINGS.streamReadKey) => crypto.createHmac('sha256', key).update(raw).digest('hex');
const signedHeaders = (raw, over = {}) => ({
  'content-type': 'application/json',
  'x-bunnystream-signature-version': 'v1',
  'x-bunnystream-signature-algorithm': 'hmac-sha256',
  'x-bunnystream-signature': sign(raw),
  ...over,
});
/* A webhook as Bunny sends one, pretty-printed on purpose: only the raw bytes verify. */
const eventBody = (videoId, status, timestamp, over = {}) => JSON.stringify({
  IsLiveStreamWebhook: false, VideoLibraryId: Number(FAKE_BUNNY_SETTINGS.libraryId) || FAKE_BUNNY_SETTINGS.libraryId,
  VideoGuid: videoId, Status: status, EventId: crypto.randomUUID(), Timestamp: timestamp, ...over,
}, null, 2);
const webhook = (raw, headers = signedHeaders(raw), on) => send('/hub/bunny-webhook', { method: 'POST', raw, headers, on });

test.before(async () => {
  db = openDatabase(path.join(TMP, 'billing.db'));
  db.prepare("INSERT INTO account (id, username, password_hash, created_at, updated_at) VALUES (1, 'tester', ?, ?, ?)")
    .run(await hashPassword(PASSWORD), nowIso(), nowIso());
  bunny = fakeBunny();
  app = createApp(db, { hub: settings(), deliverablesDir: DIR, bunnyFetch: bunny.fetchImpl, videoLookupGapMs: 1 });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
  const login = await send('/api/login', {
    method: 'POST', host: `127.0.0.1:${port}`, headers: { 'content-type': 'application/json' },
    raw: JSON.stringify({ username: 'tester', password: PASSWORD }),
  });
  cookie = login.headers['set-cookie'][0].split(';')[0];
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  console.error = realError;
  fs.rmSync(TMP, { recursive: true, force: true });
});

/* An accepted project with one item and a version on Bunny, still transcoding. */
async function published({ listAfter = 0 } = {}) {
  const now = nowIso();
  const p = { id: newId('prj'), item: newId('dlv') };
  db.prepare('INSERT INTO projects (id, upid, needs_upid, accepted_at, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)')
    .run(p.id, `U${p.id.slice(-4)}`, now, now, now);
  db.prepare("INSERT INTO estimates (id, project_id, upid, name, date, status, client_json, created_at, updated_at) VALUES (?, ?, ?, 'Webhook job', '2026-10-01', 'accepted', '{}', ?, ?)")
    .run(newId('est'), p.id, p.id, now, now);
  db.prepare("INSERT INTO deliverables (id, project_id, position, title, created_at, updated_at) VALUES (?, ?, 1, 'Hero film', ?, ?)")
    .run(p.item, p.id, now, now);
  const added = await api('POST', `/api/projects/${p.id}/deliverables/${p.item}/versions`, { path: 'Acme/Hero.mp4' });
  assert.equal(added.status, 200, added.text);
  p.version = added.body.deliverables.find((d) => d.id === p.item).versions.slice(-1)[0].id;
  Object.assign(bunny.state, { statusOnFetch: 3, listAfter, neverList: false, failFetch: false });
  const r = await api('POST', `/api/projects/${p.id}/deliverables/${p.item}/versions/${p.version}/bunny`, {});
  assert.equal(r.body.status, 'processing');
  p.video = () => db.prepare("SELECT * FROM bunny_assets WHERE version_id = ? AND kind = 'video'").get(p.version);
  p.status = async () => (await api('GET', `/api/projects/${p.id}/deliverables/${p.item}/versions/${p.version}/bunny`)).body;
  return p;
}
const needs = async () => (await api('GET', `/api/needs?today=${TODAY}`)).body.items;

test('a signed webhook is applied: Finished makes the version ready', async () => {
  const p = await published();
  const id = p.video().bunny_video_id;
  const r = await webhook(eventBody(id, 3, '2026-11-26T01:00:00Z'));
  assert.deepEqual([r.status, r.body], [200, { ok: true, outcome: 'applied' }]);
  assert.deepEqual([p.video().status, p.video().progress_done, p.video().last_event_at], ['ready', 1, '2026-11-26T01:00:00.000Z']);
  const callsBefore = bunny.calls.length;
  assert.equal((await p.status()).status, 'ready');
  assert.equal(bunny.calls.length, callsBefore, 'a ready row asks Bunny nothing more');
});

test('unsigned, wrongly signed, tampered and re-serialised bodies are refused, and change nothing', async () => {
  const p = await published();
  const id = p.video().bunny_video_id;
  const raw = eventBody(id, 3, '2026-11-26T02:00:00Z');
  const compact = JSON.stringify(JSON.parse(raw));
  for (const [label, body, headers] of [
    ['unsigned', raw, { 'content-type': 'application/json' }],
    ['another key', raw, signedHeaders(raw, { 'x-bunnystream-signature': sign(raw, 'not-the-read-key') })],
    ['tampered', raw.replace('"Status": 3', '"Status": 5'), signedHeaders(raw)],
    ['re-serialised', compact, signedHeaders(raw)],
    ['upper-case hex', raw, signedHeaders(raw, { 'x-bunnystream-signature': sign(raw).toUpperCase() })],
    ['another version', raw, signedHeaders(raw, { 'x-bunnystream-signature-version': 'v2' })],
    ['another algorithm', raw, signedHeaders(raw, { 'x-bunnystream-signature-algorithm': 'hmac-sha1' })],
    ['signed with the API key', raw, signedHeaders(raw, { 'x-bunnystream-signature': sign(raw, FAKE_BUNNY_SETTINGS.streamApiKey) })],
  ]) {
    const r = await webhook(body, headers);
    assert.deepEqual([r.status, r.body], [401, { error: 'unsigned' }], label);
  }
  assert.equal(p.video().status, 'processing');
  // The compact body signed as itself is fine: what counts is the bytes, not the layout.
  assert.equal((await webhook(compact)).status, 200);
});

test('a JSON parser mounted ahead of the webhook breaks it, so the real app must not have one', async () => {
  const p = await published();
  const raw = eventBody(p.video().bunny_video_id, 3, '2026-11-26T03:00:00Z');
  // The real app (above) verifies a pretty-printed body: no parser has touched it.
  assert.equal((await webhook(raw)).status, 200);

  // The same router behind express.json(): every webhook fails, loudly.
  const wrong = express();
  wrong.use(express.json());
  wrong.use(app);
  const s = await new Promise((resolve) => { const x = wrong.listen(0, '127.0.0.1', () => resolve(x)); });
  try {
    const r = await webhook(raw, signedHeaders(raw), s.address().port);
    assert.equal(r.status, 401);
    assert.ok(logged.some((l) => /a JSON parser is mounted ahead of the webhook/.test(l)));
  } finally { await new Promise((resolve) => s.close(resolve)); }
});

test('events out of order or twice: the newest wins, and progress never undoes ready', async () => {
  const p = await published();
  const id = p.video().bunny_video_id;
  assert.equal((await webhook(eventBody(id, 3, '2026-11-26T04:00:03Z'))).body.outcome, 'applied');
  assert.equal((await webhook(eventBody(id, 2, '2026-11-26T04:00:01Z'))).body.outcome, 'ignored', 'older than the last applied');
  assert.equal((await webhook(eventBody(id, 4, '2026-11-26T04:00:05Z'))).body.outcome, 'unchanged', 'a resolution after Finished');
  assert.equal((await webhook(eventBody(id, 3, '2026-11-26T04:00:03Z'))).body.outcome, 'applied', 'a redelivery is harmless');
  assert.equal(p.video().status, 'ready');
  assert.equal((await webhook(eventBody(id, 5, '2026-11-26T04:00:00Z'))).body.outcome, 'ignored', 'an older failure');
  assert.equal(p.video().status, 'ready');

  assert.equal((await webhook(eventBody(id, 32, '2026-11-26T05:00:00Z'))).body.outcome, 'applied');
  assert.deepEqual([p.video().status, p.video().error], ['failed', 'The video was deleted on Bunny. Publish again.']);
});

test('codes that say nothing about playing, another library and a live stream are ignored', async () => {
  const p = await published();
  const id = p.video().bunny_video_id;
  for (const [label, raw] of [
    ['captions', eventBody(id, 9, '2026-11-26T06:00:00Z')],
    ['another library', eventBody(id, 3, '2026-11-26T06:00:00Z', { VideoLibraryId: 999 })],
    ['a live stream', eventBody(id, 3, '2026-11-26T06:00:00Z', { IsLiveStreamWebhook: true })],
    ['no video', eventBody('', 3, '2026-11-26T06:00:00Z')],
  ]) {
    assert.deepEqual((await webhook(raw)).body, { ok: true, outcome: 'ignored' }, label);
  }
  assert.equal(p.video().status, 'processing');
  const bad = '{"Status": 3,';
  assert.equal((await webhook(bad)).status, 400, 'signed but not JSON');
});

test('an unknown id is a 200, and sends the rows still waiting for their id to look again', async () => {
  const p = await published({ listAfter: 10 });
  assert.equal(p.video().bunny_video_id, null, 'Bunny hasn’t listed it');
  const video = bunny.state.videos[bunny.state.videos.length - 1];
  video.listAfter = 0;
  video.status = 4;
  const r = await webhook(eventBody(video.guid, 3, '2026-11-26T07:00:00Z'));
  assert.deepEqual([r.status, r.body.outcome], [200, 'unknown']);
  await app.locals.bunnyPublisher.adopted();
  assert.deepEqual([p.video().bunny_video_id, p.video().status], [video.guid, 'ready'], 'found by its tag');

  const replaced = await webhook(eventBody('vid-never-ours', 3, '2026-11-26T07:00:00Z'));
  assert.deepEqual([replaced.status, replaced.body.outcome], [200, 'unknown']);
});

test('Needs you shows Publish failed for the newest version, and it leaves when the video turns ready', async () => {
  const p = await published();
  const id = p.video().bunny_video_id;
  await webhook(eventBody(id, 5, '2026-11-26T08:00:00Z'));
  const item = (await needs()).find((n) => n.id === `publish_failed:${p.version}`);
  assert.ok(item, 'listed');
  assert.deepEqual([item.kind, item.itemId, item.title, item.n, item.error],
    ['publish_failed', p.item, 'Hero film', 1, 'Bunny couldn’t transcode the file. Check it plays, then publish again.']);

  await webhook(eventBody(id, 3, '2026-11-26T08:10:00Z'));
  assert.equal((await needs()).some((n) => n.id === `publish_failed:${p.version}`), false, 'gone once ready');

  await webhook(eventBody(id, 5, '2026-11-26T08:20:00Z'));
  assert.ok((await needs()).some((n) => n.id === `publish_failed:${p.version}`));
  await api('POST', `/api/projects/${p.id}/deliverables/${p.item}/versions`, { path: 'Acme/Hero.mp4' });
  assert.equal((await needs()).some((n) => n.id === `publish_failed:${p.version}`), false, 'a newer version replaces it');
});

test('without Bunny set up the webhook is a 503, and the signing key never reaches a log', async () => {
  const off = createApp(db, { hub: settings({ bunny: { ...FAKE_BUNNY_SETTINGS, streamReadKey: '' } }), deliverablesDir: DIR });
  const s = await new Promise((resolve) => { const x = off.listen(0, '127.0.0.1', () => resolve(x)); });
  try {
    const raw = eventBody('vid-1', 3, '2026-11-26T09:00:00Z');
    assert.equal((await webhook(raw, signedHeaders(raw), s.address().port)).status, 503);
  } finally { await new Promise((resolve) => s.close(resolve)); }
  for (const line of logged) assert.ok(!line.includes(FAKE_BUNNY_SETTINGS.streamReadKey), line.slice(0, 80));
});
