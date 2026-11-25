/**
 * SaudaPulse — storage adapter shared by the Chrome extension and the phone app (PWA).
 *
 * The business logic (shared/storage.js, background/billing.js, background/packing.js, the
 * licence check, the store keys) talks to ONE interface: the `chrome.storage.StorageArea` shape
 *   area.get(keys) · area.set(items) · area.remove(keys) · area.clear()  + storage.onChanged
 * Two implementations:
 *   - Chrome extension: the browser's own chrome.storage.local / .session (unchanged).
 *   - Phone app:        createSecureArea() — IndexedDB on the phone, EVERY value encrypted with
 *                       AES-GCM 256 (Web Crypto). The key is a NON-extractable CryptoKey kept in
 *                       IndexedDB: it can be used by this site on this phone, but never read out,
 *                       exported or sent anywhere. Each record is bound to its key name
 *                       (additional data), so a ciphertext copied to another key does not decrypt.
 * installChromeFacade() publishes a minimal `globalThis.chrome` built from the two areas, so the
 * very same modules run in the PWA without a line changed.
 *
 * Nothing in this file talks to the network.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
const RECORD_VERSION = 1;
const aad = (key) => enc.encode(`sp-kv:v${RECORD_VERSION}:${key}`);
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

/* ---------------- backends: where the (already encrypted) records live ---------------- */

/** In-memory backend (unit tests, and the session area). */
export function createMemoryBackend() {
  const kv = new Map();
  const keys = new Map();
  return {
    kind: 'memory',
    async get(k) { return clone(kv.get(k)); },
    async getAll() { return new Map([...kv].map(([k, v]) => [k, clone(v)])); },
    async put(entries) { for (const [k, v] of entries) kv.set(k, clone(v)); },
    async delete(list) { for (const k of list) kv.delete(k); },
    async clear() { kv.clear(); },
    async getKey(id) { return keys.get(id); },
    /** add semantics: never overwrites a key created meanwhile; returns the stored one */
    async addKey(id, key) { if (!keys.has(id)) keys.set(id, key); return keys.get(id); },
    async deleteKey(id) { keys.delete(id); },
    _raw: kv, // tests read what is really stored
  };
}

const req = (r) => new Promise((ok, fail) => ((r.onsuccess = () => ok(r.result)), (r.onerror = () => fail(r.error))));
const done = (tx) => new Promise((ok, fail) => ((tx.oncomplete = () => ok()), (tx.onerror = () => fail(tx.error)), (tx.onabort = () => fail(tx.error))));

/** IndexedDB backend: object store `kv` (encrypted records) + `keys` (non-extractable CryptoKeys). */
export function createIdbBackend(dbName = 'saudapulse-app', idb = globalThis.indexedDB) {
  let dbp = null;
  const db = () =>
    (dbp ??= new Promise((ok, fail) => {
      const open = idb.open(dbName, 1);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains('kv')) open.result.createObjectStore('kv');
        if (!open.result.objectStoreNames.contains('keys')) open.result.createObjectStore('keys');
      };
      open.onsuccess = () => ok(open.result);
      open.onerror = () => fail(open.error);
    }).catch((e) => ((dbp = null), Promise.reject(e))));
  const run = async (store, mode, fn) => {
    const tx = (await db()).transaction(store, mode);
    const out = fn(tx.objectStore(store));
    await done(tx);
    return typeof IDBRequest !== 'undefined' && out instanceof IDBRequest ? out.result : out;
  };
  return {
    kind: 'indexeddb',
    async get(k) { return run('kv', 'readonly', (s) => s.get(k)); },
    async getAll() {
      const tx = (await db()).transaction('kv', 'readonly');
      const s = tx.objectStore('kv');
      const [ks, vs] = await Promise.all([req(s.getAllKeys()), req(s.getAll())]);
      return new Map(ks.map((k, i) => [k, vs[i]]));
    },
    async put(entries) { await run('kv', 'readwrite', (s) => { for (const [k, v] of entries) s.put(v, k); }); },
    async delete(list) { await run('kv', 'readwrite', (s) => { for (const k of list) s.delete(k); }); },
    async clear() { await run('kv', 'readwrite', (s) => s.clear()); },
    async getKey(id) { return run('keys', 'readonly', (s) => s.get(id)); },
    async addKey(id, key) {
      await run('keys', 'readwrite', (s) => s.add(key, id)).catch(() => null); // another tab created one meanwhile
      return run('keys', 'readonly', (s) => s.get(id));
    },
    async deleteKey(id) { await run('keys', 'readwrite', (s) => s.delete(id)); },
  };
}

