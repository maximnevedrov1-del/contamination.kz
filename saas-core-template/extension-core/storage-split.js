/**
 * Generic storage split for browser extensions (derived from the extension's storage.js,
 * without any product-domain keys).
 *
 *  - createSplitCollection: a collection of records stored one key per record
 *    (`<prefix><id>`) plus an index key listing the ids. A write touches only the records that
 *    changed (fingerprint compare) and the index only when the id set changes — so a big
 *    collection never hits per-item quota or rewrites megabytes for a one-record change.
 *  - createSecretStore: { [scopeId]: secret } kept encrypted at rest (token-crypto.js, AES-GCM,
 *    scopeId bound as additional data). Plain values from older versions are read as is and
 *    re-encrypted on first read; writes and that migration are serialized.
 *  - safeSet: storage.set that never throws (quota etc.).
 *
 * `area` is a function returning a chrome.storage area, e.g. () => chrome.storage.local.
 * Use `sync` for small user settings, `local` for bulk data and secrets.
 */
import { decryptToken, encryptToken, isEncrypted } from './token-crypto.js';

let lastWriteError = null;

/** storage.set that never throws: { ok:true } or { ok:false, kind:'quota'|'error', message }. One call = all or nothing. */
export async function safeSet(area, items, label = '') {
  let err = null;
  try {
    await area().set(items);
    const le = globalThis.chrome?.runtime?.lastError;
    if (le) err = le;
  } catch (e) {
    err = e || new Error('storage write failed');
  }
  if (!err) return { ok: true };
  const message = String(err.message ?? err);
  const kind = err.name === 'QuotaExceededError' || /quota/i.test(message) ? 'quota' : 'error';
  console.warn('[storage-split] write failed', label, kind, message);
  lastWriteError = { at: Date.now(), key: label, kind, message };
  return { ok: false, kind, message };
}

/** Last failed write since start, or { ok:true }. */
export const getStorageHealth = () => (lastWriteError ? { ok: false, ...lastWriteError } : { ok: true });

/** Short fingerprint (two 32-bit hashes + length) kept instead of the whole JSON. */
export function fingerprint(value) {
  const str = JSON.stringify(value);
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) ^ (h2 >>> 15);
  }
  return `${str.length}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
}

/**
 * @param {object} opts { area: () => any, indexKey: string, prefix: string }
 */
export function createSplitCollection({ area, indexKey, prefix }) {
  const keyOf = (id) => prefix + id;
  const seen = new Map(); // id → fingerprint as last written/read by this context

  async function ids() {
    const idx = (await area().get(indexKey))[indexKey];
    return Array.isArray(idx) ? idx : [];
  }

  return {
    ids,
    /** @returns {Promise<Record<string, any>>} */
    async getAll() {
      const list = await ids();
      if (!list.length) return {};
      const per = await area().get(list.map(keyOf));
      const out = Object.fromEntries(list.filter((id) => per[keyOf(id)] !== undefined).map((id) => [id, per[keyOf(id)]]));
      for (const [id, v] of Object.entries(out)) seen.set(id, fingerprint(v));
      return out;
    },
    async get(id) {
      return (await area().get(keyOf(id)))[keyOf(id)] ?? null;
    },
    /** Replace the whole collection, writing only changed records (index and data in one write). */
    async setAll(records) {
      const before = await ids();
      const next = Object.keys(records || {}).filter((id) => records[id]);
      const patch = {};
      const fps = [];
      for (const id of next) {
        const fp = fingerprint(records[id]);
        if (seen.get(id) !== fp) patch[keyOf(id)] = records[id];
        fps.push([id, fp]);
      }
      const gone = before.filter((id) => !next.includes(id));
      if (gone.length || next.length !== before.length || next.some((id, i) => before[i] !== id)) patch[indexKey] = next;
      const res = Object.keys(patch).length ? await safeSet(area, patch, indexKey) : { ok: true };
      if (!res.ok) return res; // nothing written: keep old data, skip removals
      for (const [id, fp] of fps) seen.set(id, fp);
      if (gone.length) {
        await area().remove(gone.map(keyOf));
        gone.forEach((id) => seen.delete(id));
      }
      return res;
    },
    /** Change one record: fn(record|null) → new record, undefined (keep the mutated one) or null (remove). */
    async update(id, fn) {
      const cur = await this.get(id);
      const draft = structuredClone(cur);
      let next = fn(draft);
      if (next === undefined) next = draft;
      const list = await ids();
      if (!next) {
        if (list.includes(id)) {
          const r = await safeSet(area, { [indexKey]: list.filter((x) => x !== id) }, indexKey);
          if (!r.ok) return null;
        }
        await area().remove(keyOf(id));
        seen.delete(id);
        return null;
      }
      const fp = fingerprint(next);
      const patch = {};
      if (fp !== fingerprint(cur)) patch[keyOf(id)] = next;
      if (!list.includes(id)) patch[indexKey] = [...list, id];
      if (!Object.keys(patch).length || (await safeSet(area, patch, indexKey)).ok) seen.set(id, fp);
      return next;
    },
    async clear() {
      const list = await ids();
      await area().remove([indexKey, ...list.map(keyOf)]);
      seen.clear();
    },
  };
}

/**
 * @param {object} opts { area: () => any, key: string }; `key` holds a map scopeId → ciphertext
 */
export function createSecretStore({ area, key }) {
  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
  const raw = async () => (await area().get(key))[key] ?? {};

  async function migratePlain() {
    const stored = await raw(); // fresh: a newer write may have happened
    let changed = false;
    for (const [scopeId, v] of Object.entries(stored)) {
      if (v && !isEncrypted(v)) (stored[scopeId] = await encryptToken(scopeId, v)), (changed = true);
    }
    if (changed) await safeSet(area, { [key]: stored }, key);
  }

  return {
    /** Plain secrets by scopeId; values that cannot be decrypted (other key / store, damaged) are skipped. */
    async getAll() {
      const stored = await raw();
      const out = {};
      let plain = false;
      for (const [scopeId, v] of Object.entries(stored)) {
        if (!v) continue;
        if (!isEncrypted(v)) plain = true;
        const secret = await decryptToken(scopeId, v);
        if (secret) out[scopeId] = secret;
      }
      if (plain) await serial(migratePlain).catch((e) => console.warn('[storage-split] secret encryption failed', e));
      return out;
    },
    /** @param {Record<string, string>} secrets plain secrets by scopeId (replaces the stored set) */
    set: (secrets) =>
      serial(async () => {
        const enc = {};
        for (const [scopeId, s] of Object.entries(secrets || {})) if (s) enc[scopeId] = isEncrypted(s) ? s : await encryptToken(scopeId, s);
        return safeSet(area, { [key]: enc }, key);
      }),
  };
}
