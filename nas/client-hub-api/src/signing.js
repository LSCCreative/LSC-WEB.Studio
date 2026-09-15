// Self-hosted analogue of the Bunny pull-zone token signing the old Edge
// Script used (signPullUrl in client-hub-docs/hub-edge-script.js): an
// HMAC over "path|expires", carried as query params. Same shape, same TTL
// use, no external CDN.
import { hmacSign, safeEqual } from './crypto.js';

const SIGNING_SECRET = process.env.SIGNING_SECRET;
if (!SIGNING_SECRET) {
  throw new Error('SIGNING_SECRET env var is required (signs record/file URLs) — set it in the NAS .env, never in the repo.');
}

export function signPath(path, ttlSeconds = 900) {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const token = hmacSign(SIGNING_SECRET, `${path}|${expires}`);
  return { token, expires };
}

export function verifyPath(path, token, expires) {
  const expiresNum = Number(expires);
  if (!Number.isFinite(expiresNum) || expiresNum < Math.floor(Date.now() / 1000)) return false;
  if (typeof token !== 'string' || !token) return false;
  const expected = hmacSign(SIGNING_SECRET, `${path}|${expiresNum}`);
  return safeEqual(token, expected);
}

export function signedUrl(publicBase, path, ttlSeconds) {
  const { token, expires } = signPath(path, ttlSeconds);
  return `${publicBase}${path}?token=${token}&expires=${expires}`;
}