/* ---------------- areas: the chrome.storage.StorageArea shape ---------------- */

function normalizeKeys(keys) {
  if (keys == null) return { all: true, list: [], defaults: {} };
  if (typeof keys === 'string') return { all: false, list: [keys], defaults: {} };
  if (Array.isArray(keys)) return { all: false, list: keys.map(String), defaults: {} };
  if (typeof keys === 'object') return { all: false, list: Object.keys(keys), defaults: keys };
  return { all: false, list: [], defaults: {} };
}

function createEvents() {
  const listeners = new Set();
  return {
    onChanged: {
      addListener: (fn) => listeners.add(fn),
      removeListener: (fn) => listeners.delete(fn),
      hasListener: (fn) => listeners.has(fn),
    },
    emit(changes, areaName) {
      if (!Object.keys(changes).length) return;
      for (const fn of [...listeners]) {
        try { fn(structuredClone(changes), areaName); } catch { /* a listener never breaks a write */ }
      }
    },
  };
}

/**
 * Encrypted StorageArea.
 * @param {{ backend: ReturnType<typeof createMemoryBackend>, name?: string, keyId?: string,
 *           onChange?: (changes:object)=>void, onUndecryptable?: (key:string)=>void }} opts
 */
export function createSecureArea({ backend, name = 'local', keyId = 'kv-v1', onChange = null, onUndecryptable = null } = {}) {
  if (!backend) throw new Error('backend required');
  let keyP = null;
  const cryptoKey = () =>
    (keyP ??= (async () => {
      const found = await backend.getKey(keyId);
      if (found) return found;
      const fresh = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      return (await backend.addKey(keyId, fresh)) || fresh;
    })().catch((e) => ((keyP = null), Promise.reject(e))));

  async function seal(key, value) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(key) }, await cryptoKey(), enc.encode(JSON.stringify(value)));
    return { v: RECORD_VERSION, iv, ct: new Uint8Array(ct) };
  }
  async function open(key, rec) {
    if (!rec || rec.v !== RECORD_VERSION || !rec.iv || !rec.ct) return undefined;
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv, additionalData: aad(key) }, await cryptoKey(), rec.ct);
      return JSON.parse(dec.decode(plain));
    } catch {
      try { onUndecryptable?.(key); } catch { /* ignore */ }
      return undefined; // other key, moved record, damaged: treated as absent
    }
  }

  // one write at a time: read-modify-write callers see writes in the order they were made
  let chain = Promise.resolve();
  const serial = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  const area = {
    async get(keys) {
      const { all, list, defaults } = normalizeKeys(keys);
      const out = {};
      if (all) {
        for (const [k, rec] of await backend.getAll()) {
          const v = await open(k, rec);
          if (v !== undefined) out[k] = v;
        }
        return out;
      }
      for (const k of list) {
        const v = await open(k, await backend.get(k));
        if (v !== undefined) out[k] = v;
        else if (defaults[k] !== undefined) out[k] = clone(defaults[k]);
      }
      return out;
    },
    set(items) {
      return serial(async () => {
        const entries = Object.entries(items || {}).filter(([, v]) => v !== undefined);
        const changes = {};
        const sealed = [];
        for (const [k, v] of entries) {
          const json = JSON.parse(JSON.stringify(v)); // same rules as chrome.storage: JSON values only
          const old = await open(k, await backend.get(k));
          sealed.push([k, await seal(k, json)]);
          changes[k] = { oldValue: old, newValue: json };
        }
        await backend.put(sealed); // one transaction: all or nothing
        onChange?.(changes, name);
      });
    },
    remove(keys) {
      return serial(async () => {
        const list = (Array.isArray(keys) ? keys : [keys]).map(String);
        const changes = {};
        for (const k of list) {
          const old = await open(k, await backend.get(k));
          if (old !== undefined) changes[k] = { oldValue: old };
        }
        await backend.delete(list);
        onChange?.(changes, name);
      });
    },
    clear() {
      return serial(async () => {
        const changes = {};
        for (const [k, rec] of await backend.getAll()) {
          const old = await open(k, rec);
          if (old !== undefined) changes[k] = { oldValue: old };
        }
        await backend.clear();
        onChange?.(changes, name);
      });
    },
    /** Forget the key itself: every stored record becomes unreadable at once («стереть всё»). */
    async destroy() {
      await serial(async () => {
        await backend.clear();
        await backend.deleteKey(keyId);
        keyP = null;
      });
    },
  };
  return area;
}

