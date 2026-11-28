'use strict';

/* The only file that talks to Bunny. Native fetch, no SDK. Keys arrive in
   `settings` at startup and only travel in the AccessKey header, so they can't
   reach an error message or a log line. Publishing logic lives in
   ../bunny-publish.js. */

const { signBunnyUrl, expiresIn } = require('./bunny-tokens');

const STREAM_API = 'https://video.bunnycdn.com';
/* How long a signed Bunny link works (Slice 9): long enough for a review session. */
const SIGNED_TTL_SECONDS = 6 * 60 * 60;
const REQUEST_TIMEOUT_MS = 30_000;
/* An original photo or master through the NAS's upload: generous, so a big file on
   a slow line isn't cut off, but a hung connection still ends. */
const STORAGE_PUT_TIMEOUT_MS = 15 * 60 * 1000;

/* A host as the .env may give it, with or without a scheme or a trailing slash. */
const bareHost = (host) => String(host || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
/* Each segment of a storage path escaped on its own, so a name with spaces, `#` or
   `?` stays one file and a `/` in a path still separates folders. */
const escapePath = (path) => String(path).split('/').map(encodeURIComponent).join('/');

/* Every key the hub needed at boot. The two pull zones' token keys aren't here
   (BUNNY_STREAM_TOKEN_KEY, BUNNY_STORAGE_TOKEN_KEY, Slice 9): without one, that
   zone's links go out unsigned, which works until its token authentication is on. */
const REQUIRED = {
  libraryId: 'BUNNY_STREAM_LIBRARY_ID',
  streamApiKey: 'BUNNY_STREAM_API_KEY',
  streamReadKey: 'BUNNY_STREAM_READ_KEY',
  streamCdnHost: 'BUNNY_STREAM_CDN_HOST',
  storageZone: 'BUNNY_STORAGE_ZONE',
  storagePassword: 'BUNNY_STORAGE_PASSWORD',
  storageHost: 'BUNNY_STORAGE_HOST',
  storageCdnHost: 'BUNNY_STORAGE_CDN_HOST',
};

/* The env names still missing, so the server can say Bunny isn't set up
   rather than refusing to start the whole admin. */
function missingBunnySettings(settings = {}) {
  return Object.entries(REQUIRED).filter(([key]) => !settings[key]).map(([, name]) => name);
}

/* Bunny's REST enum, which is NOT the webhook's: here 3 is still transcoding
   and 4 is finished, whereas a webhook's 3 means finished. */
function statusFromVideo(video) {
  if (video.status === 4) return 'ready';
  if (video.status === 5 || video.status === 6) return 'failed';
  return 'processing';
}

function createBunny(settings, { fetchImpl = fetch, now = Date.now } = {}) {
  const missing = missingBunnySettings(settings);
  if (missing.length) throw new Error(`Bunny isn't set up: missing ${missing.join(', ')}`);
  const { libraryId, streamApiKey, streamCdnHost, storageZone, storagePassword } = settings;
  const storageHost = bareHost(settings.storageHost);
  const storageCdnHost = bareHost(settings.storageCdnHost);
  const storageApiUrl = (path) => `https://${storageHost}/${encodeURIComponent(storageZone)}/${escapePath(path)}`;
  const ttl = Number(settings.signedTtlSeconds) > 0 ? Number(settings.signedTtlSeconds) : SIGNED_TTL_SECONDS;
  const streamTokenKey = settings.streamTokenKey || '';
  const storageTokenKey = settings.storageTokenKey || '';

  /* Bunny Storage's reason, from its JSON ({ HttpCode, Message }) when it sends one. */
  async function storageReason(res) {
    const text = await res.text().catch(() => '');
    try { return JSON.parse(text).Message || 'no details'; } catch (_) { return 'no details'; }
  }

  async function streamRequest(path, { method = 'GET', body } = {}) {
    const res = await fetchImpl(`${STREAM_API}/library/${libraryId}${path}`, {
      method,
      headers: {
        AccessKey: streamApiKey,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => null);
    // Fetch reports some rejections as HTTP 200 with success:false.
    if (!res.ok || data?.success === false) {
      throw new Error(`Bunny Stream ${method} failed (${res.status}): ${data?.message || 'no details'}`);
    }
    return data;
  }

  /* The list filter is a substring match, so the caller's own check is still
     needed: "Acme" also returns "Acme Winter". `key` is what the search looks
     for and `owns(name)` which listed name is really it (bunny-publish.js: the
     project's id, so a renamed project still finds its collection). Adopting an
     existing collection is what stops a lost row from creating a second one.
     Returns { id, name }: the name Bunny has, found or made. */
  async function findOrCreateCollection(name, { key = name, owns = (n) => n === name } = {}) {
    const params = new URLSearchParams({ search: key, itemsPerPage: '1000' });
    const { items } = await streamRequest(`/collections?${params}`);
    const existing = (items || []).find((c) => owns(String(c.name || '')));
    if (existing) return { id: existing.guid, name: existing.name };
    const created = await streamRequest('/collections', { method: 'POST', body: { name } });
    return { id: created.guid, name };
  }

  /* Bunny pulls the file itself. Its response has no video id, so the caller
     puts a unique tag in the title and finds it with findVideoByTag. */
  async function fetchVideo({ url, title, collectionId }) {
    const params = new URLSearchParams({ collectionId });
    await streamRequest(`/videos/fetch?${params}`, { method: 'POST', body: { url, title } });
  }

  /* Newest video carrying this tag. Null if Bunny hasn't listed it yet. A failed
     one is skipped unless `includeFailed`: adopting after a crash must not pick
     up a dead attempt, but a row looking for its own (unique) tag needs to see
     that Bunny gave up, or it waits out the 30 minutes for nothing. */
  async function findVideoByTag(tag, collectionId, { includeFailed = false } = {}) {
    const params = new URLSearchParams({ search: tag, collection: collectionId, itemsPerPage: '100' });
    const { items } = await streamRequest(`/videos?${params}`);
    const matches = (items || [])
      .filter((v) => v.title?.includes(tag) && (includeFailed || statusFromVideo(v) !== 'failed'))
      .sort((a, b) => String(b.dateUploaded).localeCompare(String(a.dateUploaded)));
    return matches[0] || null;
  }

  /* One video by its id, for a row still transcoding. Null once Bunny has no
     such video (deleted in the dashboard), so the caller can say so. A 404 only
     counts as that when the library itself still answers: a wrong library id or
     a moved API also 404s, and must not read as every video deleted. */
  async function getVideo(videoId) {
    try {
      return await streamRequest(`/videos/${encodeURIComponent(videoId)}`);
    } catch (err) {
      if (!/\(404\)/.test(err.message)) throw err;
      await streamRequest('/videos?itemsPerPage=1');
      return null;
    }
  }

  /* Edge Storage (photos, Slice 6; masters, Slice 8). `body` is a Buffer or a file
     stream: a stream needs `length`, which Bunny is sent as Content-Length. `checksum`
     is the bytes' SHA-256 in hex: Bunny refuses the upload if what arrived differs.
     `signal` replaces the 15-minute limit: a master may take hours on the NAS's
     upload, so its job ends the request itself when the bytes stop moving. */
  async function putObject(path, body, { length, checksum, signal } = {}) {
    const res = await fetchImpl(storageApiUrl(path), {
      method: 'PUT',
      headers: {
        AccessKey: storagePassword,
        'Content-Type': 'application/octet-stream',
        ...(length != null ? { 'Content-Length': String(length) } : {}),
        ...(checksum ? { Checksum: String(checksum).toUpperCase() } : {}),
      },
      body,
      duplex: 'half',
      signal: signal || AbortSignal.timeout(STORAGE_PUT_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Bunny Storage refused the upload (${res.status}): ${await storageReason(res)}`);
  }

  /* What one storage folder holds: [{ name, length, checksum }] for its files (the
     checksum is Bunny's SHA-256, uppercase hex). A folder that isn't there is empty. */
  async function listFolder(path) {
    const res = await fetchImpl(`${storageApiUrl(path)}/`, {
      headers: { AccessKey: storagePassword, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`Bunny Storage couldn’t list a folder (${res.status}): ${await storageReason(res)}`);
    const items = await res.json().catch(() => null);
    if (!Array.isArray(items)) throw new Error('Bunny Storage listed a folder in a shape this server doesn’t know.');
    return items.filter((i) => !i.IsDirectory).map((i) => ({ name: i.ObjectName, length: i.Length, checksum: i.Checksum || null }));
  }

  /* What one storage folder holds, folders included, for cleanup (Slice 11):
     [{ name, isDirectory, length, changedAt }]. A folder that isn't there is empty. */
  async function listEntries(path) {
    const res = await fetchImpl(`${storageApiUrl(path)}/`, {
      headers: { AccessKey: storagePassword, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`Bunny Storage couldn’t list a folder (${res.status}): ${await storageReason(res)}`);
    const items = await res.json().catch(() => null);
    if (!Array.isArray(items)) throw new Error('Bunny Storage listed a folder in a shape this server doesn’t know.');
    return items.map((i) => ({
      name: i.ObjectName, isDirectory: Boolean(i.IsDirectory), length: i.Length,
      changedAt: i.LastChanged || i.DateCreated || null,
    }));
  }

  /* ── Removing (Slice 11: cleanup and Take offline). Each answers once the thing
     is gone, and one already gone counts as gone, so a removal can be run again. */

  /* A file, or with `folder` the whole folder and everything under it. */
  async function deleteObject(path, { folder = false } = {}) {
    // Never the zone itself: a folder delete is recursive, so an empty path would take every client's files.
    if (!String(path || '').split('/').some(Boolean)) throw new Error('Refusing to delete Bunny Storage’s root.');
    const res = await fetchImpl(`${storageApiUrl(path)}${folder ? '/' : ''}`, {
      method: 'DELETE',
      headers: { AccessKey: storagePassword, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok || res.status === 404) return;
    throw new Error(`Bunny Storage couldn’t delete ${folder ? 'a folder' : 'a file'} (${res.status}): ${await storageReason(res)}`);
  }

  /* Like getVideo, a 404 is "already gone" only while the library itself answers. */
  async function deleteVideo(videoId) {
    try {
      await streamRequest(`/videos/${encodeURIComponent(videoId)}`, { method: 'DELETE' });
    } catch (err) {
      if (!/\(404\)/.test(err.message)) throw err;
      await streamRequest('/videos?itemsPerPage=1');
    }
  }

  /* Every video in one collection, page by page: [{ guid, title, dateUploaded }]. */
  async function listCollectionVideos(collectionId) {
    const all = [];
    for (let page = 1; page <= 100; page += 1) {
      const params = new URLSearchParams({ collection: collectionId, page: String(page), itemsPerPage: '100' });
      const data = await streamRequest(`/videos?${params}`);
      const items = Array.isArray(data && data.items) ? data.items : [];
      all.push(...items.map((v) => ({ guid: v.guid, title: String(v.title || ''), dateUploaded: v.dateUploaded || null })));
      const total = Number(data && data.totalItems);
      if (items.length < 100 || (Number.isFinite(total) && all.length >= total)) break;
    }
    return all;
  }

  async function deleteCollection(collectionId) {
    try {
      await streamRequest(`/collections/${encodeURIComponent(collectionId)}`, { method: 'DELETE' });
    } catch (err) {
      if (!/\(404\)/.test(err.message)) throw err;
      await streamRequest('/videos?itemsPerPage=1');
    }
  }

  /* Every CDN link below is built when someone is answered, never stored, and signed
     here, the one place (Slice 9): a link copied out of a reply stops working once it
     expires. A video's links carry a token for its whole folder, in the path, so the
     playlist's segments load with it. `ttlSeconds` overrides the review TTL (a
     download's redirect). */
  const storageUrl = (path, { ttlSeconds = ttl } = {}) => signBunnyUrl(
    `https://${storageCdnHost}/${escapePath(path)}`, storageTokenKey, { expires: expiresIn(ttlSeconds, now()) },
  );
  const streamUrl = (videoId, file) => signBunnyUrl(
    `https://${streamCdnHost}/${videoId}/${file}`, streamTokenKey,
    { expires: expiresIn(ttl, now()), directory: `/${videoId}/`, pathForm: true },
  );
  const hlsUrl = (videoId) => streamUrl(videoId, 'playlist.m3u8');
  const posterUrl = (videoId) => streamUrl(videoId, 'thumbnail.jpg');

  return {
    findOrCreateCollection, fetchVideo, findVideoByTag, getVideo, statusFromVideo, hlsUrl, posterUrl,
    putObject, listFolder, storageUrl,
    listEntries, deleteObject, deleteVideo, listCollectionVideos, deleteCollection,
  };
}

module.exports = { createBunny, missingBunnySettings, statusFromVideo, SIGNED_TTL_SECONDS };
