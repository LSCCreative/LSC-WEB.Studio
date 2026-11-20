'use strict';

/* The Client Portal's /hub/* routes, moved from the hub's own server
   (nas/client-hub-api) without changing what they do. Everything comes in as
   arguments: the database, the secrets and the settings, so nothing here opens
   a file or reads the environment when it is loaded, and the tests run it on a
   throwaway database (merge safeguard S14).

   createHubRouter returns an Express router, mounted by app.js (merge task M3)
   with its own CORS, the hub hostname and one /health. It parses its own JSON
   and answers its own 404s and errors in JSON, as the hub's server did, so it
   is mounted before billing's body parser. */

const { basename, extname, posix } = require('path');
const express = require('express');
const { createBackup } = require('../backup');
const { sha256Hex, randomToken } = require('./tokens');
const { createUrlSigner } = require('./url-signing');
const { createHubCors } = require('./cors');
const { createBunny, missingBunnySettings, statusFromVideo } = require('./bunny');
const { createDeliverables, streamFile, VIDEO_EXTENSIONS } = require('./deliverables');
const { createAttemptThrottle } = require('./throttle');

/* How long a publish may wait for Bunny to list the fetched video before it is
   reported as failed. Without it a lost fetch job stays "processing" forever. */
const UNLISTED_VIDEO_LIMIT_MS = 30 * 60 * 1000;
const VIDEO_LOOKUP_ATTEMPTS = 3;

/* Client sign-in is an email and a 4-digit code, so it is limited twice: per
   address (billing's rate limit), and per email however many addresses try,
   so a spread-out guess at one client's code stops after a few wrong ones. */
const LIMITS = {
  auth: { max: 20, windowMs: 10 * 60 * 1000 },
  sign: { max: 10, windowMs: 10 * 60 * 1000 },
  records: { max: 120, windowMs: 10 * 60 * 1000 },
};
const CODE_FAILURE_LIMIT = 10;
const CODE_FAILURE_WINDOW_MS = 15 * 60 * 1000;

/* Same file, same key: "a/../b/c.mp4" and "b/c.mp4" must not publish twice. */
function normalizeDeliverablePath(value) {
  const trimmed = String(value || '').trim();
  return trimmed ? posix.normalize(trimmed) : '';
}

function publishTag(seed) {
  return `lsc-${sha256Hex(seed).slice(0, 16)}`;
}

/**
 * opts (config.hub, see config.js; its defaults live there, not here):
 *   signingSecret   required; the router won't build without the secret
 *   publicBaseUrl   required: this API's public address, used in the links it hands out
 *   deliverablesDir required: the read-only NAS deliverables folder
 *   backupDir       required: where the copy before each write goes (billing's backups)
 *   corsOrigins     origins allowed to send credentials
 *   bunny           Bunny settings; with any missing, publishing answers 503
 *   rateLimit       required: billing's per-address limiter (routes/public.js)
 *   clientIp        required: billing's client address (routes/public.js), so the
 *                   agreement's evidence reads what billing's does
 *   requireAdmin    required: billing's login check (auth.js requireAuth). The studio's
 *                   routes here are the Bunny publish pair, until Slice 2 moves them to /api
 *   limits          overrides LIMITS, for tests
 * Tests only: bunnyFetch swaps fetch for Bunny calls, videoLookupGapMs the wait
 * between looking for a fetched video.
 */
