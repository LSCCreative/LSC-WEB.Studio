'use strict';

/* The portal's two CORS shapes, one per trust level:
   - credentialed: routes that send or may send a cookie. The origin has to be
     named, because "*" can't be used with credentials.
   - open: signed record reads and file links. No cookie, so any origin.
   Billing's own CORS doesn't apply to /hub/* (merge task M3, safeguard S5). */

function createHubCors(allowedOrigins) {
  const allowed = new Set(allowedOrigins);

  function credentialedCors(req, res, next) {
    const origin = req.headers.origin;
    if (origin && allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  }

  function openCors(req, res, next) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  }

  return { credentialedCors, openCors };
}

module.exports = { createHubCors };
