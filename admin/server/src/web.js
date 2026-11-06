'use strict';

/* The admin's own pages, served by this server (merge task M4) rather than by
   GitHub Pages. This re-creates the two jobs Pages' workflow did on each deploy
   (merge safeguard S17):

   1. js/config.js is written here from the server's settings, never read from
      disk. The admin and /api now share an origin, so the API's address is the
      page's own; the Google Maps browser key and Map ID come from LSC_MAPS_KEY
      and LSC_MAPS_ID.

   2. Every page gets fresh scripts. A stale cached js/calc.js once priced an
      estimate with an old money model while the server used a new one. So each
      local script and stylesheet a page names is stamped `?v=<hash of the
      file>`, and the page itself is sent `no-cache`: a browser asks for the page
      each time, and a changed file is a new address it has never cached. Only an
      address carrying the file's current stamp may be cached for long; anything
      else is revalidated. The stamp follows the file's contents, so it changes
      when a file does and not on every restart, and it is rechecked on each page
      request, so a file edited while the server runs is picked up too.

   Only the folders the pages need are served: not README.md, and not a
   js/config.js left on disk from serving the folder some other way. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

/** The top-level names under web/ that may be served. */
const SERVED = new Set(['index.html', 'favicon.png', 'css', 'js', 'fonts', 'c', 'email']);

/** The pages, by the paths that ask for them. Their references are stamped. */
const PAGES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/c/', 'c/index.html'],
  ['/c/index.html', 'c/index.html'],
]);

const CONFIG_FILE = 'js/config.js';
const LONG_CACHE = 'public, max-age=31536000, immutable';

/* A local <script src> or <link href> naming a .js or .css file: relative, with
   no scheme, no leading slash and no query string already. */
const REFERENCE = /(<(?:script|link)\b[^>]*?\b(?:src|href)=")([^"?#:/][^"?#:]*\.(?:js|css))(")/g;

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

/**
 * opts: { dir: the web/ folder, maps: { key, mapId } }
 * Returns a router for the admin's pages, files and generated config.
 */
function createWebRouter({ dir, maps = {} }) {
  if (!dir) throw new Error('createWebRouter: dir is required');
  const root = path.resolve(dir);
  const stamps = new Map(); // relative path -> { mtimeMs, size, stamp }

  /** The file's current stamp, or '' if it isn't there. */
  function stampOf(rel) {
    let stat;
    try {
      stat = fs.statSync(path.join(root, rel));
    } catch {
      stamps.delete(rel);
      return '';
    }
    if (!stat.isFile()) return '';
    const held = stamps.get(rel);
    if (held && held.mtimeMs === stat.mtimeMs && held.size === stat.size) return held.stamp;
    const stamp = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex').slice(0, 12);
    stamps.set(rel, { mtimeMs: stat.mtimeMs, size: stat.size, stamp });
    return stamp;
  }

  /** The page with each local script and stylesheet it names stamped. */
  function stampedPage(page) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    const base = path.posix.dirname(page);
    return html.replace(REFERENCE, (whole, open, ref, close) => {
      const rel = path.posix.normalize(path.posix.join(base, ref));
      if (rel === CONFIG_FILE || rel.startsWith('../')) return whole;
      const stamp = stampOf(rel);
      return stamp ? `${open}${ref}?v=${stamp}${close}` : whole;
    });
  }

  const router = express.Router();

  router.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  router.get(`/${CONFIG_FILE}`, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/javascript').send(configScript(maps));
  });

  router.get([...PAGES.keys()], (req, res, next) => {
    // Routing isn't strict, so /c arrives here too: send it to /c/, where the
    // page's relative addresses resolve.
    const page = PAGES.get(req.path);
    if (!page) return req.path === '/c' ? res.redirect(301, '/c/') : next();
    let body;
    try {
      body = stampedPage(page);
    } catch (err) {
      return next(err);
    }
    res.setHeader('Cache-Control', 'no-cache');
    // The admin and the client pages are never framed: no clickjacking.
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.type('html').send(body);
  });

  const files = express.static(root, {
    index: false,
    redirect: true,
    setHeaders(res, file) {
      const rel = path.relative(root, file).split(path.sep).join('/');
      const v = res.req.query.v;
      const current = /\.(?:js|css)$/.test(rel) && typeof v === 'string' && v === stampOf(rel);
      res.setHeader('Cache-Control', current ? LONG_CACHE : 'no-cache');
    },
  });

  router.use((req, res, next) => {
    // Judged on the path as the file server will read it, so /js/../README.md
    // (or the same with %2e) can't reach a file outside the served folders.
    let segments;
    try {
      segments = decodeURIComponent(req.path).split('/');
    } catch {
      return next();
    }
    if (segments.includes('..') || !SERVED.has(segments[1])) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    return files(req, res, next);
  });

  return router;
}

module.exports = { createWebRouter, WEB_DIR: path.join(__dirname, '..', '..', 'web') };
