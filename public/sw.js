// Bump este número sempre que algum arquivo em SHELL mudar — é o que faz o
// navegador perceber que o sw.js tem bytes diferentes e buscar a versão nova
// no servidor (senão o worker antigo, com o cache antigo, fica valendo pra
// sempre). Ver /sw.js no firebase.json: Cache-Control no-cache garante que
// essa checagem de bytes nunca usa uma cópia de sw.js desatualizada.
const CACHE = "tasks-v2";
const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./manifest.json",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./firebase.js",
  "./firebase-config.js",
  "./auth.js",
  "./app.js",
  "./workspaces.js",
  "./projects.js",
  "./profile.js",
  "./board.js",
  "./globalview.js",
  "./tasks.js",
  "./tags.js",
  "./drag.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  // Deixa passar requisições externas (Firebase, Google Fonts, CDN)
  if (!e.request.url.startsWith(self.location.origin)) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Cache-first para assets locais
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((res) => {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
        return res;
      });
    })
  );
});
