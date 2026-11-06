'use strict';

/* The admin served by the server (merge task M4): its pages, a config.js
   written from settings, and fresh scripts after every change (safeguard
   S17). Most tests run on a small throwaway web/ folder, so a file can be
   changed under a running server; the last ones check the real pages. */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-web-'));
process.env.DATA_DIR = TMP;
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough-0123456789';
process.env.COOKIE_SECURE = '0';
process.env.LSC_MAPS_KEY = 'the-developers-real-key';

const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');
const express = require('express');
const { createWebRouter, WEB_DIR, MIRRORS } = require('../src/web');

const HUB_HOST = 'hub.example';
const WEB = path.join(TMP, 'web');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

function write(rel, text) {
  fs.mkdirSync(path.dirname(path.join(WEB, rel)), { recursive: true });
  fs.writeFileSync(path.join(WEB, rel), text);
}

write('index.html', [
  '<!doctype html><meta name="lsc-version" content=""><title>Admin</title>',
  '<link rel="stylesheet" href="css/app.css">',
  '<link rel="icon" type="image/png" href="favicon.png">',
  '<script src="https://maps.example/api.js"></script>',
  '<script src="/js/rooted.js"></script>',
  '<script src="js/config.js"></script>',
  '<script src="js/calc.js"></script>',
  '<script src="js/missing.js"></script>',
].join('\n'));
write('c/index.html', '<link rel="stylesheet" href="c.css"><script src="../js/config.js"></script><script src="../js/calc.js"></script><script src="c.js"></script>');
write('c/c.js', 'window.C = 1;');
write('c/c.css', 'body{}');
write('css/app.css', 'body{color:red}');
write('js/calc.js', 'window.LSCCalc = { version: 1 };');
write('js/config.js', "window.LSC_API_BASE = 'http://left-on-disk.example';");
write('favicon.png', 'png');
write('README.md', 'internal notes');
write('.env', 'SECRET=1');

async function start(opts = {}) {
  const db = openDatabase(path.join(TMP, `app-${crypto.randomBytes(4).toString('hex')}.db`));
  // The fixture has no copies of the server's files to check, and is edited
  // under the running server, so it is read afresh on every request.
  const app = createApp(db, { webDir: WEB, webMirrors: [], webRecheckMs: 0, ...opts });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const { port } = server.address();
  const call = (p, { method = 'GET', host = `127.0.0.1:${port}`, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host, ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end();
  });
  const close = async () => {
    await new Promise((r) => server.close(r));
    db.close();
  };
  return { call, close };
}

/** The address a page gives a file, as written in its markup. */
const addressOf = (html, file) => {
  const m = new RegExp(`(?:src|href)="(${file.replace(/[.]/g, '\\.')}(?:\\?v=[0-9a-f]+)?)"`).exec(html);
  return m && m[1];
};

let s;
test.before(async () => { s = await start(); });
test.after(async () => { await s.close(); });

