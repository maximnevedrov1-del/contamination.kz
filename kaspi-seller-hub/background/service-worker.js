/**
 * SaudaPulse — background service worker (MV3, ES module).
 *
 *  - Tab registry: which open Kaspi tab belongs to which store (chrome.storage.session,
 *    because the worker itself can be stopped at any time).
 *  - Sync: asks every store tab for a snapshot, merges per store, dedupes by order id,
 *    caches in chrome.storage.local with timestamps. A tab that does not answer only
 *    marks ITS store unavailable.
 *  - Command routing for user-triggered bulk actions (pack, invoices, payments,
 *    returns/refusals, chat replies), executed sequentially per store with pauses.
 *  - Chat polling via chrome.alarms (passive: never navigates a tab).
 *  - Notifications and the toolbar badge.
 */
import '../shared/selectors.js';
import {
  getSettings,
  saveSettings,
  getSnapshots,
  setSnapshots,
  getChat,
  setChat,
  addInvoices,
  pruneInvoices,
  updateSnapshot,
  setLastSync,
  getLastSync,
  getRegistry,
  setRegistry,
  setPrintQueue,
  clearCache,
  getApiTokens,
  setApiTokens,
  getCosts,
  setCosts,
  getCatalog,
  KEYS,
} from '../shared/storage.js';
import * as K from './kaspi-api.js';
import * as B from './billing.js';
import { catalogHandlers, pollImports, ALARM_IMPORTS, onFeedDrop } from './catalog-service.js';
import { staffHandlers, staffGate, checkStaff, scheduleStaffCheck, ALARM_STAFF } from './staff.js';
import { startHealth, flushHealth, scheduleHealth, ALARM_HEALTH } from './health.js';
import { supportHandlers, pollTickets } from './support.js';
import { usageHandlers, flushUsage, noteAction, ACTION_OF } from './usage.js';
import { growthHandlers, reportDigest, alertDeadlines } from './growth.js';
import { packingHandlers } from './packing.js';
import { initI18n, t, formatMoney, formatDate } from '../shared/i18n.js';
import { migrateStorage, DATA_VERSION } from '../shared/migrations.js';
import { FEATURES } from '../shared/features.js';
import { logError, scrub, getErrorLog, clearErrorLog, formatReport } from '../shared/errorlog.js';
import { sleep, withTimeout, createMutex, fillTemplate, nextStoreColor, groupBy, uid, storeCounts, sumCounts, deadlineOf, urgencyOf, kzParts } from '../shared/utils.js';

const S = globalThis.KSH_SELECTORS;
const LOG = '[KSH/sw]';
const lock = createMutex();
const ALARM_CHAT = 'ksh-chat-poll';
const ALARM_SYNC = 'ksh-sync';
const DASHBOARD_URL = chrome.runtime.getURL('dashboard/dashboard.html');

/** Log to the console and to the local journal for support (shared/errorlog.js). */
const report = (where, e) => {
  console.warn(LOG, where, e?.code || e?.message || e);
  logError(where, e);
};

/*
 * Stored data is brought to the current format once per worker start, before any
 * page gets an answer (shared/migrations.js). A failure is journaled; the data
 * stays as it was and a copy is kept in ksh.preMigration.
 */
const dataReady = migrateStorage()
  .then((r) => {
    if (r.error) report('migrate', new Error(`v${r.from}→v${DATA_VERSION}: ${r.error}`));
    else if (r.downgraded) report('migrate', new Error(`data v${r.from} is newer than this build (v${DATA_VERSION})`));
  })
  .catch((e) => report('migrate', e));

self.addEventListener('error', (e) => logError('worker:error', e.error || e.message));
self.addEventListener('unhandledrejection', (e) => logError('worker:unhandled', e.reason));

/** Errors worth a journal line (not validation answers like «fill the price»). */
const SYSTEM_ERROR = /^(api|feedUpload|feedForbidden|feedDrop|billingNetwork|billingServer|workerError|noResponse|import|card)/;

/* ===================================================================== */
/* Messaging helpers                                                      */
/* ===================================================================== */

/** Broadcast to open extension pages (dashboard, popup, print). */
const broadcast = (type, payload) => chrome.runtime.sendMessage({ type, payload }).catch(() => {});

/**
 * Send a command to a content script, with timeout.
 * @param {number} tabId
 * @param {string} type
 * @param {object} [payload]
 * @param {number} [timeout]
 */
function sendToTab(tabId, type, payload = {}, timeout = 15000) {
  return withTimeout(chrome.tabs.sendMessage(tabId, { type, payload }), timeout, 'tabTimeout');
}

/* ===================================================================== */
/* Tab registry                                                           */
/* ===================================================================== */

/**
 * Record what a content script reported about its tab, and remember the store.
 * @param {number} tabId
 * @param {{authenticated:boolean, shopId:string|null, shopName:string, pageType:string, url:string, origin:string}} info
 */
function registerTab(tabId, info) {
  return lock(async () => {
    const reg = await getRegistry();
    reg[tabId] = { tabId, ...info, lastSeen: Date.now() };
    await setRegistry(reg);
    if (info.authenticated && info.shopId) await upsertStore(info);
  });
}

/** Add a newly seen store to settings (keeps alias/colour/enabled if known). Call inside lock. */
async function upsertStore({ shopId, shopName, origin }) {
  const settings = await getSettings();
  const existing = settings.stores[shopId];
  if (existing && existing.origin === origin && (!shopName || existing.name === shopName) && Date.now() - (existing.lastSeen || 0) < 60000) return;
  const used = Object.values(settings.stores).map((s) => s.color);
  settings.stores[shopId] = {
    ...existing,
    id: shopId,
    name: shopName || existing?.name || shopId,
    alias: existing?.alias || '',
    color: existing?.color || nextStoreColor(used),
    enabled: existing?.enabled ?? true,
    origin,
    addedAt: existing?.addedAt || Date.now(),
    lastSeen: Date.now(),
  };
  await saveSettings({ stores: settings.stores });
}

/* ===================================================================== */
/* Subscription                                                           */
/* ===================================================================== */

const enabledStoreList = (settings) => Object.values(settings.stores).filter((s) => s.enabled);

/**
 * Stores covered by the subscription: enabled stores in the order they were
 * added, up to the plan's store limit. null limit = developer mode (all).
 */
function allowedStoreIds(settings, lic) {
  const list = enabledStoreList(settings).sort((a, b) => (a.addedAt || a.lastSeen || 0) - (b.addedAt || b.lastSeen || 0));
  const limit = lic?.storeLimit;
  return (limit == null ? list : list.slice(0, Math.max(0, limit))).map((s) => s.id);
}

/** Licence view for the current state (cached; re-checked online every few minutes). */
/** SHA-256 of each connected Kaspi store id: lets the server give one free trial per
 *  store without ever receiving the ids themselves. */
