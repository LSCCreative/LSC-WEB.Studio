'use strict';

/**
 * Who a portal visitor is (merged-admin C1). One Client code per client (IA
 * "Client code"), signed in with their email; a session the server checks on
 * every client route; an invite that only says whose sign-in it is.
 *
 * THE CODE. Six digits, chosen here, shown to the studio once and kept only as
 * an HMAC under the portal's secret: a short code's plain hash would fall to a
 * loop over a backup. Issuing a new one replaces the old, ends the client's
 * sessions, and retires their old per-project codes.
 *
 * OLD CODES. Until a client is issued a Client code, the old hub's per-project
 * codes still sign them in (brief, Defaults 5): a `private_auth` row on one of
 * their projects, for their address, with that code. Those were 4 digits, kept
 * as plain SHA-256 by the old hub. The session it opens is the client's, like any
 * other: projects are reached through the client, never through the old row.
 *
 * ONE ADDRESS, ONE CLIENT (S13). An address two clients share (only possible from
 * before R2) signs nobody in, and can't be given a code.
 *
 * Every refusal is the same refusal: an unknown address, a shared one and a wrong
 * code can't be told apart from outside, and take the same work to answer.
 */

const { randomBytes, randomInt } = require('crypto');
const { sha256Hex, randomToken, hmacSign, safeEqual } = require('./hub/tokens');
const { normEmail, LOGIN_IDS } = require('./clients');

const CODE_DIGITS = 6;
/* What the sign-in form may send: a Client code, or an old 4-digit one. */
const CODE_FORMAT = /^(?:\d{4}|\d{6})$/;
const SESSION_DAYS = 30;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_TOKEN = 200;

/**
 * @param {object} db
 * @param {{ secret: string }} opts  the portal's signing secret (config.hub)
 */