test('the admin page names each local script and stylesheet by its contents', async () => {
  const page = await s.call('/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.equal(page.headers['cache-control'], 'no-cache', 'the page is asked for every time');
  assert.equal(addressOf(page.text, 'js/calc.js'), `js/calc.js?v=${sha('window.LSCCalc = { version: 1 };')}`);
  assert.equal(addressOf(page.text, 'css/app.css'), `css/app.css?v=${sha('body{color:red}')}`);
  assert.match(page.text, /src="js\/config\.js"/, 'config.js is written per request, so it carries no stamp');
  assert.match(page.text, /src="https:\/\/maps\.example\/api\.js"/, 'another site’s script is left alone');
  assert.match(page.text, /src="\/js\/rooted\.js"/, 'so is a rooted address');
  assert.match(page.text, /src="js\/missing\.js"/, 'a file that isn’t there is left as written');
  assert.equal((await s.call('/index.html')).text, page.text);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal(page.headers['content-security-policy'], "frame-ancestors 'none'");
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
});

test('a browser holding the old version loads the new calc.js (S17)', async () => {
  const before = addressOf((await s.call('/')).text, 'js/calc.js');
  const cached = await s.call(`/${before}`);
  assert.equal(cached.text, 'window.LSCCalc = { version: 1 };');
  assert.equal(cached.headers['cache-control'], 'public, max-age=31536000, immutable',
    'an address naming its contents can be kept');

  // A deploy, or an edit while the server runs: same size, so only the contents tell.
  write('js/calc.js', 'window.LSCCalc = { version: 2 };');
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(WEB, 'js/calc.js'), t, t);
  try {
    const page = await s.call('/');
    assert.equal(page.headers['cache-control'], 'no-cache', 'so the browser asks for the page again');
    const after = addressOf(page.text, 'js/calc.js');
    assert.notEqual(after, before, 'and the page names an address it has never cached');
    const fresh = await s.call(`/${after}`);
    assert.equal(fresh.text, 'window.LSCCalc = { version: 2 };');
    assert.equal(`js/calc.js?v=${sha(fresh.text)}`, after, 'a long-kept address holds the bytes its stamp names');
    assert.equal(fresh.headers['cache-control'], 'public, max-age=31536000, immutable');
    const old = await s.call(`/${before}`);
    assert.equal(old.headers['cache-control'], 'no-cache', 'an out-of-date stamp is never kept for long');
    assert.equal(old.text, 'window.LSCCalc = { version: 2 };');
  } finally {
    write('js/calc.js', 'window.LSCCalc = { version: 1 };');
  }
});

test('a file asked for without its stamp is revalidated, not kept', async () => {
  for (const p of ['/js/calc.js', '/js/calc.js?v=forged', '/favicon.png', '/c/c.css']) {
    const r = await s.call(p);
    assert.deepEqual([r.status, r.headers['cache-control']], [200, 'no-cache'], p);
    assert.ok(r.headers.etag, `${p} has an ETag to revalidate by`);
  }
});

test('the client page’s own and shared files are stamped too, from its folder', async () => {
  assert.equal((await s.call('/c')).status, 301, '/c goes to /c/, where its relative addresses work');
  const page = await s.call('/c/');
  assert.equal(page.headers['cache-control'], 'no-cache');
  assert.equal(addressOf(page.text, '../js/calc.js'), `../js/calc.js?v=${sha('window.LSCCalc = { version: 1 };')}`);
  assert.equal(addressOf(page.text, 'c.js'), `c.js?v=${sha('window.C = 1;')}`);
  assert.equal(addressOf(page.text, 'c.css'), `c.css?v=${sha('body{}')}`);
  assert.match(page.text, /src="\.\.\/js\/config\.js"/);
  assert.equal((await s.call('/c/index.html')).text, page.text);
});

test('config.js is written from settings, never read from disk', async () => {
  const r = await s.call('/js/config.js');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /javascript/);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.doesNotMatch(r.text, /left-on-disk/);
  assert.match(r.text, /window\.LSC_API_BASE = window\.location\.origin;/, 'the API is the page’s own origin');
  assert.doesNotMatch(r.text, /the-developers-real-key/, 'a test never reads the real Maps key');
  assert.match(r.text, /window\.LSC_MAPS_KEY = "";/);

  const set = await start({ webMaps: { key: 'browser-key', mapId: '</script><script>alert(1)//' } });
  try {
    const c = (await set.call('/js/config.js')).text;
    assert.match(c, /window\.LSC_MAPS_KEY = "browser-key";/);
    assert.match(c, /window\.LSC_MAPS_ID = "\\u003c\/script>\\u003cscript>alert\(1\)\/\/";/, 'a value can’t close the script');
    const run = new Function('window', `${c}; return window;`)({ location: { origin: 'https://app.example' } });
    assert.deepEqual([run.LSC_API_BASE, run.LSC_MAPS_KEY, run.LSC_MAPS_ID],
      ['https://app.example', 'browser-key', '</script><script>alert(1)//']);
  } finally { await set.close(); }
});

