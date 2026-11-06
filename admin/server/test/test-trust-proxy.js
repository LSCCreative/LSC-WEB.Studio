'use strict';

/* The login throttle counts per client address. Behind the tunnel that address
   is the last X-Forwarded-For entry, the one Cloudflare wrote. Anything before
   it is whatever the client sent, so it must not change who a request is from. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Must be set before config.js is loaded, so the test never touches the real
// .env, the real data directory, or the real billing.db.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-proxy-'));
process.env.DATA_DIR = TMP;
process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough-0123456789';
process.env.COOKIE_SECURE = '0'; // the test server speaks plain HTTP
process.env.NODE_ENV = 'test';

const { openDatabase, nowIso } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');

const USERNAME = 'lachlan';

let server;
let baseUrl;
let db;

const attempt = (forwardedFor) => fetch(baseUrl + '/api/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': forwardedFor },
  body: JSON.stringify({ username: USERNAME, password: 'wrong' }),
});

test.before(async () => {
  db = openDatabase(path.join(TMP, 'billing.db'));
  db.prepare(`
    INSERT INTO account (id, username, password_hash, created_at, updated_at)
    VALUES (1, ?, ?, ?, ?)
  `).run(USERNAME, await hashPassword('correct-horse-battery-staple'), nowIso(), nowIso());
  const app = createApp(db);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (server) server.close();
  if (db) db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('a forged X-Forwarded-For entry can’t dodge the login throttle', async () => {
  for (let i = 1; i <= 3; i += 1) {
    assert.equal((await attempt(`10.0.0.${i}, 203.0.113.7`)).status, 401);
  }
  assert.equal((await attempt('10.0.0.4, 203.0.113.7')).status, 429);
});

test('a different visitor behind the same tunnel has their own count', async () => {
  assert.equal((await attempt('203.0.113.8')).status, 401);
});
