'use strict';

/* The checklist as the studio works it (merged-admin R3): items, stage, versions
 * and publishing, on the real app, a throwaway database and a temporary
 * deliverables folder. Nothing here can reach real data or the NAS. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-deliverables-'));
process.env.DATA_DIR = TMP;
process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough-0123456789';
process.env.COOKIE_SECURE = '0';
process.env.NODE_ENV = 'test';

const express = require('express');
const { openDatabase, nowIso, newId } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');
const { toRelativeDeliverablePath, streamFile } = require('../src/hub/deliverables');

const DIR = path.join(TMP, 'deliverables');
fs.mkdirSync(path.join(DIR, 'Acme', 'Stills'), { recursive: true });
fs.mkdirSync(path.join(DIR, 'Acme', 'Empty'), { recursive: true });
fs.mkdirSync(path.join(DIR, 'Acme', 'Huge'), { recursive: true });
fs.writeFileSync(path.join(DIR, 'Acme', 'Hero.mp4'), '0123456789');
fs.writeFileSync(path.join(DIR, 'Acme', 'Final.mov'), 'final');
fs.writeFileSync(path.join(DIR, 'Acme', 'Notes.pdf'), 'pdf');
fs.writeFileSync(path.join(DIR, 'Loose.mp4'), 'x');
fs.writeFileSync(path.join(TMP, 'outside.mp4'), 'secret');
for (const n of ['a.jpg', 'b.PNG', 'skip.cr2']) fs.writeFileSync(path.join(DIR, 'Acme', 'Stills', n), n);
for (let i = 0; i < 201; i += 1) fs.writeFileSync(path.join(DIR, 'Acme', 'Huge', `${i}.jpg`), 'x');

const PASSWORD = 'a-long-test-password';
let db;
let server;
let base;
let cookie;

const call = async (method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* a file */ }
  return { status: res.status, body: json, text, headers: res.headers };
};

test.before(async () => {
  db = openDatabase(path.join(TMP, 'billing.db'));
  db.prepare("INSERT INTO account (id, username, password_hash, created_at, updated_at) VALUES (1, 'tester', ?, ?, ?)")
    .run(await hashPassword(PASSWORD), nowIso(), nowIso());
  const app = createApp(db, { deliverablesDir: DIR });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: PASSWORD }),
  });
  cookie = login.headers.getSetCookie()[0].split(';')[0];
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function project({ accepted = true, archived = false, quoted = 0 } = {}) {
  const now = nowIso();
  const id = newId('prj');
  const est = newId('est');
  db.prepare('INSERT INTO projects (id, upid, needs_upid, accepted_at, archived_at, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?)')
    .run(id, id, accepted ? now : null, archived ? now : null, now, now);
  db.prepare("INSERT INTO estimates (id, project_id, upid, name, date, status, client_json, created_at, updated_at) VALUES (?, ?, ?, 'Job', '2026-10-01', ?, '{}', ?, ?)")
    .run(est, id, id, accepted ? 'accepted' : 'draft', now, now);
  const items = [];
  for (let i = 1; i <= quoted; i += 1) {
    const item = newId('dlv');
    db.prepare("INSERT INTO deliverables (id, project_id, position, title, estimate_id, quote_line_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'line', ?, ?)")
      .run(item, id, i, `Quoted ${i}`, est, now, now);
    items.push(item);
  }
  return { id, items };
}

const url = (p, rest = '') => `/api/projects/${p.id}/deliverables${rest}`;
const itemOf = (reply, id) => reply.body.deliverables.find((d) => d.id === id);
const addVersion = (p, item, body) => call('POST', url(p, `/${item}/versions`), body);
const newestOf = (reply, id) => { const v = itemOf(reply, id).versions; return v[v.length - 1]; };

test('NAS paths: the file manager’s absolute path converts; anything else absolute is refused', () => {
  const root = '/volume4/LSC Creative_Media/Client Deliverables_Media';
  assert.equal(toRelativeDeliverablePath(`${root}/Acme/Hero.mp4`), 'Acme/Hero.mp4');
  assert.equal(toRelativeDeliverablePath('Acme/Hero.mp4'), 'Acme/Hero.mp4');
  assert.equal(toRelativeDeliverablePath('/volume4/Other/Hero.mp4'), null);
  assert.equal(toRelativeDeliverablePath(`${root}Extra/Hero.mp4`), null, 'a share whose name only starts the same');
});

