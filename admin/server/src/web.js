'use strict';

/* The admin's own pages, served by this server (merge task M4) rather than by
   GitHub Pages. This re-creates the two jobs Pages' workflow did on each deploy
   (merge safeguard S17), and closes the gaps around them:

   1. js/config.js is written here from the server's settings, never read from
      disk, however its address is spelt. The admin and /api share an origin,
      so the API's address is the page's own; the Google Maps browser key and
      Map ID come from LSC_MAPS_KEY and LSC_MAPS_ID.

   2. Every page gets fresh scripts. A stale cached js/calc.js once priced an
      estimate with an old money model while the server used a new one. So each
      local script and stylesheet a page names is stamped `?v=<hash of the
      file>`, and the page itself is sent `no-cache`: a browser asks for the page
      each time, and a changed file is a new address it has never cached. Only an
      address carrying the file's current stamp may be cached for long. A script
      or stylesheet is sent from the same read its stamp was taken from, so a
      long-cached address always holds the bytes its stamp names.

   3. A tab left open across a change hears about it. The admin page carries a
      version, the hash of the page as stamped, and every /api reply says the
      current one (X-LSC-Version, app.js); js/update.js offers a reload when
      they differ, since the app never reloads on its own.

   4. It won't start wrong. Without web/index.html, or with a web/ copy of
      calc.js, documents.js or call-sheet.js that differs from the server's, it
      refuses to start: a server that passes /health while its pages 500, or
      whose browser and server price differently, is worse than one that is
      plainly down.

   Files are checked against the disk at most once a second, so nothing is read
   per request once warm, and an edit while the server runs is picked up.
   Only the folders the pages need are served: not README.md, and not a
   js/config.js left on disk from serving the folder some other way. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

const WEB_DIR = path.join(__dirname, '..', '..', 'web');

/** The top-level names under web/ that may be served. */
const SERVED = new Set(['index.html', 'favicon.png', 'css', 'js', 'fonts', 'c', 'email']);

/** The pages, by the paths that ask for them. Their references are stamped. */
const PAGES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/c/', 'c/index.html'],
  ['/c/index.html', 'c/index.html'],
]);

/** The files the browser and the server each keep a copy of (web/README.md). */
const MIRRORS = ['calc.js', 'documents.js', 'call-sheet.js']
  .map((name) => ({ web: `js/${name}`, server: path.join(__dirname, name) }));

const CONFIG_FILE = 'js/config.js';
const LONG_CACHE = 'public, max-age=31536000, immutable';

/* A local <script src> or <link href> naming a .js or .css file: relative, with
   no scheme, no leading slash and no query string already. */
const REFERENCE = /(<(?:script|link)\b[^>]*?\b(?:src|href)=")([^"?#:/][^"?#:]*\.(?:js|css))(")/g;
/* Where the admin page carries its version: <meta name="lsc-version" content="">. */
const VERSION_META = /(<meta name="lsc-version" content=")(")/;

const hashOf = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12);

/** A JS string literal that can't close the <script> it is written into. */
const jsString = (value) => JSON.stringify(String(value || '')).replace(/</g, '\\u003c');

function configScript(maps) {
  return [
    '/* Written by the server (server/src/web.js) on each request. The API is this',
    '   page\'s own origin. Not a file: web/js/config.js is never served. */',
    'window.LSC_API_BASE = window.location.origin;',
    `window.LSC_MAPS_KEY = ${jsString(maps.key)};`,
    `window.LSC_MAPS_ID = ${jsString(maps.mapId)};`,
    '',
  ].join('\n');
}

/** Throws unless the folder holds the admin and its copies match the server's. */
function checkWebDir(root, mirrors) {
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    throw new Error(`The admin's pages aren't at ${root}: index.html is missing. The server needs web/ beside server/ (the Docker image copies it in).`);
  }
  for (const m of mirrors) {
    let same = false;
    try {
      same = fs.readFileSync(path.join(root, m.web)).equals(fs.readFileSync(m.server));
    } catch {
      same = false;
    }
    if (!same) {
      throw new Error(`web/${m.web} doesn't match ${m.server}: the browser and the server would disagree. Copy the server's file over it (web/README.md).`);
    }
  }
}

