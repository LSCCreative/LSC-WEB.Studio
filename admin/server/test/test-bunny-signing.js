'use strict';

/* Signed, expiring Bunny links (Bunny Slice 9), on the real app with the portal
 * mounted, a fake Bunny, both pull zones' token keys set, a forced 60-second TTL and
 * a clock the test moves:
 *   - the token is Bunny's advanced HMAC-SHA256 one, checked against the formula;
 *   - a video's playlist and poster are signed for their folder, in the path, so
 *     the segments load; the link runs out and a later reply gives a new one;
 *   - the paid email's master link is hub-api's route, good for 90 days, which
 *     sends each click on to Bunny with a link of its own; a bad or old link, or an
 *     item no longer needed, is refused; the email's set key doesn't move with time.
 * Nothing here can reach real data, Bunny or the NAS. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-bunny-signing-'));
process.env.DATA_DIR = TMP;
process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough-0123456789';
process.env.COOKIE_SECURE = '0';
process.env.NODE_ENV = 'test';

const { openDatabase, nowIso, newId } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');
const { signBunnyUrl, expiresIn } = require('../src/hub/bunny-tokens');
const { DOWNLOAD_LINK_SECONDS } = require('../src/bunny-publish');
const { fakeBunny, FAKE_BUNNY_SETTINGS } = require('./fake-bunny');

for (const level of ['log', 'warn', 'error']) console[level] = () => {};

const STREAM_KEY = 'stream-zone-token-key';
const STORAGE_KEY = 'storage-zone-token-key';
const TTL = 60;
const DIR = path.join(TMP, 'deliverables');
fs.mkdirSync(DIR, { recursive: true });
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
const hub = {
  signingSecret: 'test-signing-secret', corsOrigins: ['https://lsccreative.studio'], publicBaseUrl: 'https://hub.example',
  appUrl: 'https://app.example/', portalUrl: 'https://lsccreative.studio/client-hub-app/', deliverablesDir: DIR,
  bunny: { ...FAKE_BUNNY_SETTINGS, streamTokenKey: STREAM_KEY, storageTokenKey: STORAGE_KEY, signedTtlSeconds: TTL },
};

/* Bunny's formula, written out again here rather than called: the test checks the code. */
const expected = (key, signaturePath, expires, signingData = '') => `HS256-${crypto.createHmac('sha256', key)
  .update(`${signaturePath}${expires}${signingData}`).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;

let db;
let bunny;
let clock = Date.parse('2026-12-01T00:00:00Z');
let on;

async function start() {
  const app = createApp(db, { hub, deliverablesDir: DIR, bunnyFetch: bunny.fetchImpl, videoLookupGapMs: 1, bunnyNow: () => clock });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (url, { method = 'GET', body, cookie, host } = {}) => {
    const res = await fetch(base + url, {
      method,
      redirect: 'manual',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(host ? { host } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
    const set = res.headers.get('set-cookie') || '';
    return { status: res.status, body: json, text, headers: res.headers, cookie: set ? set.split(';')[0] : null };
  };
  const admin = (await call('/api/login', { method: 'POST', body: { username: 'tester', password: 'a-long-test-password' } })).cookie;
  return { app, server, call, admin, publisher: app.locals.bunnyPublisher };
}

test.before(async () => {
  db = openDatabase(path.join(TMP, 'billing.db'));
  db.prepare("INSERT INTO account (id, username, password_hash, created_at, updated_at) VALUES (1, 'tester', ?, ?, ?)")
    .run(await hashPassword('a-long-test-password'), nowIso(), nowIso());
  bunny = fakeBunny();
  on = await start();
});

test.after(async () => {
  await new Promise((r) => on.server.close(r));
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

/* A client's accepted project with one Final video, published to Bunny and to the client. */
let serial = 0;
async function job() {
  serial += 1;
  const now = nowIso();
  const clientId = newId('cl');
  const email = `sg${serial}@salt.example`;
  db.prepare("INSERT INTO clients (id, business_name, contact_name, email, created_at, updated_at) VALUES (?, ?, 'Priya Nair', ?, ?, ?)")
    .run(clientId, `Salt ${serial}`, email, now, now);
  const projectId = newId('prj');
  db.prepare(`INSERT INTO projects (id, upid, client_id, needs_upid, accepted_at, name, created_at, updated_at, opened_at)
              VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`).run(projectId, `SG-${serial}`, clientId, now, `Film ${serial}`, now, now, now);
  const estimateId = newId('est');
  db.prepare(`INSERT INTO estimates (id, project_id, upid, name, date, status, client_id, client_json, active_rows_json, totals_json, created_at, updated_at)
              VALUES (?, ?, ?, 'Film', '2026-11-01', 'accepted', ?, '{}', '{}', '{}', ?, ?)`).run(estimateId, projectId, `SG-${serial}`, clientId, now, now);
  const item = newId('dlv');
  db.prepare(`INSERT INTO deliverables (id, project_id, position, title, stage, estimate_id, quote_line_id, created_at, updated_at)
              VALUES (?, ?, 1, 'Hero film', 'final', ?, 'line', ?, ?)`).run(item, projectId, estimateId, now, now);
  const rel = `Sign${serial}/Hero 4K.mov`;
  fs.mkdirSync(path.join(DIR, `Sign${serial}`), { recursive: true });
  fs.writeFileSync(path.join(DIR, rel), crypto.randomBytes(64 * 1024));
  // A file written "before" the publish, on the test's clock.
  const before = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(path.join(DIR, rel), before, before);

  const issued = await on.call(`/api/clients/${clientId}/portal`, { method: 'POST', body: {}, cookie: on.admin });
  const session = (await on.call('/hub/auth', { method: 'POST', body: { email, code: issued.body.code } })).cookie;
  const studio = `/api/projects/${projectId}/deliverables/${item}`;
  const r = await on.call(`${studio}/versions?today=${TODAY}`, { method: 'POST', body: { path: rel }, cookie: on.admin });
  assert.equal(r.status, 200, r.text);
  const versionId = r.body.deliverables.find((d) => d.id === item).versions.slice(-1)[0].id;
  assert.equal((await on.call(`${studio}/versions/${versionId}/bunny`, { method: 'POST', body: {}, cookie: on.admin })).status, 200);
  await on.publisher.masterJobs();
  const published = await on.call(`${studio}/versions/${versionId}/publish?today=${TODAY}`, { method: 'POST', body: {}, cookie: on.admin });
  assert.equal(published.status, 200, published.text);
  return {
    projectId, item, versionId,
    review: async () => {
      const reply = await on.call(`/hub/projects/${projectId}`, { cookie: session });
      assert.equal(reply.status, 200, reply.text);
      return { review: reply.body.project.deliverables[0].versions.slice(-1)[0].review, text: reply.text };
    },
  };
}

test('the token is Bunny’s advanced one: HMAC-SHA256 over path, expiry and token_path, base64url', () => {
  const expires = 1798000000;
  const plain = 'https://cdn.example/p/i/v/600/a%20b.jpg';
  assert.equal(signBunnyUrl(plain, '', { expires }), plain, 'no key: unsigned, as before Slice 9');

  const one = signBunnyUrl(plain, 'k', { expires });
  assert.equal(one, `https://cdn.example/p/i/v/600/a%20b.jpg?token=${expected('k', '/p/i/v/600/a%20b.jpg', expires)}&expires=${expires}`);

  const dir = signBunnyUrl('https://vz.example/vid-9/playlist.m3u8', 'k', { expires, directory: '/vid-9/', pathForm: true });
  assert.equal(dir, `https://vz.example/bcdn_token=${expected('k', '/vid-9/', expires, 'token_path=/vid-9/')}&token_path=%2Fvid-9%2F&expires=${expires}/vid-9/playlist.m3u8`,
    'the folder signed with token_path raw, sent URL-encoded, the file last so segments resolve under the token');
  assert.match(dir, /bcdn_token=HS256-[A-Za-z0-9_-]+&/, 'base64url, no padding');

  // Rounded up to the hour, so replies within an hour give the same URL; a short TTL rounds to itself.
  assert.equal(expiresIn(6 * 3600, Date.parse('2026-12-01T00:10:00Z')), Date.parse('2026-12-01T07:00:00Z') / 1000);
  assert.equal(expiresIn(60, Date.parse('2026-12-01T00:10:30Z')), Date.parse('2026-12-01T00:12:00Z') / 1000);
});

