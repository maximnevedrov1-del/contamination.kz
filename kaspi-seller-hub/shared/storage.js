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

/** @returns {Promise<Record<string, Snapshot>>} */
export const getSnapshots = () => read(local, KEYS.snapshots, {});
/** Pages get the worker's state without the (large) snapshots and read them here. */
export async function withSnapshots(st) {
  if (st && st.settings && !st.snapshots) st.snapshots = await getSnapshots();
  return st;
}
/** @param {Record<string, Snapshot>} v */
export const setSnapshots = (v) => write(local, KEYS.snapshots, v);

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
  list.forEach((i) => map.set(`${i.shopId}::${i.orderId}`, i));
  await write(local, KEYS.invoices, [...map.values()]);
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
export const getApiTokens = () => read(local, KEYS.apiTokens, {});
export const setApiTokens = (v) => write(local, KEYS.apiTokens, v);
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
export const clearCache = () => local().remove([KEYS.snapshots, KEYS.chat, KEYS.lastSync, KEYS.apiEntries]);

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