function createHubRouter(db, opts = {}) {
  for (const [key, name] of [['publicBaseUrl', 'HUB_PUBLIC_BASE_URL'], ['deliverablesDir', 'DELIVERABLES_DIR'], ['backupDir', 'the backups folder']]) {
    if (!opts[key]) throw new Error(`The hub router needs ${key} (${name}); config.hub carries it.`);
  }
  for (const key of ['rateLimit', 'clientIp', 'requireAdmin']) {
    if (typeof opts[key] !== 'function') throw new Error(`The hub router needs ${key}, from billing's code; app.js passes it.`);
  }
  const { publicBaseUrl, backupDir, clientIp, requireAdmin } = opts;
  const limits = { ...LIMITS, ...(opts.limits || {}) };
  const limit = (name) => opts.rateLimit(limits[name]);
  const codeFailures = createAttemptThrottle({ limit: CODE_FAILURE_LIMIT, windowMs: CODE_FAILURE_WINDOW_MS });
  const lookupGapMs = opts.videoLookupGapMs ?? 1000;
  const signer = createUrlSigner(opts.signingSecret);
  const { credentialedCors, openCors } = createHubCors(opts.corsOrigins || []);
  const deliverables = createDeliverables(opts.deliverablesDir);
  const bunnyMissing = missingBunnySettings(opts.bunny);
  const bunny = bunnyMissing.length ? null : createBunny(opts.bunny, { fetchImpl: opts.bunnyFetch });

  const getRecord = db.prepare('SELECT data FROM records WHERE project_id = ?');
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
      signed_at          = excluded.signed_at,
      signature_data_url = excluded.signature_data_url,
      consent_text       = excluded.consent_text,
      consent_checked    = excluded.consent_checked,
      user_agent         = excluded.user_agent,
      verification_token = excluded.verification_token,
      ip_address         = excluded.ip_address,
      received_at        = excluded.received_at
  `);

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

  /* One Node process, so these maps are enough to stop a double click, or a
     whole folder published at once, from creating duplicates on Bunny. */
  const publishesInFlight = new Map();
  const collectionsInFlight = new Map();

  function tokenFor(path, downloadable) {
    insertDeliverableToken.run(randomToken(16), path, downloadable, new Date().toISOString());
    return findDeliverableTokenByPath.get(path, downloadable).token;
  }

  function collectionFor(folderName) {
    const row = getBunnyCollection.get(folderName);
    if (row) return Promise.resolve(row.collection_id);
    if (collectionsInFlight.has(folderName)) return collectionsInFlight.get(folderName);
    const pending = bunny.findOrCreateCollection(folderName)
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
      hlsUrl: id ? bunny.hlsUrl(id) : null,
      posterUrl: id ? bunny.posterUrl(id) : null,
      ...(row.error ? { error: row.error } : {}),
      // The NAS file was replaced after publishing, so Bunny still has the old
      // cut. Only force:true republishes it, so the editor needs telling.
      sourceChanged: Boolean(stat)
        && (stat.size !== row.source_size || Math.round(stat.mtimeMs) !== row.source_mtime),
    };
  }

  /* Bunny may list a fetched video a moment after accepting the job, so a row
     can have no id yet. A failed lookup leaves the row for the next poll. */
  async function resolveVideoId(row) {
    if (row.bunny_video_id || row.status === 'failed') return row;
    try {
      const video = await bunny.findVideoByTag(row.publish_tag, row.collection_id);
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
      // replaces. The older video stays on Bunny, because a client's published
      // record may still point at it.
      const tag = publishTag(existing ? `${path}\n${Date.now()}` : path);

      // First publish only: a crash after an earlier fetch left a video on
      // Bunny but no row here. Adopt it rather than pulling the file again.
      let video = existing ? null : await bunny.findVideoByTag(tag, collectionId);
      if (!video) {
        await bunny.fetchVideo({
          url: `${publicBaseUrl}/hub/files/${tokenFor(path, 0)}`,
          title: `${basename(path)} [${tag}]`,
          collectionId,
        });
        for (let attempt = 0; !video && attempt < VIDEO_LOOKUP_ATTEMPTS; attempt += 1) {
          await new Promise((done) => setTimeout(done, lookupGapMs));
          video = await bunny.findVideoByTag(tag, collectionId);
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

  function requireBunny(req, res, next) {
    if (!bunny) return res.status(503).json({ error: 'bunny not set up' });
    next();
  }

  /* The copy before a write, as billing's /api writes get (backup.js). Taken
     after a request is checked, so a stranger's bad request can't push real
     recovery points out of the ten kept. A failed copy is logged, not fatal,
     as for /api. */
  async function backupBeforeWrite() {
    try {
      await createBackup(db, backupDir, 'prewrite');
    } catch (err) {
      console.error('[hub] pre-write snapshot failed:', err.message);
    }
  }

  const router = express.Router();

  // Raw-body routes (the Bunny webhook, task B1) go above this line: they need
  // the exact bytes for their signature check (merge safeguard S20).
  router.use('/hub', express.json({ limit: '2mb' }));

  // ── POST /hub/auth: { email, code } or { invite }. Credentialed CORS because
  // the portal sends credentials on every call, though this route reads no cookie.
  router.use('/hub/auth', credentialedCors);
  router.post('/hub/auth', limit('auth'), (req, res) => {
    const body = req.body || {};

    if (body.invite) {
      const row = findByInviteToken.get(String(body.invite));
      if (!row) return res.status(404).json({ error: 'invalid invite' });
      // Codes are stored hashed, so onboarding can't reveal one: the client
      // still signs in with email + the code from their invitation.
      return res.json({ projectId: row.project_id, clientCode: '' });
    }

    const email = String(body.email || '').trim().toLowerCase();
    const code = String(body.code || '');
    if (!email || !/^\d{4}$/.test(code)) return res.status(400).json({ error: 'bad request' });

    const emailHash = sha256Hex(email);
    if (codeFailures.isLimited(emailHash)) return res.status(429).json({ error: 'too many attempts' });
    const codeHash = sha256Hex(code);
    const projectIds = [];
    const records = {};
    for (const row of findByEmailHash.all(emailHash)) {
      if (row.code_hash === codeHash) {
        projectIds.push(row.project_id);
        records[row.project_id] = signer.signedUrl(publicBaseUrl, `/hub/records/${row.project_id}`, 900);
      }
    }
    if (!projectIds.length) {
      codeFailures.record(emailHash);
      return res.json({ token: null, projectIds: [] });
    }
    codeFailures.clear(emailHash);
    const token = sha256Hex(codeHash + emailHash + Date.now());
    res.json({ token, projectIds, records });
  });

  // ── POST /hub/agreement (client): the signed deliverables agreement and its
  // evidence, kept private. The address is read here, never taken from the client.
  router.use('/hub/agreement', credentialedCors);
  router.post('/hub/agreement', limit('sign'), async (req, res) => {
    const body = req.body || {};
    const projectId = String(body.projectId || '').trim();
    const signerName = String(body.signerName || '').trim();
    const signedAt = String(body.signedAt || '').trim();
    const signatureDataUrl = String(body.signatureDataUrl || '').trim();
    const consentText = String(body.consentText || '').trim();

    if (!projectId || !signerName || !signedAt || !signatureDataUrl || !consentText) {
      return res.status(400).json({ error: 'bad payload' });
    }
    if (body.consentChecked !== true) return res.status(400).json({ error: 'consent required' });
    if (!getRecord.get(projectId)) return res.status(404).json({ error: 'not found' });

    await backupBeforeWrite();
    upsertAgreementEvidence.run({
      project_id: projectId,
      signer_name: signerName,
      signed_at: signedAt,
      signature_data_url: signatureDataUrl,
      consent_text: consentText,
      consent_checked: 1,
      user_agent: String(body.userAgent || ''),
      verification_token: String(body.verificationToken || ''),
      ip_address: clientIp(req),
      received_at: new Date().toISOString(),
    });
    res.json({ ok: true });
  });

  // ── GET /hub/records/:projectId?token=&expires=: a signed, short-lived read,
  // reached only through the URLs /hub/auth hands out.
  router.use('/hub/records', openCors);
  router.get('/hub/records/:projectId', limit('records'), (req, res) => {
    const { projectId } = req.params;
    if (!signer.verifyPath(`/hub/records/${projectId}`, req.query.token, req.query.expires)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const row = getRecord.get(projectId);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.type('application/json').send(row.data);
  });

  // ── GET /hub/files/:token: the stable link itself. Public by design: the
  // token is the access control, like a pasted Bunny Stream link.
  router.use('/hub/files', openCors);
  router.get('/hub/files/:token', (req, res) => {
    const row = findDeliverablePathByToken.get(req.params.token);
    if (!row) return res.status(404).json({ error: 'not found' });
    const resolved = deliverables.resolveDeliverablePath(row.relative_path);
    if (!resolved) return res.status(404).json({ error: 'not found' });
    streamFile(req, res, resolved.absolute, resolved.stat, Boolean(row.downloadable));
  });

  // ── POST /hub/publish-asset (the studio): { path, kind: 'video', force? }. Once per
  // NAS path unless force:true. Bunny pulls the file from its /hub/files link.
  router.use('/hub/publish-asset', credentialedCors);
  router.post('/hub/publish-asset', requireAdmin, requireBunny, async (req, res) => {
    const path = normalizeDeliverablePath(req.body?.path);
    if ((req.body?.kind ?? 'video') !== 'video') return res.status(400).json({ error: 'unsupported kind' });

    const resolved = deliverables.resolveDeliverablePath(path);
    if (!resolved) return res.status(404).json({ error: 'file not found' });
    if (!path.includes('/')) return res.status(422).json({ error: 'file must be inside a project folder' });
    if (!VIDEO_EXTENSIONS.has(extname(path).toLowerCase())) {
      return res.status(422).json({ error: 'not a video file' });
    }

    let pending = publishesInFlight.get(path);
    if (!pending) {
      await backupBeforeWrite();
      // Checked again: another request may have started it while the copy ran.
      pending = publishesInFlight.get(path);
    }
    if (!pending) {
      pending = publishVideo(path, resolved, req.body?.force === true)
        .finally(() => publishesInFlight.delete(path));
      publishesInFlight.set(path, pending);
    }

    try {
      const row = await pending;
      res.status(row.status === 'failed' ? 502 : 200).json(bunnyAssetResponse(row, resolved.stat));
    } catch (err) {
      if (!err.keptExisting) throw err;
      res.status(502).json({ ...bunnyAssetResponse(getBunnyAsset.get(path, 'video'), resolved.stat), error: err.message });
    }
  });

  // ── GET /hub/publish-status?path=&kind= (the studio). Doesn't need the NAS file:
  // a published video can outlive it.
  router.use('/hub/publish-status', credentialedCors);
  router.get('/hub/publish-status', requireAdmin, requireBunny, async (req, res) => {
    const path = normalizeDeliverablePath(req.query.path);
    const row = getBunnyAsset.get(path, String(req.query.kind || 'video'));
    if (!row) return res.status(404).json({ error: 'not published' });
    const current = await resolveVideoId(row);
    res.json(bunnyAssetResponse(current, deliverables.resolveDeliverablePath(path)?.stat));
  });

  /* The hub's server answered everything in JSON, and the portal reads every
     reply as JSON: an unknown /hub path or a bad body mustn't get HTML. */
  router.use('/hub', (req, res) => res.status(404).json({ error: 'not found' }));
  // eslint-disable-next-line no-unused-vars -- Express spots error handlers by their four arguments.
  router.use('/hub', (err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[hub] unhandled error:', req.method, req.path, err);
    res.status(status).json({ error: status >= 500 ? 'server error' : 'bad request' });
  });

  router.deliverablesHealth = deliverables.health;
  return router;
}

module.exports = { createHubRouter, normalizeDeliverablePath };
