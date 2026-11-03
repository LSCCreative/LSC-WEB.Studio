// The only file that talks to Bunny. Native fetch, no SDK. Keys come from the
// NAS .env and only ever travel in the AccessKey header, so they can't reach an
// error message or a log line. Publishing logic and SQLite live in hubRoutes.js.

// BUNNY_CDN_TOKEN_KEY is deliberately absent: token auth doesn't exist until
// Slice 9, and requiring it now would stop the API booting.
const REQUIRED_ENV = [
  'BUNNY_STREAM_LIBRARY_ID',
  'BUNNY_STREAM_API_KEY',
  'BUNNY_STREAM_READ_KEY',
  'BUNNY_STREAM_CDN_HOST',
  'BUNNY_STORAGE_ZONE',
  'BUNNY_STORAGE_PASSWORD',
  'BUNNY_STORAGE_HOST',
  'BUNNY_STORAGE_CDN_HOST',
];
const missingEnv = REQUIRED_ENV.filter(name => !process.env[name]);
if (missingEnv.length) {
  throw new Error(`Missing env vars: ${missingEnv.join(', ')} — set them in the NAS .env, never in the repo.`);
}

const STREAM_API = 'https://video.bunnycdn.com';
const LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID;
const STREAM_API_KEY = process.env.BUNNY_STREAM_API_KEY;
const STREAM_CDN_HOST = process.env.BUNNY_STREAM_CDN_HOST;

const REQUEST_TIMEOUT_MS = 30_000;

async function streamRequest(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${STREAM_API}/library/${LIBRARY_ID}${path}`, {
    method,
    headers: {
      AccessKey: STREAM_API_KEY,
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

// The list filter is a substring match, so an exact-name check is still needed:
// searching "Acme" also returns "Acme Winter". Adopting an existing collection
// here is what stops a lost DB row from creating a second one.
export async function findOrCreateCollection(name) {
  const params = new URLSearchParams({ search: name, itemsPerPage: '1000' });
  const { items } = await streamRequest(`/collections?${params}`);
  const existing = (items || []).find(c => c.name === name);
  if (existing) return existing.guid;
  const created = await streamRequest('/collections', { method: 'POST', body: { name } });
  return created.guid;
}

// Bunny pulls the file itself, so nothing has to stay awake to upload it.
// Its documented response is only { success, message, statusCode } with no
// video id, so the caller puts a unique tag in the title and finds it with
// findVideoByTag.
export async function fetchVideo({ url, title, collectionId }) {
  const params = new URLSearchParams({ collectionId });
  await streamRequest(`/videos/fetch?${params}`, { method: 'POST', body: { url, title } });
}

// Bunny's REST enum, which is NOT the webhook's: here 3 is still transcoding
// and 4 is finished, whereas a webhook's 3 means finished.
export function statusFromVideo(video) {
  if (video.status === 4) return 'ready';
  if (video.status === 5 || video.status === 6) return 'failed';
  return 'processing';
}

// Newest video carrying this tag, skipping failed ones so a retry can't adopt
// the attempt it's replacing. Null if Bunny hasn't listed it yet.
export async function findVideoByTag(tag, collectionId) {
  const params = new URLSearchParams({ search: tag, collection: collectionId, itemsPerPage: '100' });
  const { items } = await streamRequest(`/videos?${params}`);
  const matches = (items || [])
    .filter(v => v.title?.includes(tag) && statusFromVideo(v) !== 'failed')
    .sort((a, b) => String(b.dateUploaded).localeCompare(String(a.dateUploaded)));
  return matches[0] || null;
}

export function hlsUrl(videoId) {
  return `https://${STREAM_CDN_HOST}/${videoId}/playlist.m3u8`;
}

export function posterUrl(videoId) {
  return `https://${STREAM_CDN_HOST}/${videoId}/thumbnail.jpg`;
}
