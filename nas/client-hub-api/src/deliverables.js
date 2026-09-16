// Filesystem side of the video URL scheme: path safety under DELIVERABLES_DIR
// and HTTP Range-aware streaming. Token issuing/lookup lives in hubRoutes.js
// (SQLite), which is the only caller allowed to hand out an absolute path.
import { createReadStream, statSync } from 'node:fs';
import { basename, extname, resolve, sep } from 'node:path';

export const DELIVERABLES_DIR = resolve(process.env.DELIVERABLES_DIR || '/srv/deliverables');

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

// Resolves a relative path under DELIVERABLES_DIR, rejecting anything that
// escapes the tree (absolute paths, `..`, null bytes). Returns the resolved
// absolute path + a pre-fetched stat, or null if the path is unsafe or
// doesn't point at a real file (deleted/renamed after a token was issued).
export function resolveDeliverablePath(relativePath) {
  if (!relativePath || typeof relativePath !== 'string') return null;
  if (relativePath.startsWith('/') || relativePath.includes('\0')) return null;
  const absolute = resolve(DELIVERABLES_DIR, relativePath);
  if (absolute !== DELIVERABLES_DIR && !absolute.startsWith(DELIVERABLES_DIR + sep)) return null;
  try {
    const stat = statSync(absolute);
    return stat.isFile() ? { absolute, stat } : null;
  } catch {
    return null;
  }
}

function contentTypeFor(absolutePath) {
  return MIME_TYPES[extname(absolutePath).toLowerCase()] || 'application/octet-stream';
}

// HTTP Range support (RFC 7233) — what lets a video element scrub/resume
// instead of restarting from byte 0 on every seek. `downloadable` (Slice 14)
// only changes what the browser does with the response (open a Save dialog
// vs. play inline) — the token is still the sole access control either way.
export function streamFile(req, res, absolutePath, stat, downloadable) {
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
