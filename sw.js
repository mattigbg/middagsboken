// Gör att appen startar även utan internet.
// Öka versionen när appens filer ändras, så hämtar telefonerna den nya versionen.
const VERSION = "middagsboken-v3";
const IMAGES = "middagsboken-bilder";
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "config.js",
  "seed.js",
  "vendor/supabase.js",
  "manifest.webmanifest",
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/favicon-32.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== IMAGES).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Bilder (egna och från importerade recept): spara en kopia så de syns utan internet.
  if (req.destination === "image" && url.origin !== location.origin) {
    e.respondWith(caches.open(IMAGES).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      try { const res = await fetch(req); if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res; } catch { return Response.error(); }
    }));
    return;
  }

  // Databasen ska alltid gå direkt till nätet.
  if (url.hostname.endsWith("supabase.co") || url.hostname.endsWith("supabase.in")) return;

  // Typsnitt: spara när de väl hämtats.
  if (url.hostname.includes("fonts.googleapis.com") || url.hostname.includes("fonts.gstatic.com")) {
    e.respondWith(caches.open(VERSION).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      try { const res = await fetch(req); c.put(req, res.clone()); return res; } catch { return Response.error(); }
    }));
    return;
  }

  if (url.origin !== location.origin) return;

  // Appens egna filer: försök nätet först (så uppdateringar kommer fram), annars sparad kopia.
  e.respondWith(
    fetch(req)
      .then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match("index.html")))
  );
});