const storeKeyCache = new Map();
async function storeKeys(stores) {
  const out = [];
  for (const st of stores) {
    // normalised so the same shop always gives the same key
    const id = String(st.id ?? '').trim().toLowerCase();
    if (!id) continue;
    if (!storeKeyCache.has(id)) {
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ksh:${id}`));
      storeKeyCache.set(id, [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join(''));
    }
    out.push(storeKeyCache.get(id));
  }
  return out;
}

async function currentLicense(force = false) {
  const settings = await getSettings();
  const stores = enabledStoreList(settings);
  return B.licenseView({ force, storeCount: stores.length, storeKeys: await storeKeys(Object.values(settings.stores)) });
}

let lastReconcileAt = 0;
let lastReconcileKey = null;
/**
 * Licence + automatic billing: renewal invoice for all stores from remind_days
 * before the end (or once expired), add-on invoice when more stores are connected
 * than covered; then the payment reminder with the Kaspi QR.
 */
async function billingMaintenance(force = false, reconcile = force) {
  let lic = await currentLicense(force);
  if (!B.isConfigured() || lic?.needsConsent) return lic; // no invoices before the offer is accepted
  const count = enabledStoreList(await getSettings()).length;
  // The server call is idempotent: repeat it only when something changed (store count,
  // renewal window, open invoice) or every 30 min — not every minute for every client.
  const key = JSON.stringify([count, lic?.status, lic?.renewalDue, lic?.storeLimit, lic?.pendingInvoice?.id, lic?.pendingInvoice?.stores]);
  if (reconcile || key !== lastReconcileKey || Date.now() - lastReconcileAt > 30 * 60000) {
    lastReconcileAt = Date.now();
    lastReconcileKey = key;
    try {
      if (await B.reconcileInvoice(count, lic)) lic = await currentLicense(true);
    } catch (e) {
      console.warn(LOG, 'billing reconcile', e.code || e.message);
      B.reportClientError(`billing_${e.code || 'error'}`, 'maintenance');
    }
  }
  await notifyPayment(lic).catch((e) => console.warn(LOG, 'pay notify', e));
  return lic;
}

/** Image notification with the Kaspi QR: once a day per invoice amount. */
async function notifyPayment(lic) {
  const inv = lic?.pendingInvoice;
  if (!inv || !(lic.renewalDue || !lic.canUse || inv.kind === 'addon')) return;
  const key = `${inv.id}:${inv.amount}:${new Date().toDateString()}`;
  const { 'ksh.payNotified': last } = await chrome.storage.local.get('ksh.payNotified');
  if (last === key) return;
  try { await chrome.storage.local.set({ 'ksh.payNotified': key }); } catch (e) { console.warn('[ksh.sw] storage write failed', e?.message || e); }
  await initI18n();
  const amount = formatMoney(inv.amount);
  const msgKey = !lic.canUse ? 'notifications.payExpired' : inv.kind === 'addon' ? 'notifications.payAddon' : 'notifications.payRenewal';
  const message = t(msgKey, { amount, stores: inv.stores, date: lic.coverageEnd ? formatDate(lic.coverageEnd) : '', days: lic.daysLeft });
  const opts = { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon-128.png'), title: t('notifications.payTitle', { amount }), message, priority: 2, requireInteraction: true };
  const qr = lic.payment?.qr_url;
  if (qr) {
    try {
      const res = await fetch(qr);
      const buf = new Uint8Array(await res.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      Object.assign(opts, { type: 'image', imageUrl: `data:${res.headers.get('content-type') || 'image/png'};base64,${btoa(bin)}` });
    } catch {
      /* QR not reachable → plain notification */
    }
  }
  await showNotification(`ksh:pay:${inv.id}`, opts); // click → dashboard "#pay" (QR window)
}

/** A store's price list lost most of its products: held back, the seller decides. */
onFeedDrop(async (shopId, drop) => {
  await initI18n();
  const name = (await getSettings()).stores?.[shopId]?.name || '';
  await showNotification(`ksh:catalog:drop-${shopId}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: t('notifications.feedDropTitle', { store: name }),
    message: t('notifications.feedDropText', { from: drop?.from ?? 0, to: drop?.to ?? 0 }),
    priority: 2,
    requireInteraction: true,
  });
});

/**
 * Notification that works in every browser: Chrome/Yandex/Edge/Opera show the QR image;
 * Firefox only knows "basic" (retried without the image); Safari has no notifications
 * API at all (skipped — the dashboard banner / payment window still show everything).
 */
async function showNotification(id, opts) {
  if (!chrome.notifications?.create) return;
  try {
    await chrome.notifications.create(id, opts);
  } catch (e) {
    if (opts.type === 'basic') return console.warn(LOG, 'notification', e?.message);
    const { imageUrl, requireInteraction, ...basic } = opts;
    await chrome.notifications.create(id, { ...basic, type: 'basic' }).catch((e2) => console.warn(LOG, 'notification', e2?.message));
  }
}

function unregisterTab(tabId) {
  return lock(async () => {
    const reg = await getRegistry();
    if (reg[tabId]) {
      delete reg[tabId];
      await setRegistry(reg);
      broadcast('bg:registryChanged');
    }
  });
}

/** Inject content scripts into a Kaspi tab opened before the extension was installed. */
async function injectContent(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/network-tap.js'], world: 'MAIN' }).catch(() => {});
  await chrome.scripting.executeScript({ target: { tabId }, files: ['shared/selectors.js', 'content/content.js'] });
}

/**
 * Find all open Kaspi tabs, make sure each has a live content script, and
 * refresh the registry from their answers.
 * @returns {Promise<Array<object>>} live registry entries
 */
async function discoverTabs() {
  if (!FEATURES.cabinet) return []; // API-only build: cabinet tabs are not read (callers iterate the result)
  const tabs = await chrome.tabs.query({ url: [...S.tabMatchPatterns] });
  const live = [];
  await Promise.all(
    tabs
      .filter((tab) => !tab.discarded && tab.id != null && /^(https?|file):/.test(tab.url || tab.pendingUrl || ''))
      .map(async (tab) => {
        let info = await sendToTab(tab.id, 'ksh:ping', {}, 2000).catch(() => null);
        if (!info) {
          try {
            await injectContent(tab.id);
            info = await sendToTab(tab.id, 'ksh:ping', {}, 3000);
          } catch (e) {
            console.warn(LOG, 'tab unreachable', tab.id, e.message);
          }
        }
        if (info?.ok) live.push({ tabId: tab.id, ...info, lastSeen: Date.now() });
      }),
  );
  await lock(async () => {
    const reg = Object.fromEntries(live.map((e) => [e.tabId, e]));
    await setRegistry(reg);
    for (const e of live) if (e.authenticated && e.shopId) await upsertStore(e);
  });
  return live;
}

/**
 * Best tab for a store. `prefer` is a page type (e.g. 'chat'); otherwise
 * non-chat tabs are preferred so chat tabs are left alone.
 */
async function pickTab(shopId, prefer) {
  const entries = Object.values(await getRegistry()).filter((e) => e.shopId === shopId && e.authenticated);
  if (!entries.length) return null;
  const score = (e) => (prefer ? (e.pageType === prefer ? 2 : 0) : e.pageType === 'chat' ? 0 : 1) + e.lastSeen / 1e15;
  return entries.sort((a, b) => score(b) - score(a))[0];
}

/** Wait until a tab finished loading and its content script answers. */
async function waitForTabReady(tabId, timeout = S.timing.navigationTimeoutMs) {
  const deadline = Date.now() + timeout;
  await sleep(300);
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('tabClosed');
    if (tab.status === 'complete') {
      const ping = await sendToTab(tabId, 'ksh:ping', {}, 1500).catch(() => null);
      if (ping?.ok) {
        await registerTab(tabId, ping);
        await sleep(800); // let the SPA render its data
        return ping;
      }
    }
    await sleep(500);
  }
  throw new Error('navigationTimeout');
}

/** Navigate a store tab to a path from selectors.urls (user-triggered actions only). */
async function navigateTab(entry, path) {
  const url = new URL(path, entry.origin).href;
  await chrome.tabs.update(entry.tabId, { url });
  return waitForTabReady(entry.tabId);
}

/**
 * Run a content-script command in the right tab of a store. If the content
 * script reports `needsNavigation` and a URL is given, the tab is navigated once.
 * @param {string} shopId
 * @param {string} type
 * @param {object} payload
 * @param {{ navigateTo?:string, prefer?:string, timeout?:number }} [opts]
 */
async function runInStore(shopId, type, payload, { navigateTo, prefer, timeout = 30000 } = {}) {
  let entry = await pickTab(shopId, prefer);
  if (!entry) {
    await discoverTabs();
    entry = await pickTab(shopId, prefer);
  }
  if (!entry) return { ok: false, error: 'storeUnavailable' };
  let res = await sendToTab(entry.tabId, type, payload, timeout).catch((e) => ({ ok: false, error: e.message }));
  if (!res?.ok && res?.needsNavigation && navigateTo) {
    try {
      await navigateTab(entry, navigateTo);
      res = await sendToTab(entry.tabId, type, payload, timeout).catch((e) => ({ ok: false, error: e.message }));
    } catch (e) {
      res = { ok: false, error: e.message };
    }
  }
  return res ?? { ok: false, error: 'noResponse' };
}

/* ===================================================================== */
/* Snapshots & sync                                                       */
/* ===================================================================== */

const LIST_SECTIONS = ['orders', 'returns', 'refusals', 'chat'];

/**
 * Merge fresh snapshots from one or more tabs of the same store with the
 * previously cached snapshot. A section that is not visible right now keeps its
 * cached data (marked source:'cache'), so coverage accumulates while the seller
 * browses different pages. List items are deduplicated by id.
 */
function mergeStoreSnapshot(prev, fresh) {
  const sections = {};
  const keys = new Set([...Object.keys(prev?.sections || {}), ...fresh.flatMap((f) => Object.keys(f.sections || {}))]);
  for (const key of keys) {
    const ok = fresh.map((f) => f.sections?.[key]).filter((s) => s?.status === 'ok');
    if (ok.length) {
      if (LIST_SECTIONS.includes(key)) {
        const map = new Map();
        ok.forEach((s) => s.items?.forEach((it) => map.set(String(it.id), it)));
        // Sources are merged in order (DOM first, API last), so API data wins for the same order.
        const source = ok.some((s) => s.source === 'api') ? 'api' : ok[0].source;
        sections[key] = { status: 'ok', source, ts: Date.now(), items: [...map.values()] };
      } else {
        sections[key] = { ...ok[0], ts: Date.now() };
      }
    } else if (prev?.sections?.[key]?.status === 'ok') {
      sections[key] = { ...prev.sections[key], source: 'cache' };
    } else {
      const err = fresh.map((f) => f.sections?.[key]).find((s) => s?.status === 'error');
      sections[key] = err || { status: 'notVisible' };
    }
  }
  const head = fresh[0];
  return {
    shopId: head.shopId,
    shopName: head.shopName,
    ts: Date.now(),
    status: 'ok',
    sections,
    missingSelectors: [...new Set(fresh.flatMap((f) => f.missingSelectors || []))],
    selectorsVersion: head.selectorsVersion,
  };
}

