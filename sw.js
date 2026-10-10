/**
 * Offline app shell.
 *
 * This is what makes the "serverless" claim real in daily use: the only thing a
 * static host ever provides is the code itself, once. After the first visit the
 * app opens from cache, and pairing works with no server reachable at all.
 */

const CACHE = 'wisp-v3';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './icon.svg',
  './src/app.js',
  './src/codec.js',
  './src/crypto.js',
  './src/identity.js',
  './src/payload.js',
  './src/sdp.js',
  './src/session.js',
  './src/store.js',
  './src/config.js',
  './src/chats.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match('./index.html'));
    }),
  );
});