function createPortalAccess(db, { secret } = {}) {
  if (!secret) throw new Error('Portal access needs the portal’s signing secret (HUB_SIGNING_SECRET).');
  const codeHash = (clientId, code) => hmacSign(secret, `client-code\n${clientId}\n${code}`);
  const sessionId = (token) => hmacSign(secret, `client-session\n${token}`);

  const holdersOf = db.prepare('SELECT id FROM clients WHERE email = ? AND email <> \'\'');
  const loginOf = db.prepare('SELECT * FROM client_logins WHERE client_id = ?');
  const legacyCodes = db.prepare(`
    SELECT code_hash FROM private_auth
     WHERE project_id IN (${LOGIN_IDS}) AND email_hash = ? AND code_hash IS NOT NULL
  `);
  const sessionById = db.prepare('SELECT * FROM client_sessions WHERE id = ?');
  const dropSession = db.prepare('DELETE FROM client_sessions WHERE id = ?');

  /** A new Client code and invite for the client, replacing any before. The code and invite come back once. */
  function issue(clientId, { projectId = null, now = new Date().toISOString() } = {}) {
    const code = String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
    const invite = randomToken(24);
    db.transaction(() => {
      db.prepare(`
        INSERT INTO client_logins (client_id, code_hash, invite_hash, invite_project_id, code_set_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(client_id) DO UPDATE SET
          code_hash = excluded.code_hash, invite_hash = excluded.invite_hash,
          invite_project_id = excluded.invite_project_id, code_set_at = excluded.code_set_at,
          updated_at = excluded.updated_at
      `).run(clientId, codeHash(clientId, code), sha256Hex(invite), projectId, now, now);
      // A new code is a reset: whoever was signed in with the old one signs in again.
      db.prepare('DELETE FROM client_sessions WHERE client_id = ?').run(clientId);
    })();
    return { code, invite };
  }

  /** The client this email and code sign in, as { clientId, via }, or null. */
  function signIn(rawEmail, rawCode) {
    const email = normEmail(rawEmail);
    const code = String(rawCode == null ? '' : rawCode);
    const holders = email ? holdersOf.all(email) : [];
    if (holders.length !== 1) {
      codeHash('', code); // the same work as a real check
      return null;
    }
    const clientId = holders[0].id;
    const login = loginOf.get(clientId);
    if (login) return safeEqual(login.code_hash, codeHash(clientId, code)) ? { clientId, via: 'code' } : null;
    const wanted = sha256Hex(code);
    const old = legacyCodes.all(clientId, clientId, sha256Hex(email));
    return old.some((r) => safeEqual(r.code_hash, wanted)) ? { clientId, via: 'legacy' } : null;
  }

  /** A session for the client: the token for the cookie (kept only as its HMAC) and when it ends. */
  function startSession(clientId, via, { userAgent = '', ip = '' } = {}) {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
    db.transaction(() => {
      db.prepare(`
        INSERT INTO client_sessions (id, client_id, via, created_at, expires_at, last_seen_at, user_agent, ip)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(sessionId(token), clientId, via, now.toISOString(), expires.toISOString(), now.toISOString(),
        String(userAgent).slice(0, 255), String(ip).slice(0, 100));
      // Each sign-in clears the client's own expired sessions.
      db.prepare('DELETE FROM client_sessions WHERE client_id = ? AND expires_at <= ?').run(clientId, now.toISOString());
    })();
    return { token, expiresAt: expires };
  }

  /** The live session behind a cookie's token, as { id, clientId, via }, or null. */
  function readSession(token) {
    if (typeof token !== 'string' || !token || token.length > MAX_TOKEN) return null;
    const id = sessionId(token);
    const row = sessionById.get(id);
    if (!row) return null;
    const now = Date.now();
    if (new Date(row.expires_at).getTime() <= now) {
      dropSession.run(id);
      return null;
    }
    if (now - new Date(row.last_seen_at).getTime() > TOUCH_INTERVAL_MS) {
      db.prepare('UPDATE client_sessions SET last_seen_at = ? WHERE id = ?').run(new Date(now).toISOString(), id);
    }
    return { id, clientId: row.client_id, via: row.via };
  }

  function endSession(token) {
    if (typeof token === 'string' && token && token.length <= MAX_TOKEN) dropSession.run(sessionId(token));
  }

  /**
   * Whose sign-in an invite is, as { clientId, email, projectId }, or null. It
   * signs nobody in: the client still gives their code. An old hub invite counts
   * until the client is issued a Client code, as their old code does.
   */
  function inviteFor(token) {
    if (typeof token !== 'string' || !token || token.length > MAX_TOKEN) return null;
    const row = db.prepare(`
      SELECT l.client_id, l.invite_project_id, c.email FROM client_logins l JOIN clients c ON c.id = l.client_id
       WHERE l.invite_hash = ?
    `).get(sha256Hex(token));
    if (row) return { clientId: row.client_id, email: row.email, projectId: row.invite_project_id || null };
    const old = db.prepare(`
      SELECT p.id AS project_id, p.client_id, c.email FROM private_auth a
        JOIN hub_imports i ON i.hub_id = a.project_id
        JOIN projects p ON p.id = i.project_id
        JOIN clients c ON c.id = p.client_id
       WHERE a.invite_token = ?
         AND NOT EXISTS (SELECT 1 FROM client_logins l WHERE l.client_id = p.client_id)
    `).get(token);
    return old ? { clientId: old.client_id, email: old.email, projectId: old.project_id } : null;
  }

  return { issue, signIn, startSession, readSession, endSession, inviteFor };
}

/** What the studio sees of a client's portal access. No secret is in it. */
function accessStatus(db, clientId) {
  const login = db.prepare('SELECT code_set_at, invite_project_id FROM client_logins WHERE client_id = ?').get(clientId);
  const now = new Date().toISOString();
  const sessions = db.prepare(`
    SELECT COUNT(*) AS n, MAX(created_at) AS last FROM client_sessions WHERE client_id = ? AND expires_at > ?
  `).get(clientId, now);
  const legacy = db.prepare(`
    SELECT COUNT(*) AS n FROM private_auth WHERE project_id IN (${LOGIN_IDS}) AND code_hash IS NOT NULL
  `).get(clientId, clientId).n;
  return {
    hasCode: Boolean(login),
    codeSetAt: login ? login.code_set_at : null,
    inviteProjectId: login ? login.invite_project_id || null : null,
    // Old per-project codes that still sign this client in: none once a code is issued.
    oldCodes: login ? 0 : legacy,
    signedIn: sessions.n,
    lastSignInAt: sessions.last || null,
  };
}

module.exports = { createPortalAccess, accessStatus, CODE_FORMAT, CODE_DIGITS, SESSION_DAYS };
