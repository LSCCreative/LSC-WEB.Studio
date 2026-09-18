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
const getAgreementEvidence = db.prepare('SELECT * FROM agreement_evidence WHERE project_id = ?');
const findByEmailHash = db.prepare('SELECT * FROM private_auth WHERE email_hash = ?');
const findByInviteToken = db.prepare('SELECT * FROM private_auth WHERE invite_token = ?');

const insertDeliverableToken = db.prepare(`
  INSERT INTO deliverable_tokens (token, relative_path, downloadable, created_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(relative_path, downloadable) DO NOTHING
`);
const findDeliverableTokenByPath = db.prepare('SELECT token FROM deliverable_tokens WHERE relative_path = ? AND downloadable = ?');
const findDeliverablePathByToken = db.prepare('SELECT relative_path, downloadable FROM deliverable_tokens WHERE token = ?');

const upsertAgreementEvidence = db.prepare(`
  INSERT INTO agreement_evidence (
    project_id, signer_name, signed_at, signature_data_url, consent_text,
    consent_checked, user_agent, verification_token, ip_address, received_at
  ) VALUES (
    @project_id, @signer_name, @signed_at, @signature_data_url, @consent_text,
    @consent_checked, @user_agent, @verification_token, @ip_address, @received_at
  )
  ON CONFLICT(project_id) DO UPDATE SET
    signer_name        = excluded.signer_name,
    signed_at           = excluded.signed_at,
    signature_data_url = excluded.signature_data_url,
    consent_text        = excluded.consent_text,
    consent_checked     = excluded.consent_checked,
    user_agent          = excluded.user_agent,
    verification_token  = excluded.verification_token,
    ip_address          = excluded.ip_address,
    received_at         = excluded.received_at
`);

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

// ---------- POST /hub/agreement (client, new) — legal/audit evidence bundle ----------
// Called once, right after the client signs the deliverables agreement
// (client-hub-app/index.html bindAgreementScreen). Stores the full signed
// agreement (signer name, timestamp, signature image) alongside the legal
// evidence (consent text/checked, user-agent, verification token) in the
// PRIVATE agreement_evidence table — never in the public `records` row.
// credentialedCors, not openCors: hubFetch sends credentials:'include' on
// every call (see the /hub/auth comment above for why that still requires a
// non-wildcard CORS response even though this route reads no cookie).
// The ip_address is the one field the client cannot supply itself — it is
// read from the request here, server-side, so it holds up as evidence.
hubRouter.use('/hub/agreement', credentialedCors);
hubRouter.post('/hub/agreement', (req, res) => {
  const body = req.body || {};
  const projectId = String(body.projectId || '').trim();
  const signerName = String(body.signerName || '').trim();
  const signedAt = String(body.signedAt || '').trim();
  const signatureDataUrl = String(body.signatureDataUrl || '').trim();
  const consentText = String(body.consentText || '').trim();
  const consentChecked = body.consentChecked === true;

  if (!projectId || !signerName || !signedAt || !signatureDataUrl || !consentText) {
    return res.status(400).json({ error: 'bad payload' });
  }
  if (!consentChecked) return res.status(400).json({ error: 'consent required' });
  if (!getRecord.get(projectId)) return res.status(404).json({ error: 'not found' });

  upsertAgreementEvidence.run({
    project_id: projectId,
    signer_name: signerName,
    signed_at: signedAt,
    signature_data_url: signatureDataUrl,
    consent_text: consentText,
    consent_checked: 1,
    user_agent: String(body.userAgent || ''),
    verification_token: String(body.verificationToken || ''),
    ip_address: req.ip || '',
    received_at: new Date().toISOString(),
  });

  res.json({ ok: true });
});

// ---------- GET /hub/agreement/:projectId (admin, new, Slice 6) ----------
// Lets the admin dashboard/editor open the full legal-evidence bundle for a
// signed project (signer name, timestamp, IP, user-agent, consent text) —
// the badge from Slice 4 only shows accepted/signedAt. Reads straight from
// the private agreement_evidence table Slice 5 wrote; 404 if never signed.
// (credentialedCors for /hub/agreement is already registered above.)
hubRouter.get('/hub/agreement/:projectId', requireAdmin, (req, res) => {
  const row = getAgreementEvidence.get(req.params.projectId);
  if (!row) return res.status(404).json({ error: 'not found' });

  res.json({
    signerName: row.signer_name,
    signedAt: row.signed_at,
    signatureDataUrl: row.signature_data_url,
    consentText: row.consent_text,
    consentChecked: Boolean(row.consent_checked),
    userAgent: row.user_agent,
    verificationToken: row.verification_token,
    ipAddress: row.ip_address,
    receivedAt: row.received_at,
  });
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
  const downloadable = req.body?.downloadable ? 1 : 0;
  if (!resolveDeliverablePath(path)) return res.status(404).json({ error: 'file not found' });

  insertDeliverableToken.run(randomToken(16), path, downloadable, new Date().toISOString());
  const { token } = findDeliverableTokenByPath.get(path, downloadable);
  res.json({ url: `${PUBLIC_BASE_URL}/hub/files/${token}` });
});

// ---------- GET /hub/files/:token — the stable URL itself ----------
// Public and unauthenticated by design (same trust level as a pasted Bunny
// Stream link) — the token is the only thing standing in for access control.
// `downloadable` (Slice 14) only steers Content-Disposition, not who can fetch it.
hubRouter.use('/hub/files', openCors);
hubRouter.get('/hub/files/:token', (req, res) => {
  const row = findDeliverablePathByToken.get(req.params.token);
  if (!row) return res.status(404).json({ error: 'not found' });

  const resolved = resolveDeliverablePath(row.relative_path);
  if (!resolved) return res.status(404).json({ error: 'not found' });

  streamFile(req, res, resolved.absolute, resolved.stat, Boolean(row.downloadable));
});

// ---------- POST /hub/notify (admin) — invitation / reset / delivery email ----------
hubRouter.use('/hub/notify', credentialedCors);
hubRouter.post('/hub/notify', requireAdmin, (req, res) => {
  const payload = req.body || {};
  // TODO(provider): read a mail provider key from process.env and POST to it.
  console.log('[hub/notify]', JSON.stringify(payload));
  res.json({ ok: true, dispatched: payload.kind || 'unknown' });
});