/** Plain in-memory StorageArea (chrome.storage.session equivalent: gone when the tab closes). */
export function createMemoryArea({ name = 'session', onChange = null } = {}) {
  const kv = new Map();
  return {
    async get(keys) {
      const { all, list, defaults } = normalizeKeys(keys);
      if (all) return Object.fromEntries([...kv].map(([k, v]) => [k, clone(v)]));
      const out = {};
      for (const k of list) {
        if (kv.has(k)) out[k] = clone(kv.get(k));
        else if (defaults[k] !== undefined) out[k] = clone(defaults[k]);
      }
      return out;
    },
    async set(items) {
      const changes = {};
      for (const [k, v] of Object.entries(items || {})) {
        if (v === undefined) continue;
        const json = JSON.parse(JSON.stringify(v));
        changes[k] = { oldValue: clone(kv.get(k)), newValue: json };
        kv.set(k, json);
      }
      onChange?.(changes, name);
    },
    async remove(keys) {
      const changes = {};
      for (const k of (Array.isArray(keys) ? keys : [keys]).map(String)) {
        if (kv.has(k)) changes[k] = { oldValue: clone(kv.get(k)) };
        kv.delete(k);
      }
      onChange?.(changes, name);
    },
    async clear() {
      const changes = Object.fromEntries([...kv].map(([k, v]) => [k, { oldValue: v }]));
      kv.clear();
      onChange?.(changes, name);
    },
  };
}

/**
 * PWA: build `chrome.storage` (+ the few chrome.runtime bits the shared modules read) from an
 * encrypted local area and a memory session area, and publish it as globalThis.chrome.
 * Refuses to run inside the extension (where the real chrome.storage exists).
 */
export function installChromeFacade({ backend, version = '0.0.0', baseUrl = globalThis.location?.href || 'https://saudapulse.kz/app/', onUndecryptable } = {}) {
  if (globalThis.chrome?.storage?.local && !globalThis.chrome.__saudapulseFacade) throw new Error('real chrome.storage present: the facade is for the web app only');
  const events = createEvents();
  const local = createSecureArea({ backend, name: 'local', onChange: (c, n) => events.emit(c, n), onUndecryptable });
  const session = createMemoryArea({ name: 'session', onChange: (c, n) => events.emit(c, n) });
  const facade = {
    __saudapulseFacade: true,
    storage: { local, session, onChanged: events.onChanged },
    runtime: {
      id: 'saudapulse-web',
      lastError: undefined,
      getManifest: () => ({ version }),
      getURL: (p = '') => new URL(String(p).replace(/^\//, ''), baseUrl).href,
      sendMessage: () => Promise.resolve(), // no worker in the web app: broadcasts go nowhere
      onMessage: { addListener() {}, removeListener() {} },
    },
  };
  globalThis.chrome = facade;
  return facade;
}
