/**
 * Secrets (API tokens, keys) at rest: AES-GCM 256, value format 'enc1:<iv b64url>:<ciphertext b64url>'.
 *
 * The key is a NON-extractable CryptoKey kept in IndexedDB (not in chrome.storage), so a dump
 * or export of chrome.storage.local, or a glance at it in DevTools, shows no usable token.
 * The scopeId (workspace / account / store id) is bound as additional data: a ciphertext moved to another store does not decrypt.
 * Limit: code running inside the extension (or someone with full access to the Chrome
 * profile) can still use the key — this protects stored data, not a compromised extension.
 */
const PREFIX = 'enc1:';
const DB = 'app-secrets';
const STORE = 'keys';
const KEY_ID = 'apiTokens';

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b + '='.repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
const req = (r) => new Promise((ok, fail) => ((r.onsuccess = () => ok(r.result)), (r.onerror = () => fail(r.error))));

const newKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

async function loadOrCreateKey() {
  if (typeof indexedDB === 'undefined') return newKey(); // plain Node (unit tests): per-process key
  const open = indexedDB.open(DB, 1);
  open.onupgradeneeded = () => open.result.createObjectStore(STORE);
  const db = await req(open);
  try {
    const found = await req(db.transaction(STORE).objectStore(STORE).get(KEY_ID));
    if (found) return found;
    const key = await newKey();
    // add() fails if another context created a key meanwhile → use the stored one
    await req(db.transaction(STORE, 'readwrite').objectStore(STORE).add(key, KEY_ID)).catch(() => null);
    return (await req(db.transaction(STORE).objectStore(STORE).get(KEY_ID))) || key;
  } finally {
    db.close();
  }
}
let keyPromise = null;
const tokenKey = () => (keyPromise ??= loadOrCreateKey().catch((e) => ((keyPromise = null), Promise.reject(e))));

export const isEncrypted = (v) => typeof v === 'string' && v.startsWith(PREFIX);

/** @param {string} scopeId bound as AES-GCM additional data @param {string} token */
export async function encryptToken(scopeId, token) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(String(scopeId)) }, await tokenKey(), new TextEncoder().encode(String(token)));
  return `${PREFIX}${b64u(iv)}:${b64u(ct)}`;
}

/** Plain token, or null when the value cannot be decrypted (other key, other store, damaged). */
export async function decryptToken(scopeId, value) {
  if (!isEncrypted(value)) return value ?? null;
  try {
    const [iv, ct] = value.slice(PREFIX.length).split(':');
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv), additionalData: new TextEncoder().encode(String(scopeId)) }, await tokenKey(), unb64u(ct));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/** Generic names for the same primitives. */
export const encryptSecret = encryptToken;
export const decryptSecret = decryptToken;
