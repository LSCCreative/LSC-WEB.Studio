// Reimplements client-hub-docs/hub-edge-script.js's four /hub/* routes
// against SQLite instead of flat Bunny Storage JSON blobs, plus the new
// POST /hub/admin-auth. Request/response shapes match the Edge Script
// exactly so client-hub-app/index.html's hubApi needs no logic changes
// (Slice 5 only repoints HUB_CONFIG.edgeBase and adds credentials:'include').
import { Router } from 'express';
import { db } from './db.js';
import { sha256Hex, randomToken } from './crypto.js';
import { signedUrl, verifyPath } from './signing.js';
import { resolveDeliverablePath, streamFile } from './deliverables.js';
import { credentialedCors, openCors } from './cors.js';
import {
  requireAdmin,
  verifyAdminPin,
  createAdminSession,
  setAdminSessionCookie,
  isRateLimited,
  recordAttempt,
} from './adminAuth.js';

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://hub-api.lsccreative.studio';

const upsertRecord = db.prepare(`
  INSERT INTO records (project_id, data, updated_at)
  VALUES (@project_id, @data, @updated_at)
  ON CONFLICT(project_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`);
const upsertPrivateAuth = db.prepare(`
  INSERT INTO private_auth (project_id, client_email, email_hash, code_hash, invite_token, delivered, updated_at)
  VALUES (@project_id, @client_email, @email_hash, @code_hash, @invite_token, @delivered, @updated_at)
  ON CONFLICT(project_id) DO UPDATE SET
    client_email = excluded.client_email,
    email_hash   = excluded.email_hash,
    code_hash    = excluded.code_hash,
    invite_token = excluded.invite_token,
    delivered    = excluded.delivered,
    updated_at   = excluded.updated_at
`);
const getRecord = db.prepare('SELECT data FROM records WHERE project_id = ?');
const findByEmailHash = db.prepare('SELECT * FROM private_auth WHERE email_hash = ?');
const findByInviteToken = db.prepare('SELECT * FROM private_auth WHERE invite_token = ?');

const insertDeliverableToken = db.prepare(`
  INSERT INTO deliverable_tokens (token, relative_path, created_at)
  VALUES (?, ?, ?)
  ON CONFLICT(relative_path) DO NOTHING
`);
const findDeliverableTokenByPath = db.prepare('SELECT token FROM deliverable_tokens WHERE relative_path = ?');
const findDeliverablePathByToken = db.prepare('SELECT relative_path FROM deliverable_tokens WHERE token = ?');

export const hubRouter = Router();

// ---------- POST /hub/admin-auth (new) — email + PIN → HttpOnly session ----------
hubRouter.use('/hub/admin-auth', credentialedCors);
hubRouter.post('/hub/admin-auth', (req, res) => {
  if (isRateLimited(req.ip)) return res.status(429).json({ error: 'too many attempts' });
  recordAttempt(req.ip);

  const { email, pin } = req.body || {};
  if (!verifyAdminPin(email, pin)) return res.status(401).json({ error: 'invalid credentials' });

  setAdminSessionCookie(res, createAdminSession());
  res.json({ ok: true });
});

// ---------- POST /hub/publish (admin) — body { record, priv } ----------
hubRouter.use('/hub/publish', credentialedCors);
hubRouter.post('/hub/publish', requireAdmin, (req, res) => {
  const { record, priv } = req.body || {};
  if (!record || !record.id || !priv) return res.status(400).json({ error: 'bad payload' });

  const now = new Date().toISOString();
  upsertRecord.run({ project_id: record.id, data: JSON.stringify(record), updated_at: now });

  const clientEmail = String(priv.clientEmail || '').trim();
  upsertPrivateAuth.run({
    project_id: record.id,
    client_email: clientEmail,
    email_hash: clientEmail ? sha256Hex(clientEmail.toLowerCase()) : null,
    code_hash: priv.codeHash || null,
    invite_token: priv.inviteToken || null,
    delivered: priv.delivered ? 1 : 0,
    updated_at: now,
  });

  res.json({ ok: true, publishedAt: now });
});

