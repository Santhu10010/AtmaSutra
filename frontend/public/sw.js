const CACHE_NAME = "atmasutra-offline-v2";
const API_CACHE = `${CACHE_NAME}-data`;
const APP_CACHE = `${CACHE_NAME}-app`;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("atmasutra-offline-") && key !== CACHE_NAME && key !== API_CACHE && key !== APP_CACHE).map((key) => caches.delete(key)));
    const appCache = await caches.open(APP_CACHE);
    try {
      const response = await fetch("/");
      if (response.ok) await appCache.put("/", response);
    } catch {
      // Offline installation can still use any shell already stored by this version.
    }
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "CACHE_APP_RESOURCES" && Array.isArray(event.data.urls)) {
    event.waitUntil((async () => {
      const cache = await caches.open(APP_CACHE);
      const urls = event.data.urls.filter((url) => typeof url === "string" && url.startsWith("/_next/static/"));
      await Promise.allSettled(urls.map((url) => cache.add(url)));
    })());
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method === "DELETE" && url.pathname === "/api/data") {
    event.respondWith((async () => {
      const response = await fetch(request);
      if (response.ok) await caches.delete(API_CACHE);
      return response;
    })());
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/")) {
    event.respondWith((async () => {
      const cache = await caches.open(API_CACHE);
      try {
        const response = await fetch(request);
        if (response.ok && response.type !== "opaque") await cache.put(request, response.clone());
        return response;
      } catch {
        const cached = await cache.match(request);
        if (cached) return cached;
        throw new Error("Offline and no saved copy is available.");
      }
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(APP_CACHE);
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put("/", response.clone());
        return response;
      } catch {
        const cached = await cache.match("/");
        if (cached) return cached;
        throw new Error("Offline and AtmaSutra has not been opened on this device yet.");
      }
    })());
    return;
  }

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith((async () => {
      const cache = await caches.open(APP_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })());
  }
});
