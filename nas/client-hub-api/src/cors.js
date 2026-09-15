// Two CORS shapes, matching the two trust levels in play:
//  - credentialedCors: admin routes. The session cookie must cross origins
//    (client-hub-app's site → hub-api.lsccreative.studio), so the allowed
//    origin has to be named explicitly — "*" is incompatible with credentials.
//  - openCors: public data routes (client auth, signed record/file reads).
//    No cookie involved, so a wide-open origin is fine — matches the old
//    Edge Script's onOriginResponse, which stamped "*" on every storage read.
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || 'https://lsccreative.studio')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function credentialedCors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
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

export function openCors(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}