test('only the folders the pages need are served', async () => {
  for (const p of ['/README.md', '/.env', '/js/../README.md', '/%2e%2e/package.json', '/css/', '/nope.html']) {
    assert.equal((await s.call(p)).status, 404, p);
  }
  for (const p of ['/css/app.css', '/favicon.png', '/c/c.js']) {
    assert.equal((await s.call(p)).status, 200, p);
  }
  const api = await s.call('/api/nope');
  assert.equal(api.status, 401, '/api is still behind the session gate');
  assert.equal((await s.call('/js/calc.js', { method: 'POST' })).status, 404);
});

test('the portal’s hostname serves none of the admin (S4)', async () => {
  const hub = await start({ hub: {
    signingSecret: 'test-signing-secret', adminEmail: 'owner@lsc.example', adminPinHash: sha('4821'),
    corsOrigins: ['https://lsccreative.studio'], publicBaseUrl: `https://${HUB_HOST}`,
    deliverablesDir: TMP, backupDir: path.join(TMP, 'backups'), bunny: {},
  } });
  try {
    for (const p of ['/', '/index.html', '/js/config.js', '/js/calc.js', '/c/', '/favicon.png']) {
      const r = await hub.call(p, { host: HUB_HOST });
      assert.deepEqual([r.status, r.text], [404, '{"error":"not found"}'], p);
    }
    assert.equal((await hub.call('/')).status, 200, 'the admin’s own hostname still gets it');
  } finally { await hub.close(); }
});

test('every script and stylesheet the real pages name exists, and is stamped', async () => {
  const real = await start({ webDir: WEB_DIR, webMirrors: undefined });
  try {
    for (const [p, dir] of [['/', ''], ['/c/', 'c/']]) {
      const html = (await real.call(p)).text;
      const refs = [...html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+\.(?:js|css)(?:\?v=[0-9a-f]+)?)"/g)].map((m) => m[1]);
      assert.ok(refs.length > 3, `${p} names its files`);
      for (const ref of refs) {
        if (/js\/config\.js$/.test(ref)) continue;
        assert.match(ref, /\?v=[0-9a-f]{12}$/, `${p}: ${ref} is stamped`);
        const file = path.posix.normalize(path.posix.join(dir, ref.replace(/\?.*$/, '')));
        const r = await real.call(`/${file}${ref.slice(ref.indexOf('?'))}`);
        assert.deepEqual([r.status, r.headers['cache-control']], [200, 'public, max-age=31536000, immutable'], file);
      }
    }
    const calc = (await real.call('/')).text.match(/src="js\/calc\.js\?v=([0-9a-f]+)"/);
    assert.ok(calc, 'calc.js, the file S17 exists for, is among them');
    assert.equal(calc[1], sha(fs.readFileSync(path.join(WEB_DIR, 'js', 'calc.js'))));
  } finally { await real.close(); }
});

test('an unchanged file answers 304 to the ETag it was sent with', async () => {
  const first = await s.call('/js/calc.js');
  const again = await s.call('/js/calc.js', { headers: { 'if-none-match': first.headers.etag } });
  assert.deepEqual([again.status, again.text], [304, '']);
});

test('config.js is the generated one however its address is spelt', async () => {
  for (const p of ['/js/./config.js', '/js//config.js', '/js/%2e/config.js', '/c/../js/config.js', '/js/CONFIG.js']) {
    const r = await s.call(p);
    assert.equal(r.status, 200, p);
    assert.match(r.text, /window\.location\.origin/, p);
    assert.doesNotMatch(r.text, /left-on-disk/, p);
    assert.equal(r.headers['cache-control'], 'no-store', p);
  }
});