/**
 * Pull fresh data from every open store tab.
 * @returns {Promise<object>} state for the UI
 */
/*
 * One sync at a time. Connecting 5 stores in a row used to start 5 overlapping full
 * syncs (the first store was downloaded 5 times). A call while a sync runs now waits
 * for it and then runs ONE more (it may need a store added in the meantime); further
 * calls share that queued run.
 */
let syncRunning = null;
let syncQueued = null;
function sync() {
  if (!syncRunning) {
    syncRunning = syncNow().finally(() => (syncRunning = null));
    return syncRunning;
  }
  syncQueued ??= syncRunning.catch(() => {}).then(() => {
    syncQueued = null;
    return sync();
  });
  return syncQueued;
}

async function syncNow() {
  // No active subscription → no data is pulled; the UI shows the paywall.
  const lic = await billingMaintenance();
  if (!lic.canUse) {
    const state = await getState();
    broadcast('bg:stateChanged', state);
    return state;
  }

  const entries = await discoverTabs();
  const results = await Promise.all(
    entries.map((e) => sendToTab(e.tabId, 'ksh:snapshot', {}, 20000).catch((err) => ({ ok: false, error: err.message, tabId: e.tabId }))),
  );

  // Stores above the plan's limit are not synced.
  const allowed = new Set(allowedStoreIds(await getSettings(), lic));
  const byShop = {};
  results.forEach((r) => {
    // discoverTabs() has already registered new stores, so `allowed` covers them too.
    if (r?.ok && r.authenticated && r.shopId && allowed.has(r.shopId)) (byShop[r.shopId] ??= []).push(r);
  });

  // Stores connected by API token: fetched directly, no tab needed.
  const apiErrors = {};
  const [tokens, settingsNow, prevNow] = await Promise.all([getApiTokens(), getSettings(), getSnapshots()]);
  await Promise.all(
    Object.entries(tokens).map(async ([shopId, token]) => {
      const store = settingsNow.stores[shopId];
      if (!store || !store.enabled || !allowed.has(shopId)) return;
      if (breakerOpen(store.api)) {
        apiErrors[shopId] = store.api.error || 'apiNetwork'; // resting: the last data stays
        return;
      }
      try {
        const snap = await apiSnapshot(shopId, token, prevNow[shopId], store);
        B.trackFunnel('first_sync_done');
        (byShop[shopId] ??= []).push(snap); // last → API wins over DOM for the same order
      } catch (e) {
        apiErrors[shopId] = e.code || e.message;
        console.warn(LOG, 'api sync failed', shopId, e.code, e.status, e.detail);
      }
    }),
  );
  await recordApiHealth(Object.keys(tokens), apiErrors);

  await lock(async () => {
    const [settings, prev] = await Promise.all([getSettings(), getSnapshots()]);
    const next = {};
    const shopIds = new Set([...Object.keys(settings.stores), ...Object.keys(byShop)]);
    for (const shopId of shopIds) {
      if (byShop[shopId]) next[shopId] = mergeStoreSnapshot(prev[shopId], byShop[shopId]);
      else if (settings.stores[shopId]?.enabled && !allowed.has(shopId))
        next[shopId] = { ...(prev[shopId] || { shopId, shopName: settings.stores[shopId]?.name || shopId, sections: {}, missingSelectors: [] }), status: 'overLimit', checkedAt: Date.now() };
      else if (apiErrors[shopId])
        next[shopId] = { ...(prev[shopId] || { shopId, shopName: settings.stores[shopId]?.name || shopId, sections: {}, missingSelectors: [] }), status: 'error', error: apiErrors[shopId], checkedAt: Date.now() };
      else
        next[shopId] = {
          ...(prev[shopId] || { shopId, shopName: settings.stores[shopId]?.name || shopId, sections: {}, missingSelectors: [] }),
          // A store without a live tab is "tab closed". Logged-out cabinet tabs cannot be
          // attributed to a store, so they are reported separately (unauthTabs).
          status: 'noTab',
          checkedAt: Date.now(),
        };
    }
    await setSnapshots(next);
    await setLastSync(Date.now());
    await notifyDiff(prev, next, settings);
  });
  await updateBadge();
  await notifyDeadlines().catch((e) => console.warn(LOG, 'deadline notify', e));
  // A store found during this sync (e.g. a new cabinet tab) may exceed the plan:
  // bill it now so the payment window can show right away.
  if (B.isConfigured() && lic.storeLimit != null && !lic.pendingInvoice && enabledStoreList(await getSettings()).length > lic.storeLimit) {
    await billingMaintenance(true).catch((e) => console.warn(LOG, 'billing after sync', e));
  }
  const state = await getState();
  broadcast('bg:stateChanged', state);
  return state;
}

/** Warn once per order when its deadline is near or missed. */
async function notifyDeadlines() {
  const settings = await getSettings();
  const snapshots = await getSnapshots();
  const { [KEYS.deadlineNotified]: seen = {} } = await chrome.storage.session.get(KEYS.deadlineNotified);
  const fresh = [];
  for (const [shopId, snap] of Object.entries(snapshots)) {
    const store = settings.stores[shopId];
    if (!store?.enabled) continue;
    for (const it of snap.sections?.orders?.items || []) {
      const dl = deadlineOf(it, settings);
      const u = urgencyOf(dl, settings);
      const key = `${shopId}::${it.id}::${dl?.kind}::${u}`;
      if ((u === 'soon' || u === 'overdue') && !seen[key]) {
        seen[key] = Date.now();
        fresh.push({ it, dl, u, store: store.alias || store.name });
      }
    }
  }
  if (!fresh.length) return;
  try { await chrome.storage.session.set({ [KEYS.deadlineNotified]: seen }); } catch (e) { console.warn('[ksh.sw] storage write failed', e?.message || e); }
  // Telegram (if linked): one message per order, even when Chrome notifications are off
  alertDeadlines(fresh).catch((e) => console.warn(LOG, 'telegram alert', e));
  if (!settings.notifications.deadlines) return;
  await initI18n();
  const overdue = fresh.filter((f) => f.u === 'overdue').length;
  const first = fresh[0];
  const msg = t('notifications.deadlines', { count: fresh.length, overdue, store: first.store, order: first.it.id });
  notify('deadlines', t('notifications.deadlinesTitle'), msg, 'orders');
}

/** A content script pushed a fresh snapshot by itself (the seller is browsing). */
async function onContentUpdate(snap) {
  if (!snap?.authenticated || !snap.shopId) return;
  await lock(async () => {
    await updateSnapshot(snap.shopId, (cur) => mergeStoreSnapshot(cur || undefined, [snap]));
  });
  await updateBadge();
  broadcast('bg:stateChanged', await getState());
}

/** State consumed by popup and dashboard. */
/**
 * State for extension pages. Without `full`, the per-store snapshots (all orders —
 * 15–20 MB with 5 stores × 5 000 orders) are left out: pages read them straight from
 * chrome.storage (shared/storage.js → withSnapshots) instead of receiving a copy in
 * every message and every broadcast after a sync.
 */
async function getState({ full = false } = {}) {
  const [settings, snapshots, lastSync, registry, tokens, catalog] = await Promise.all([getSettings(), full ? getSnapshots() : null, getLastSync(), getRegistry(), getApiTokens(), getCatalog()]);
  const tabs = Object.values(registry);
  const license = await currentLicense().catch(() => ({ status: 'offline', canUse: false, storeLimit: 0 }));
  return {
    settings,
    ...(full ? { snapshots } : {}),
    lastSync,
    tabs,
    unauthTabs: tabs.filter((e) => !e.authenticated && e.isCabinet).length,
    license,
    allowedStoreIds: allowedStoreIds(settings, license),
    // for the home page checklist (ids only, never the tokens)
    apiStores: Object.keys(tokens).filter((id) => settings.stores[id]),
    catalogReady: Object.keys(catalog).length > 0,
  };
}

/* ===================================================================== */
/* Notifications & badge                                                  */
/* ===================================================================== */