// ---------- POST /hub/auth — { email, code } or { invite } ----------
// credentialedCors, not openCors: Slice 5's hubFetch sends credentials:'include'
// on every call including this one (it doesn't read the cookie — no requireAdmin
// here — but the browser still requires a non-wildcard, credentials-enabled CORS
// response on ANY credentialed fetch, or it blocks the response before JS sees it).
hubRouter.use('/hub/auth', credentialedCors);
hubRouter.post('/hub/auth', (req, res) => {
  const body = req.body || {};

  if (body.invite) {
    const row = findByInviteToken.get(String(body.invite));
    if (!row) return res.status(404).json({ error: 'invalid invite' });
    // Codes are stored hashed, so onboarding can't reveal one — the client
    // still signs in with email + the code from their invitation email.
    return res.json({ projectId: row.project_id, clientCode: '' });
  }

  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '');
  if (!email || !/^\d{4}$/.test(code)) return res.status(400).json({ error: 'bad request' });

  const emailHash = sha256Hex(email);
  const codeHash = sha256Hex(code);
  const candidates = findByEmailHash.all(emailHash);

  const projectIds = [];
  const records = {};
  for (const row of candidates) {
    if (row.code_hash === codeHash) {
      projectIds.push(row.project_id);
      records[row.project_id] = signedUrl(PUBLIC_BASE_URL, `/hub/records/${row.project_id}`, 900);
    }
  }
  if (!projectIds.length) return res.json({ token: null, projectIds: [] });
  const token = sha256Hex(codeHash + emailHash + Date.now());
  res.json({ token, projectIds, records });
});

// ---------- GET /hub/records/:projectId?token=&expires= ----------
// Signed short-lived read, same TTL/shape as the old pull-zone signed URL.
// Referenced only via the URLs /hub/auth just issued, never guessed.
hubRouter.use('/hub/records', openCors);
hubRouter.get('/hub/records/:projectId', (req, res) => {
  const { projectId } = req.params;
  if (!verifyPath(`/hub/records/${projectId}`, req.query.token, req.query.expires)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const row = getRecord.get(projectId);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.type('application/json').send(row.data);
});

// ---------- POST /hub/deliverable-url (admin, new) — { path } → { url } ----------
// Video URL scheme (Slice 4): a stable, unguessable URL for a file the admin
// has already dropped into the deliverables folder directly on the NAS (this
// API never receives an upload). Deliberately NOT the short-lived signed
// pattern /hub/records uses above — matches today's Bunny Stream links,
// which don't expire either. Idempotent: calling it again for a path already
// registered returns the same URL rather than minting a new one, so it's
// safe to re-run after a restart or a copy/paste mistake.
// Supersedes the old Edge Script's generic /hub/sign (removed — it had no
// caller in client-hub-app and this route now owns the /hub/files/* prefix
// it used to sign paths under).
hubRouter.use('/hub/deliverable-url', credentialedCors);
hubRouter.post('/hub/deliverable-url', requireAdmin, (req, res) => {
  const path = String(req.body?.path || '').trim();
  if (!resolveDeliverablePath(path)) return res.status(404).json({ error: 'file not found' });

  insertDeliverableToken.run(randomToken(16), path, new Date().toISOString());
  const { token } = findDeliverableTokenByPath.get(path);
  res.json({ url: `${PUBLIC_BASE_URL}/hub/files/${token}` });
});

// ---------- GET /hub/files/:token — the stable URL itself ----------
// Public and unauthenticated by design (same trust level as a pasted Bunny
// Stream link) — the token is the only thing standing in for access control.
hubRouter.use('/hub/files', openCors);
hubRouter.get('/hub/files/:token', (req, res) => {
  const row = findDeliverablePathByToken.get(req.params.token);
  if (!row) return res.status(404).json({ error: 'not found' });

  const resolved = resolveDeliverablePath(row.relative_path);
  if (!resolved) return res.status(404).json({ error: 'not found' });

  streamFile(req, res, resolved.absolute, resolved.stat);
});

// ---------- POST /hub/notify (admin) — invitation / reset / delivery email ----------
hubRouter.use('/hub/notify', credentialedCors);
hubRouter.post('/hub/notify', requireAdmin, (req, res) => {
  const payload = req.body || {};
  // TODO(provider): read a mail provider key from process.env and POST to it.
  console.log('[hub/notify]', JSON.stringify(payload));
  res.json({ ok: true, dispatched: payload.kind || 'unknown' });
});
