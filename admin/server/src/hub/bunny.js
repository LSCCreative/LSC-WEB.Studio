'use strict';

/* The only file that talks to Bunny. Native fetch, no SDK. Keys arrive in
   `settings` at startup and only travel in the AccessKey header, so they can't
   reach an error message or a log line. Publishing logic lives in
   ../bunny-publish.js. */

const STREAM_API = 'https://video.bunnycdn.com';
const REQUEST_TIMEOUT_MS = 30_000;
/* An original photo or master through the NAS's upload: generous, so a big file on
   a slow line isn't cut off, but a hung connection still ends. */
const STORAGE_PUT_TIMEOUT_MS = 15 * 60 * 1000;

/* A host as the .env may give it, with or without a scheme or a trailing slash. */
const bareHost = (host) => String(host || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
/* Each segment of a storage path escaped on its own, so a name with spaces, `#` or
   `?` stays one file and a `/` in a path still separates folders. */
const escapePath = (path) => String(path).split('/').map(encodeURIComponent).join('/');

/* Every key the hub needed at boot. The CDN token key isn't here: token auth
   comes later, and requiring it now would stop the server starting. */
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

function createBunny(settings, { fetchImpl = fetch } = {}) {
  const missing = missingBunnySettings(settings);
  if (missing.length) throw new Error(`Bunny isn't set up: missing ${missing.join(', ')}`);
  const { libraryId, streamApiKey, streamCdnHost, storageZone, storagePassword } = settings;
  const storageHost = bareHost(settings.storageHost);
  const storageCdnHost = bareHost(settings.storageCdnHost);
  const storageApiUrl = (path) => `https://${storageHost}/${encodeURIComponent(storageZone)}/${escapePath(path)}`;

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
     is the bytes' SHA-256 in hex: Bunny refuses the upload if what arrived differs. */
  async function putObject(path, body, { length, checksum } = {}) {
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
      signal: AbortSignal.timeout(STORAGE_PUT_TIMEOUT_MS),
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

  /* Where a stored file is served from (the storage zone's pull zone). */
  const storageUrl = (path) => `https://${storageCdnHost}/${escapePath(path)}`;

  const hlsUrl = (videoId) => `https://${streamCdnHost}/${videoId}/playlist.m3u8`;
  const posterUrl = (videoId) => `https://${streamCdnHost}/${videoId}/thumbnail.jpg`;

  return {
    findOrCreateCollection, fetchVideo, findVideoByTag, getVideo, statusFromVideo, hlsUrl, posterUrl,
    putObject, listFolder, storageUrl,
  };
}

module.exports = { createBunny, missingBunnySettings, statusFromVideo };
