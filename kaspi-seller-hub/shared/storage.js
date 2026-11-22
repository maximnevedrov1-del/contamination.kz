/**
 * SaudaPulse — typed wrapper around chrome.storage.
 *
 * local   : settings, per-store snapshots, chat cache, invoices (persistent)
 * session : tab registry, print queue (cleared when the browser closes)
 */

/** Storage keys — never use raw strings elsewhere. */
export const KEYS = Object.freeze({
  settings: 'ksh.settings',
  snapshots: 'ksh.snapshots',
  chat: 'ksh.chat',
  invoices: 'ksh.invoices',
  lastSync: 'ksh.lastSync',
  registry: 'ksh.registry', // session
  printQueue: 'ksh.printQueue', // session
  apiTokens: 'ksh.apiTokens', // { [shopId]: token } — never sent to extension pages
  apiEntries: 'ksh.apiEntries', // legacy: order contents now live in the snapshots; removed on update
  costs: 'ksh.costs', // { [sku]: cost price in ₸ } — written by the worker only
  deadlineNotified: 'ksh.deadlineNotified', // session: order keys already warned about
  pickList: 'ksh.pickList', // session: pick list handed to print.html
  catalog: 'ksh.catalog', // { [sku]: Product } — the seller's assortment (shared/catalog.js)
  feeds: 'ksh.feeds', // { [shopId]: price-list settings + upload status }
  imports: 'ksh.imports', // card uploads to Kaspi: [{ shopId, code, skus, status, result, at }]
  contentCache: 'ksh.contentCache', // Kaspi categories/attributes (24 h)
  photos: 'ksh.photos', // { [sku]: photo } — the seller's own product photos (shared/photos.js)
});

/**
 * @typedef {'ru'|'kk'} Lang
 * @typedef {{ id:string, name:string, alias?:string, color:string, enabled:boolean, origin?:string, lastSeen?:number }} StoreConfig
 * @typedef {{
 *   lang: Lang,
 *   theme: 'system'|'light'|'dark',
 *   chatPollSec: number,
 *   notifications: { newOrders:boolean, newMessages:boolean, returns:boolean },
 *   stores: Record<string, StoreConfig>
 * }} Settings
 *
 * @typedef {{
 *   id:string, shopId:string, kind:'order'|'return'|'refusal',
 *   date:string|null, status:string, statusRaw:string,
 *   amount:number|null, paymentStatus:'paid'|'pending'|'failed'|'refunded'|'unknown', paymentRaw:string,
 *   customer?:string, reason?:string, url?:string
 * }} OrderItem
 *
 * @typedef {{ status:'ok'|'notVisible'|'error', items?:any[], data?:any, error?:string, source?:'dom'|'network'|'cache' }} Section
 *
 * @typedef {{
 *   shopId:string, shopName:string, ts:number,
 *   status:'ok'|'noTab'|'notAuth'|'error', error?:string,
 *   sections: Record<string, Section>,
 *   missingSelectors: string[]
 * }} Snapshot
 *
 * @typedef {{ orderId:string, shopId:string, kind:'pdf'|'html', data:string, ts:number }} Invoice
 */

/** @type {Settings} */
export const DEFAULT_SETTINGS = Object.freeze({
  lang: 'ru',
  theme: 'system',
  chatPollSec: 30,
  notifications: { newOrders: true, newMessages: true, returns: false, deadlines: true },
  // acceptHours is the seller's own target: Kaspi publishes no fixed acceptance limit.
  deadlines: { acceptHours: 2, warnHours: 2 },
  // Kaspi commission in % — by product category, else the default. null = not set.
  profit: { defaultCommission: null, byCategory: {} },
  // waybills: original | label (thermal printer, labelW×labelH mm) | a4 | a4x4 — dashboard/print-layout.js
  print: { paper: 'original', labelW: 100, labelH: 150 },
  // «Только чтение»: nothing is changed in Kaspi (no accept / pack / card upload / price list)
  readOnly: false,
  // «Компьютер склада»: the owner's view is locked with a PIN, packers sign in (background/staff.js)
  warehouse: { enabled: false },
  stores: {},
});

