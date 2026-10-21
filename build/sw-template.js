/* Bounce service worker — generated at build time from build/sw-template.js. */
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const CACHE = `bounce-${VERSION}`;
const SHARE_CACHE = 'bounce-share';
const scoped = (path) => new URL(path, self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // cache: 'reload' bypasses the browser HTTP cache so a new version never precaches an old shell.
      .then((c) => c.addAll(PRECACHE.map((p) => new Request(scoped(p), { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('bounce-') && k !== CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // Network first so new versions arrive; cached shell when offline. 'no-cache' revalidates even
    // when the host sends a max-age, so a deploy is visible on the next launch.
    event.respondWith(
      // Some older engines reject a RequestInit on a navigation request; fall back to a plain fetch.
      fetch(req, { cache: 'no-cache' })
        .catch(() => fetch(req))
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(scoped('./index.html'), copy));
          }
          return res;
        })
        .catch(() => caches.match(scoped('./index.html')).then((r) => r || caches.match(scoped('./')))),
    );
    return;
  }
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          // Some hosts answer a missing file with the HTML shell; never store that under a script URL.
          const html = (res.headers.get('content-type') || '').startsWith('text/html');
          if (res.ok && res.type === 'basic' && !html) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});

async function receiveShare(req) {
  try {
    const form = await req.formData();
    const cache = await caches.open(SHARE_CACHE);
    let i = 0;
    for (const f of form.getAll('audio')) {
      if (typeof f === 'string') continue;
      const key = scoped(`./__shared/${Date.now()}-${i++}?name=${encodeURIComponent(f.name || 'shared-audio')}`);
      await cache.put(key, new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream' } }));
    }
  } catch (e) {
    // Fall through to the app; it will show an empty library.
  }
  return Response.redirect(scoped('./?shared=1'), 303);
}
