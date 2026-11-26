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

const { posix } = require('path');
const express = require('express');
const cookie = require('cookie');
const { sha256Hex } = require('./tokens');
const { createHubCors } = require('./cors');
const { createPortalAccess, CODE_FORMAT, SESSION_DAYS } = require('../portal-access');
const { normEmail } = require('../clients');
const { clientView, projectCard, projectView, noteView, itemStatus } = require('./views');
const { newId, nowIso } = require('../db');
const { createDeliverables, streamFile } = require('./deliverables');
const { createAttemptThrottle } = require('./throttle');
const { invoiceView, sydneyDay } = require('../public');

/* Client sign-in is an email and a short code, so it is limited twice: per
   address (billing's rate limit), and per email however many addresses try,
   so a spread-out guess at one client's code stops after a few wrong ones.
   Invites count with sign-ins; a signed-in client's reads have their own count,
   and so does their media: a video asks again for each seek, and a photo library
   for each image, so it has room the reads don't need. */
const LIMITS = {
  auth: { max: 20, windowMs: 10 * 60 * 1000 },
  read: { max: 300, windowMs: 10 * 60 * 1000 },
  media: { max: 3000, windowMs: 10 * 60 * 1000 },
  note: { max: 300, windowMs: 10 * 60 * 1000 },
};
/* A note's length cap: a long paragraph, not a document (the table holds 4000). */
const NOTE_MAX = 4000;
/* Unsent notes one client can hold on one item: far past any real review, short of
   a reply that buries the page. */
const UNSENT_MAX = 200;
/* How long the media route trusts what it last read of a client's projects and a
   photo folder (see ownsProject). */
const MEDIA_MEMORY_MS = 10 * 1000;
/* The rate as the signed agreement wrote it: "hourly rate of AUD $63.00" in the
   contract's Revisions clause (documents.js, {hourly_rate}), or "hourly rate is $63.00".
   Only an amount straight after those words: any other amount nearby (a travel rate, a
   deposit) is never taken for it, and a clause worded otherwise gives none. */
const RATE_IN_AGREEMENT = /hourly rate(?:\s+(?:of|is))?(?:\s+AUD)?\s*(\$\s?\d[\d,]*(?:\.\d{1,2})?)/i;
function rateIn(text) {
  const m = RATE_IN_AGREEMENT.exec(String(text || ''));
  return m ? m[1].replace(/\s+/g, '') : null;
}
const CODE_FAILURE_LIMIT = 10;
const CODE_FAILURE_WINDOW_MS = 15 * 60 * 1000;

/* The client's session cookie (C1). Host-only on hub-api, so no other host is
   sent it; `/hub` only, so billing's routes never see it; Lax, which a fetch from
   lsccreative.studio still carries (the same site), and a cross-site form post
   doesn't. HttpOnly: the portal's script never holds the token. */
const SESSION_COOKIE = 'lsc_portal';
/* View as client (C8): the studio's preview, a cookie of its own beside the client's,
   so opening one never ends or replaces a real sign-in on that browser. */
const PREVIEW_COOKIE = 'lsc_portal_preview';
/* What a preview may do: read. Anything else under `signedIn` is refused (C8). */
const READ_METHODS = new Set(['GET', 'HEAD']);

/* Same file, same key: "a/../b/c.mp4" and "b/c.mp4" must not publish twice. */
function normalizeDeliverablePath(value) {
  const trimmed = String(value || '').trim();
  return trimmed ? posix.normalize(trimmed) : '';
}

/**
 * opts (config.hub, see config.js; its defaults live there, not here):
 *   signingSecret   required; the router won't build without the secret
 *   publicBaseUrl   required: this API's public address, used in the links it hands out
 *   deliverablesDir required: the read-only NAS deliverables folder
 *   corsOrigins     origins allowed to send credentials
 *   bunnyPublisher  bunny-publish.js's publisher: GET /hub/source checks its signatures.
 *                   Absent or not set up, that route answers 404
 *   rateLimit       required: billing's per-address limiter (routes/public.js)
 *   clientIp        required: billing's client address (routes/public.js), so the
 *                   agreement's evidence reads what billing's does
 *   cookieSecure    the session cookie's Secure flag (config.cookieSecure); on unless false
 *   appUrl          where the client's quote and invoice pages are (config.appUrl, with
 *                   its trailing slash): the portal links to `${appUrl}c/#e|i/<token>`
 *   limits          overrides LIMITS, for tests
 */
