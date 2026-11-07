'use strict';

/* The hub editor's email + PIN sign-in. It retires when the editor moves into
   the admin (merge task R3); until then it works exactly as on the hub. */

const { randomToken, sha256Hex, safeEqual } = require('./tokens');
const { createAttemptThrottle } = require('./throttle');

const ADMIN_SESSION_COOKIE = 'hub_admin_session';

/* The cookie has no Max-Age, so closing the browser signs out. The row still
   expires, for tabs left open for days. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/* The PIN is 4 digits, so the API is all that stands between it and a script:
   attempts are throttled per address, whether they succeed or not. */
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const ATTEMPT_LIMIT = 5;

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const raw = part.slice(idx + 1).trim();
    // Another site's malformed cookie (a stray %) mustn't throw: keep it as sent.
    let value = raw;
    try { value = decodeURIComponent(raw); } catch { /* not percent-encoded */ }
    out[part.slice(0, idx).trim()] = value;
  }
  return out;
}

function createAdminAuth(db, { adminEmail, adminPinHash, now = Date.now } = {}) {
  if (!adminPinHash) {
    throw new Error('HUB_ADMIN_PIN_HASH is required (sha256 hex of the hub editor PIN). Set it in the NAS .env, never in the repo.');
  }
  const email = String(adminEmail || '').trim().toLowerCase();

  const insertSession = db.prepare('INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?, ?, ?)');
  const getSession = db.prepare('SELECT * FROM admin_sessions WHERE token = ?');
  const deleteExpiredSessions = db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?');
  const throttle = createAttemptThrottle({ limit: ATTEMPT_LIMIT, windowMs: ATTEMPT_WINDOW_MS, now });

  function verifyAdminPin(givenEmail, pin) {
    const emailOk = safeEqual((givenEmail || '').trim().toLowerCase(), email);
    const pinStr = String(pin ?? '');
    const pinOk = /^\d{4}$/.test(pinStr) && safeEqual(sha256Hex(pinStr), adminPinHash);
    return emailOk && pinOk;
  }

  function createAdminSession() {
    const t = now();
    deleteExpiredSessions.run(new Date(t).toISOString());
    const token = randomToken(32);
    insertSession.run(token, new Date(t).toISOString(), new Date(t + SESSION_TTL_MS).toISOString());
    return token;
  }

  function setAdminSessionCookie(res, token) {
    res.append('Set-Cookie', `${ADMIN_SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=None; Path=/`);
  }

  function requireAdmin(req, res, next) {
    const token = parseCookies(req.headers.cookie)[ADMIN_SESSION_COOKIE];
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    const row = getSession.get(token);
    if (!row || new Date(row.expires_at).getTime() < now()) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  }

  const isRateLimited = (ip) => throttle.isLimited(ip);
  const recordAttempt = (ip) => throttle.record(ip);
  /** How many addresses the throttle is holding, for the tests. */
  const trackedAddresses = () => throttle.size();

  return { verifyAdminPin, createAdminSession, setAdminSessionCookie, requireAdmin, isRateLimited, recordAttempt, trackedAddresses };
}

module.exports = { createAdminAuth, ADMIN_SESSION_COOKIE, ATTEMPT_LIMIT };
