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
 *   amount:number|null, paymentStatus:'paid'|'pending'|'failed'|'unknown', paymentRaw:string,
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
  notifications: { newOrders: true, newMessages: true, returns: false },
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
  return { ...structuredClone(DEFAULT_SETTINGS), ...s, notifications: { ...DEFAULT_SETTINGS.notifications, ...s.notifications } };
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

/** Wipe cached Kaspi data (keeps settings). */
export const clearCache = () => local().remove([KEYS.snapshots, KEYS.chat, KEYS.lastSync]);

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