function createHubRouter(db, opts = {}) {
  if (!opts.signingSecret) throw new Error('The hub router needs signingSecret (HUB_SIGNING_SECRET); config.hub carries it.');
  for (const [key, name] of [['publicBaseUrl', 'HUB_PUBLIC_BASE_URL'], ['deliverablesDir', 'DELIVERABLES_DIR']]) {
    if (!opts[key]) throw new Error(`The hub router needs ${key} (${name}); config.hub carries it.`);
  }
  for (const key of ['rateLimit', 'clientIp']) {
    if (typeof opts[key] !== 'function') throw new Error(`The hub router needs ${key}, from billing's code; app.js passes it.`);
  }
  const { publicBaseUrl, clientIp } = opts;
  const limits = { ...LIMITS, ...(opts.limits || {}) };
  const limit = (name) => opts.rateLimit(limits[name]);
  const codeFailures = createAttemptThrottle({ limit: CODE_FAILURE_LIMIT, windowMs: CODE_FAILURE_WINDOW_MS });
  const { credentialedCors, openCors } = createHubCors(opts.corsOrigins || []);
  const allowedOrigins = new Set(opts.corsOrigins || []);
  const deliverables = createDeliverables(opts.deliverablesDir);
  const bunnyPublisher = opts.bunnyPublisher && opts.bunnyPublisher.ready ? opts.bunnyPublisher : null;
  const access = createPortalAccess(db, { secret: opts.signingSecret });
  const cookieSecure = opts.cookieSecure !== false;
  // Loaded here, not with the module: billing's project code reads its settings as it loads.
  const { readProjectRows, localToday } = require('../routes/projects');
  const { readChecklist, ROUNDS_INCLUDED } = require('../delivery');
  const { logActivity } = require('../routes/projects');

  const getClient = db.prepare('SELECT * FROM clients WHERE id = ?');
  /* The invoices a client has actually been sent (C3): sent or paid, of a kind with
     a page. Scheduled ones haven't gone yet; a void one was taken back. */
  const sentInvoices = db.prepare(`
    SELECT * FROM invoices WHERE project_id = ? AND status IN ('sent', 'paid') AND kind IN ('deposit', 'final', 'single')
     ORDER BY COALESCE(issued_at, created_at), created_at, id
  `);
  /* The project's signed quote: its page still offers the signed agreement once
     accepted (IA Defaults 10, checked in web/c/c.js). Accepted in the app, it has none. */
  const signedQuote = db.prepare(`
    SELECT e.public_token, s.signed_at FROM signatures s
      JOIN estimate_versions v ON v.id = s.version_id
      JOIN estimates e ON e.id = v.estimate_id
     WHERE e.project_id = ? AND e.status = 'accepted' AND e.public_token IS NOT NULL
       -- The page offers the signed agreement only for its newest version (publicEstimate's \`signed\`).
       AND v.n = (SELECT MAX(n) FROM estimate_versions WHERE estimate_id = e.id)
     ORDER BY s.signed_at DESC LIMIT 1
  `);
  const appUrl = opts.appUrl || '';
  /* What the project's signed agreement says the hourly rate is (C5): the rounds-used
     notice quotes it, never Settings' rate today (brief, Revision rounds). The newest
     signature on the project's accepted quote; none when it was Mark accepted. */
  const signedAgreement = db.prepare(`
    SELECT s.agreement_text FROM signatures s
      JOIN estimate_versions v ON v.id = s.version_id
      JOIN estimates e ON e.id = v.estimate_id
     WHERE e.project_id = ? AND e.status = 'accepted'
     ORDER BY s.signed_at DESC LIMIT 1
  `);
  /* A version the client has been given: published, on an item still needed. */
  const getPublishedVersion = db.prepare(`
    SELECT v.* FROM deliverable_versions v JOIN deliverables d ON d.id = v.deliverable_id
     WHERE v.id = ? AND v.project_id = ? AND v.published_at IS NOT NULL AND d.not_needed_at IS NULL
  `);

  const getVersionSource = db.prepare('SELECT id, source_path FROM deliverable_versions WHERE id = ?');
  const findDeliverablePathByToken = db.prepare('SELECT relative_path, downloadable FROM deliverable_tokens WHERE token = ?');



  const router = express.Router();

  // Raw-body routes go above this line: they need the exact bytes for their
  // signature check (merge safeguard S20).

  // ── POST /hub/bunny-webhook: Bunny Stream telling us a video's state (Bunny
  // Slice 3). Signed over the raw body (bunny-publish.js verifyWebhook), so it is
  // read here as bytes; any parser ahead of it makes every webhook fail, which
  // test-bunny-webhook.js catches. Unsigned or wrong is a 401, which Bunny doesn't
  // retry. A good one is a 200 whatever it changed (an unknown id included), so
  // Bunny stops; it is applied before answering, so a 200 means it is recorded.
  router.post('/hub/bunny-webhook', express.raw({ type: () => true, limit: '64kb' }), async (req, res) => {
    if (!bunnyPublisher) return res.status(503).json({ error: 'bunny not set up' });
    if (!Buffer.isBuffer(req.body)) {
      console.error('[hub/bunny-webhook] the body was already parsed: a JSON parser is mounted ahead of the webhook');
      return res.status(401).json({ error: 'unsigned' });
    }
    if (!bunnyPublisher.verifyWebhook(req.body, req.headers)) return res.status(401).json({ error: 'unsigned' });
    let event;
    try {
      event = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'bad request' });
    }
    try {
      const outcome = await bunnyPublisher.applyWebhook(event);
      return res.json({ ok: true, outcome });
    } catch (err) {
      // A 5xx is retried by Bunny for about 4 hours: right for a database hiccup.
      console.error('[hub/bunny-webhook] could not apply an event:', err.message);
      return res.status(500).json({ error: 'server error' });
    }
  });

  router.use('/hub', express.json({ limit: '2mb' }));

  /* ── The client's side (C1) ──────────────────────────────────────────────
     Every route that reads or writes a client's work goes through `signedIn`,
     which checks the session cookie against client_sessions. A project is found
     through the signed-in client, so another client's project, and one that
     doesn't exist, are the same "not found". */

  const readCookie = (req, name) => {
    try {
      return cookie.parse(req.headers.cookie || '')[name] || null;
    } catch {
      return null;
    }
  };
  const readToken = (req) => readCookie(req, SESSION_COOKIE);
  const readPreviewToken = (req) => readCookie(req, PREVIEW_COOKIE);
  const cookieFor = (name) => (value, maxAge) => cookie.serialize(name, value, {
    httpOnly: true, secure: cookieSecure, sameSite: 'lax', path: '/hub', maxAge,
  });
  const sessionCookie = cookieFor(SESSION_COOKIE);
  const previewCookie = cookieFor(PREVIEW_COOKIE);

  /* A write from a browser names its page. One that names another site is
     refused before anything is read; tools that send no Origin are left to the
     cookie and the code, as billing's own routes are. */
  function fromThePortal(req, res, next) {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return res.status(403).json({ error: 'forbidden' });
    return next();
  }

  /* One count per kind across its routes: guessing invites uses up sign-ins, and
     the portal's reads share theirs. */
  const authLimit = limit('auth');
  const readLimit = limit('read');
  const mediaLimit = limit('media');
  const noteLimit = limit('note');

  /* A preview (C8) applies only to a request that says it comes from the preview's
     page (`?preview=1`, which that page adds to every call and the server to every
     review link it gives it). It reads as its client does, through the same routes,
     and every write is refused here, before any route's own checks, so a write route
     added later is refused too. A marked request with no live preview is told so
     (`preview_ended`), never answered as whoever else is signed in on the browser;
     an unmarked one, such as a client's own tab beside it, ignores the preview cookie.
     Nothing is touched by reading one: no session row, no "last seen". */
  function signedIn(req, res, next) {
    if (req.query.preview === '1') {
      const preview = access.readPreview(readPreviewToken(req));
      if (!preview) return res.status(401).json({ error: 'preview_ended' });
      if (!READ_METHODS.has(req.method)) return res.status(403).json({ error: 'preview' });
      const client = getClient.get(preview.clientId);
      if (!client) return res.status(401).json({ error: 'preview_ended' });
      req.portal = { session: null, client, preview };
      return next();
    }
    const session = access.readSession(readToken(req));
    const client = session && getClient.get(session.clientId);
    if (!client) return res.status(401).json({ error: 'signed_out' });
    req.portal = { session, client, preview: null };
    return next();
  }
  const previewView = (preview) => (preview ? { projectId: preview.projectId, expiresAt: preview.expiresAt } : null);

  /* The signed-in client's own projects, as the lists read them: accepted work
     only (a quote still being decided isn't the portal's), current and past. */
  function projectsOf(clientId) {
    return readProjectRows(db, { today: localToday(), clientId })
      .map((row) => row.project)
      .filter((p) => p.delivery.group !== 'pipeline');
  }

  /* The media route is asked once per seek and once per photo, so it doesn't
     rebuild the client's projects or re-read the NAS folder each time. A short
     memory of each answers what it has seen; anything it hasn't is looked up
     fresh, so new work and new photos appear at once, and what is withdrawn
     goes within MEDIA_MEMORY_MS. */
  const ownedMemory = new Map();   // clientId → { at, ids: Set }
  const folderMemory = new Map();  // source path → { at, byKey: Map(key → name) }
  const remembered = (memory, key, fresh, has) => {
    const hit = memory.get(key);
    if (hit && Date.now() - hit.at < MEDIA_MEMORY_MS && has(hit)) return hit;
    if (memory.size > 500) memory.clear();
    const value = { at: Date.now(), ...fresh() };
    memory.set(key, value);
    return value;
  };
  const ownsProject = (clientId, projectId) => remembered(ownedMemory, clientId,
    () => ({ ids: new Set(projectsOf(clientId).map((p) => p.id)) }), (m) => m.ids.has(projectId)).ids.has(projectId);
  /* A photo's key: a short hash of its file name, so a link keeps pointing at the
     same image when the folder changes, and the name itself is never sent. */
  const photoKey = (name) => sha256Hex(`photo\n${name}`).slice(0, 16);
  const photosIn = (sourcePath, key) => remembered(folderMemory, sourcePath, () => ({
    byKey: new Map((deliverables.listDeliverableFolderImages(sourcePath) || []).map((name) => [photoKey(name), name])),
  }), (m) => key === undefined || m.byKey.has(key)).byKey;

  /* A version's review copy, played from the NAS through the route below, until
     Bunny's takes over (Slice 4). Addressed by ids, never by path or file name;
     a photo library's images by their key, in the folder's sorted order. */
  function reviewOf(projectId, v, preview) {
    if (!v.sourcePath) return null;
    const url = `${publicBaseUrl}/hub/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(v.id)}/review`;
    // A preview's <video> and <img> can't add the marker themselves, so their links carry it (photo= stays last).
    const mark = preview ? 'preview=1' : '';
    if (v.kind !== 'photos') return { type: 'file', url: mark ? `${url}?${mark}` : url };
    folderMemory.delete(v.sourcePath); // the project page reads the folder as it is now
    return { type: 'photos', urls: [...photosIn(v.sourcePath).keys()].map((key) => `${url}?${mark ? mark + '&' : ''}photo=${key}`) };
  }

  // ── POST /hub/auth: { email, code } → the session cookie and who signed in.
  router.use('/hub/auth', credentialedCors);
  router.post('/hub/auth', authLimit, fromThePortal, (req, res) => {
    const body = req.body || {};
    const email = normEmail(body.email);
    const code = String(body.code == null ? '' : body.code).trim();
    if (!email || email.length > 254 || !CODE_FORMAT.test(code)) return res.status(400).json({ error: 'bad_request' });

    const emailHash = sha256Hex(email);
    if (codeFailures.isLimited(emailHash)) return res.status(429).json({ error: 'too_many_attempts' });
    const who = access.signIn(email, code);
    if (!who) {
      codeFailures.record(emailHash);
      return res.status(401).json({ error: 'wrong_code' });
    }
    codeFailures.clear(emailHash);
    const { token } = access.startSession(who.clientId, who.via, {
      userAgent: req.headers['user-agent'] || '', ip: clientIp(req),
    });
    res.setHeader('Set-Cookie', sessionCookie(token, SESSION_DAYS * 24 * 60 * 60));
    return res.json({ ok: true, client: clientView(getClient.get(who.clientId)) });
  });

  // ── POST /hub/invite: { token } from `#/invite/<token>` → whose sign-in it is
  // and where it lands. It signs nobody in. The token travels in the body, never
  // a URL, so it reaches no log.
  router.use('/hub/invite', credentialedCors);
  router.post('/hub/invite', authLimit, fromThePortal, (req, res) => {
    const invite = access.inviteFor((req.body || {}).token);
    if (!invite) return res.status(404).json({ error: 'not_found' });
    return res.json({ ok: true, email: invite.email, projectId: invite.projectId });
  });

  // ── GET /hub/session: who is signed in, or 401.
  router.use('/hub/session', credentialedCors);
  router.get('/hub/session', readLimit, signedIn, (req, res) => {
    res.json({ ok: true, client: clientView(req.portal.client), preview: previewView(req.portal.preview) });
  });

  // ── POST /hub/sign-out: ends this session, signed in or not, and any preview on this browser.
  router.use('/hub/sign-out', credentialedCors);
  router.post('/hub/sign-out', fromThePortal, (req, res) => {
    access.endSession(readToken(req));
    access.endPreview(readPreviewToken(req));
    res.setHeader('Set-Cookie', [sessionCookie('', 0), previewCookie('', 0)]);
    res.json({ ok: true });
  });

  // ── POST /hub/preview: { token } from `#/preview/<token>` (C8) → the preview's
  // cookie, whose client it is, and the project it opens on. The link works once.
  // The token travels in the body, never a URL, so it reaches no log. It doesn't
  // touch the client's own session cookie.
  router.use('/hub/preview', credentialedCors);
  router.post('/hub/preview', authLimit, fromThePortal, (req, res) => {
    const opened = access.openPreview((req.body || {}).token);
    const client = opened && getClient.get(opened.clientId);
    if (!client) return res.status(404).json({ error: 'not_found' });
    res.setHeader('Set-Cookie', previewCookie(opened.token, Math.floor((Date.parse(opened.expiresAt) - Date.now()) / 1000)));
    return res.json({ ok: true, client: clientView(client), preview: previewView(opened) });
  });

  // ── POST /hub/preview/end: ends the preview on this browser, if any. The client's own sign-in stays.
  router.post('/hub/preview/end', fromThePortal, (req, res) => {
    access.endPreview(readPreviewToken(req));
    res.setHeader('Set-Cookie', previewCookie('', 0));
    res.json({ ok: true });
  });

  // ── GET /hub/projects and /hub/projects/:id: the signed-in client's work.
  router.use('/hub/projects', credentialedCors);
  router.get('/hub/projects', readLimit, signedIn, (req, res) => {
    res.json({ ok: true, projects: projectsOf(req.portal.client.id).map(projectCard) });
  });
  router.get('/hub/projects/:id', readLimit, signedIn, (req, res) => {
    const project = projectsOf(req.portal.client.id).find((p) => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'not_found' });
    const today = localToday();
    const invoices = sentInvoices.all(project.id).map((row) => {
      // The client's own invoice page's figures. One invoice that can't be read is
      // left out (and logged), rather than costing the client the whole page.
      let view;
      try {
        view = invoiceView(db, row, today);
      } catch (err) {
        console.error('[hub] an invoice couldn’t be shown on the portal:', row.id, err.message);
        return null;
      }
      // An invoice in Hnry is the one Hnry sent: billing's page for it would show
      // billing's number and bank details, so the client gets no link to it, and
      // its number is Hnry's. Billing's own is Hnry's PO field, which the client
      // never sees, so until Hnry's arrives it has none.
      const inHnry = Boolean(row.hnry_invoice_id || row.hnry_number || row.hnry_pushed_at);
      return {
        id: row.id,
        kind: row.kind,
        number: inHnry ? (row.hnry_number || '') : view.number,
        state: view.state,
        issuedOn: view.issuedOn,
        dueOn: view.dueOn,
        paidOn: view.paidOn,
        amount: view.totals.due.total,
        url: !inHnry && row.public_token && appUrl ? `${appUrl}c/#i/${row.public_token}` : null,
      };
    }).filter(Boolean);
    const signed = appUrl ? signedQuote.get(project.id) : null;
    return res.json({
      ok: true,
      project: projectView(project, readChecklist(db, project.id), {
        reviewOf: (v) => reviewOf(project.id, v, Boolean(req.portal.preview)),
        clientId: req.portal.client.id,
        invoices,
        agreement: signed ? { url: `${appUrl}c/#e/${signed.public_token}`, signedOn: sydneyDay(signed.signed_at) } : null,
        hourlyRate: rateIn((signedAgreement.get(project.id) || {}).agreement_text),
      }),
    });
  });

  /* ── The client's feedback (C4): notes saved as they're added, removed while
     unsent, and sent as one set per version. Client-written, so in tables of their
     own (S10), with no backup per write (S16: the nightly one covers them, see
     WORKING_NOTES). The server sets every date and checks every field (S8). A
     project, item or note that isn't this client's is the same not found. */

  const getOwnProject = db.prepare('SELECT * FROM projects WHERE id = ? AND client_id = ?');
  const getItem = db.prepare('SELECT * FROM deliverables WHERE id = ? AND project_id = ?');
  const newestPublishedOf = db.prepare(`
    SELECT * FROM deliverable_versions WHERE deliverable_id = ? AND published_at IS NOT NULL ORDER BY n DESC LIMIT 1
  `);
  const submissionOf = db.prepare('SELECT * FROM client_submissions WHERE version_id = ?');
  const approvalOn = db.prepare('SELECT * FROM client_approvals WHERE version_id = ?');
  const finalRounds = db.prepare("SELECT COUNT(*) AS n FROM client_submissions WHERE deliverable_id = ? AND stage = 'final'");
  /* Every unsent note this client has on the item, whichever version it was written on:
     notes left unsent when the studio published the next version go with the next set,
     so none is stranded (brief: a note is never silently dropped). */
  const unsentOn = db.prepare('SELECT id FROM client_notes WHERE deliverable_id = ? AND client_id = ? AND submission_id IS NULL');
  const noteByKey = db.prepare('SELECT * FROM client_notes WHERE client_id = ? AND client_key = ?');
  const insertNote = db.prepare(`
    INSERT INTO client_notes (id, project_id, deliverable_id, version_id, client_id, text, seconds, photo_key, photo_name, created_at, client_key)
    VALUES (@id, @project_id, @deliverable_id, @version_id, @client_id, @text, @seconds, @photo_key, @photo_name, @created_at, @client_key)
  `);
  const sentAtOf = (submissionId) => (submissionId ? (db.prepare('SELECT submitted_at FROM client_submissions WHERE id = ?').get(submissionId) || {}).submitted_at || null : null);
  const savedNote = (n) => noteView({
    id: n.id, versionId: n.version_id, text: n.text, seconds: n.seconds, photoKey: n.photo_key, createdAt: n.created_at, submittedAt: sentAtOf(n.submission_id),
  });
  const refuseNote = (res, status, error) => res.status(status).json({ error });

  /* The item a client is writing about, on the version they can write on: this
     client's accepted project, not archived; the item still needed; its newest
     published version, which must be the one they were looking at; not sent yet;
     not approved (C5: an approved version takes no more notes, and no second
     approval). Answers and returns null when any isn't so. */
  function writableItem(req, res, versionId) {
    const clientId = req.portal.client.id;
    const p = ownsProject(clientId, req.params.id) && getOwnProject.get(req.params.id, clientId);
    const d = p && getItem.get(req.params.itemId, p.id);
    if (!d || d.not_needed_at) return refuseNote(res, 404, 'not_found') && null;
    if (p.archived_at) return refuseNote(res, 409, 'archived') && null;
    const v = newestPublishedOf.get(d.id);
    if (!v) return refuseNote(res, 404, 'not_found') && null;
    // A newer version arrived while the page was open: the client is told, and their text stays with them.
    if (String(versionId || '') !== v.id) return refuseNote(res, 409, 'not_current') && null;
    if (submissionOf.get(v.id)) return refuseNote(res, 409, 'sent') && null;
    if (d.hub_status === 'approved' || d.hub_status === 'delivered') return refuseNote(res, 409, 'approved') && null;
    if (approvalOn.get(v.id)) return refuseNote(res, 409, 'approved') && null;
    return { p, d, v, clientId };
  }

  // ── POST /hub/projects/:id/items/:itemId/notes: { versionId, text, seconds?, photo? } → the saved note.
  router.post('/hub/projects/:id/items/:itemId/notes', noteLimit, fromThePortal, signedIn, (req, res) => {
    const body = req.body || {};
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > NOTE_MAX) return refuseNote(res, 400, 'bad_request');
    // The page's own id for this note: a retry after a lost reply gets back what was saved.
    const key = body.key === undefined || body.key === null ? null : String(body.key);
    if (key !== null && !/^[A-Za-z0-9_-]{8,64}$/.test(key)) return refuseNote(res, 400, 'bad_request');
    if (key !== null) {
      const already = noteByKey.get(req.portal.client.id, key);
      if (already) {
        return already.project_id === req.params.id && already.deliverable_id === req.params.itemId
          ? res.json({ ok: true, note: savedNote(already) })
          : refuseNote(res, 400, 'bad_request');
      }
    }
    let seconds = null;
    if (body.seconds !== undefined && body.seconds !== null) {
      seconds = Number(body.seconds);
      if (typeof body.seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > 86400) {
        return refuseNote(res, 400, 'bad_request');
      }
    }
    const at = writableItem(req, res, body.versionId);
    if (!at) return undefined;
    // A video's note can carry a time and no photo; a photo library's names one of its photos.
    let photoKey = null;
    let photoName = null;
    if (at.v.kind === 'photos') {
      photoKey = String(body.photo || '');
      photoName = /^[0-9a-f]{16}$/.test(photoKey) ? photosIn(at.v.source_path, photoKey).get(photoKey) : null;
      if (!photoName || seconds !== null) return refuseNote(res, 400, 'bad_request');
    } else if (body.photo !== undefined && body.photo !== null) {
      return refuseNote(res, 400, 'bad_request');
    }
    if (unsentOn.all(at.d.id, at.clientId).length >= UNSENT_MAX) return refuseNote(res, 409, 'too_many');
    const row = {
      id: newId('cn'), project_id: at.p.id, deliverable_id: at.d.id, version_id: at.v.id, client_id: at.clientId,
      text, seconds, photo_key: photoKey, photo_name: photoName, created_at: nowIso(), client_key: key,
    };
    // Checked and written in one synchronous turn (no await in this route): a Send can't land in between.
    insertNote.run(row);
    return res.status(201).json({
      ok: true,
      note: noteView({ id: row.id, versionId: row.version_id, text, seconds, photoKey, createdAt: row.created_at, submittedAt: null }),
    });
  });

  // ── DELETE /hub/projects/:id/notes/:noteId: a note the client hasn't sent yet.
  router.delete('/hub/projects/:id/notes/:noteId', noteLimit, fromThePortal, signedIn, (req, res) => {
    const clientId = req.portal.client.id;
    const n = db.prepare('SELECT * FROM client_notes WHERE id = ? AND project_id = ? AND client_id = ?')
      .get(req.params.noteId, req.params.id, clientId);
    if (!n) return refuseNote(res, 404, 'not_found');
    if (n.submission_id) return refuseNote(res, 409, 'sent');
    db.prepare('DELETE FROM client_notes WHERE id = ? AND submission_id IS NULL').run(n.id);
    return res.json({ ok: true });
  });

  // ── POST /hub/projects/:id/items/:itemId/submit: { versionId } → sends every unsent note on it as one set.
  router.post('/hub/projects/:id/items/:itemId/submit', noteLimit, fromThePortal, signedIn, (req, res) => {
    const at = writableItem(req, res, (req.body || {}).versionId);
    if (!at) return undefined;
    const id = newId('cs');
    const submittedAt = nowIso();
    let count = 0;
    try {
      db.transaction(() => {
        const notes = unsentOn.all(at.d.id, at.clientId);
        count = notes.length;
        if (!count) return;
        db.prepare(`
          INSERT INTO client_submissions (id, project_id, deliverable_id, version_id, client_id, stage, note_count, submitted_at, ip, user_agent)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, at.p.id, at.d.id, at.v.id, at.clientId, at.v.stage, count, submittedAt,
          clientIp(req), String(req.headers['user-agent'] || '').slice(0, 255));
        db.prepare('UPDATE client_notes SET submission_id = ? WHERE deliverable_id = ? AND client_id = ? AND submission_id IS NULL')
          .run(id, at.d.id, at.clientId);
      })();
    } catch (err) {
      // Two sends at once: the version's one submission is already there.
      if (/UNIQUE/.test(err.message)) return refuseNote(res, 409, 'sent');
      throw err;
    }
    if (!count) return refuseNote(res, 409, 'no_notes');
    // The studio hears of it by email (C6). After the save, off the reply, and it can't fail it.
    if (typeof opts.onNotesSubmitted === 'function') {
      Promise.resolve().then(() => opts.onNotesSubmitted({ submissionId: id })).catch(() => {});
    }
    // A set on a Final is a revision round (C5); the page says how many are left.
    return res.json({ ok: true, submittedAt, noteCount: count, rounds: { included: ROUNDS_INCLUDED, used: finalRounds.get(at.d.id).n } });
  });

  /* ── POST /hub/projects/:id/items/:itemId/approve: { versionId } → CONFIRM APPROVAL (C5).
     The record (S12): who (the client, and the email and name they had then), when
     (the server's clock), from where (the address the tunnel saw, and the browser's
     user agent) and exactly what (the version, its number, stage and file). First
     write wins: an approval already on the version is the answer, unchanged, so a
     double click or a second tab can't move its time. Refused while notes on the item
     are unsent (brief: they'd be lost), and after notes were sent on the version (it
     waits for the studio's next one). A client write: no backup per write (S16). */
  /* With the item's status as the server now reads it (views.js itemStatus), so the page
     never decides on its own that the item is signed off: a newer file the studio added,
     even unpublished, means the item isn't, whatever this version's approval says. */
  const approvalReply = (a) => {
    const item = readChecklist(db, a.project_id).find((d) => d.id === a.deliverable_id);
    return {
      ok: true,
      approval: { versionId: a.version_id, approvedAt: a.approved_at, deemed: a.kind === 'deemed' },
      itemStatus: item ? itemStatus(item) : null,
    };
  };
  router.post('/hub/projects/:id/items/:itemId/approve', noteLimit, fromThePortal, signedIn, (req, res) => {
    const versionId = String((req.body || {}).versionId || '');
    const clientId = req.portal.client.id;
    const already = versionId && ownsProject(clientId, req.params.id) && approvalOn.get(versionId);
    if (already && already.project_id === req.params.id && already.deliverable_id === req.params.itemId) {
      return res.json(approvalReply(already));
    }
    const at = writableItem(req, res, versionId);
    if (!at) return undefined;
    if (unsentOn.all(at.d.id, clientId).length) return refuseNote(res, 409, 'unsent_notes');
    const client = req.portal.client;
    const row = {
      id: newId('ca'), project_id: at.p.id, deliverable_id: at.d.id, version_id: at.v.id, client_id: clientId,
      email: String(client.email || ''), name: String(client.contact_name || client.business_name || ''),
      stage: at.v.stage, version_n: at.v.n, file_name: String(at.v.file_name || ''), approved_at: nowIso(),
      ip: clientIp(req), user_agent: String(req.headers['user-agent'] || '').slice(0, 255),
    };
    try {
      db.transaction(() => {
        db.prepare(`
          INSERT INTO client_approvals (id, project_id, deliverable_id, version_id, kind, client_id, email, name, stage, version_n,
                                        file_name, approved_at, ip, user_agent)
          VALUES (@id, @project_id, @deliverable_id, @version_id, 'client', @client_id, @email, @name, @stage, @version_n,
                  @file_name, @approved_at, @ip, @user_agent)
        `).run(row);
        logActivity(db, at.p.id, 'client_approved', { title: at.d.title, n: at.v.n, stage: at.v.stage }, row.approved_at);
      })();
    } catch (err) {
      // Two at once: the first one's record is the approval.
      if (/UNIQUE/.test(err.message)) return res.json(approvalReply(approvalOn.get(at.v.id)));
      throw err;
    }
    // After the reply's data is saved, never holding it up: the files may be due now (C10).
    if (typeof opts.onApproved === 'function') {
      Promise.resolve().then(() => opts.onApproved({ projectId: at.p.id })).catch(() => {});
    }
    return res.status(201).json(approvalReply(row));
  });

  /* ── GET /hub/projects/:id/versions/:versionId/review[?photo=<key>]: the review
     copy itself, from the NAS, with Range so a video seeks. Only a version the
     signed-in client has been given; anything else, theirs or not, is the same not
     found. Always inline: nothing here is a download (C2), and nothing is left in
     the browser's cache once they sign out. The <video> and <img> on the portal
     send the cookie because hub-api and the portal are the same site. */
  router.get('/hub/projects/:id/versions/:versionId/review', mediaLimit, signedIn, (req, res) => {
    const notFound = () => res.status(404).json({ error: 'not_found' });
    const owned = ownsProject(req.portal.client.id, req.params.id);
    const v = owned && getPublishedVersion.get(req.params.versionId, req.params.id);
    if (!v || !v.source_path) return notFound();
    let relative = v.source_path;
    if (v.kind === 'photos') {
      const key = String(req.query.photo || '');
      const name = /^[0-9a-f]{16}$/.test(key) && photosIn(v.source_path, key).get(key);
      if (!name) return notFound();
      relative = `${v.source_path}/${name}`;
    } else if (req.query.photo !== undefined) {
      return notFound();
    }
    const file = deliverables.resolveDeliverablePath(relative);
    if (!file) return notFound();
    return streamFile(req, res, file.absolute, file.stat, false, { cacheControl: 'no-store' });
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

  // ── GET /hub/source/:versionId/:name?token&expires: where Bunny pulls a version's
  // file from when it is published (bunny-publish.js). The signature names the
  // version and runs out after 6 hours, so this mints nothing permanent; the name
  // is only for Bunny's eyes and must be the file's own. Range, like /hub/files.
  router.get('/hub/source/:versionId/:name', (req, res) => {
    const notFound = () => res.status(404).json({ error: 'not_found' });
    const { versionId, name } = req.params;
    if (!bunnyPublisher || !bunnyPublisher.verifySource(versionId, String(req.query.token || ''), req.query.expires)) return notFound();
    const v = getVersionSource.get(versionId);
    if (!v || !v.source_path || posix.basename(v.source_path) !== name) return notFound();
    const file = deliverables.resolveDeliverablePath(v.source_path);
    if (!file) return notFound();
    // What Bunny gets is what sourceChanged compares against.
    bunnyPublisher.servedSource(v.id, file.stat);
    return streamFile(req, res, file.absolute, file.stat, false, { cacheControl: 'no-store' });
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
