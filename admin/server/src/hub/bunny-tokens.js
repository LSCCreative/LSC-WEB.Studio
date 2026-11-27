'use strict';

/* Bunny CDN token authentication, the advanced (HMAC-SHA256) kind (Bunny Slice 9).
   Follows Bunny's own Node reference (BunnyWay/BunnyCDN.TokenAuthentication,
   nodejs/token.js), read 2026-11-27:

     token = "HS256-" + base64url(HMAC-SHA256(key, signaturePath + expires + signingData))

   signaturePath is the URL's path, or token_path when one is given (a directory:
   every file under it is allowed, which is what lets an HLS player load the
   segments a playlist names). signingData is the token_ parameters, sorted, as
   key=value joined by &, with raw values; in the URL they are URL-encoded. No IP
   is signed (a phone moves between networks mid-review).

   Two forms:
     query  https://host/path/file?token=…&token_path=…&expires=…
     path   https://host/bcdn_token=…&token_path=…&expires=…/path/file
   HLS needs the path form: the player resolves the playlist's relative segment
   URLs against it, so they carry the token too.

   No key: the URL goes out unsigned, as before Slice 9, so the server works the
   same until the pull zone's token authentication is switched on. */

const crypto = require('crypto');

const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * @param {string} url      an unsigned Bunny CDN URL
 * @param {string} key      the pull zone's URL Token Authentication Key ('' = don't sign)
 * @param {{ expires: number, directory?: string, pathForm?: boolean }} opts
 *   expires    Unix seconds
 *   directory  a token_path such as '/<videoId>/' (trailing slash: Bunny matches a prefix)
 *   pathForm   the bcdn_token form, for HLS
 */
function signBunnyUrl(url, key, { expires, directory, pathForm = false }) {
  if (!key) return url;
  const parsed = new URL(url);
  const params = directory ? [['token_path', directory]] : [];
  params.sort(([a], [b]) => a.localeCompare(b));
  const signingData = params.map(([k, v]) => `${k}=${v}`).join('&');
  const urlData = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const hmac = crypto.createHmac('sha256', key);
  hmac.update(directory || parsed.pathname);
  hmac.update(String(expires));
  hmac.update(signingData);
  const token = `HS256-${base64url(hmac.digest())}`;
  const tail = urlData ? `&${urlData}` : '';
  const base = `${parsed.protocol}//${parsed.host}`;
  return pathForm
    ? `${base}/bcdn_token=${token}${tail}&expires=${expires}${parsed.pathname}`
    : `${base}${parsed.pathname}?token=${token}${tail}&expires=${expires}`;
}

/* When a link signed now stops working: at least `ttlSeconds` away, rounded up to
   the hour (or to the TTL, when that is shorter: a test's forced short TTL), so
   replies within the same hour give the same URLs and the browser's cache keeps
   the images it already has. */
function expiresIn(ttlSeconds, nowMs = Date.now()) {
  const step = Math.max(1, Math.min(3600, ttlSeconds));
  const at = Math.floor(nowMs / 1000) + ttlSeconds;
  return Math.ceil(at / step) * step;
}

module.exports = { signBunnyUrl, expiresIn };