async function notify(id, title, message, route) {
  await initI18n();
  await showNotification(`ksh:${route}:${id}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title,
    message,
    priority: 1,
  });
}

/** Notify about orders/returns that were not there in the previous snapshot. */
async function notifyDiff(prev, next, settings) {
  await initI18n();
  for (const [shopId, snap] of Object.entries(next)) {
    const before = prev[shopId];
    if (!before?.sections || snap.status !== 'ok') continue; // never notify on first sight
    const store = settings.stores[shopId];
    if (store && !store.enabled) continue;
    const name = store?.alias || store?.name || snap.shopName;
    const newIds = (sec, filter = () => true) => {
      // Without a previous list for this section everything would look "new".
      if (before.sections[sec]?.status !== 'ok' || snap.sections[sec]?.status !== 'ok') return [];
      const old = new Set(before.sections[sec].items.map((i) => i.id));
      return snap.sections[sec].items.filter((i) => filter(i) && !old.has(i.id));
    };
    if (settings.notifications.newOrders) {
      const n = newIds('orders', (o) => o.status === 'new').length;
      if (n) notify(shopId, t('notifications.newOrdersTitle'), t('notifications.newOrders', { count: n, store: name }), 'orders');
    }
    if (settings.notifications.returns) {
      const n = newIds('returns').length;
      if (n) notify(`${shopId}r`, t('notifications.returnsTitle'), t('notifications.returns', { count: n, store: name }), 'returns');
    }
  }
}

/** Many call sites per sync: calls within 300 ms share one run (each run parses all snapshots). */
let badgeRun = null;
function updateBadge() {
  badgeRun ??= new Promise((r) => setTimeout(r, 300)).then(() => {
    badgeRun = null;
    return renderBadge();
  });
  return badgeRun;
}

let printOpening = false;

async function renderBadge() {
  const [snapshots, chat, settings] = await Promise.all([getSnapshots(), getChat(), getSettings()]);
  const enabled = Object.values(snapshots).filter((s) => settings.stores[s.shopId]?.enabled === true);
  const totals = sumCounts(enabled.map(storeCounts));
  const unread = Object.entries(chat)
    .filter(([id]) => settings.stores[id]?.enabled === true)
    .reduce((n, [, c]) => n + (c.conversations || []).reduce((m, x) => m + (x.unread || 0), 0), 0);
  const total = (totals.newOrders || 0) + unread;
  await chrome.action.setBadgeText({ text: total ? String(total > 99 ? '99+' : total) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#e34948' });
}

/* ===================================================================== */
/* Official API (stores connected with a token)                            */
/* ===================================================================== */

const DAY = 86400000;

/** Save per-store API health (last success / last error) in settings. */
async function recordApiHealth(shopIds, errors) {
  if (!shopIds.length) return;
  await lock(async () => {
    const settings = await getSettings();
    let changed = false;
    for (const id of shopIds) {
      const st = settings.stores[id];
      if (!st?.api) continue;
      if (breakerOpen(st.api) && errors[id]) continue; // skipped while resting: keep the counters
      st.api = errors[id]
        ? { ...st.api, error: errors[id], errorAt: Date.now(), fails: OUTAGE_CODES.has(errors[id]) ? (st.api.fails || 0) + 1 : 0 }
        : { ...st.api, error: null, lastOkAt: Date.now(), fails: 0 };
      changed = true;
    }
    if (changed) await saveSettings({ stores: settings.stores });
  });
}

/**
 * Build a store snapshot from the API: orders of the last 28 days (90 on first
 * sync) + older API orders kept from the cache, split into orders / returns /
 * refusals, plus top products from order contents.
 */
async function apiSnapshot(shopId, token, prevSnap, store) {
  const prevItems = prevSnap?.sections?.orders?.items || [];
  const hadApi = prevItems.some((i) => i.api);
  const days = hadApi ? S.api.syncDays : S.api.firstSyncDays;
  const raw = await K.listOrders(token, days);
  const fresh = raw.map(K.toOrderItem);
  const freshIds = new Set(fresh.map((i) => i.id));
  const windowStart = Date.now() - days * DAY;
  const keepFrom = Date.now() - S.api.firstSyncDays * DAY;
  const kept = prevItems.filter((i) => i.api && !freshIds.has(i.id) && i.date && new Date(i.date).getTime() < windowStart && new Date(i.date).getTime() >= keepFrom);
  const { topProducts, entriesOf } = await apiTopProducts(shopId, token, [...fresh, ...kept], prevItems);
  // Order contents travel with the order: needed for profit and the pick list.
  const all = [...fresh, ...kept].map((i) => ({ ...i, entries: entriesOf(i.id) || i.entries }));
  const section = (items) => ({ status: 'ok', source: 'api', items });
  return {
    ok: true,
    authenticated: true,
    shopId,
    shopName: store.name,
    sections: {
      orders: section(all),
      returns: section(all.filter((i) => i.kind === 'return')),
      refusals: section(all.filter((i) => i.kind === 'refusal')),
      analytics: { status: 'ok', source: 'api', data: { kpi: {}, series: [], topProducts } },
    },
    missingSelectors: [],
  };
}

/**
 * Order contents are one request per order, so they are kept for as long as the order is
 * in the snapshot (they do not change) and fetched at most `entriesPerSync` per sync
 * (3 in parallel), active and newest orders first. 5 000 orders of history fill in within
 * ~17 syncs (≈ 1.5 h). The contents live only inside the store's snapshot (order.entries):
 * the separate cache ksh.apiEntries held a second copy of all of them and is removed.
 */
async function apiTopProducts(shopId, token, items, prevItems = []) {
  const cache = {};
  for (const i of prevItems) if (i.api && Array.isArray(i.entries)) cache[i.id] = i.entries;
  const todo = items
    .filter((i) => i.api?.entriesUrl && i.kind !== 'refusal' && !cache[i.id]) // refusals: no profit, no pick list
    .sort((a, b) => (a.api.state === 'ARCHIVE') - (b.api.state === 'ARCHIVE') || (b.date || '').localeCompare(a.date || ''))
    .slice(0, S.api.entriesPerSync || 60);
  let stop = null;
  const worker = async () => {
    while (todo.length && !stop) {
      const it = todo.shift();
      try {
        cache[it.id] = await K.getEntries(token, { relationships: { entries: { links: { related: it.api.entriesUrl } } } });
      } catch (e) {
        stop = e; // the rest waits for the next sync
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(S.api.concurrency || 3, todo.length) }, worker));
  if (stop?.code === 'apiUnauthorized') throw stop;
  const agg = new Map();
  for (const it of items) {
    for (const e of cache[it.id] || []) {
      const k = e.sku || e.name;
      if (!k) continue;
      const p = agg.get(k) || { sku: e.sku, name: e.name || e.category, revenue: 0, units: 0, returns: 0 };
      if (it.kind === 'return') p.returns += e.quantity || 0;
      if (it.kind !== 'refusal') {
        p.units += e.quantity || 0;
        if (it.kind === 'order') p.revenue += e.total ?? (e.price || 0) * (e.quantity || 1);
      }
      agg.set(k, p);
    }
  }
  return {
    topProducts: [...agg.values()].map((p) => ({ ...p, returnRate: p.units ? p.returns / p.units : null })),
    entriesOf: (code) => cache[code],
  };
}

/** Current API state of one order (fresh from Kaspi), written back into the cache. */
async function refreshApiOrder(shopId, token, code) {
  const raw = await K.getOrderByCode(token, code);
  if (!raw) return null;
  const item = K.toOrderItem(raw);
  await lock(async () => {
    await updateSnapshot(shopId, (cur) => {
    const sec = cur?.sections;
    if (!sec) return;
    const old = sec.orders?.items?.find((i) => i.id === item.id);
    if (old?.entries) item.entries = old.entries;
    const put = (name, belongs) => {
      if (!sec[name]?.items) return;
      sec[name].items = sec[name].items.filter((i) => i.id !== item.id);
      if (belongs) sec[name].items.push(item);
    };
    put('orders', true);
    put('returns', item.kind === 'return');
    put('refusals', item.kind === 'refusal');
    });
  });
  return item;
}

/** Fetch the waybill of an order (if Kaspi has generated it) and store it as an invoice. */
async function apiCollectWaybill(shopId, token, item, attempts = 1) {
  let it = item;
  for (let i = 0; i < attempts && !it?.api?.waybill; i++) {
    if (i) await sleep(2500);
    it = await refreshApiOrder(shopId, token, item.id);
  }
  if (!it?.api?.waybill) return { ok: false, error: 'waybillNotReady' };
  const file = await K.downloadWaybill(token, it.api.waybill);
  await lock(() => addInvoices([{ orderId: it.id, shopId, ...file, ts: Date.now() }]));
  return { ok: true };
}

/** Wrap API calls so ApiError codes reach the UI. */
const apiCall = (fn) => fn().catch((e) => ({ ok: false, error: e.code || e.message }));

const apiActions = {
  accept: (shopId, token, code) =>
    apiCall(async () => {
      const it = await refreshApiOrder(shopId, token, code);
      if (!it) return { ok: false, error: 'orderNotVisible' };
      if (it.api.state === 'SIGN_REQUIRED') return { ok: false, error: 'signatureRequired' };
      if (it.api.status !== 'APPROVED_BY_BANK') return { ok: false, error: 'notAcceptable' };
      await K.acceptOrder(token, it.api);
      const after = await refreshApiOrder(shopId, token, code);
      return after?.api.status === 'ACCEPTED_BY_MERCHANT' ? { ok: true } : { ok: false, error: 'notAcceptable' };
    }),
  pack: (shopId, token, code) =>
    apiCall(async () => {
      const it = await refreshApiOrder(shopId, token, code);
      if (!it) return { ok: false, error: 'orderNotVisible' };
      if (it.api.status === 'APPROVED_BY_BANK') return { ok: false, error: 'acceptFirst' };
      if (it.api.status !== 'ACCEPTED_BY_MERCHANT') return { ok: false, error: 'packDisabled' };
      if (!it.api.isKaspiDelivery) return { ok: false, error: 'notKaspiDelivery' };
      if (!it.api.assembled) await K.assembleOrder(token, it.api, 1);
      const inv = await apiCollectWaybill(shopId, token, it, 6);
      return { ok: true, invoiceError: inv.ok ? undefined : inv.error };
    }),
  invoice: (shopId, token, code) =>
    apiCall(async () => {
      const it = await refreshApiOrder(shopId, token, code);
      if (!it) return { ok: false, error: 'orderNotVisible' };
      return apiCollectWaybill(shopId, token, it, 1);
    }),
};

/* ===================================================================== */
/* Bulk actions                                                           */
/* ===================================================================== */

/**
 * Run `perItem` for every item, sequentially inside a store (with a pause) and
 * in parallel across stores. Broadcasts progress.
 * @param {string} kind
 * @param {Array<{shopId:string, orderId:string}>} items
 * @param {(shopId:string, item:any)=>Promise<object>} perItem
 */
async function runJob(kind, items, perItem) {
  const jobId = uid('job');
  const total = items.length;
  const results = [];
  broadcast('bg:progress', { jobId, kind, done: 0, total });
  await Promise.all(
    Object.entries(groupBy(items, (i) => i.shopId)).map(async ([shopId, list]) => {
      for (let i = 0; i < list.length; i++) {
        let res;
        try {
          res = await perItem(shopId, list[i]);
        } catch (e) {
          res = { ok: false, error: e.message };
        }
        results.push({ shopId, orderId: list[i].orderId, ok: !!res?.ok, error: res?.error, info: res?.invoiceError });
        broadcast('bg:progress', { jobId, kind, done: results.length, total });
        if (i < list.length - 1) await sleep(S.timing.actionDelayMs);
      }
    }),
  );
  await updateBadge();
  broadcast('bg:stateChanged', await getState()); // statuses changed by the action show up at once
  return { jobId, results };
}

/** A URL taken from Kaspi's page, accepted only on the store's own https origin. */
function safeStoreUrl(url, origin) {
  try {
    const u = new URL(url);
    // localhost and file:// are the demo mode (their URL.origin is "null" for file:)
    if (u.protocol === 'file:') return origin === 'file://' ? u.href : null;
    const secure = u.protocol === 'https:' || u.hostname === 'localhost';
    return secure && u.origin === origin ? u.href : null;
  } catch {
    return null;
  }
}

async function storeInvoice(shopId, res) {
  if (res?.invoice) await lock(() => addInvoices([{ ...res.invoice, shopId }]));
}

const actions = {
  /** "Pack selected": click Упаковать in the store tab and capture the invoice. */
  /** "Accept selected" — API stores only (Kaspi: irreversible). */
  accept: async ({ items }) => {
    const tokens = await getApiTokens();
    return runJob('accept', items, (shopId, { orderId }) => (tokens[shopId] ? apiActions.accept(shopId, tokens[shopId], orderId) : { ok: false, error: 'notApiStore' }));
  },

  pack: async ({ items }) => {
    const tokens = await getApiTokens();
    return runJob('pack', items, async (shopId, { orderId }) => {
      if (tokens[shopId]) return apiActions.pack(shopId, tokens[shopId], orderId);
      const res = await runInStore(shopId, 'ksh:pack', { orderId }, { navigateTo: fillTemplate(S.urls.orderDetails, { orderId }), timeout: 45000 });
      await storeInvoice(shopId, res);
      return res;
    });
  },

  /** "Generate invoices": collect Kaspi's invoices for already packed orders. */
  fetchInvoices: async ({ items }) => {
    const tokens = await getApiTokens();
    return runJob('invoices', items, async (shopId, { orderId }) => {
      if (tokens[shopId]) return apiActions.invoice(shopId, tokens[shopId], orderId);
      const res = await runInStore(shopId, 'ksh:invoice', { orderId }, { navigateTo: fillTemplate(S.urls.orderDetails, { orderId }), timeout: 30000 });
      await storeInvoice(shopId, res);
      return res;
    });
  },

  /** "Print invoices": hand the selection to print.html. */
  // One print tab: repeated clicks reload it instead of opening a tab each (every tab renders
  // the whole queue at 300 dpi — 50 clicks used to mean 50 tabs and an out-of-memory browser).
  print: async ({ items }) => {
    if (printOpening) return { ok: true };
    printOpening = true;
    try {
      await setPrintQueue(items);
      const url = chrome.runtime.getURL('dashboard/print.html');
      const [tab] = (await chrome.tabs.query({ url })).filter((t) => t.url === url);
      if (tab) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        await chrome.tabs.reload(tab.id);
      } else await chrome.tabs.create({ url });
    } finally {
      setTimeout(() => (printOpening = false), 1500); // a burst of clicks opens one tab
    }
    return { ok: true };
  },

  /** "Process selected" for returns/refusals: open Kaspi's own flow for each. */
  process: async ({ items, kind }) => {
    const tpl = kind === 'refusal' ? S.urls.refusalDetails : S.urls.returnDetails;
    const results = [];
    for (const [shopId, list] of Object.entries(groupBy(items, (i) => i.shopId))) {
      const entry = await pickTab(shopId);
      const origin = entry?.origin || (await getSettings()).stores[shopId]?.origin;
      if (!origin) {
        list.forEach((i) => results.push({ ...i, ok: false, error: 'storeUnavailable' }));
        continue;
      }
      for (let i = 0; i < list.length; i++) {
        // Links scraped from the page are used only if they stay on the store's origin.
        const scraped = safeStoreUrl(list[i].url, origin);
        const url = scraped || new URL(fillTemplate(tpl, { orderId: list[i].orderId }), origin).href;
        if (i === 0 && entry) {
          await chrome.tabs.update(entry.tabId, { url, active: true });
          const tab = await chrome.tabs.get(entry.tabId);
          await chrome.windows.update(tab.windowId, { focused: true });
        } else {
          const opener = entry ? await chrome.tabs.get(entry.tabId).catch(() => null) : null;
          await chrome.tabs.create({ url, active: false, openerTabId: opener?.id, index: opener ? opener.index + i : undefined });
        }
        results.push({ ...list[i], ok: true });
      }
    }
    return { results };
  },

  /** "Refresh payment status": re-read statuses from the store tabs. */
  refreshPayments: async ({ items }) => {
    const results = [];
    const tokens = await getApiTokens();
    for (const [shopId, list] of Object.entries(groupBy(items, (i) => i.shopId))) {
      if (tokens[shopId]) {
        for (const { orderId } of list) {
          const r = await apiCall(async () => ((await refreshApiOrder(shopId, tokens[shopId], orderId)) ? { ok: true } : { ok: false, error: 'orderNotVisible' }));
          results.push({ shopId, orderId, ok: r.ok, error: r.error });
        }
        continue;
      }
      const res = await runInStore(shopId, 'ksh:payments', { orderIds: list.map((i) => i.orderId) }, { navigateTo: S.urls.ordersList });
      if (!res?.ok) {
        list.forEach((i) => results.push({ ...i, ok: false, error: res?.error }));
        continue;
      }
      await lock(async () => {
        await updateSnapshot(shopId, (cur) => {
          const items = cur?.sections?.orders?.items || [];
          for (const st of res.statuses) {
            const it = items.find((o) => o.id === String(st.id));
            if (it && st.paymentStatus) Object.assign(it, { paymentStatus: st.paymentStatus, paymentRaw: st.paymentRaw });
            results.push({ shopId, orderId: st.id, ok: !!st.paymentStatus, error: st.paymentStatus ? undefined : 'orderNotVisible' });
          }
        });
      });
    }
    broadcast('bg:stateChanged', await getState());
    return { results };
  },
};

/* ===================================================================== */
/* Chat                                                                   */
/* ===================================================================== */

/** Passive poll: read the conversation list from every store's tabs. Never navigates. */
async function pollChat() {
  const settings = await getSettings();
  const registry = Object.values(await getRegistry()).filter((e) => e.authenticated && e.shopId && settings.stores[e.shopId]?.enabled === true);
  const shops = [...new Set(registry.map((e) => e.shopId))];
  if (!shops.length) return;
  const responses = await Promise.all(
    shops.map(async (shopId) => {
      const entry = await pickTab(shopId, 'chat');
      return [shopId, await sendToTab(entry.tabId, 'ksh:chatList', {}, 10000).catch(() => null)];
    }),
  );
  let newUnread = 0;
  const newIn = [];
  await lock(async () => {
    const chat = await getChat();
    for (const [shopId, res] of responses) {
      if (res?.chat?.status !== 'ok') continue;
      const before = new Map((chat[shopId]?.conversations || []).map((c) => [c.id, c]));
      for (const c of res.chat.items) {
        const d = (c.unread || 0) - (before.get(c.id)?.unread || 0);
        if (chat[shopId] && d > 0) {
          newUnread += d;
          newIn.push(settings.stores[shopId]?.alias || settings.stores[shopId]?.name || shopId);
        }
      }
      chat[shopId] = { ...(chat[shopId] || {}), conversations: res.chat.items, ts: Date.now(), threads: chat[shopId]?.threads || {} };
    }
    await setChat(chat);
  });
  if (newUnread && settings.notifications.newMessages) {
    await initI18n();
    notify('chat', t('notifications.newMessagesTitle'), t('notifications.newMessages', { count: newUnread, store: [...new Set(newIn)].join(', ') }), 'chat');
  }
  await updateBadge();
  broadcast('bg:chatUpdated', await getChat());
}

/**
 * Load a conversation thread. `passive` (dashboard polling) never navigates the
 * store tab; an explicit click in the dashboard may navigate it once.
 */
async function chatThread({ shopId, conversationId, passive = false }) {
  const res = await runInStore(shopId, 'ksh:chatThread', { conversationId }, {
    prefer: 'chat',
    navigateTo: passive ? undefined : fillTemplate(S.urls.chatThread, { conversationId }),
  });
  if (res?.ok) {
    await lock(async () => {
      const chat = await getChat();
      const store = (chat[shopId] ??= { conversations: [], threads: {} });
      store.threads = { ...(store.threads || {}), [conversationId]: { messages: res.messages, ts: Date.now() } };
      const conv = store.conversations.find((c) => c.id === conversationId);
      if (conv) conv.unread = 0; // opening the thread in Kaspi marks it read there too
      await setChat(chat);
    });
    await updateBadge();
  }
  return res;
}

async function chatSend({ shopId, conversationId, text }) {
  const res = await runInStore(shopId, 'ksh:chatSend', { conversationId, text }, {
    prefer: 'chat',
    navigateTo: fillTemplate(S.urls.chatThread, { conversationId }),
  });
  if (res?.ok && res.messages) {
    await lock(async () => {
      const chat = await getChat();
      const store = (chat[shopId] ??= { conversations: [], threads: {} });
      store.threads = { ...(store.threads || {}), [conversationId]: { messages: res.messages, ts: Date.now() } };
      await setChat(chat);
    });
  }
  return res;
}

/** Open one pinned background tab on the chat page per store (explicit button in UI). */
async function openChatTabs() {
  const settings = await getSettings();
  const reg = Object.values(await getRegistry());
  let opened = 0;
  for (const store of Object.values(settings.stores)) {
    if (!store.enabled || !store.origin) continue;
    if (reg.some((e) => e.shopId === store.id && e.pageType === 'chat')) continue;
    await chrome.tabs.create({ url: new URL(S.urls.chat, store.origin).href, active: false, pinned: true });
    opened++;
  }
  return { ok: true, opened };
}

/* ===================================================================== */
/* Misc                                                                   */
/* ===================================================================== */

let dashboardOpening = null; // in-flight guard: a burst of calls (onInstalled + message) opens one tab
/** Focus the existing dashboard tab (and its window) or create one. `query` is e.g. 'welcome=1'. */
function openDashboard(route = 'orders', query = '', { keepPage = false } = {}) {
  if (dashboardOpening) return dashboardOpening;
  dashboardOpening = (async () => {
    // chrome-extension:// URLs are not valid match patterns, so filter manually.
    const tab = (await chrome.tabs.query({})).find((x) => x.url?.startsWith(DASHBOARD_URL));
    const url = `${DASHBOARD_URL}${query ? `?${query}` : ''}#${route || 'home'}`;
    if (tab) {
      // no route (or keepPage, e.g. on install) = just focus, keep the page the user is on
      await chrome.tabs.update(tab.id, route && !keepPage ? { active: true, url } : { active: true });
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    } else await chrome.tabs.create({ url });
  })().finally(() => { dashboardOpening = null; });
  return dashboardOpening;
}