import { decryptToken, encryptToken, isEncrypted } from './token-crypto.js';

const local = () => chrome.storage.local;
const session = () => chrome.storage.session;

async function read(area, key, fallback) {
  const res = await area().get(key);
  return res[key] ?? structuredClone(fallback);
}
let lastWriteError = null;
/** storage.set that never throws (quota etc.): returns { ok: true } or { ok: false, kind, message }. One call = all or nothing. */
async function safeSet(area, items, label) {
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
  console.warn('[ksh.storage] write failed', label, kind, message);
  lastWriteError = { at: Date.now(), key: label, kind, message };
  return { ok: false, kind, message };
}
/** Last failed write since this worker started, or { ok: true }. */
export function getStorageHealth() {
  return lastWriteError ? { ok: false, ...lastWriteError } : { ok: true };
}
const write = (area, key, value) => safeSet(area, { [key]: value }, key);

/** @returns {Promise<Settings>} */
export async function getSettings() {
  const s = await read(local, KEYS.settings, DEFAULT_SETTINGS);
  const d = structuredClone(DEFAULT_SETTINGS);
  return {
    ...d,
    ...s,
    notifications: { ...d.notifications, ...s.notifications },
    deadlines: { ...d.deadlines, ...s.deadlines },
    profit: { ...d.profit, ...s.profit, byCategory: { ...(s.profit?.byCategory || {}) } },
    print: { ...d.print, ...s.print },
  };
}

/**
 * Shallow-merge a patch into settings.
 * @param {Partial<Settings>} patch
 * @returns {Promise<Settings>}
 */
export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await write(local, KEYS.settings, next);
  return next;
}

/* ---------- snapshots: one storage key per store ----------
 * ksh.snapIndex = [shopId…] and ksh.snap.<shopId> = Snapshot. A change to one store
 * rewrites only that store's key. The old single key ksh.snapshots ({ [shopId]: Snapshot })
 * is still read while no index exists and is removed by the first write.
 * Writers are the service worker only, always under its mutex.
 */
export const SNAP_INDEX = 'ksh.snapIndex';
export const SNAP_PREFIX = 'ksh.snap.';
const snapKey = (shopId) => SNAP_PREFIX + shopId;
const IS_WORKER = typeof window === 'undefined';

/*
 * Returns and refusals are a subset of the store's orders (API sync): stored as order ids
 * ({ itemsFrom:'orders', ids }) instead of a second full copy, and rebuilt on read.
 * A list with any item that is not identical to the order (cabinet pages) is stored as is.
 */
const DERIVED = ['returns', 'refusals'];
export function packSnapshot(sn) {
  const orders = sn?.sections?.orders?.items;
  if (!Array.isArray(orders)) return sn;
  let byId = null;
  let out = sn;
  for (const name of DERIVED) {
    const sec = sn.sections[name];
    if (!Array.isArray(sec?.items) || !sec.items.length) continue;
    byId ??= new Map(orders.map((i) => [String(i.id), i]));
    const same = sec.items.every((i) => {
      const o = byId.get(String(i?.id));
      return o && (o === i || JSON.stringify(o) === JSON.stringify(i));
    });
    if (!same) continue;
    if (out === sn) out = { ...sn, sections: { ...sn.sections } };
    const { items, ...rest } = sec;
    out.sections[name] = { ...rest, itemsFrom: 'orders', ids: items.map((i) => String(i.id)) };
  }
  return out;
}
export function unpackSnapshot(sn) {
  const secs = sn?.sections;
  if (!secs || !DERIVED.some((n) => secs[n]?.itemsFrom === 'orders')) return sn;
  const byId = new Map((secs.orders?.items || []).map((i) => [String(i.id), i]));
  for (const name of DERIVED) {
    const sec = secs[name];
    if (sec?.itemsFrom !== 'orders') continue;
    const { itemsFrom, ids, ...rest } = sec;
    secs[name] = { ...rest, items: (ids || []).map((id) => byId.get(id)).filter(Boolean) };
  }
  return sn;
}

