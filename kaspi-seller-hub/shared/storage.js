/**
 * Kaspi Seller Hub — typed wrapper around chrome.storage.
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
  apiEntries: 'ksh.apiEntries', // { [shopId::code]: entries[] } — order contents cache
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
const write = (area, key, value) => area().set({ [key]: value });

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
/** JSON of each store as last written/seen in this context → unchanged stores are skipped. */
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
      else snapSeen.set(k.slice(SNAP_PREFIX.length), JSON.stringify(c.newValue));
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
    for (const [id, sn] of Object.entries(out)) snapSeen.set(id, JSON.stringify(sn));
  }
  return out;
}
/** One store's snapshot (null when absent). */
export async function getSnapshot(shopId) {
  const got = await local().get([SNAP_INDEX, snapKey(shopId), KEYS.snapshots]);
  if (!Array.isArray(got[SNAP_INDEX])) return got[KEYS.snapshots]?.[shopId] ?? null;
  return got[snapKey(shopId)] ?? null;
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
  for (const id of ids) {
    const json = JSON.stringify(v[id]);
    if (legacy || snapSeen.get(id) !== json) patch[snapKey(id)] = v[id];
    snapSeen.set(id, json);
  }
  const gone = before.filter((id) => !ids.includes(id));
  if (legacy || gone.length || ids.length !== before.length || ids.some((id, i) => before[i] !== id)) patch[SNAP_INDEX] = ids;
  if (Object.keys(patch).length) await local().set(patch); // index and data in one write
  gone.forEach((id) => snapSeen.delete(id));
  const drop = [...gone.map(snapKey), ...(legacy && KEYS.snapshots in got ? [KEYS.snapshots] : [])];
  if (drop.length) await local().remove(drop);
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
  const cur = got[snapKey(shopId)] ?? null;
  const curJson = cur && JSON.stringify(cur); // before fn may mutate it
  let next = fn(cur);
  if (next === undefined) next = cur;
  const ids = got[SNAP_INDEX];
  if (!next) {
    if (ids.includes(shopId)) await local().set({ [SNAP_INDEX]: ids.filter((id) => id !== shopId) });
    await local().remove(snapKey(shopId));
    snapSeen.delete(shopId);
    return null;
  }
  const json = JSON.stringify(next);
  const patch = {};
  if (json !== curJson) patch[snapKey(shopId)] = next;
  if (!ids.includes(shopId)) patch[SNAP_INDEX] = [...ids, shopId];
  snapSeen.set(shopId, json);
  if (Object.keys(patch).length) await local().set(patch);
  return next;
}

/** Chat cache: { [shopId]: { conversations: [...], threads: { [conversationId]: messages[] } } } */
export const getChat = () => read(local, KEYS.chat, {});
export const setChat = (v) => write(local, KEYS.chat, v);

/** @returns {Promise<Invoice[]>} */
export const getInvoices = () => read(local, KEYS.invoices, []);

/**
 * Add/replace invoices (deduplicated by shopId + orderId).
 * @param {Invoice[]} list
 */
export async function addInvoices(list) {
  const map = new Map((await getInvoices()).map((i) => [`${i.shopId}::${i.orderId}`, i]));
  const now = Date.now();
  list.forEach((i) => map.set(`${i.shopId}::${i.orderId}`, { ...i, ts: i.ts || now }));
  await write(local, KEYS.invoices, pruneInvoiceList([...map.values()], now));
}

/**
 * Waybills are base64 files (often 50–300 KB each), so the list is bounded:
 * older than maxAgeDays, beyond maxCount or beyond maxBytes → the oldest go first.
 * Entries without ts (older versions) are kept by age but go first by count/size.
 * The newest invoice is always kept.
 */
export const INVOICE_LIMITS = Object.freeze({ maxAgeDays: 30, maxCount: 500, maxBytes: 50 * 1024 * 1024 });
export function pruneInvoiceList(list, now = Date.now(), limits = INVOICE_LIMITS) {
  const minTs = now - limits.maxAgeDays * 86400000;
  const sorted = (list || []).filter((i) => i && (!i.ts || i.ts >= minTs)).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const out = [];
  let bytes = 0;
  for (const i of sorted) {
    const size = (i.data?.length || 0) + 200;
    if (out.length && (out.length >= limits.maxCount || bytes + size > limits.maxBytes)) break;
    out.push(i);
    bytes += size;
  }
  return out;
}
/** Remove invoices of the given stores (store removed) and apply the limits. */
export async function pruneInvoices({ dropShops = [] } = {}) {
  const list = await getInvoices();
  const drop = new Set(dropShops);
  const next = pruneInvoiceList(list.filter((i) => !drop.has(i.shopId)));
  if (next.length !== list.length) await write(local, KEYS.invoices, next);
  return list.length - next.length;
}
export const clearInvoices = () => write(local, KEYS.invoices, []);

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
export const getApiEntries = () => read(local, KEYS.apiEntries, {});
export const setApiEntries = (v) => write(local, KEYS.apiEntries, v);

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
