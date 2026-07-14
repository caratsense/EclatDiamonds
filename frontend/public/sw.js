/*
 * CaratSense service worker — minimal offline app shell (PWA).
 *
 * Strategy:
 *  - install : pre-cache the static app shell (best-effort; a single 404 must
 *              not fail the whole install).
 *  - activate: delete every cache that isn't the current version, then claim
 *              open clients so a new deploy's SW takes over immediately.
 *  - fetch   : GET + same-origin only.
 *      • navigations  → network-first, falling back to cache, then "/".
 *      • static assets → stale-while-revalidate.
 *      • everything else (API/auth, RSC payloads, cross-origin) is bypassed
 *        and hits the network directly — never cached.
 *
 * Bumping CACHE_VERSION invalidates all prior caches on the next activate, so
 * stale Next.js build assets can never survive across a deploy.
 */

const CACHE_VERSION = "caratsense-v1";

// The app shell to pre-cache. Content-hashed Next.js build assets are cached
// lazily on first request (stale-while-revalidate), not listed here.
const APP_SHELL = [
  "/",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-icon.png",
  "/eclat-logo.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) =>
        // allSettled: one missing asset shouldn't abort the install.
        Promise.allSettled(APP_SHELL.map((url) => cache.add(url))),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_VERSION)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** Same-origin static assets we're happy to serve stale while revalidating. */
function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname === "/manifest.webmanifest" ||
    /\.(?:js|css|png|jpe?g|svg|gif|webp|avif|ico|woff2?|ttf|otf)$/.test(
      url.pathname,
    )
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Never touch non-GET (mutations) — let them go straight to the network.
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Only our own origin. Cross-origin (e.g. the backend API host) is never cached.
  if (url.origin !== self.location.origin) return;

  // Skip anything API/auth-shaped served from the same origin.
  if (url.pathname.startsWith("/auth") || url.pathname.startsWith("/api")) return;

  // Skip React Server Component payloads — always fetch fresh to avoid staleness.
  if (url.searchParams.has("_rsc") || req.headers.get("RSC") === "1") return;

  // Navigations: network-first, fall back to any cached page, then the shell.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() =>
          caches
            .match(req)
            .then((cached) => cached || caches.match("/")),
        ),
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.open(CACHE_VERSION).then((cache) =>
        cache.match(req).then((cached) => {
          const network = fetch(req)
            .then((res) => {
              if (res && res.status === 200) cache.put(req, res.clone());
              return res;
            })
            .catch(() => cached);
          return cached || network;
        }),
      ),
    );
  }
});