/**
 * opts: { dir: the web/ folder, maps: { key, mapId }, mirrors: [{ web, server }],
 *         recheckMs: how long a file's state is trusted (tests pass 0), now }
 * Returns a router for the admin's pages, files and generated config, with
 * router.version() the admin page's current version.
 */
function createWebRouter({ dir, maps = {}, mirrors = MIRRORS, recheckMs = 1000, now = Date.now }) {
  if (!dir) throw new Error('createWebRouter: dir is required');
  const root = path.resolve(dir);
  checkWebDir(root, mirrors);

  // relative path -> { checkedAt, mtimeMs, size, body, stamp }
  const held = new Map();

  /** The file as last read, its stamp taken from those same bytes; null if it isn't there. */
  function fileOf(rel) {
    const t = now();
    const was = held.get(rel);
    if (was && t - was.checkedAt < recheckMs) return was;
    const abs = path.join(root, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      held.delete(rel);
      return null;
    }
    if (!stat.isFile()) {
      held.delete(rel);
      return null;
    }
    if (was && was.mtimeMs === stat.mtimeMs && was.size === stat.size) {
      was.checkedAt = t;
      return was;
    }
    const body = fs.readFileSync(abs);
    const file = { checkedAt: t, mtimeMs: stat.mtimeMs, size: stat.size, body, stamp: hashOf(body) };
    held.set(rel, file);
    return file;
  }

  /** The page with each local script and stylesheet it names stamped, and no version yet. */
  function stamped(page) {
    const file = fileOf(page);
    if (!file) throw new Error(`${page} is missing from ${root}`);
    const base = path.posix.dirname(page);
    return file.body.toString('utf8').replace(REFERENCE, (whole, open, ref, close) => {
      const rel = path.posix.normalize(path.posix.join(base, ref));
      if (rel === CONFIG_FILE || rel.startsWith('../')) return whole;
      const asset = fileOf(rel);
      return asset ? `${open}${ref}?v=${asset.stamp}${close}` : whole;
    });
  }

  /** The admin page's version: a hash of it as stamped, so any change to it or a file it loads. '' if unreadable. */
  function version() {
    try {
      return hashOf(stamped('index.html'));
    } catch {
      return '';
    }
  }

  // Strict, so /c doesn't match /c/: the file server redirects it there, where
  // the page's relative addresses resolve.
  const router = express.Router({ strict: true });

  router.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  router.get([...PAGES.keys()], (req, res, next) => {
    let body;
    try {
      body = stamped(PAGES.get(req.path));
    } catch (err) {
      return next(err);
    }
    body = body.replace(VERSION_META, `$1${hashOf(body)}$2`);
    res.setHeader('Cache-Control', 'no-cache');
    // The admin and the client pages are never framed: no clickjacking.
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.type('html').send(body);
  });

  const others = express.static(root, {
    index: false,
    redirect: true,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  });

  router.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    // The path as the file server would read it: /js/../README.md, %2e%2e,
    // /js/./config.js and /js//config.js all become what they name.
    let rel;
    try {
      rel = path.posix.normalize(decodeURIComponent(req.path)).replace(/^\/+/, '');
    } catch {
      return next();
    }
    if (rel.toLowerCase() === CONFIG_FILE) {
      res.setHeader('Cache-Control', 'no-store');
      return res.type('application/javascript').send(configScript(maps));
    }
    if (!SERVED.has(rel.split('/')[0])) return next();
    if (!/\.(?:js|css)$/.test(rel)) return others(req, res, next);
    const file = fileOf(rel);
    if (!file) return next();
    res.setHeader('Cache-Control', req.query.v === file.stamp ? LONG_CACHE : 'no-cache');
    res.setHeader('ETag', `"${file.stamp}"`);
    res.type(path.extname(rel));
    return res.send(file.body); // answers 304 itself when the ETag still matches
  });

  router.version = version;
  return router;
}

module.exports = { createWebRouter, WEB_DIR, MIRRORS };