test('the page carries its version, and every /api reply the current one', async () => {
  const page = await s.call('/');
  const mine = /<meta name="lsc-version" content="([0-9a-f]{12})">/.exec(page.text);
  assert.ok(mine, 'the server fills the page’s version in');
  for (const p of ['/api/session', '/api/nope']) {
    assert.equal((await s.call(p)).headers['x-lsc-version'], mine[1], `${p}, signed in or not`);
  }
  assert.equal((await s.call('/health')).headers['x-lsc-version'], undefined, 'only /api says it');

  write('js/calc.js', 'window.LSCCalc = { version: 3 };');
  try {
    const now = (await s.call('/api/session')).headers['x-lsc-version'];
    assert.notEqual(now, mine[1], 'a changed script is a new version, so an open tab hears of it');
    assert.match((await s.call('/')).text, new RegExp(`content="${now}"`), 'and a reload carries it');
  } finally {
    write('js/calc.js', 'window.LSCCalc = { version: 1 };');
  }
  assert.doesNotMatch((await s.call('/c/')).text, /lsc-version/, 'the client page has none');
});

test('files are trusted for a second, not read on every request', async () => {
  let t = 1000;
  const router = createWebRouter({ dir: WEB, mirrors: [], now: () => t });
  const app = express().use(router);
  const server = await new Promise((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
  const get = (p) => fetch(`http://127.0.0.1:${server.address().port}${p}`).then((r) => r.text());
  try {
    const v1 = router.version();
    assert.equal(await get('/c/c.css'), 'body{}');
    write('c/c.css', 'body{color:blue}');
    write('js/calc.js', 'window.LSCCalc = { version: 9 };');
    assert.equal(router.version(), v1, 'within the second, the file as last read');
    assert.equal(await get('/c/c.css'), 'body{}');
    t += 1000;
    assert.notEqual(router.version(), v1, 'after it, the change');
    assert.equal(await get('/c/c.css'), 'body{color:blue}');
  } finally {
    write('c/c.css', 'body{}');
    write('js/calc.js', 'window.LSCCalc = { version: 1 };');
    await new Promise((r) => server.close(r));
  }
});

test('it won’t start without the pages, or with a copy that differs from the server’s', () => {
  const empty = fs.mkdtempSync(path.join(TMP, 'empty-'));
  assert.throws(() => createWebRouter({ dir: empty, mirrors: [] }), /index\.html is missing/);

  const mirror = fs.mkdtempSync(path.join(TMP, 'mirror-'));
  fs.writeFileSync(path.join(mirror, 'index.html'), '<!doctype html>');
  fs.mkdirSync(path.join(mirror, 'js'));
  const server = path.join(mirror, 'server-calc.js');
  fs.writeFileSync(server, 'calc v2');
  fs.writeFileSync(path.join(mirror, 'js', 'calc.js'), 'calc v1');
  const mirrors = [{ web: 'js/calc.js', server }];
  assert.throws(() => createWebRouter({ dir: mirror, mirrors }), /web\/js\/calc\.js doesn.t match/);
  fs.unlinkSync(path.join(mirror, 'js', 'calc.js'));
  assert.throws(() => createWebRouter({ dir: mirror, mirrors }), /doesn.t match/, 'a missing copy is a mismatch too');
  fs.writeFileSync(path.join(mirror, 'js', 'calc.js'), 'calc v2');
  assert.doesNotThrow(() => createWebRouter({ dir: mirror, mirrors }));

  const db = openDatabase(path.join(TMP, 'refuse.db'));
  assert.throws(() => createApp(db, { webDir: empty }), /index\.html is missing/, 'createApp refuses too');
  db.close();
  assert.deepEqual(MIRRORS.map((m) => m.web), ['js/calc.js', 'js/documents.js', 'js/call-sheet.js']);
  assert.doesNotThrow(() => createWebRouter({ dir: WEB_DIR }), 'the real web/ matches the real server');
});