async function openStore({ shopId }) {
  const entry = await pickTab(shopId);
  if (entry) {
    await chrome.tabs.update(entry.tabId, { active: true });
    const tab = await chrome.tabs.get(entry.tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    return { ok: true };
  }
  const origin = (await getSettings()).stores[shopId]?.origin;
  await chrome.tabs.create({ url: origin ? new URL(S.urls.home, origin).href : 'https://kaspi.kz/mc/' });
  return { ok: true, opened: true };
}

async function scheduleAlarms() {
  const { chatPollSec } = await getSettings();
  // chrome.alarms minimum period is 30 s.
  if (FEATURES.cabinet) await chrome.alarms.create(ALARM_CHAT, { periodInMinutes: Math.max(30, chatPollSec) / 60 });
  else await chrome.alarms.clear(ALARM_CHAT); // chat lives in the cabinet tab only
  await chrome.alarms.create(ALARM_SYNC, { periodInMinutes: 1 }); // ticks every minute; syncDue() decides
}

/**
 * Smart polling: during the working day (08:00–22:00 Almaty) every 2 minutes, at night every
 * 10 minutes. The requests go from the seller's own browser with their own token, so a trial
 * is polled like a paid account (the first orders must show up fast).
 */
export function syncInterval(now = Date.now()) {
  const h = kzParts(now).hours;
  return (h >= 8 && h < 22 ? 2 : 10) * 60000;
}
async function syncDue() {
  return Date.now() - ((await getLastSync()) || 0) >= syncInterval() - 15000; // alarms are not exact
}

/**
 * Circuit breaker: after 3 failed syncs in a row because Kaspi is down (server error, network,
 * rate limit, unexpected answer — not a wrong token), the store rests for 10 minutes; the last
 * data is shown with its time («Kaspi API временно недоступен, показываем данные от …»).
 */
const OUTAGE_CODES = new Set(['apiNetwork', 'apiHttp', 'apiRateLimit', 'apiFormat', 'apiTimeout']);
const BREAKER_FAILS = 3;
const BREAKER_PAUSE = 10 * 60000;
export const breakerOpen = (api, now = Date.now()) => !!api && (api.fails || 0) >= BREAKER_FAILS && now - (api.errorAt || 0) < BREAKER_PAUSE;

/* ===================================================================== */
/* Wiring                                                                 */
/* ===================================================================== */

/** UI → worker message handlers. */
const uiHandlers = {
  /** Errors of extension pages go to the same journal. */
  /** Funnel milestone from the dashboard (fire-and-forget, deduplicated in billing.js). */
  'ui:trackFunnel': async ({ event }) => {
    B.trackFunnel(String(event || ''));
    return { ok: true };
  },
  /** Anonymous UX counters from the dashboard (whitelisted codes only, fire-and-forget). */
  'ui:trackUx': async ({ events }) => {
    B.trackUxEvents(events);
    return { ok: true };
  },
  'ui:logError': async ({ where, message }) => {
    await logError(`page:${String(where || '').slice(0, 30)}`, String(message || ''));
    return { ok: true };
  },

  /** Text report for support: version, browser, counts and the last errors — no tokens, no buyers. */
  'ui:diagnostics': async () => {
    const [settings, tokens, errors] = await Promise.all([getSettings(), getApiTokens(), getErrorLog()]);
    const lic = await currentLicense().catch(() => null);
    const ua = navigator.userAgent.match(/(YaBrowser|Edg|OPR|Firefox|Chrome|Version)\/[\d.]+/g) || [];
    const os = /Windows/.test(navigator.userAgent) ? 'Windows' : /Android/.test(navigator.userAgent) ? 'Android' : /Mac OS|iPhone|iPad/.test(navigator.userAgent) ? 'Apple' : /Linux/.test(navigator.userAgent) ? 'Linux' : '?';
    const text = formatReport({
      version: chrome.runtime.getManifest().version,
      browser: `${ua.join(' ') || 'unknown'} · ${os}`,
      dataVersion: DATA_VERSION,
      stores: Object.keys(settings.stores || {}).length,
      apiStores: Object.keys(tokens || {}).length,
      licence: lic ? `${lic.status}${lic.daysLeft != null ? `, ${lic.daysLeft} дн.` : ''}` : 'unknown',
      errors,
    });
    return { ok: true, text, count: errors.length };
  },

  'ui:clearErrors': async () => {
    await clearErrorLog();
    return { ok: true };
  },

  'ui:getState': (p) => getState({ full: !!p?.full }),
  'ui:sync': () => sync(),
  'ui:pack': (p) => actions.pack(p),
  /** Cost price of a product (by SKU), shared by all stores. null removes it. */
  'ui:saveCost': async ({ sku, cost }) =>
    lock(async () => {
      if (typeof sku !== 'string' || !sku.trim()) return { ok: false, error: 'catalogInvalid' };
      const costs = await getCosts();
      if (cost == null || cost === '' || !Number.isFinite(Number(cost)) || Number(cost) < 0) delete costs[sku];
      else costs[sku] = Number(cost);
      await setCosts(costs);
      return { ok: true };
    }),
  'ui:accept': (p) => actions.accept(p),
  /** Connect a store by API token (verified against Kaspi first). */
  'ui:connectApi': async ({ shopId, name, token }) => {
    token = String(token || '').trim();
    if (!token) return { ok: false, error: 'tokenEmpty' };
    if (!shopId && !String(name || '').trim()) return { ok: false, error: 'storeNameEmpty' };
    try {
      await K.verifyToken(token);
    } catch (e) {
      return { ok: false, error: e.code || e.message };
    }
    const id = await lock(async () => {
      const settings = await getSettings();
      const sid = shopId && settings.stores[shopId] ? shopId : `api-${uid('s').slice(-8)}`;
      const existing = settings.stores[sid];
      const used = Object.values(settings.stores).map((s) => s.color);
      settings.stores[sid] = {
        ...existing,
        id: sid,
        name: existing?.name || String(name).trim(),
        alias: existing?.alias || '',
        color: existing?.color || nextStoreColor(used),
        enabled: existing?.enabled ?? true,
        origin: existing?.origin || 'https://kaspi.kz',
        addedAt: existing?.addedAt || Date.now(),
        lastSeen: existing?.lastSeen || Date.now(),
        api: { connected: true, last4: token.slice(-4), connectedAt: Date.now(), error: null },
      };
      await saveSettings({ stores: settings.stores });
      const tokens = await getApiTokens();
      tokens[sid] = token;
      await setApiTokens(tokens);
      return sid;
    });
    sync().catch((e) => console.warn(LOG, 'sync after connect', e)); // first load runs in the background
    return { ok: true, shopId: id };
  },
  'ui:disconnectApi': async ({ shopId }) => {
    await lock(async () => {
      const tokens = await getApiTokens();
      delete tokens[shopId];
      await setApiTokens(tokens);
      const settings = await getSettings();
      if (settings.stores[shopId]) {
        delete settings.stores[shopId].api;
        await saveSettings({ stores: settings.stores });
      }
    });
    return { ok: true };
  },
  'ui:fetchInvoices': (p) => actions.fetchInvoices(p),
  'ui:print': (p) => actions.print(p),
  'ui:process': (p) => actions.process(p),
  'ui:refreshPayments': (p) => actions.refreshPayments(p),
  'ui:chatList': async () => {
    await pollChat();
    return getChat();
  },
  'ui:chatThread': (p) => chatThread(p),
  'ui:chatSend': (p) => chatSend(p),
  'ui:openChatTabs': () => openChatTabs(),
  'ui:openStore': (p) => openStore(p),
  'ui:openDashboard': (p) => openDashboard(p?.route),
  /** Partial settings update (never the store list — see ui:updateStore). */
  'ui:saveSettings': async ({ patch }) => {
    const rest = { ...(patch || {}) };
    delete rest.stores;
    const next = await lock(() => saveSettings(rest));
    await scheduleAlarms();
    await updateBadge();
    return next;
  },
  /** Patch one store's alias / colour / enabled flag. */
  'ui:updateStore': async ({ shopId, patch }) => {
    const next = await lock(async () => {
      const settings = await getSettings();
      if (!settings.stores[shopId]) return settings;
      const { alias, color, enabled } = patch || {};
      Object.assign(settings.stores[shopId], Object.fromEntries(Object.entries({ alias, color, enabled }).filter(([, v]) => v !== undefined)));
      return saveSettings({ stores: settings.stores });
    });
    await updateBadge();
    return next;
  },
  /** Forget a store and its cached data (it comes back if its cabinet is opened again). */
  'ui:removeStore': async ({ shopId }) => {
    const next = await lock(async () => {
      const settings = await getSettings();
      delete settings.stores[shopId];
      const [chat, tokens] = await Promise.all([getChat(), getApiTokens()]);
      delete chat[shopId];
      delete tokens[shopId];
      await Promise.all([updateSnapshot(shopId, () => null), setChat(chat), setApiTokens(tokens), pruneInvoices({ dropShops: [shopId] })]);
      return saveSettings({ stores: settings.stores });
    });
    await updateBadge();
    broadcast('bg:stateChanged', await getState());
    return next;
  },
  'ui:settingsChanged': async () => {
    await scheduleAlarms();
    await updateBadge();
    return { ok: true };
  },
  'ui:clearCache': async () => {
    await lock(() => clearCache());
    await updateBadge();
    return { ok: true };
  },

  /* ---------- subscription ---------- */
  // force = re-read the licence now; reconcile = also re-issue invoices (default: only if something changed)
  'ui:billingState': ({ force, reconcile }) => billingMaintenance(!!force, reconcile ?? !!force),
  /** "Оплатить подключение": add-on (or renewal) invoice for all enabled stores. */
  'ui:billingAddon': (p) =>
    billingCall(async () => {
      lastReconcileAt = Date.now();
      // the upsell window asks for one store more than is connected (the store comes after payment)
      const total = Math.max(enabledStoreList(await getSettings()).length, Math.min(200, Number(p?.total) || 0));
      const lic = await B.requestAddon({ total });
      await notifyPayment(lic).catch(() => {});
      return { ok: true, license: lic };
    }),
  'ui:billingSetPhone': (p) => billingCall(async () => ({ ok: true, license: await B.setPhone(p) })),
  'ui:billingAcceptTerms': () =>
    billingCall(async () => {
      const lic = await B.acceptTerms();
      sync().catch((e) => console.warn(LOG, 'sync after consent', e));
      return { ok: true, license: lic };
    }),
  'ui:billingRequestCode': ({ email }) => billingCall(() => B.requestCode(email)),
  'ui:billingVerify': ({ email, code, consent }) =>
    billingCall(async () => {
      await B.verifyCode(email, code);
      // The box was ticked on the login screen before the code was requested.
      if (consent) await B.acceptTerms().catch((e) => console.warn(LOG, 'accept terms', e));
      const lic = await currentLicense(true);
      sync().catch((e) => console.warn(LOG, 'sync after login', e));
      return { ok: true, license: lic };
    }),
  'ui:billingReferral': () =>
    billingCall(async () => {
      const info = await B.referralInfo();
      const { pendingRefCode } = await chrome.storage.local.get('pendingRefCode');
      return { ok: true, referral: info, pending: pendingRefCode || '' };
    }),
  'ui:billingApplyReferral': ({ code }) =>
    billingCall(async () => {
      const r = await B.applyReferral(code);
      await chrome.storage.local.remove('pendingRefCode').catch(() => {});
      return { ok: true, result: r };
    }),
  'ui:billingCreateInvoice': (p) => billingCall(async () => ({ ok: true, license: await B.createInvoice(p) })),
  'ui:billingCancelInvoice': (p) => billingCall(async () => ({ ok: true, license: await B.cancelInvoice(p) })),
  'ui:billingLogout': async () => {
    await B.logout();
    const state = await getState();
    broadcast('bg:stateChanged', state);
    return { ok: true };
  },
};

/** Run a billing call and turn its error into { ok:false, error:<code> }. */
const billingCall = (fn) => fn().catch((e) => ({ ok: false, error: e.code || e.message }));

/** Actions that need an active subscription (trial or paid). */
/** Everything that changes something in Kaspi (or the price list Kaspi reads). */
const WRITES = new Set(['ui:pack', 'ui:accept', 'ui:process', 'ui:chatSend', 'ui:catalogPublish', 'ui:feedSync', 'ui:feedSettings']);
globalThis.KSH_READONLY = false;
const refreshReadOnly = async () => (globalThis.KSH_READONLY = !!(await getSettings()).readOnly);
refreshReadOnly();

const NEEDS_LICENSE = new Set([
  'ui:pack', 'ui:accept', 'ui:fetchInvoices', 'ui:print', 'ui:process', 'ui:refreshPayments',
  'ui:chatList', 'ui:chatThread', 'ui:chatSend', 'ui:openChatTabs', 'ui:connectApi',
  'ui:catalogPublish', 'ui:catalogImport', 'ui:feedSettings', 'ui:feedSync',
  'ui:contentCategories', 'ui:contentAttributes', 'ui:contentValues',
]);

// Product upload ("Выгрузка товаров"): catalog, Kaspi cards, price lists per store.
Object.assign(
  uiHandlers,
  catalogHandlers({ allowedShopIds: async (settings) => allowedStoreIds(settings, await currentLicense()) }),
  staffHandlers(),
  packingHandlers(),
  supportHandlers({ diagnostics: () => uiHandlers['ui:diagnostics']() }),
  usageHandlers(),
  growthHandlers({ license: (force) => billingMaintenance(!!force, false) }),
);
startHealth();

/**
 * Subscription gate for UI actions: no licence → refused; items from stores
 * above the plan's store limit → refused.
 * @returns {Promise<object|null>} an error response, or null when allowed
 */
async function licenseGate(type, payload) {
  if (WRITES.has(type) && (await refreshReadOnly())) return { ok: false, error: 'readOnly' };
  if (!NEEDS_LICENSE.has(type)) return null;
  const lic = await currentLicense();
  if (!lic.canUse) return { ok: false, error: 'subscriptionRequired' };
  const shops = [...(payload?.items || []).map((i) => i.shopId), payload?.shopId, ...(payload?.shopIds || [])].filter(Boolean);
  if (shops.length && type !== 'ui:connectApi') {
    const allowed = new Set(allowedStoreIds(await getSettings(), lic));
    if (shops.some((id) => !allowed.has(id))) return { ok: false, error: lic.sharedStores ? 'storeShared' : 'storeOverLimit' };
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg?.type) return false;
  const fromExtensionPage = sender.url?.startsWith(chrome.runtime.getURL(''));

  // API-only build: a cabinet page never registers a store (no content scripts ship, but an
  // older install or a manual injection must not create stores either)
  if (msg.type.startsWith('content:') && !FEATURES.cabinet) return false;
  if (msg.type.startsWith('content:') && sender.tab?.id != null && !fromExtensionPage) {
    const tabId = sender.tab.id;
    if (msg.type === 'content:hello') registerTab(tabId, msg.payload).then(() => broadcast('bg:registryChanged'));
    if (msg.type === 'content:update') registerTab(tabId, msg.payload).then(() => onContentUpdate(msg.payload));
    return false;
  }

  const fn = fromExtensionPage && uiHandlers[msg.type];
  if (!fn) return false;
  dataReady
    // «Компьютер склада»: packers get packing only, nobody else gets anything until signed in
    .then(async () => (await staffGate(msg.type, msg.payload)) || (await licenseGate(msg.type, msg.payload)) || fn(msg.payload || {}))
    .then((res) => {
      if (res?.ok === false && SYSTEM_ERROR.test(String(res.error || ''))) logError(`worker:${msg.type}`, { code: res.error, status: res.status, message: '' });
      if (ACTION_OF[msg.type] && res && res.ok !== false && res.error == null) noteAction(ACTION_OF[msg.type]); // control panel: counts only
      sendResponse(res);
    })
    .catch((e) => {
      console.error(LOG, msg.type, e);
      logError(`worker:${msg.type}`, e);
      sendResponse({ ok: false, error: scrub(e.message) || 'workerError' });
    });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => unregisterTab(tabId));
/** Chrome match pattern → RegExp (a leading "*." also matches the bare domain; current patterns are exact hosts). */
const patternToRegExp = (p) => {
  const [, scheme, host, path] = p.match(/^(\w+):\/\/([^/]*)(\/.*)$/); // host is empty for file:///
  const esc = (x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const hostRe = host.startsWith('*.') ? `([^/]+\\.)?${esc(host.slice(2))}` : esc(host);
  return new RegExp(`^${esc(scheme)}://${hostRe}(:\\d+)?${esc(path).replace(/\*/g, '.*')}$`);
};
const TAB_PATTERNS = S.tabMatchPatterns.map(patternToRegExp);

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url && !TAB_PATTERNS.some((re) => re.test(change.url))) unregisterTab(tabId);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await dataReady;
  if (alarm.name === ALARM_CHAT && (await currentLicense().catch(() => ({}))).canUse) pollChat().catch((e) => report('chat poll', e));
  if (alarm.name === ALARM_SYNC && (await syncDue())) sync().catch((e) => { report('sync', e); B.reportClientError(`sync_${e?.code || 'error'}`, 'alarm'); });
  if (alarm.name === ALARM_IMPORTS) pollImports().catch((e) => report('card imports', e));
  if (alarm.name === ALARM_STAFF) checkStaff().catch((e) => report('staff check', e));
  if (alarm.name === ALARM_HEALTH) {
    flushHealth().catch(() => {}); // counts only; a failed send is retried next time
    flushUsage().catch(() => {});
    reportDigest().catch(() => {});
    pollTickets().catch(() => {});
  }
});

