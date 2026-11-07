'use strict';

/* Hashing and tokens for the Client Portal. Was the hub's crypto.js. */

const { createHash, createHmac, randomBytes, timingSafeEqual } = require('crypto');

function sha256Hex(str) {
  return createHash('sha256').update(String(str)).digest('hex');
}

function randomToken(bytes = 24) {
  return randomBytes(bytes).toString('hex');
}

function hmacSign(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/* Constant-time compare for fixed-shape secrets (hex hashes, tokens). Inputs of
   different length are never equal; for the fixed-length hex values this is
   used on, that tells an attacker nothing. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

module.exports = { sha256Hex, randomToken, hmacSign, safeEqual };
