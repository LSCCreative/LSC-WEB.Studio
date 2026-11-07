'use strict';

/* Short-lived signed URLs for portal records: an HMAC over "path|expires",
   carried as query params. Was the hub's signing.js, renamed so it can't be
   mistaken for billing's signing.js (signatures on quotes). The secret is
   passed in at startup; nothing is read from the environment here. */

const { hmacSign, safeEqual } = require('./tokens');

function createUrlSigner(secret, { now = Date.now } = {}) {
  if (!secret) {
    throw new Error('HUB_SIGNING_SECRET is required (it signs portal record URLs). Set it in the NAS .env, never in the repo.');
  }
  const nowSeconds = () => Math.floor(now() / 1000);

  function signPath(path, ttlSeconds = 900) {
    const expires = nowSeconds() + ttlSeconds;
    return { token: hmacSign(secret, `${path}|${expires}`), expires };
  }

  function verifyPath(path, token, expires) {
    const expiresNum = Number(expires);
    if (!Number.isFinite(expiresNum) || expiresNum < nowSeconds()) return false;
    if (typeof token !== 'string' || !token) return false;
    return safeEqual(token, hmacSign(secret, `${path}|${expiresNum}`));
  }

  function signedUrl(publicBase, path, ttlSeconds) {
    const { token, expires } = signPath(path, ttlSeconds);
    return `${publicBase}${path}?token=${token}&expires=${expires}`;
  }

  return { signPath, verifyPath, signedUrl };
}

module.exports = { createUrlSigner };