chrome.notifications?.onClicked.addListener((id) => {
  const route = id.split(':')[1] || 'orders';
  openDashboard(route);
  chrome.notifications.clear(id);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[KEYS.settings]) {
    globalThis.KSH_READONLY = !!changes[KEYS.settings].newValue?.readOnly;
    const a = changes[KEYS.settings].oldValue?.chatPollSec;
    const b = changes[KEYS.settings].newValue?.chatPollSec;
    if (a !== b) scheduleAlarms();
  }
});

/**
 * Every time the worker wakes: make sure the periodic jobs exist (Chrome may drop alarms after an
 * update, a crash or a long sleep). Existing alarms are left alone, so their timing is not reset.
 */
async function ensureAlarms() {
  const have = new Set((await chrome.alarms.getAll()).map((a) => a.name));
  if (!have.has(ALARM_SYNC)) await scheduleAlarms();
  if (!have.has(ALARM_HEALTH)) await scheduleHealth();
  if (!have.has(ALARM_STAFF)) await scheduleStaffCheck();
}
ensureAlarms().catch(() => {});

/* The landing (saudapulse.kz) may ask an installed extension to open its dashboard. Nothing else is
   accepted and nothing is returned except {ok} / the version. */
function isSaudaPulseOrigin(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && (u.hostname === 'saudapulse.kz' || u.hostname.endsWith('.saudapulse.kz'));
  } catch { return false; }
}
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (!isSaudaPulseOrigin(sender?.origin || sender?.url)) { sendResponse({ ok: false }); return false; }
  if (msg?.type === 'PING') { sendResponse({ ok: true, version: chrome.runtime.getManifest().version }); return false; }
  if (msg?.type === 'OPEN_DASHBOARD') {
    const ref = typeof msg.ref === 'string' ? msg.ref.trim().toUpperCase() : '';
    if (/^SP-[A-Z0-9]{6}$/.test(ref)) chrome.storage.local.set({ pendingRefCode: ref }).catch(() => {});
    openDashboard('').then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true; // async response
  }
  sendResponse({ ok: false });
  return false;
});

/* Toolbar click: no default_popup is set in the manifest, so the click opens the dashboard.
   Focuses the existing dashboard tab instead of opening a duplicate. */
chrome.action?.onClicked?.addListener(() => { openDashboard('').catch(() => {}); });

chrome.runtime.onInstalled.addListener((details) => {
  if (details?.reason === 'install') openDashboard('home', 'welcome=1', { keepPage: true }).catch(() => {});
  // Order contents now live only in the snapshots: drop the old duplicate cache (one-off, idempotent).
  chrome.storage.local.remove('ksh.apiEntries').catch(() => {});
  scheduleAlarms();
  scheduleHealth();
  discoverTabs().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  scheduleAlarms();
  scheduleStaffCheck().catch(() => {});
  scheduleHealth();
  discoverTabs().catch(() => {});
});
