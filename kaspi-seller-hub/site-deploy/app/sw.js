self.__SHELL__ = ["./","./app.css","./core/background/billing.js","./core/background/kaspi-api.js","./core/shared/api-sync.js","./core/shared/billing-config.js","./core/shared/errorlog.js","./core/shared/kaspi-relay-client.js","./core/shared/license-signature.js","./core/shared/qr-transfer.js","./core/shared/selectors.js","./core/shared/spbackup.js","./core/shared/storage-adapter.js","./core/shared/storage.js","./core/shared/store-key.js","./core/shared/token-crypto.js","./core/shared/utils.js","./icons/apple-touch-icon.png","./icons/icon-192.png","./icons/icon-512.png","./icons/icon-maskable-512.png","./index.html","./js/boot.js","./js/config.js","./js/data.js","./js/install.js","./js/main.js","./js/scan.js","./js/turnstile.js","./manifest.webmanifest","./vendor/jsQR-LICENSE.txt","./vendor/jsQR.js"];
/**
 * SaudaPulse phone app — service worker: offline APP SHELL ONLY.
 *
 * Caches exactly the files listed in SHELL (HTML, CSS, JS, icons of /app/). It never caches,
 * stores or even looks at anything else: no Supabase answers (login, licence), no relay / Kaspi
 * answers (orders, tokens), no POST, nothing cross-origin, nothing with an Authorization header.
 * Those requests are not intercepted at all — they go straight to the network.
 * The build (tools/build-app.mjs) fills SHELL and VERSION.
 */
const VERSION = '3af327bc73e9';
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
