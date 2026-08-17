const CACHE = 'gtrz-mail-shell-v3';
const SHELL = ['/', '/manifest.webmanifest', '/favicon.svg', '/brand/gtrz-symbol.svg', '/brand/gtrz-lockup.svg'];

function isCacheableRequest(request, url) {
  return request.method === 'GET' &&
    url.origin === self.location.origin &&
    !url.pathname.startsWith('/api/') &&
    url.pathname !== '/sw.js';
}

function isImmutableAsset(url) {
  return url.pathname.startsWith('/assets/');
}

async function cacheResponse(request, response) {
  if (!response || !response.ok || response.type === 'opaque') return response;
  const cache = await caches.open(CACHE);
  await cache.put(request, response.clone());
  return response;
}

async function revalidate(request) {
  try {
    const response = await fetch(request);
    await cacheResponse(request, response);
    return response;
  } catch {
    return null;
  }
}

async function cachedFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  return cacheResponse(request, response);
}

async function staleWhileRevalidate(request, event) {
  const cached = await caches.match(request);
  if (cached) {
    event.waitUntil(revalidate(request));
    return cached;
  }

  const response = await fetch(request);
  return cacheResponse(request, response);
}

async function navigationResponse(request, event) {
  const cached = await caches.match(request) || await caches.match('/');

  if (cached) {
    event.waitUntil(revalidate(request));
    return cached;
  }

  try {
    const response = await fetch(request);
    return cacheResponse(request, response);
  } catch {
    return caches.match('/');
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (!isCacheableRequest(request, url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request, event));
    return;
  }

  if (isImmutableAsset(url)) {
    event.respondWith(cachedFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request, event));
});
