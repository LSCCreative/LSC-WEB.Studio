'use strict';

/* The filesystem side of deliverable links: keeping paths inside the
   deliverables folder, and streaming files with Range support. Tokens live in
   routes.js, the only caller allowed to turn one into an absolute path. */

const { createReadStream, readdirSync, statSync } = require('fs');
const { basename, extname, resolve, sep } = require('path');

const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4v': 'video/x-m4v',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

/* What a photo library may show. A subset of MIME_TYPES: a photo folder can
   also hold proxies, RAWs, sidecars or .DS_Store, which don't belong in the
   client's grid. */
const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/* A mis-pasted path (the share root instead of one project folder) would
   otherwise mint two tokens for every image on the NAS in one click. */
const MAX_PHOTOS_PER_FOLDER = 200;

function contentTypeFor(absolutePath) {
  return MIME_TYPES[extname(absolutePath).toLowerCase()] || 'application/octet-stream';
}

function createDeliverables(dir) {
  const root = resolve(dir || '/srv/deliverables');

  /* Absolute path under the folder, or null for anything that escapes it
     (absolute paths, `..`, null bytes). */
  function inside(relativePath) {
    if (!relativePath || typeof relativePath !== 'string') return null;
    if (relativePath.startsWith('/') || relativePath.includes('\0')) return null;
    const absolute = resolve(root, relativePath);
    if (absolute !== root && !absolute.startsWith(root + sep)) return null;
    return absolute;
  }

  /* The resolved path and its stat, or null if the path is unsafe or isn't a
     real file (deleted or renamed after its token was issued). */
  function resolveDeliverablePath(relativePath) {
    const absolute = inside(relativePath);
    if (!absolute) return null;
    try {
      const stat = statSync(absolute);
      return stat.isFile() ? { absolute, stat } : null;
    } catch {
      return null;
    }
  }

  /* Image names directly in one folder, sorted. Callers never get an absolute
     path, so this can't list anything outside the deliverables folder. One
     flat folder by design: subfolders are left out. */
  function listDeliverableFolderImages(relativePath) {
    const absolute = inside(relativePath);
    if (!absolute) return null;
    let stat;
    try {
      stat = statSync(absolute);
    } catch {
      return null;
    }
    if (!stat.isDirectory()) return null;
    return readdirSync(absolute, { withFileTypes: true })
      .filter((entry) => entry.isFile() && PHOTO_EXTENSIONS.has(extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  }

  /* For /health: whether the folder can be read, and how many project folders
     it holds. */
  function health() {
    try {
      return { ok: true, projects: readdirSync(root).length };
    } catch (err) {
      return { ok: false, error: err.code };
    }
  }

  return { root, resolveDeliverablePath, listDeliverableFolderImages, health };
}

/* HTTP Range support (RFC 7233), so a video can seek instead of restarting.
   `downloadable` only changes whether the browser saves or plays the file;
   the token is the access control either way. */
function streamFile(req, res, absolutePath, stat, downloadable) {
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentTypeFor(absolutePath));
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Last-Modified', stat.mtime.toUTCString());
  res.setHeader('Content-Disposition', downloadable
    ? `attachment; filename="${basename(absolutePath).replace(/"/g, '')}"`
    : 'inline');

  const range = req.headers.range;
  if (!range) {
    res.setHeader('Content-Length', stat.size);
    createReadStream(absolutePath).pipe(res);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  const hasStart = Boolean(match && match[1] !== '');
  const hasEnd = Boolean(match && match[2] !== '');
  if (!match || (!hasStart && !hasEnd)) {
    res.setHeader('Content-Range', `bytes */${stat.size}`);
    res.status(416).end();
    return;
  }

  const start = hasStart ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
  const end = hasStart && hasEnd ? Number(match[2]) : stat.size - 1;

  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0 || end >= stat.size) {
    res.setHeader('Content-Range', `bytes */${stat.size}`);
    res.status(416).end();
    return;
  }

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  res.setHeader('Content-Length', end - start + 1);
  createReadStream(absolutePath, { start, end }).pipe(res);
}

module.exports = { createDeliverables, streamFile, MAX_PHOTOS_PER_FOLDER };
