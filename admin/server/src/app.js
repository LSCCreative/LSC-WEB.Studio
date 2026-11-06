'use strict';

const path = require('path');
const express = require('express');
const { config, appUrlOf } = require('./config');
const { registerAuthRoutes, requireAuth } = require('./auth');
const { preWriteBackup } = require('./backup');
const { registerEstimateRoutes } = require('./routes/estimates');
const { registerClientRoutes } = require('./routes/clients');
const { registerPricingRoutes } = require('./routes/pricing');
const { registerSettingsRoutes } = require('./routes/settings');
const { registerPdfRoutes } = require('./routes/pdf');
const { registerOverheadRoutes } = require('./routes/overhead');
const { registerGoalsRoutes } = require('./routes/goals');
const { registerDepreciationRoutes } = require('./routes/depreciation');
const { registerTaxYearRoutes } = require('./routes/tax-years');
const { registerCalendarRoutes } = require('./routes/calendar');
const { registerHolidayRoutes } = require('./routes/holidays');
const { registerSetupRoutes } = require('./routes/setup');
const { registerProjectRoutes } = require('./routes/projects');
const { registerInvoiceRoutes } = require('./routes/invoices');
const { registerPublicRoutes } = require('./routes/public');
const { registerEmailRoutes, registerSendRoutes } = require('./routes/email');
const { registerRecoveryRoutes, registerAccountRoutes } = require('./routes/account');
const { registerGoogleOAuthRoutes, registerGoogleRoutes } = require('./routes/google');
const { createGoogleSync } = require('./google-sync');
const { createMailer } = require('./mail');
const { createOutbox } = require('./sends');
const { createHnry } = require('./hnry');
const { createHnryPusher } = require('./hnry-push');
const { createHubRouter } = require('./hub/routes');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const underPath = (req, prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`);

/** "host[:port]" of a URL, lower case, or '' if it isn't one. */
function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * The UI is served from GitHub Pages, a different origin than this API, so the
 * browser needs an explicit CORS allow-list with credentials — otherwise the
 * session cookie never gets sent. `CORS_ORIGINS` is empty by default (same-
 * origin only); set it once the Pages URL is known.
 *
 * The Client Portal's origins are never granted here, even if one is added to
 * CORS_ORIGINS by mistake (merge safeguard S5): a portal page must never be
 * able to make a credentialed call to /api.
 */
function createCors(allowedOrigins, portalOrigins) {
  const portal = new Set(portalOrigins);
  for (const o of allowedOrigins.filter((x) => portal.has(x))) {
    console.error(`[cors] ${o} is the Client Portal's origin, so CORS_ORIGINS can't grant it /api; it is ignored`);
  }
  return function corsMiddleware(req, res, next) {
    // The client's routes answer CORS themselves, without credentials
    // (routes/public.js): a client page must never be offered the session.
    // The portal's /hub routes answer their own too (hub/cors.js).
    if (underPath(req, '/public') || underPath(req, '/hub')) return next();
    const origin = req.headers.origin;
    // The list is read on each request, as before: tests add to it live.
    if (origin && allowedOrigins.includes(origin) && !portal.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      // The editor's autosave headers (trip-planner task 7) need a preflight pass.
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-LSC-Autosave, X-LSC-Session');
      // Not CORS-safelisted, so without this the page can't read the PDF's filename.
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

/**
 * The portal's hostname serves the portal and nothing else (merge safeguard
 * S4): /api, the admin and the client pages answer 404 there. The owner's
 * cookie is host-only, so a portal page can never carry it, and stored
 * hub-api file links keep working. Read from the Host header as sent, not
 * X-Forwarded-Host, which a client could write.
 */
function portalHostOnly(portalHost) {
  return (req, res, next) => {
    if (!portalHost || String(req.headers.host || '').toLowerCase() !== portalHost) return next();
    if (req.path === '/health' || underPath(req, '/hub')) return next();
    res.status(404).json({ error: 'not found' });
  };
}

/**
 * The Client Portal's routes, or a 503 for them when its secrets aren't set:
 * billing still starts without them, saying why. Setting only one of the two
 * is a mistake, so that stops the server instead.
 */
function buildPortal(db, hub) {
  if (!hub) return null;
  if (!hub.signingSecret && !hub.adminPinHash) {
    console.warn('[hub] HUB_SIGNING_SECRET and HUB_ADMIN_PIN_HASH aren\'t set, so the Client Portal\'s /hub routes answer 503');
    return null;
  }
  return createHubRouter(db, hub);
}

/**
 * Builds the Express app. Takes an open database handle so tests can pass a
 * throwaway one instead of the real billing.db. `opts.holidaySource` swaps the
 * public-holiday fetch for a stub. `opts.mailer` swaps the email transport
 * (mail.js createMailer) and `opts.renderPdf` the PDF renderer; the send
 * queue's worker is `app.locals.outbox`, started by index.js.
 */
function createApp(db, opts = {}) {
  const app = express();

  /* Exactly one hop, always: the tunnel (merge safeguard S7). `true` would
     believe the leftmost X-Forwarded-For entry, which the client writes, and
     let a script reset its login throttle; off would make every visitor the
     tunnel, so one person's tries would lock everyone out. TRUST_PROXY now
     only decides whether CF-Connecting-IP is believed (routes/public.js). */
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // The Client Portal (merge task M3). Tests pass their own settings, or get
  // the 503 stub: a test never reads the developer's real hub settings.
  const hub = opts.hub !== undefined ? opts.hub : (config.isTest ? null : config.hub);
  const portal = buildPortal(db, hub);

  app.use(portalHostOnly(hub ? hostOf(hub.publicBaseUrl) : ''));
  app.use(createCors(config.corsOrigins, (hub || config.hub).corsOrigins || []));

  /* Routes that need the raw request body (a webhook's signature check, merge
     safeguard S20) mount here, before any JSON parser reads it. The portal's
     router parses its own JSON, after its own raw-body routes, so it comes
     before billing's parser too and answers bad bodies in its own JSON. */
  if (portal) app.use(portal);
  else app.use('/hub', (_req, res) => res.status(503).json({ error: 'portal not set up' }));

  app.use(express.json({ limit: '2mb' }));

  // The send queue (task 28): signing queues email and kicks the worker, the
  // owner's routes edit the queue. Built here so a test passes its own mailer.
  // A test never reaches a real SMTP server, whatever the developer's .env holds.
  const mailer = opts.mailer || createMailer(config.isTest ? {} : config);
  const outbox = createOutbox(db, mailer, {
    now: opts.now,
    appUrl: opts.appUrl !== undefined ? opts.appUrl : config.appUrl,
    render: opts.renderPdf,
  });
  app.locals.outbox = outbox;
  app.locals.mailer = mailer;

  // Hnry (hnry-invoicing): an accepted project's deposit or single invoice is
  // pushed there as a draft, after the accept commits and in the background.
  // A test never reaches Zapier, whatever the developer's .env holds, unless it
  // passes its own `hnry` (a fake transport). Not set up = nothing is pushed.
  const hnry = opts.hnry || createHnry(config.isTest ? {} : config);
  const hnryPush = createHnryPusher(db, hnry, { now: opts.now });
  app.locals.hnry = hnry;
  app.locals.hnryPush = hnryPush;

  // ── /health — the only route besides /login that never requires a session,
  // and the one health check for billing and the portal both (merge safeguard
  // S15). Deliberately says nothing about the data; it is a liveness probe for
  // Container Manager, not a status page. An unreadable deliverables folder is
  // named but doesn't fail it: restarting the container wouldn't remount it,
  // and billing would go down with it.
  app.get('/health', (_req, res) => {
    try {
      db.prepare('SELECT 1').get();
    } catch (err) {
      res.type('text/plain').status(503).send('db unavailable');
      return;
    }
    const deliverables = portal ? portal.deliverablesHealth() : { ok: true };
    res.type('text/plain').status(200)
      .send(deliverables.ok ? 'ok' : `ok; deliverables folder unreadable (${deliverables.error || 'unknown'})`);
  });

  // The call sheet's route images (trip-planner task 9). A test never reaches
  // Google, whatever the developer's .env holds, unless it passes its own key
  // and a stub fetch.
  const maps = {
    key: opts.mapsKey !== undefined ? opts.mapsKey : (config.isTest ? '' : config.googleMapsServerKey),
    fetchImpl: opts.mapsFetch,
  };

  // ── The client's pages (stage E): no session, by unguessable link, and
  // outside /api so no owner route can be reached through them.
  registerPublicRoutes(app, db, { ...opts, outbox, hnryPush, ownerEmail: mailer.replyTo, maps });

  // ── Auth. /api/login, /api/logout, /api/session and /api/password/* handle
  // their own session state and must be registered before the gate below.
  registerAuthRoutes(app, db);
  // "Forgot password" and the reset link: no session, by definition.
  registerRecoveryRoutes(app, db, {
    mailer,
    appUrl: opts.appUrl !== undefined ? opts.appUrl : config.appUrl,
  });

  // The Google Calendar connection (trip-planner task 12). A test never
  // reaches Google, whatever the developer's .env holds, unless it passes its
  // own client and a stub fetch. Start and the callback are browser
  // navigations that check the session themselves and answer with redirects.
  const oauth = {
    ...(opts.googleOAuth !== undefined ? opts.googleOAuth : (config.isTest ? {} : config.googleOAuth)),
    fetchImpl: opts.googleFetch,
    now: opts.googleNow,
  };
  const appOrigin = opts.appOrigin !== undefined ? opts.appOrigin : config.appOrigin;

  // Writing bookings to the calendar (task 14). The routes that change a
  // booking say which estimate they changed (`app.locals.googleSync.touch`);
  // the gate below also tells it about every other write, so an event can't
  // be left stale by a route that forgot. Nothing here fails a save.
  const googleSync = createGoogleSync(db, {
    oauth,
    appUrl: appUrlOf(opts.appUrl !== undefined ? opts.appUrl : config.appUrl),
    now: opts.googleNow,
    debounceMs: opts.googleSyncDebounceMs,
    enabled: opts.googleCalendarWrite !== undefined ? opts.googleCalendarWrite : config.googleCalendarWrite,
  });
  app.locals.googleSync = googleSync;
  registerGoogleOAuthRoutes(app, db, { oauth, appOrigin, sync: googleSync });

  // ── Everything under /api from here down requires a valid session. New API
  // routes mount after this line and inherit the gate for free.
  app.use('/api', requireAuth(db));
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && !req.path.startsWith('/google/')) {
      res.on('finish', () => {
        if (res.statusCode < 400) googleSync.noteWrite();
      });
    }
    next();
  });

  // PDF export is a POST but never writes the database. Mounted ahead of the
  // pre-write snapshot so exporting doesn't rotate real recovery points out
  // of the 10 kept.
  registerPdfRoutes(app, db);
  registerEmailRoutes(app, db, { mailer, appUrl: opts.appUrl !== undefined ? opts.appUrl : config.appUrl });

  app.use('/api', preWriteBackup(db, config.backupDir));

  registerAccountRoutes(app, db);
  registerEstimateRoutes(app, db, {
    maps,
    render: opts.renderPdf,
    appUrl: opts.appUrl !== undefined ? opts.appUrl : config.appUrl,
  });
  registerClientRoutes(app, db);
  registerPricingRoutes(app, db);
  registerSettingsRoutes(app, db);
  registerOverheadRoutes(app, db);
  registerGoalsRoutes(app, db);
  registerDepreciationRoutes(app, db);
  registerTaxYearRoutes(app, db);
  registerCalendarRoutes(app, db, { oauth });
  registerHolidayRoutes(app, db, opts);
  registerSetupRoutes(app, db);
  // Stage D's Mark sent routes (POST …/sent) are for the tests alone (C13):
  // the app sends through …/send, whose checks they don't share.
  const stageD = { markSent: opts.markSentRoutes !== undefined ? opts.markSentRoutes : config.isTest };
  registerProjectRoutes(app, db, { ...stageD, hnryPush });
  registerInvoiceRoutes(app, db, { ...stageD, hnryPush });
  registerSendRoutes(app, db, { outbox });
  registerGoogleRoutes(app, db, { oauth, sync: googleSync });
  googleSync.start();

  // ── Static app shell. Empty until the UI is ported off the Electron build.
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', extensions: ['html'] }));

  // ── Fallbacks. API 404s stay JSON so the client's fetch wrapper can tell a
  // missing route from a missing page.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // eslint-disable-next-line no-unused-vars -- Express identifies error
  // handlers by arity; `next` must stay in the signature.
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error('[error]', req.method, req.path, err);
    const body = { error: err.code || 'server_error' };
    if (err.expose && err.message) body.message = err.message;
    res.status(status).json(body);
  });

  return app;
}

module.exports = { createApp, PUBLIC_DIR };