test('the client’s video plays from a signed folder link that runs out; a later reply gives a new one', async () => {
  const j = await job();
  const { review, text } = await j.review();
  assert.equal(review.type, 'hls');
  const videoId = db.prepare("SELECT bunny_video_id FROM bunny_assets WHERE version_id = ? AND kind = 'video'").pluck().get(j.versionId);
  const m = new RegExp(`^https://${FAKE_BUNNY_SETTINGS.streamCdnHost.replace(/\./g, '\\.')}/bcdn_token=(HS256-[A-Za-z0-9_-]+)&token_path=%2F${videoId}%2F&expires=(\\d+)/${videoId}/playlist\\.m3u8$`).exec(review.url);
  assert.ok(m, review.url);
  const expires = Number(m[2]);
  assert.equal(m[1], expected(STREAM_KEY, `/${videoId}/`, expires, `token_path=/${videoId}/`), 'signed with the Stream zone’s key');
  assert.ok(expires > clock / 1000 && expires <= clock / 1000 + 2 * TTL, 'a forced 60 s TTL');
  assert.match(review.poster, new RegExp(`/bcdn_token=HS256-[^/]+/${videoId}/thumbnail\\.jpg$`), 'the poster too');
  assert.doesNotMatch(text, new RegExp(`https://${FAKE_BUNNY_SETTINGS.streamCdnHost}/${videoId}/`), 'no unsigned Stream link');
  assert.doesNotMatch(text, /master-|\/hub\/download\//, 'and no download');

  clock += 5 * 60 * 1000;
  const later = await j.review();
  assert.notEqual(later.review.url, review.url, 'the expired link is replaced by a fresh one');
  assert.ok(Number(/&expires=(\d+)\//.exec(later.review.url)[1]) > clock / 1000);
});

test('the paid email’s master link goes through hub-api for 90 days; each click gets its own Bunny link', async () => {
  const j = await job();
  const m = on.publisher.masterForEmail(j.versionId);
  assert.ok(m, 'the master landed');
  const link = new URL(m.url);
  assert.equal(link.origin, 'https://hub.example');
  assert.equal(link.pathname, `/hub/download/${j.versionId}/Hero%204K.mov`);
  assert.equal(Number(link.searchParams.get('expires')), Math.floor(clock / 1000) + DOWNLOAD_LINK_SECONDS);
  const hubHost = { host: 'hub.example' };

  const go = await on.call(link.pathname + link.search, hubHost);
  assert.equal(go.status, 302, go.text);
  assert.equal(go.headers.get('cache-control'), 'no-store');
  const target = new URL(go.headers.get('location'));
  assert.equal(target.host, FAKE_BUNNY_SETTINGS.storageCdnHost);
  assert.match(target.pathname, new RegExp(`^/${j.projectId}/${j.item}/${j.versionId}/master-[0-9a-f]{24}/Hero%204K\\.mov$`));
  const targetExpires = Number(target.searchParams.get('expires'));
  assert.equal(target.searchParams.get('token'), expected(STORAGE_KEY, target.pathname, targetExpires), 'signed with the storage zone’s key');
  assert.ok(targetExpires >= clock / 1000 + 24 * 3600, 'long enough for a big download');

  // A tampered or unsigned link says so in a sentence, and nothing about the file.
  const bad = await on.call(link.pathname + link.search.replace(/token=[^&]+/, 'token=nope'), hubHost);
  assert.equal(bad.status, 410);
  assert.match(bad.text, /expired or isn’t valid/);
  assert.equal((await on.call(link.pathname, hubHost)).status, 410);

  // The email's set key names the upload, so the link being re-signed later sends nothing new.
  clock += 24 * 3600 * 1000;
  const again = on.publisher.masterForEmail(j.versionId);
  assert.equal(again.key, m.key);
  assert.notEqual(again.url, m.url);

  // The link still works a month on; an item marked not needed refuses it.
  assert.equal((await on.call(link.pathname + link.search, hubHost)).status, 302);
  db.prepare('UPDATE deliverables SET not_needed_at = ? WHERE id = ?').run(nowIso(), j.item);
  const gone = await on.call(link.pathname + link.search, hubHost);
  assert.equal(gone.status, 404);
  assert.match(gone.text, /isn’t available any more/);
  db.prepare('UPDATE deliverables SET not_needed_at = NULL WHERE id = ?').run(j.item);

  // After 90 days the emailed link has run out.
  clock += DOWNLOAD_LINK_SECONDS * 1000;
  assert.equal((await on.call(link.pathname + link.search, hubHost)).status, 410);
});
