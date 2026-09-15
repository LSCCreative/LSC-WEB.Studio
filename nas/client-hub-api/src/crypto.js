import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256Hex(str) {
  return createHash('sha256').update(String(str)).digest('hex');
}

export function randomToken(bytes = 24) {
  return randomBytes(bytes).toString('hex');
}

export function hmacSign(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

// Constant-time compare for fixed-shape secrets (hex hashes, tokens). Inputs
// of different length are never equal — the fixed-length hex values this is
// used for make that check itself uninformative to an attacker.
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
