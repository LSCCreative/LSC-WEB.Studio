// Reimplements client-hub-docs/hub-edge-script.js's four /hub/* routes
// against SQLite instead of flat Bunny Storage JSON blobs, plus the new
// POST /hub/admin-auth. Request/response shapes match the Edge Script
// exactly so client-hub-app/index.html's hubApi needs no logic changes
// (Slice 5 only repoints HUB_CONFIG.edgeBase and adds credentials:'include').
import { basename, extname, posix } from 'node:path';
import { Router } from 'express';
import { db } from './db.js';
import {
  findOrCreateCollection,
  fetchVideo,
  findVideoByTag,
  statusFromVideo,
  hlsUrl,
  posterUrl,
} from './bunny.js';
import { sha256Hex, randomToken } from './crypto.js';
import { signedUrl, verifyPath } from './signing.js';
import {
  resolveDeliverablePath,
  listDeliverableFolderImages,
  MAX_PHOTOS_PER_FOLDER,
  streamFile,
} from './deliverables.js';
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

// ---------- POST /hub/deliverable-folder (admin) — photo libraries ----------
// Folder counterpart of /hub/deliverable-url. A photo library is a NAS folder,
// not a file, so the admin registers the whole folder in one click and gets a
// URL pair back per image. Each image is an ORDINARY deliverable underneath --
// same deliverable_tokens table, same two-tokens-per-file rule (inline for the
// thumbnail, attachment for the download) — so no schema change is involved
// and /hub/files/:token serves these exactly like any video.
hubRouter.use('/hub/deliverable-folder', credentialedCors);
hubRouter.post('/hub/deliverable-folder', requireAdmin, (req, res) => {
  const path = String(req.body?.path || '').trim();
  const names = listDeliverableFolderImages(path);
  if (!names) return res.status(404).json({ error: 'folder not found' });
  if (!names.length) return res.status(422).json({ error: 'no images in folder' });
  if (names.length > MAX_PHOTOS_PER_FOLDER) {
    return res.status(422).json({
      error: `folder has ${names.length} images (limit ${MAX_PHOTOS_PER_FOLDER}) — point at a single delivery folder`,
    });
  }

  const now = new Date().toISOString();
  const photos = names.map(name => {
    // `path` is already validated as inside the tree and `name` comes from
    // readdir (never from the request), so this join can't escape it.
    const relative = `${path.replace(/\/+$/, '')}/${name}`;
    const urls = [0, 1].map(downloadable => {
      insertDeliverableToken.run(randomToken(16), relative, downloadable, now);
      return `${PUBLIC_BASE_URL}/hub/files/${findDeliverableTokenByPath.get(relative, downloadable).token}`;
    });
    return { name, reviewUrl: urls[0], downloadUrl: urls[1] };
  });

  res.json({ photos });
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

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.m4v']);

// How long a publish may wait for Bunny to list the fetched video before it's
// reported as failed. Without this a lost fetch job stays "processing" forever.
const UNLISTED_VIDEO_LIMIT_MS = 30 * 60 * 1000;
const VIDEO_LOOKUP_ATTEMPTS = 3;
const VIDEO_LOOKUP_GAP_MS = 1000;

const getBunnyAsset = db.prepare('SELECT * FROM bunny_assets WHERE relative_path = ? AND kind = ?');
const upsertBunnyAsset = db.prepare(`
  INSERT INTO bunny_assets (
    relative_path, kind, bunny_video_id, collection_id, publish_tag, status,
    error, source_size, source_mtime, created_at, updated_at
  ) VALUES (
    @relative_path, @kind, @bunny_video_id, @collection_id, @publish_tag, @status,
    @error, @source_size, @source_mtime, @now, @now
  )
  ON CONFLICT(relative_path, kind) DO UPDATE SET
    bunny_video_id = excluded.bunny_video_id,
    collection_id  = excluded.collection_id,
    publish_tag    = excluded.publish_tag,
    status         = excluded.status,
    error          = excluded.error,
    source_size    = excluded.source_size,
    source_mtime   = excluded.source_mtime,
    updated_at     = excluded.updated_at
`);
const setBunnyAssetVideo = db.prepare(`
  UPDATE bunny_assets SET bunny_video_id = ?, status = ?, updated_at = ?
  WHERE relative_path = ? AND kind = ?
`);
const failBunnyAsset = db.prepare(`
  UPDATE bunny_assets SET status = 'failed', error = ?, updated_at = ?
  WHERE relative_path = ? AND kind = ?
`);
const getBunnyCollection = db.prepare('SELECT collection_id FROM bunny_collections WHERE folder_name = ?');
const insertBunnyCollection = db.prepare(`
  INSERT INTO bunny_collections (folder_name, collection_id, created_at) VALUES (?, ?, ?)
  ON CONFLICT(folder_name) DO UPDATE SET collection_id = excluded.collection_id
`);

// One Node process, so these maps are enough to stop a double click, or a widget
// publishing a whole folder at once, from creating duplicates on Bunny.
const publishesInFlight = new Map();
const collectionsInFlight = new Map();

// Same file, same key: "a/../b/c.mp4" and "b/c.mp4" must not publish twice.
function normalizeDeliverablePath(value) {
  const trimmed = String(value || '').trim();
  return trimmed ? posix.normalize(trimmed) : '';
}

function publishTag(seed) {
  return `lsc-${sha256Hex(seed).slice(0, 16)}`;
}

function collectionFor(folderName) {
  const row = getBunnyCollection.get(folderName);
  if (row) return Promise.resolve(row.collection_id);
  if (collectionsInFlight.has(folderName)) return collectionsInFlight.get(folderName);

  const pending = findOrCreateCollection(folderName)
    .then((collectionId) => {
      insertBunnyCollection.run(folderName, collectionId, new Date().toISOString());
      return collectionId;
    })
    .finally(() => collectionsInFlight.delete(folderName));
  collectionsInFlight.set(folderName, pending);
  return pending;
}

function bunnyAssetResponse(row, stat) {
  const id = row.bunny_video_id;
  return {
    status: row.status,
    videoId: id || null,
    hlsUrl: id ? hlsUrl(id) : null,
    posterUrl: id ? posterUrl(id) : null,
    ...(row.error ? { error: row.error } : {}),
    // The NAS file was replaced after publishing, so Bunny still has the old
    // cut. Only force:true republishes it, so the editor needs to be told.
    sourceChanged: Boolean(stat)
      && (stat.size !== row.source_size || Math.round(stat.mtimeMs) !== row.source_mtime),
  };
}

// Bunny may list a fetched video a moment after accepting the job, so a row can
// legitimately have no id yet. Lookup failures leave it as it is for the next poll.
async function resolveVideoId(row) {
  if (row.bunny_video_id || row.status === 'failed') return row;
  try {
    const video = await findVideoByTag(row.publish_tag, row.collection_id);
    if (video) {
      setBunnyAssetVideo.run(video.guid, statusFromVideo(video), new Date().toISOString(), row.relative_path, row.kind);
    } else if (Date.now() - new Date(row.updated_at).getTime() > UNLISTED_VIDEO_LIMIT_MS) {
      failBunnyAsset.run('Bunny never listed the fetched video. Publish again.', new Date().toISOString(), row.relative_path, row.kind);
    }
  } catch (err) {
    console.error('[hub/publish-asset] video lookup failed:', err.message);
  }
  return getBunnyAsset.get(row.relative_path, row.kind);
}

async function publishVideo(path, resolved, force) {
  const existing = getBunnyAsset.get(path, 'video');
  // A failed row has nothing playable, so publishing again retries it.
  if (existing && !force && existing.status !== 'failed') return resolveVideoId(existing);

  const source = { source_size: resolved.stat.size, source_mtime: Math.round(resolved.stat.mtimeMs) };
  const base = { relative_path: path, kind: 'video', ...source, error: null };

  try {
    const collectionId = await collectionFor(path.split('/')[0]);

    // A repeat publish gets its own tag so the lookup can't find the video it
    // replaces. That older video stays on Bunny because a client's published
    // record may still point at it; deleting the collection (Slice 11) removes it.
    const tag = publishTag(existing ? `${path}\n${Date.now()}` : path);

    // First publish only: a crash after a previous fetch left a video on Bunny
    // but no row here. Adopt it rather than pulling the file a second time.
    let video = existing ? null : await findVideoByTag(tag, collectionId);
    if (!video) {
      insertDeliverableToken.run(randomToken(16), path, 0, new Date().toISOString());
      const { token } = findDeliverableTokenByPath.get(path, 0);
      await fetchVideo({
        url: `${PUBLIC_BASE_URL}/hub/files/${token}`,
        title: `${basename(path)} [${tag}]`,
        collectionId,
      });
      for (let attempt = 0; !video && attempt < VIDEO_LOOKUP_ATTEMPTS; attempt += 1) {
        await new Promise(done => setTimeout(done, VIDEO_LOOKUP_GAP_MS));
        video = await findVideoByTag(tag, collectionId);
      }
    }

    upsertBunnyAsset.run({
      ...base,
      bunny_video_id: video?.guid || null,
      collection_id: collectionId,
      publish_tag: tag,
      status: video ? statusFromVideo(video) : 'processing',
      now: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[hub/publish-asset] publish failed:', err.message);
    // A failed force must not overwrite a video that's still working.
    if (existing && existing.status !== 'failed') {
      const kept = new Error(err.message);
      kept.keptExisting = true;
      throw kept;
    }
    upsertBunnyAsset.run({
      ...base,
      bunny_video_id: null,
      collection_id: existing?.collection_id || null,
      publish_tag: existing?.publish_tag || null,
      status: 'failed',
      error: err.message,
      now: new Date().toISOString(),
    });
  }
  return getBunnyAsset.get(path, 'video');
}

// ---------- POST /hub/publish-asset (admin) — { path, kind:'video', force? } ----------
// Idempotent per NAS path: publishing a path again returns the existing row
// unless force:true. Bunny pulls the file from its /hub/files/<token> URL.
hubRouter.use('/hub/publish-asset', credentialedCors);
hubRouter.post('/hub/publish-asset', requireAdmin, async (req, res) => {
  const path = normalizeDeliverablePath(req.body?.path);
  if ((req.body?.kind ?? 'video') !== 'video') return res.status(400).json({ error: 'unsupported kind' });

  const resolved = resolveDeliverablePath(path);
  if (!resolved) return res.status(404).json({ error: 'file not found' });
  if (!path.includes('/')) return res.status(422).json({ error: 'file must be inside a project folder' });
  if (!VIDEO_EXTENSIONS.has(extname(path).toLowerCase())) {
    return res.status(422).json({ error: 'not a video file' });
  }

  let pending = publishesInFlight.get(path);
  if (!pending) {
    pending = publishVideo(path, resolved, req.body?.force === true)
      .finally(() => publishesInFlight.delete(path));
    publishesInFlight.set(path, pending);
  }

  try {
    const row = await pending;
    const body = bunnyAssetResponse(row, resolved.stat);
    res.status(row.status === 'failed' ? 502 : 200).json(body);
  } catch (err) {
    if (!err.keptExisting) throw err;
    res.status(502).json({ ...bunnyAssetResponse(getBunnyAsset.get(path, 'video'), resolved.stat), error: err.message });
  }
});

// ---------- GET /hub/publish-status?path=&kind= (admin) ----------
// Doesn't need the NAS file to still exist: a published video can outlive it.
hubRouter.use('/hub/publish-status', credentialedCors);
hubRouter.get('/hub/publish-status', requireAdmin, async (req, res) => {
  const path = normalizeDeliverablePath(req.query.path);
  const row = getBunnyAsset.get(path, String(req.query.kind || 'video'));
  if (!row) return res.status(404).json({ error: 'not published' });
  const current = await resolveVideoId(row);
  res.json(bunnyAssetResponse(current, resolveDeliverablePath(path)?.stat));
});

// ---------- POST /hub/notify (admin) — invitation / reset / delivery email ----------
hubRouter.use('/hub/notify', credentialedCors);
hubRouter.post('/hub/notify', requireAdmin, (req, res) => {
  const payload = req.body || {};
  // TODO(provider): read a mail provider key from process.env and POST to it.
  console.log('[hub/notify]', JSON.stringify(payload));
  res.json({ ok: true, dispatched: payload.kind || 'unknown' });
});
