/**
 * SaudaPulse phone app — service worker: offline APP SHELL ONLY.
 *
 * Caches exactly the files listed in SHELL (HTML, CSS, JS, icons of /app/). It never caches,
 * stores or even looks at anything else: no Supabase answers (login, licence), no relay / Kaspi
 * answers (orders, tokens), no POST, nothing cross-origin, nothing with an Authorization header.
 * Those requests are not intercepted at all — they go straight to the network.
 * The build (tools/build-app.mjs) fills SHELL and VERSION.
 */
const VERSION = '__APP_BUILD__';
const CACHE = `sp-shell-${VERSION}`;
const SHELL = self.__SHELL__ || ['./', './index.html', './app.css', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('sp-shell-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const scope = new URL(self.registration.scope);
const shellPaths = new Set(SHELL.map((p) => new URL(p, scope).pathname));

/** Only same-origin GETs of a shell file, without credentials headers. */
function isShellRequest(req) {
  if (req.method !== 'GET' || req.headers.has('Authorization')) return false;
  const u = new URL(req.url);
  if (u.origin !== scope.origin || u.search) return false;
  return shellPaths.has(u.pathname) || (req.mode === 'navigate' && u.pathname.startsWith(scope.pathname));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (!isShellRequest(req)) return; // not ours: the browser handles it, nothing is cached
  if (req.mode === 'navigate') {
    // fresh page when online, the cached shell when offline
    e.respondWith(fetch(req).catch(() => caches.match(new URL('./index.html', scope).href)));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
