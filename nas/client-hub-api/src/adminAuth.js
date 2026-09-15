import { db } from './db.js';
import { randomToken, sha256Hex, safeEqual } from './crypto.js';

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'lachlan@creativelsc.com').trim().toLowerCase();

// Never the raw PIN — sha256 hex of it. Set in the NAS .env, e.g.
//   node -e "console.log(require('crypto').createHash('sha256').update('2803').digest('hex'))"
const ADMIN_PIN_HASH = process.env.ADMIN_PIN_HASH;
if (!ADMIN_PIN_HASH) {
  throw new Error('ADMIN_PIN_HASH env var is required (sha256 hex of the admin PIN) — set it in the NAS .env, never in the repo.');
}

export const ADMIN_SESSION_COOKIE = 'hub_admin_session';

// Cookie itself carries no Max-Age (browser-session lifetime, matching the
// old sessionStorage-based admin auth: closing the tab signs you out). The
// server-side row still expires as a safety net for tabs left open for days.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const insertSession = db.prepare('INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?, ?, ?)');
const getSession = db.prepare('SELECT * FROM admin_sessions WHERE token = ?');
const deleteExpiredSessions = db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?');

export function verifyAdminPin(email, pin) {
  const emailOk = safeEqual((email || '').trim().toLowerCase(), ADMIN_EMAIL);
  const pinStr = String(pin ?? '');
  const pinOk = /^\d{4}$/.test(pinStr) && safeEqual(sha256Hex(pinStr), ADMIN_PIN_HASH);
  return emailOk && pinOk;
}

export function createAdminSession() {
  deleteExpiredSessions.run(new Date().toISOString());
  const token = randomToken(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  insertSession.run(token, now.toISOString(), expiresAt.toISOString());
  return token;
}

export function setAdminSessionCookie(res, token) {
  res.append('Set-Cookie', `${ADMIN_SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=None; Path=/`);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function requireAdmin(req, res, next) {
  const token = parseCookies(req.headers.cookie)[ADMIN_SESSION_COOKIE];
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  const row = getSession.get(token);
  if (!row || new Date(row.expires_at).getTime() < Date.now()) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// The PIN is only 4 digits (10,000 combinations) — the API itself is the
// only thing standing between that and a brute-force script, so throttle
// attempts per source IP regardless of whether they succeed or fail.
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const ATTEMPT_LIMIT = 5;
const attemptsByIp = new Map();

export function isRateLimited(ip) {
  const now = Date.now();
  const recent = (attemptsByIp.get(ip) || []).filter((t) => now - t < ATTEMPT_WINDOW_MS);
  attemptsByIp.set(ip, recent);
  return recent.length >= ATTEMPT_LIMIT;
}

export function recordAttempt(ip) {
  const recent = attemptsByIp.get(ip) || [];
  recent.push(Date.now());
  attemptsByIp.set(ip, recent);
}
