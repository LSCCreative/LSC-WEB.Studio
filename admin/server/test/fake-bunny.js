'use strict';

/* A stand-in for Bunny Stream's API, from the shapes in its OpenAPI 1.6.18 and what
   the real library did on 2026-11-03: the fetch call answers with no video id
   (some refusals as HTTP 200 with success:false), and the search is a substring
   match. One library, `lib1`. Nothing here touches the network.

   state:
     collections, videos   what Bunny holds
     failFetch             the next fetch calls are refused
     listAfter             how many searches pass before a fetched video is listed
                           (Bunny lists one a few seconds after accepting it)
     neverList             fetched videos are never listed
     statusOnFetch         a fetched video's REST status (4 finished, 3 transcoding,
                           5 transcode failed, 6 the pull failed)
     libraryGone           every request 404s, as a wrong library id would
   calls: every request, with the AccessKey it carried.

   Edge Storage (Slice 6), at FAKE_BUNNY_SETTINGS' storage host, zone `zone`:
     storage               path → { bytes, length, checksum } of every file PUT
     failPut(path)         true refuses that PUT (500)
     onPut(path)           awaited inside each PUT, before it lands
     listFails             a folder listing answers 500
   A PUT checks Content-Length and the Checksum header against the bytes, as Bunny does. */

function fakeBunny() {
  const calls = [];
  const state = {
    collections: [], videos: [], failFetch: false, listAfter: 0, neverList: false, statusOnFetch: 4, libraryGone: false,
    storage: new Map(), failPut: null, onPut: null, listFails: false,
  };
  const reply = (status, data) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) });

  async function bytesOf(body) {
    if (Buffer.isBuffer(body)) return body;
    const chunks = [];
    for await (const c of body) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  }

  async function storageImpl(u, init, method) {
    const headers = init.headers || {};
    if (headers.AccessKey !== FAKE_BUNNY_SETTINGS.storagePassword) return reply(401, { HttpCode: 401, Message: 'Unauthorized' });
    const segments = u.pathname.split('/').slice(1).map(decodeURIComponent);
    if (segments[0] !== FAKE_BUNNY_SETTINGS.storageZone) return reply(404, { HttpCode: 404, Message: 'no such zone' });
    const path = segments.slice(1).join('/');
    if (method === 'PUT') {
      const bytes = await bytesOf(init.body);
      if (state.onPut) await state.onPut(path);
      if (state.failPut && state.failPut(path)) return reply(500, { HttpCode: 500, Message: 'storage hiccup' });
      if (headers['Content-Length'] !== undefined && Number(headers['Content-Length']) !== bytes.length) {
        return reply(400, { HttpCode: 400, Message: 'length mismatch' });
      }
      const checksum = require('crypto').createHash('sha256').update(bytes).digest('hex').toUpperCase();
      if (headers.Checksum && headers.Checksum !== checksum) return reply(400, { HttpCode: 400, Message: 'checksum mismatch' });
      state.storage.set(path, { bytes, length: bytes.length, checksum });
      return reply(201, { HttpCode: 201, Message: 'File uploaded.' });
    }
    if (method === 'GET' && u.pathname.endsWith('/')) {
      if (state.listFails) return reply(500, { HttpCode: 500, Message: 'list hiccup' });
      const folder = path.replace(/\/$/, '');
      const inside = [...state.storage.entries()].filter(([k]) => k.slice(0, k.lastIndexOf('/')) === folder);
      if (!inside.length) return reply(404, { HttpCode: 404, Message: 'Object Not Found' });
      return reply(200, inside.map(([k, f]) => ({ ObjectName: k.slice(k.lastIndexOf('/') + 1), Length: f.length, Checksum: f.checksum, IsDirectory: false })));
    }
    return reply(404, { HttpCode: 404, Message: 'no such route' });
  }
  const listed = (v) => !state.neverList && v.searchesSeen >= v.listAfter;

  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const method = init.method || 'GET';
    calls.push({ method, host: u.host, path: u.pathname, search: u.search, key: init.headers && init.headers.AccessKey, body: init.body });
    if (u.host === FAKE_BUNNY_SETTINGS.storageHost) return storageImpl(u, init, method);
    const route = u.pathname.replace('/library/lib1', '');
    if (!u.pathname.startsWith('/library/lib1') || state.libraryGone) return reply(404, { message: 'no such library' });
    if (route === '/collections' && method === 'GET') {
      return reply(200, { items: state.collections.filter((c) => c.name.includes(u.searchParams.get('search'))) });
    }
    if (route === '/collections' && method === 'POST') {
      const c = { guid: `col-${state.collections.length + 1}`, name: JSON.parse(init.body).name };
      state.collections.push(c);
      return reply(200, c);
    }
    if (route === '/videos/fetch' && method === 'POST') {
      if (state.failFetch) return reply(200, { success: false, message: 'fetch refused', statusCode: 400 });
      const { title, url: source } = JSON.parse(init.body);
      state.videos.push({
        guid: `vid-${state.videos.length + 1}`, title, status: state.statusOnFetch, dateUploaded: new Date().toISOString(),
        collectionId: u.searchParams.get('collectionId'), source, listAfter: state.listAfter, searchesSeen: 0,
      });
      return reply(200, { success: true, message: 'OK', statusCode: 200 });
    }
    if (route === '/videos' && method === 'GET') {
      const search = u.searchParams.get('search');
      const collection = u.searchParams.get('collection');
      const found = state.videos.filter((v) => v.title.includes(search) && (!collection || v.collectionId === collection));
      for (const v of found) v.searchesSeen += 1;
      return reply(200, { items: found.filter(listed).map(({ listAfter, searchesSeen, ...v }) => v) });
    }
    const one = /^\/videos\/([^/]+)$/.exec(route);
    if (one && method === 'GET') {
      const v = state.videos.find((x) => x.guid === decodeURIComponent(one[1]));
      if (!v) return reply(404, { message: 'Video not found' });
      const { listAfter, searchesSeen, ...shown } = v;
      return reply(200, shown);
    }
    return reply(404, { message: 'no such route' });
  }

  const fetches = () => calls.filter((c) => c.path.endsWith('/videos/fetch')).length;
  /* The storage paths PUT so far, without the zone. */
  const puts = () => calls.filter((c) => c.method === 'PUT' && c.host === FAKE_BUNNY_SETTINGS.storageHost)
    .map((c) => c.path.split('/').slice(2).map(decodeURIComponent).join('/'));
  return { fetchImpl, calls, state, fetches, puts };
}

/* Settings in the shape config.hub.bunny has: every one set, none real. */
const FAKE_BUNNY_SETTINGS = {
  libraryId: 'lib1', streamApiKey: 'fake-stream-key', streamReadKey: 'fake-read-key',
  streamCdnHost: 'vz-test.b-cdn.net', storageZone: 'zone', storagePassword: 'fake-storage-pass',
  storageHost: 'storage.example', storageCdnHost: 'cdn.example',
};

module.exports = { fakeBunny, FAKE_BUNNY_SETTINGS };
