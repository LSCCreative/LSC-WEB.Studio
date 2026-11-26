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
     statusOnFetch         a fetched video's REST status (4 finished, 3 transcoding)
   calls: every request, with the AccessKey it carried. */

function fakeBunny() {
  const calls = [];
  const state = { collections: [], videos: [], failFetch: false, listAfter: 0, neverList: false, statusOnFetch: 4 };
  const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });
  const listed = (v) => !state.neverList && v.searchesSeen >= v.listAfter;

  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const method = init.method || 'GET';
    calls.push({ method, path: u.pathname, search: u.search, key: init.headers && init.headers.AccessKey, body: init.body });
    const route = u.pathname.replace('/library/lib1', '');
    if (!u.pathname.startsWith('/library/lib1')) return reply(404, { message: 'no such library' });
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
  return { fetchImpl, calls, state, fetches };
}

/* Settings in the shape config.hub.bunny has: every one set, none real. */
const FAKE_BUNNY_SETTINGS = {
  libraryId: 'lib1', streamApiKey: 'fake-stream-key', streamReadKey: 'fake-read-key',
  streamCdnHost: 'vz-test.b-cdn.net', storageZone: 'zone', storagePassword: 'fake-storage-pass',
  storageHost: 'storage.example', storageCdnHost: 'cdn.example',
};

module.exports = { fakeBunny, FAKE_BUNNY_SETTINGS };
