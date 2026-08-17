const CACHE = 'gtrz-mail-shell-v9';
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

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'GTRZ Mail', body: event.data ? event.data.text() : 'Você recebeu um novo e-mail.' };
  }

  const title = payload.title || 'GTRZ Mail';
  const body = payload.body || 'Você recebeu um novo e-mail.';
  const messageId = payload.messageId || '';
  const threadId = payload.threadId || messageId;
  const url = payload.url || (messageId ? `/?message=${encodeURIComponent(messageId)}` : '/');

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      client.postMessage({ type: 'gtrz-new-mail', messageId, threadId });
    }

    await self.registration.showNotification(title, {
      body,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      tag: threadId ? `gtrz-thread-${threadId}` : 'gtrz-mail',
      renotify: true,
      data: { url, messageId, threadId },
      actions: [
        { action: 'open', title: 'Abrir e-mail' }
      ]
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      await client.focus();
      client.postMessage({
        type: 'gtrz-open-message',
        messageId: event.notification.data?.messageId || '',
        threadId: event.notification.data?.threadId || ''
      });
      return;
    }
    await self.clients.openWindow(target);
  })());
});
