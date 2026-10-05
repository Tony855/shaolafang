/* FoodFlow Service Worker — v1 · 2026-10-05
   策略：HTML=Network First / assets+pages+uploads=Cache First / api+socket=bypass */
const SW_VERSION    = 'foodflow-v1-2026-10-05';
const STATIC_CACHE  = 'foodflow-static-'  + SW_VERSION;
const RUNTIME_CACHE = 'foodflow-runtime-' + SW_VERSION;

const PRECACHE_URLS = [
  '/manifest.json',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => Promise.all(
        PRECACHE_URLS.map((url) => cache.add(url).catch(() => {}))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== STATIC_CACHE && k !== RUNTIME_CACHE)
            .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

function isBypassed(url) {
  return url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io');
}
function isStaticAsset(url) {
  return url.pathname.startsWith('/assets/')
      || url.pathname.startsWith('/pages/')
      || url.pathname.startsWith('/uploads/')
      || url.pathname === '/languages.min.js'
      || url.pathname === '/languages.js';
}
function isHTMLNavigation(request) {
  return request.mode === 'navigate'
      || (request.headers.get('accept') || '').includes('text/html');
}

async function networkFirst(request) {
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
      '<div style="font-family:sans-serif;text-align:center;padding:60px 20px;">' +
      '<h2>📡 网络未连接</h2><p>请检查网络后重试</p></div>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh && fresh.ok && request.method === 'GET') {
    const cache = await caches.open(RUNTIME_CACHE);
    cache.put(request, fresh.clone());
  }
  return fresh;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  if (isBypassed(url)) return;
  if (isHTMLNavigation(request)) { event.respondWith(networkFirst(request)); return; }
  if (isStaticAsset(url))        { event.respondWith(cacheFirst(request));   return; }
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