test('the checklist needs the login, and opens at acceptance', async () => {
  const p = project();
  const res = await fetch(`${base}${url(p)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401);
  const quote = project({ accepted: false });
  const early = await call('POST', url(quote), { title: 'Too soon' });
  assert.deepEqual([early.status, early.body.error], [409, 'not_accepted']);
  assert.equal((await call('POST', '/api/projects/nope/deliverables', { title: 'x' })).status, 404);
});

test('an extra is added last, needs a title, and can go while nothing is published', async () => {
  const p = project({ quoted: 1 });
  assert.equal((await call('POST', url(p), { title: '  ' })).status, 400);
  assert.equal((await call('POST', url(p), { title: 'x'.repeat(201) })).status, 400);
  const added = await call('POST', url(p), { title: ' Behind the scenes ', format: '9:16', duration: '30s' });
  assert.equal(added.status, 200);
  const extra = added.body.deliverables[1];
  assert.deepEqual([extra.title, extra.format, extra.duration, extra.position, extra.stage], ['Behind the scenes', '9:16', '30s', 2, 'draft']);
  assert.ok(added.body.activity.some((a) => a.kind === 'deliverable_added'));

  assert.equal((await call('DELETE', url(p, `/${p.items[0]}`))).body.error, 'quoted_item');
  const gone = await call('DELETE', url(p, `/${extra.id}`));
  assert.equal(gone.body.deliverables.length, 1);

  const kept = (await call('POST', url(p), { title: 'Seen' })).body.deliverables[1];
  const withFile = await addVersion(p, kept.id, { path: 'Acme/Hero.mp4' });
  await call('POST', url(p, `/${kept.id}/versions/${newestOf(withFile, kept.id).id}/publish`));
  assert.equal((await call('DELETE', url(p, `/${kept.id}`))).body.error, 'has_published');
});

test('another project’s item or version is a 404, on every route', async () => {
  const mine = project({ quoted: 1 });
  const theirs = project({ quoted: 1 });
  const reply = await addVersion(theirs, theirs.items[0], { path: 'Acme/Hero.mp4' });
  const version = newestOf(reply, theirs.items[0]).id;
  assert.equal((await call('PUT', url(mine, `/${theirs.items[0]}`), { title: 'Mine now' })).status, 404);
  assert.equal((await call('DELETE', url(mine, `/${theirs.items[0]}`))).status, 404);
  assert.equal((await addVersion(mine, theirs.items[0], { path: 'Acme/Hero.mp4' })).status, 404);
  assert.equal((await call('POST', url(mine, `/${theirs.items[0]}/versions/${version}/publish`))).status, 404);
  assert.equal((await call('POST', url(mine, `/${mine.items[0]}/versions/${version}/publish`))).status, 404);
  assert.equal((await call('GET', url(mine, `/${mine.items[0]}/versions/${version}/file`))).status, 404);
});

test('a version’s path is checked against the NAS, inside the folder only', async () => {
  const p = project({ quoted: 1 });
  const refused = async (pathValue) => (await addVersion(p, p.items[0], { path: pathValue })).body.error;
  assert.equal(await refused(''), 'path_required');
  assert.equal(await refused('Acme/Nope.mp4'), 'file_not_found');
  assert.equal(await refused('Loose.mp4'), 'not_in_project_folder');
  assert.equal(await refused('Acme/Notes.pdf'), 'not_a_video');
  assert.equal(await refused('../outside.mp4'), 'file_not_found', 'out of the folder reads as nothing there');
  assert.equal(await refused('Acme/../../outside.mp4'), 'file_not_found');
  assert.equal(await refused('/etc/passwd'), 'outside_share');
  assert.equal(await refused('Acme/Empty'), 'no_images');
  assert.equal(await refused('Acme/Huge'), 'too_many_images');
  assert.equal((await addVersion(p, p.items[0], { path: 'Acme/Hero.mp4', driveLink: 'javascript:alert(1)' })).body.error, 'link_invalid');
  assert.deepEqual(itemOf(await call('GET', `/api/projects/${p.id}`), p.items[0]).versions, []);
});

test('a video and a photo folder make numbered versions, in the item’s stage', async () => {
  const p = project({ quoted: 1 });
  const nasRoot = '/volume4/LSC Creative_Media/Client Deliverables_Media';
  const video = await addVersion(p, p.items[0], { path: `${nasRoot}/Acme/./Hero.mp4`, driveLink: 'https://drive.example/hero' });
  assert.equal(video.status, 200, JSON.stringify(video.body));
  const v1 = newestOf(video, p.items[0]);
  assert.deepEqual([v1.n, v1.stage, v1.kind, v1.sourcePath, v1.fileName, v1.driveLink, v1.publishedAt],
    [1, 'draft', 'video', 'Acme/Hero.mp4', 'Hero.mp4', 'https://drive.example/hero', null]);

  const photos = await addVersion(p, p.items[0], { path: 'Acme/Stills/' });
  const v2 = newestOf(photos, p.items[0]);
  assert.deepEqual([v2.n, v2.kind, v2.sourcePath, v2.photoCount, v2.fileName], [2, 'photos', 'Acme/Stills', 2, 'Stills']);
  const edited = await call('PUT', url(p, `/${p.items[0]}/versions/${v2.id}`), { driveLink: 'https://drive.example/stills' });
  assert.equal(newestOf(edited, p.items[0]).driveLink, 'https://drive.example/stills');
});

test('publishing: the newest only, once, and the project goes In review', async () => {
  const p = project({ quoted: 1 });
  const first = newestOf(await addVersion(p, p.items[0], { path: 'Acme/Hero.mp4' }), p.items[0]);
  const second = newestOf(await addVersion(p, p.items[0], { path: 'Acme/Final.mov' }), p.items[0]);
  assert.equal((await call('POST', url(p, `/${p.items[0]}/versions/${first.id}/publish`))).body.error, 'not_newest');
  assert.equal((await call('DELETE', url(p, `/${p.items[0]}/versions/${first.id}`))).body.error, 'not_newest');

  const before = await call('GET', `/api/projects/${p.id}`);
  assert.equal(before.body.project.delivery.badge, 'in_production');
  const published = await call('POST', url(p, `/${p.items[0]}/versions/${second.id}/publish`));
  assert.equal(published.status, 200);
  assert.ok(newestOf(published, p.items[0]).publishedAt);
  assert.equal(published.body.project.delivery.badge, 'in_review');

  const at = newestOf(published, p.items[0]).publishedAt;
  const again = await call('POST', url(p, `/${p.items[0]}/versions/${second.id}/publish`));
  assert.equal(newestOf(again, p.items[0]).publishedAt, at, 'twice is the same as once');
  assert.equal(again.body.activity.filter((a) => a.kind === 'version_published').length, 1);
  assert.equal((await call('DELETE', url(p, `/${p.items[0]}/versions/${second.id}`))).body.error, 'published');

  // A file gone from the NAS since it was added can't be published.
  fs.writeFileSync(path.join(DIR, 'Acme', 'Temp.mp4'), 'x');
  const third = newestOf(await addVersion(p, p.items[0], { path: 'Acme/Temp.mp4' }), p.items[0]);
  fs.rmSync(path.join(DIR, 'Acme', 'Temp.mp4'));
  const missing = await call('POST', url(p, `/${p.items[0]}/versions/${third.id}/publish`));
  assert.equal(missing.body.error, 'file_missing');
  assert.match(missing.body.message, /Temp\.mp4/);
  // The NAS being away isn't the file being gone, and adding says so too.
  fs.renameSync(DIR, `${DIR}-away`);
  try {
    const away = await call('POST', url(p, `/${p.items[0]}/versions/${third.id}/publish`));
    assert.deepEqual([away.status, away.body.error], [503, 'nas_unreachable']);
    assert.equal((await addVersion(p, p.items[0], { path: 'Acme/Hero.mp4' })).status, 503);
  } finally {
    fs.renameSync(`${DIR}-away`, DIR);
  }
  // Removing that mistake puts v2 back as the newest.
  const removed = await call('DELETE', url(p, `/${p.items[0]}/versions/${third.id}`));
  assert.equal(newestOf(removed, p.items[0]).n, 2);
});

test('a newer version still unpublished doesn’t take back what the client has', async () => {
  const p = project({ quoted: 1 });
  const v1 = newestOf(await addVersion(p, p.items[0], { path: 'Acme/Hero.mp4' }), p.items[0]);
  const published = await call('POST', url(p, `/${p.items[0]}/versions/${v1.id}/publish`));
  assert.equal(published.body.project.delivery.badge, 'in_review');
  const added = await addVersion(p, p.items[0], { path: 'Acme/Final.mov' });
  assert.equal(added.body.project.delivery.badge, 'in_review');
  const list = await call('GET', `/api/projects?stage=in-review&q=${encodeURIComponent(p.id)}`);
  assert.deepEqual(list.body.projects.map((x) => x.id), [p.id]);
});

test('the stage says what the next version is, and never rewrites a published one', async () => {
  const p = project({ quoted: 1 });
  assert.equal((await call('PUT', url(p, `/${p.items[0]}`), { stage: 'gated' })).body.error, 'stage_invalid');
  const v1 = newestOf(await addVersion(p, p.items[0], { path: 'Acme/Hero.mp4' }), p.items[0]);
  const flipped = await call('PUT', url(p, `/${p.items[0]}`), { stage: 'final' });
  assert.deepEqual([itemOf(flipped, p.items[0]).stage, newestOf(flipped, p.items[0]).stage], ['final', 'final'], 'unpublished: it follows');
  const back = await call('PUT', url(p, `/${p.items[0]}`), { stage: 'draft' });
  await call('POST', url(p, `/${p.items[0]}/versions/${v1.id}/publish`));
  const after = await call('PUT', url(p, `/${p.items[0]}`), { stage: 'final' });
  assert.deepEqual([itemOf(after, p.items[0]).stage, newestOf(after, p.items[0]).stage], ['final', 'draft'], 'published: it stays what the client saw');
  const v2 = newestOf(await addVersion(p, p.items[0], { path: 'Acme/Final.mov' }), p.items[0]);
  assert.deepEqual([v2.n, v2.stage], [2, 'final']);
  assert.equal(back.status, 200);
});

test('not needed: leaves the count, can’t take a file, and can be undone', async () => {
  const p = project({ quoted: 2 });
  const off = await call('PUT', url(p, `/${p.items[0]}`), { notNeeded: true });
  assert.ok(itemOf(off, p.items[0]).notNeededAt);
  assert.deepEqual(off.body.project.delivery.checklist, { total: 2, approved: 0, notNeeded: 1, open: 1 });
  assert.equal((await addVersion(p, p.items[0], { path: 'Acme/Hero.mp4' })).body.error, 'not_needed');
  const atFirst = itemOf(off, p.items[0]).notNeededAt;
  const twice = await call('PUT', url(p, `/${p.items[0]}`), { notNeeded: true, title: 'Renamed' });
  assert.equal(itemOf(twice, p.items[0]).notNeededAt, atFirst);
  const on = await call('PUT', url(p, `/${p.items[0]}`), { notNeeded: false });
  assert.equal(itemOf(on, p.items[0]).notNeededAt, null);

  // Every item not needed, and payment off: Complete.
  await call('PUT', url(p, `/${p.items[0]}`), { notNeeded: true });
  const done = await call('PUT', url(p, `/${p.items[1]}`), { notNeeded: true });
  assert.equal(done.body.project.delivery.badge, 'complete');
  const reopened = await call('POST', url(p), { title: 'One more' });
  assert.equal(reopened.body.project.delivery.badge, 'in_production', 'adding work moves it back to Live');
});

test('an empty checklist asks, until an item is added or none are expected', async () => {
  const p = project();
  const open = await call('GET', `/api/projects/${p.id}`);
  assert.deepEqual(open.body.project.delivery.asks, ['checklist_empty']);
  const none = await call('POST', `/api/projects/${p.id}/no-deliverables`, { on: true });
  assert.deepEqual([none.body.project.delivery.asks, none.body.project.delivery.badge, Boolean(none.body.project.noDeliverablesAt)], [[], 'complete', true]);
  const undone = await call('POST', `/api/projects/${p.id}/no-deliverables`, { on: false });
  assert.deepEqual(undone.body.project.delivery.asks, ['checklist_empty']);
  // Adding work takes the answer back: removing it again asks, rather than completing.
  await call('POST', `/api/projects/${p.id}/no-deliverables`, { on: true });
  const added = await call('POST', url(p), { title: 'After all' });
  assert.equal(added.body.project.noDeliverablesAt, null);
  const removed = await call('DELETE', url(p, `/${added.body.deliverables[0].id}`));
  assert.deepEqual([removed.body.project.delivery.asks, removed.body.project.delivery.badge], [['checklist_empty'], 'in_production']);
  const busy = project({ quoted: 1 });
  assert.equal((await call('POST', `/api/projects/${busy.id}/no-deliverables`, { on: true })).body.error, 'has_items');
});

test('an archived project is filed: nothing about it changes until it’s unarchived', async () => {
  const p = project({ quoted: 1, archived: true });
  assert.equal((await call('POST', url(p), { title: 'Late' })).body.error, 'archived');
  assert.equal((await call('PUT', url(p, `/${p.items[0]}`), { title: 'Late' })).body.error, 'archived');
  assert.equal((await addVersion(p, p.items[0], { path: 'Acme/Hero.mp4' })).body.error, 'archived');
  assert.equal((await call('POST', `/api/projects/${p.id}/no-deliverables`, { on: true })).body.error, 'archived');
});

test('the studio’s preview reads the file behind the login, with Range, and mints no public link', async () => {
  const p = project({ quoted: 2 });
  const tokensBefore = db.prepare('SELECT COUNT(*) AS n FROM deliverable_tokens').get().n;
  const v = newestOf(await addVersion(p, p.items[0], { path: 'Acme/Hero.mp4' }), p.items[0]);
  const fileUrl = url(p, `/${p.items[0]}/versions/${v.id}/file`);
  const full = await call('GET', fileUrl);
  assert.deepEqual([full.status, full.text, full.headers.get('content-type'), full.headers.get('content-disposition')], [200, '0123456789', 'video/mp4', 'inline']);
  const part = await fetch(base + fileUrl, { headers: { cookie, range: 'bytes=2-4' } });
  assert.deepEqual([part.status, await part.text()], [206, '234']);
  assert.equal((await fetch(base + fileUrl)).status, 401);

  const photos = newestOf(await addVersion(p, p.items[1], { path: 'Acme/Stills' }), p.items[1]);
  const photoUrl = url(p, `/${p.items[1]}/versions/${photos.id}/file`);
  assert.deepEqual((await call('GET', photoUrl)).body.photos, ['a.jpg', 'b.PNG'], 'images only');
  assert.equal((await call('GET', `${photoUrl}?name=a.jpg`)).text, 'a.jpg');
  for (const name of ['skip.cr2', '../Hero.mp4', '../../outside.mp4']) {
    assert.equal((await call('GET', `${photoUrl}?name=${encodeURIComponent(name)}`)).status, 404, name);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deliverable_tokens').get().n, tokensBefore);
});

test('a read that fails after the stat, or a client leaving, doesn’t hurt the server', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'stream-'));
  const big = path.join(dir, 'big.mp4');
  fs.closeSync(fs.openSync(big, 'w'));
  fs.truncateSync(big, 50 * 1024 * 1024);
  const stat = fs.statSync(big);
  const app = express();
  app.get('/gone', (req, res) => streamFile(req, res, path.join(dir, 'gone.mp4'), stat, false));
  app.get('/big', (req, res) => streamFile(req, res, big, stat, false));
  const local = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  const at = `http://127.0.0.1:${local.address().port}`;
  try {
    const gone = await fetch(`${at}/gone`);
    assert.deepEqual([gone.status, await gone.json(), gone.headers.get('accept-ranges')], [404, { error: 'not_found' }, null]);

    const descriptors = () => fs.readdirSync('/dev/fd').length;
    const before = descriptors();
    for (let i = 0; i < 20; i += 1) {
      const leaving = new AbortController();
      const reply = await fetch(`${at}/big`, { signal: leaving.signal });
      leaving.abort();
      await reply.body.cancel().catch(() => {});
    }
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    assert.ok(descriptors() - before < 10, `${descriptors() - before} descriptors left open`);
    assert.equal((await fetch(`${at}/gone`)).status, 404, 'still answering');
  } finally {
    local.closeAllConnections();
    await new Promise((resolve) => local.close(resolve));
  }
});

test('the folder reply carries imported sign-off evidence for the Documents tab', async () => {
  const p = project();
  assert.equal((await call('GET', `/api/projects/${p.id}`)).body.evidence, null);
  db.prepare("INSERT INTO records (project_id, data, updated_at) VALUES (?, '{}', 'x')").run(p.id);
  db.prepare(`
    INSERT INTO agreement_evidence (project_id, signer_name, signed_at, signature_data_url, consent_text, consent_checked,
      user_agent, verification_token, ip_address, received_at)
    VALUES (?, 'Priya', '2026-09-01', 'data:image/png;base64,AAAA', 'I agree', 1, 'UA', 'vt', '203.0.113.9', '2026-09-01T01:00:00Z')
  `).run(p.id);
  const { evidence } = (await call('GET', `/api/projects/${p.id}`)).body;
  assert.deepEqual([evidence.signerName, evidence.ipAddress, evidence.consentText], ['Priya', '203.0.113.9', 'I agree']);
});
