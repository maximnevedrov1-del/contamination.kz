/**
 * SaudaPulse phone app — start-up. Order matters:
 *   1. the encrypted storage (IndexedDB + AES-GCM) is installed as `chrome.storage`,
 *   2. then the extension's own modules are loaded on top of it,
 *   3. Kaspi API calls are routed through the stateless relay,
 *   4. the service worker (app shell only) is registered.
 */
import { createIdbBackend, installChromeFacade } from '../core/shared/storage-adapter.js';
import { APP_VERSION, RELAY_URL, ANON_KEY } from './config.js';

const fail = (msg) => {
  const el = document.getElementById('app');
  if (el) el.innerHTML = `<div class="boot-error"><h1>SaudaPulse</h1><p>${msg}</p></div>`;
};

async function boot() {
  if (!globalThis.indexedDB || !globalThis.crypto?.subtle) return fail('Этот браузер не поддерживает защищённое хранение. Откройте страницу в Safari (iPhone) или Chrome (Android).');
  installChromeFacade({ backend: createIdbBackend('saudapulse-app'), version: APP_VERSION, baseUrl: new URL('./', location.href).href });
  // ask the browser not to evict our data under storage pressure (best effort)
  navigator.storage?.persist?.().catch(() => {});
  const B = await import('../core/background/billing.js');
  const { installRelayFetch } = await import('../core/shared/kaspi-relay-client.js');
  installRelayFetch({ relayUrl: RELAY_URL, anonKey: ANON_KEY, accessToken: () => B.currentToken() });
  const { start } = await import('./main.js');
  await start();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
}

boot().catch(() => fail('Не удалось запустить приложение. Обновите страницу.'));
