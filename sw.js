// Offline cache: app shell + lesson content. Bump VERSION when files change.
const VERSION = "ru-v0.1.0";
const ASSETS = [
  "./", "index.html", "manifest.webmanifest",
  "css/app.css",
  "js/app.js", "js/text.js", "js/store.js", "js/srs.js", "js/speech.js",
  "content/course.json", "content/compare.json", "content/t01.json", "content/t02.json", "content/t03.json",
  "fonts/literata-cyrillic-400-normal.woff2", "fonts/literata-cyrillic-600-normal.woff2", "fonts/literata-cyrillic-400-italic.woff2",
  "fonts/literata-latin-400-normal.woff2", "fonts/literata-latin-600-normal.woff2", "fonts/literata-latin-400-italic.woff2",
  "fonts/literata-vietnamese-400-normal.woff2", "fonts/literata-vietnamese-600-normal.woff2",
  "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network first for content (so updates arrive), cache first for everything else; same-origin only.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  const isContent = url.pathname.includes("/content/") || url.pathname.endsWith(".js") || url.pathname.endsWith(".css") || url.pathname.endsWith("/") || url.pathname.endsWith(".html");
  if (isContent) {
    e.respondWith(
      fetch(e.request).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return r; })
        .catch(() => caches.match(e.request, { ignoreSearch: true }))
    );
  } else {
    e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request)));
  }
});
