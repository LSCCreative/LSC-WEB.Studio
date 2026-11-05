'use strict';

/* The only file that talks to Bunny. Native fetch, no SDK. Keys arrive in
   `settings` at startup and only travel in the AccessKey header, so they can't
   reach an error message or a log line. Publishing logic lives in routes.js. */

const STREAM_API = 'https://video.bunnycdn.com';
const REQUEST_TIMEOUT_MS = 30_000;

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
  const { libraryId, streamApiKey, streamCdnHost } = settings;

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

  /* The list filter is a substring match, so an exact-name check is still
     needed: "Acme" also returns "Acme Winter". Adopting an existing collection
     is what stops a lost row from creating a second one. */
  async function findOrCreateCollection(name) {
    const params = new URLSearchParams({ search: name, itemsPerPage: '1000' });
    const { items } = await streamRequest(`/collections?${params}`);
    const existing = (items || []).find((c) => c.name === name);
    if (existing) return existing.guid;
    const created = await streamRequest('/collections', { method: 'POST', body: { name } });
    return created.guid;
  }

  /* Bunny pulls the file itself. Its response has no video id, so the caller
     puts a unique tag in the title and finds it with findVideoByTag. */
  async function fetchVideo({ url, title, collectionId }) {
    const params = new URLSearchParams({ collectionId });
    await streamRequest(`/videos/fetch?${params}`, { method: 'POST', body: { url, title } });
  }

  /* Newest video carrying this tag, skipping failed ones so a retry can't adopt
     the attempt it's replacing. Null if Bunny hasn't listed it yet. */
  async function findVideoByTag(tag, collectionId) {
    const params = new URLSearchParams({ search: tag, collection: collectionId, itemsPerPage: '100' });
    const { items } = await streamRequest(`/videos?${params}`);
    const matches = (items || [])
      .filter((v) => v.title?.includes(tag) && statusFromVideo(v) !== 'failed')
      .sort((a, b) => String(b.dateUploaded).localeCompare(String(a.dateUploaded)));
    return matches[0] || null;
  }

  const hlsUrl = (videoId) => `https://${streamCdnHost}/${videoId}/playlist.m3u8`;
  const posterUrl = (videoId) => `https://${streamCdnHost}/${videoId}/thumbnail.jpg`;

  return { findOrCreateCollection, fetchVideo, findVideoByTag, statusFromVideo, hlsUrl, posterUrl };
}

module.exports = { createBunny, missingBunnySettings, statusFromVideo };
