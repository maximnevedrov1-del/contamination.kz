/**
 * Stable identity for API-connected stores.
 *
 * The old code gave every API store a random id (`api-<random>`), so the same token connected on
 * another computer (or after a reinstall) looked like a NEW store: an extra paid slot and a new
 * trial key. Now the id and the server-side store key derive from the token itself:
 *   tokenHash = SHA-256('ksh-api:' + token.trim())      (hex; the raw token is never stored here)
 *   store id  = 'api-' + first 16 hex of tokenHash
 *   server key = SHA-256('ksh:' + seed), seed = 'api:' + tokenHash for API stores, the store id otherwise.
 * The Kaspi token check returns no merchant id, so the token is the only available seed.
 *
 * One-time transition: legacy API stores (random id, no tokenHash) keep their id; the next
 * connect/reconnect records their tokenHash, after which their server key is stable too (it changes
 * once, at that moment). Tab-registered stores keep the old `ksh:<id>` key.
 */
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(text) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** Full hash of a token (whitespace around it is ignored). */
export const apiTokenHash = (token) => sha256Hex(`ksh-api:${String(token ?? '').trim()}`);

/** Deterministic store id for a token: same token → same id on any computer. */
export const apiStoreIdFromHash = (hash) => `api-${hash.slice(0, 16)}`;
export const apiStoreId = async (token) => apiStoreIdFromHash(await apiTokenHash(token));

/** Existing store that already belongs to this token hash (by saved hash or by derived id), or null. */
export function findApiStore(stores, hash) {
  const id = apiStoreIdFromHash(hash);
  return Object.values(stores || {}).find((s) => s?.api?.tokenHash === hash || s?.id === id) || null;
}

/** Seed of the server-side store key. */
export function storeKeySeed(store) {
  const h = store?.api?.tokenHash;
  if (h) return `api:${h}`;
  return String(store?.id ?? '').trim().toLowerCase();
}

/** Server-side store key: SHA-256 of `ksh:<seed>`; '' when the store has no usable seed. */
export async function storeKey(store) {
  const seed = storeKeySeed(store);
  return seed ? sha256Hex(`ksh:${seed}`) : '';
}