/** Short fingerprint of a stored snapshot (two 32-bit hashes + length), kept instead of its whole JSON. */
function digest(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) ^ (h2 >>> 15);
  }
  return `${str.length}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
}
const fingerprint = (stored) => digest(JSON.stringify(stored));

/** Fingerprint of each store as last written/seen in this context → unchanged stores are skipped. */
let snapSeen = null;
function watchSnapshots() {
  if (snapSeen) return;
  snapSeen = new Map();
  // Keeps the cache equal to storage when another context changes or clears a store.
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [k, c] of Object.entries(changes)) {
      if (!k.startsWith(SNAP_PREFIX)) continue;
      if (c.newValue === undefined) snapSeen.delete(k.slice(SNAP_PREFIX.length));
      else snapSeen.set(k.slice(SNAP_PREFIX.length), fingerprint(c.newValue));
    }
    if (SNAP_INDEX in changes && !changes[SNAP_INDEX].newValue) snapSeen.clear();
  });
}

/** @returns {Promise<Record<string, Snapshot>>} */
export async function getSnapshots() {
  const got = await local().get([SNAP_INDEX, KEYS.snapshots]);
  const ids = got[SNAP_INDEX];
  if (!Array.isArray(ids)) return got[KEYS.snapshots] ?? {}; // not migrated yet
  if (!ids.length) return {};
  const per = await local().get(ids.map(snapKey));
  const out = Object.fromEntries(ids.filter((id) => per[snapKey(id)]).map((id) => [id, per[snapKey(id)]]));
  // In the worker (the only writer) remember what is stored, so a write after a wake-up
  // rewrites only the stores the caller actually changed.
  if (IS_WORKER) {
    watchSnapshots();
    for (const [id, sn] of Object.entries(out)) snapSeen.set(id, fingerprint(sn));
  }
  for (const sn of Object.values(out)) unpackSnapshot(sn);
  return out;
}
/** One store's snapshot (null when absent). */
export async function getSnapshot(shopId) {
  const got = await local().get([SNAP_INDEX, snapKey(shopId), KEYS.snapshots]);
  if (!Array.isArray(got[SNAP_INDEX])) return got[KEYS.snapshots]?.[shopId] ?? null;
  return unpackSnapshot(got[snapKey(shopId)] ?? null);
}
/** Pages get the worker's state without the (large) snapshots and read them here. */
export async function withSnapshots(st) {
  if (st && st.settings && !st.snapshots) st.snapshots = await getSnapshots();
  return st;
}
/**
 * Replace all snapshots, writing only the stores that changed.
 * @param {Record<string, Snapshot>} v
 */
export async function setSnapshots(v) {
  watchSnapshots();
  const got = await local().get([SNAP_INDEX, KEYS.snapshots]);
  const legacy = !Array.isArray(got[SNAP_INDEX]);
  const before = legacy ? Object.keys(got[KEYS.snapshots] || {}) : got[SNAP_INDEX];
  const ids = Object.keys(v || {}).filter((id) => v[id]);
  const patch = {};
  const seen = [];
  for (const id of ids) {
    const stored = packSnapshot(v[id]);
    const fp = fingerprint(stored);
    if (legacy || snapSeen.get(id) !== fp) patch[snapKey(id)] = stored;
    seen.push([id, fp]);
  }
  const gone = before.filter((id) => !ids.includes(id));
  if (legacy || gone.length || ids.length !== before.length || ids.some((id, i) => before[i] !== id)) patch[SNAP_INDEX] = ids;
  const res = Object.keys(patch).length ? await safeSet(local, patch, 'snapshots') : { ok: true }; // index and data in one write
  if (!res.ok) return res; // nothing was written: keep old data, skip removals and fingerprints
  for (const [id, fp] of seen) snapSeen.set(id, fp);
  gone.forEach((id) => snapSeen.delete(id));
  const drop = [...gone.map(snapKey), ...(legacy && KEYS.snapshots in got ? [KEYS.snapshots] : [])];
  if (drop.length) await local().remove(drop);
  return res;
}
/**
 * Change one store: fn(snapshot|null) → new snapshot, or undefined to keep the (mutated) one,
 * or null to remove it. Only that store's key (and the index for a new store) is written.
 */
export async function updateSnapshot(shopId, fn) {
  watchSnapshots();
  const got = await local().get([SNAP_INDEX, snapKey(shopId)]);
  if (!Array.isArray(got[SNAP_INDEX])) {
    // not migrated yet: migrate everything once
    const all = await getSnapshots();
    const res = fn(all[shopId] ?? null);
    if (res === null) delete all[shopId];
    else if (res !== undefined) all[shopId] = res;
    await setSnapshots(all);
    return all[shopId] ?? null;
  }
  const raw = got[snapKey(shopId)] ?? null;
  const curFp = raw && fingerprint(raw); // before fn may mutate it
  const cur = unpackSnapshot(raw);
  let next = fn(cur);
  if (next === undefined) next = cur;
  const ids = got[SNAP_INDEX];
  if (!next) {
    if (ids.includes(shopId)) {
      const r = await safeSet(local, { [SNAP_INDEX]: ids.filter((id) => id !== shopId) }, 'snapshot');
      if (!r.ok) return null; // index unchanged: keep the data it points to
    }
    await local().remove(snapKey(shopId));
    snapSeen.delete(shopId);
    return null;
  }
  const stored = packSnapshot(next);
  const fp = fingerprint(stored);
  const patch = {};
  if (fp !== curFp) patch[snapKey(shopId)] = stored;
  if (!ids.includes(shopId)) patch[SNAP_INDEX] = [...ids, shopId];
  if (!Object.keys(patch).length || (await safeSet(local, patch, 'snapshot')).ok) snapSeen.set(shopId, fp);
  return next;
}

/** Chat cache: { [shopId]: { conversations: [...], threads: { [conversationId]: messages[] } } } */
export const getChat = () => read(local, KEYS.chat, {});
/** Opened conversations kept per store (each holds its messages); the oldest opened go first. */
export const CHAT_THREADS_MAX = 50;
export function pruneChat(v, max = CHAT_THREADS_MAX) {
  for (const store of Object.values(v || {})) {
    const ids = Object.keys(store?.threads || {});
    if (ids.length <= max) continue;
    ids.sort((a, b) => (store.threads[b]?.ts || 0) - (store.threads[a]?.ts || 0));
    for (const id of ids.slice(max)) delete store.threads[id];
  }
  return v;
}
export const setChat = (v) => write(local, KEYS.chat, pruneChat(v));

/* ---------- invoices: one storage key per waybill ----------
 * ksh.invIndex = [{ k, shopId, orderId, ts, size }] and ksh.inv.<shopId::orderId> = Invoice.
 * Adding a waybill writes only that file and the small index (the old single array
 * ksh.invoices, up to 50 MB, was read and rewritten whole for every waybill).
 * The old key is still read and is moved into the split keys by the next write.
 */
export const INV_INDEX = 'ksh.invIndex';
export const INV_PREFIX = 'ksh.inv.';
const invKey = (i) => `${i.shopId}::${i.orderId}`;
const invEntry = (i) => ({ k: invKey(i), shopId: i.shopId, orderId: i.orderId, ts: i.ts, size: i.data?.length || 0 });
async function invState() {
  const got = await local().get([INV_INDEX, KEYS.invoices]);
  return { index: Array.isArray(got[INV_INDEX]) ? got[INV_INDEX] : [], legacy: Array.isArray(got[KEYS.invoices]) ? got[KEYS.invoices] : null };
}

/** @returns {Promise<Invoice[]>} */
export async function getInvoices() {
  const { index, legacy } = await invState();
  const per = index.length ? await local().get(index.map((e) => INV_PREFIX + e.k)) : {};
  const map = new Map((legacy || []).map((i) => [invKey(i), i]));
  for (const e of index) if (per[INV_PREFIX + e.k]) map.set(e.k, per[INV_PREFIX + e.k]);
  return [...map.values()];
}
/** Number of stored waybills without loading the files. */
export async function countInvoices() {
  const { index, legacy } = await invState();
  return new Set([...index.map((e) => e.k), ...(legacy || []).map(invKey)]).size;
}

/** Apply the limits to the index; write the new files that stay, remove the ones that go. */
async function commitInvoices(byK, added, legacy, now) {
  const all = [...byK.values()];
  const kept = pruneInvoiceList(all, now);
  const keep = new Set(kept.map((e) => e.k));
  const patch = { [INV_INDEX]: kept };
  for (const [k, v] of added) if (keep.has(k)) patch[INV_PREFIX + k] = v;
  const res = await safeSet(local, patch, 'invoices'); // index and new files in one write
  if (!res.ok) return { ...res, pruned: 0 }; // nothing written: skip removals so the index never points at missing data
  const drop = all.filter((e) => !keep.has(e.k)).map((e) => INV_PREFIX + e.k);
  if (legacy) drop.push(KEYS.invoices);
  if (drop.length) await local().remove(drop);
  return { ...res, pruned: all.length - kept.length };
}
/** Index + files to write, with the old single-array invoices moved in (split keys win). */
function invMerge(index, legacy) {
  const byK = new Map(index.map((e) => [e.k, e]));
  const added = new Map();
  for (const i of legacy || []) {
    if (!i || byK.has(invKey(i))) continue;
    added.set(invKey(i), i);
    byK.set(invKey(i), invEntry(i));
  }
  return { byK, added };
}

/**
 * Add/replace invoices (deduplicated by shopId + orderId).
 * @param {Invoice[]} list
 */
export async function addInvoices(list) {
  const now = Date.now();
  const { index, legacy } = await invState();
  const { byK, added } = invMerge(index, legacy);
  for (const i of list) {
    const v = { ...i, ts: i.ts || now };
    added.set(invKey(v), v);
    byK.set(invKey(v), invEntry(v));
  }
  const { pruned, ...res } = await commitInvoices(byK, added, legacy, now);
  return res;
}

/**
 * Waybills are base64 files (often 50–300 KB each), so the list is bounded:
 * older than maxAgeDays, beyond maxCount or beyond maxBytes → the oldest go first.
 * Entries without ts (older versions) are kept by age but go first by count/size.
 * The newest invoice is always kept. Works on invoices and on index entries ({ size }).
 */
export const INVOICE_LIMITS = Object.freeze({ maxAgeDays: 30, maxCount: 500, maxBytes: 50 * 1024 * 1024 });
export function pruneInvoiceList(list, now = Date.now(), limits = INVOICE_LIMITS) {
  const minTs = now - limits.maxAgeDays * 86400000;
  const sorted = (list || []).filter((i) => i && (!i.ts || i.ts >= minTs)).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const out = [];
  let bytes = 0;
  for (const i of sorted) {
    const size = (i.size ?? i.data?.length ?? 0) + 200;
    if (out.length && (out.length >= limits.maxCount || bytes + size > limits.maxBytes)) break;
    out.push(i);
    bytes += size;
  }
  return out;
}
/** Remove invoices of the given stores (store removed) and apply the limits. */
export async function pruneInvoices({ dropShops = [] } = {}) {
  const { index, legacy } = await invState();
  const { byK, added } = invMerge(index, legacy);
  const drop = new Set(dropShops);
  const gone = [...byK.values()].filter((e) => drop.has(e.shopId));
  gone.forEach((e) => (byK.delete(e.k), added.delete(e.k)));
  const { ok, pruned } = await commitInvoices(byK, added, legacy, Date.now());
  if (!ok) return 0;
  if (gone.length) await local().remove(gone.map((e) => INV_PREFIX + e.k));
  return gone.length + pruned;
}
export async function clearInvoices() {
  const { index } = await invState();
  await local().remove([INV_INDEX, KEYS.invoices, ...index.map((e) => INV_PREFIX + e.k)]);
}

export const getLastSync = () => read(local, KEYS.lastSync, 0);
export const setLastSync = (ts) => write(local, KEYS.lastSync, ts);

/** Tab registry: { [tabId]: { tabId, shopId, shopName, pageType, authenticated, url, origin, lastSeen } } */
export const getRegistry = () => read(session, KEYS.registry, {});
export const setRegistry = (v) => write(session, KEYS.registry, v);

/** Print queue: array of { shopId, orderId } chosen in the dashboard. */
export const getPrintQueue = () => read(session, KEYS.printQueue, []);
export const setPrintQueue = (v) => write(session, KEYS.printQueue, v);

/** API tokens. Read only by the service worker. */
// Stored encrypted ({ [shopId]: 'enc1:…' }, shared/token-crypto.js); callers see plain tokens.
// Older versions stored plain strings: they are read as is and re-encrypted on the first read.
// Token writes and that migration run one after another, so a migration never overwrites a newer token.
let tokenChain = Promise.resolve();
const tokenSerial = (fn) => {
  const run = tokenChain.then(fn, fn);
  tokenChain = run.catch(() => {});
  return run;
};
export async function getApiTokens() {
  const raw = await read(local, KEYS.apiTokens, {});
  const out = {};
  let plain = false;
  for (const [shopId, v] of Object.entries(raw || {})) {
    if (!v) continue;
    if (!isEncrypted(v)) plain = true;
    const tok = await decryptToken(shopId, v);
    if (tok) out[shopId] = tok;
    else console.warn('[ksh] API token of store', shopId, 'cannot be decrypted — reconnect the store');
  }
  if (plain) await tokenSerial(migrateApiTokens).catch((e) => console.warn('[ksh] token encryption failed', e));
  return out;
}
async function migrateApiTokens() {
  const raw = await read(local, KEYS.apiTokens, {}); // fresh: a newer write may have happened
  let changed = false;
  for (const [shopId, v] of Object.entries(raw)) {
    if (v && !isEncrypted(v)) (raw[shopId] = await encryptToken(shopId, v)), (changed = true);
  }
  if (changed) await write(local, KEYS.apiTokens, raw);
}
/** @param {Record<string, string>} v plain tokens by shopId */
export const setApiTokens = (v) =>
  tokenSerial(async () => {
    const enc = {};
    for (const [shopId, tok] of Object.entries(v || {})) if (tok) enc[shopId] = isEncrypted(tok) ? tok : await encryptToken(shopId, tok);
    await write(local, KEYS.apiTokens, enc);
  });

export const getCosts = () => read(local, KEYS.costs, {});
export const setCosts = (v) => write(local, KEYS.costs, v);
export const getPhotos = () => read(local, KEYS.photos, {});
export const setPhotos = (v) => write(local, KEYS.photos, v);
export const getCatalog = () => read(local, KEYS.catalog, {});
export const setCatalog = (v) => write(local, KEYS.catalog, v);
export const getFeeds = () => read(local, KEYS.feeds, {});
export const setFeeds = (v) => write(local, KEYS.feeds, v);
export const getImports = () => read(local, KEYS.imports, []);
export const setImports = (v) => write(local, KEYS.imports, v);
export const getContentCache = () => read(local, KEYS.contentCache, {});
export const setContentCache = (v) => write(local, KEYS.contentCache, v);
export const getPickList = () => read(session, KEYS.pickList, null);
export const setPickList = (v) => write(session, KEYS.pickList, v);

/** Wipe cached Kaspi data (keeps settings). */
export async function clearCache() {
  const ids = (await local().get(SNAP_INDEX))[SNAP_INDEX] || [];
  await local().remove([KEYS.snapshots, SNAP_INDEX, ...ids.map(snapKey), KEYS.chat, KEYS.lastSync, KEYS.apiEntries]);
  snapSeen?.clear();
}

/**
 * Subscribe to changes of one key.
 * @param {string} key
 * @param {(newValue:any, oldValue:any)=>void} cb
 * @returns {() => void} unsubscribe
 */
export function onKeyChange(key, cb) {
  const listener = (changes) => key in changes && cb(changes[key].newValue, changes[key].oldValue);
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
