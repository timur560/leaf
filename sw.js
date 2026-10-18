const CACHE_NAME = "leaf-library-v8";
const COVER_CACHE_NAME = "leaf-library-covers-v1";
const APP_FILES = ["./", "./index.html", "./styles.css", "./app.js", "./config.js", "./manifest.webmanifest", "./icon.svg"];
const APP_SHELL_FILES = new Set(["", "index.html", "styles.css", "app.js", "config.js"]);

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key =>
      key !== CACHE_NAME && key !== COVER_CACHE_NAME
    ).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== "GET" || requestUrl.origin !== self.location.origin) return;

  const scopePath = new URL(self.registration.scope).pathname;
  const relativePath = requestUrl.pathname.slice(scopePath.length);
  if (APP_SHELL_FILES.has(relativePath)) {
    event.respondWith((async () => {
      let response;
      try {
        response = await fetch(event.request, { cache: "no-cache" });
      } catch (error) {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        throw error;
      }
      if (response.ok) {
        try {
          await caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()));
        } catch (error) {
          console.warn(`Could not update app shell cache for ${requestUrl.pathname}:`, error);
        }
      }
      return response;
    })());
    return;
  }

  event.respondWith(
    caches.match(event.request).then(async cached => {
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok) {
        try {
          await caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()));
        } catch (error) {
          console.warn(`Could not update cache for ${requestUrl.pathname}:`, error);
        }
      }
      return response;
    })
  );
});
