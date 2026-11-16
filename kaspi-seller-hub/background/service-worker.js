/**
 * Kaspi Seller Hub — background service worker (MV3, ES module).
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
  setLastSync,
  getLastSync,
  getRegistry,
  setRegistry,
  setPrintQueue,
  clearCache,
  KEYS,
} from '../shared/storage.js';
import { initI18n, t } from '../shared/i18n.js';
import { sleep, withTimeout, createMutex, fillTemplate, nextStoreColor, groupBy, uid, storeCounts, sumCounts } from '../shared/utils.js';

const S = globalThis.KSH_SELECTORS;
const LOG = '[KSH/sw]';
const lock = createMutex();
const ALARM_CHAT = 'ksh-chat-poll';
const ALARM_SYNC = 'ksh-sync';
const DASHBOARD_URL = chrome.runtime.getURL('dashboard/dashboard.html');

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
    id: shopId,
    name: shopName || existing?.name || shopId,
    alias: existing?.alias || '',
    color: existing?.color || nextStoreColor(used),
    enabled: existing?.enabled ?? true,
    origin,
    lastSeen: Date.now(),
  };
  await saveSettings({ stores: settings.stores });
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
  const tabs = await chrome.tabs.query({ url: [...S.tabMatchPatterns] });
  const live = [];
  await Promise.all(
    tabs
      .filter((tab) => !tab.discarded && tab.id != null && /^https:/.test(tab.url || tab.pendingUrl || ''))
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
        sections[key] = { status: 'ok', source: ok[0].source, ts: Date.now(), items: [...map.values()] };
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
async function sync() {
  const entries = await discoverTabs();
  const results = await Promise.all(
    entries.map((e) => sendToTab(e.tabId, 'ksh:snapshot', {}, 20000).catch((err) => ({ ok: false, error: err.message, tabId: e.tabId }))),
  );

  const byShop = {};
  results.forEach((r) => {
    if (r?.ok && r.authenticated && r.shopId) (byShop[r.shopId] ??= []).push(r);
  });

  await lock(async () => {
    const [settings, prev] = await Promise.all([getSettings(), getSnapshots()]);
    const next = {};
    const shopIds = new Set([...Object.keys(settings.stores), ...Object.keys(byShop)]);
    for (const shopId of shopIds) {
      if (byShop[shopId]) next[shopId] = mergeStoreSnapshot(prev[shopId], byShop[shopId]);
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
  const state = await getState();
  broadcast('bg:stateChanged', state);
  return state;
}

/** A content script pushed a fresh snapshot by itself (the seller is browsing). */
async function onContentUpdate(snap) {
  if (!snap?.authenticated || !snap.shopId) return;
  await lock(async () => {
    const all = await getSnapshots();
    all[snap.shopId] = mergeStoreSnapshot(all[snap.shopId], [snap]);
    await setSnapshots(all);
  });
  await updateBadge();
  broadcast('bg:stateChanged', await getState());
}

/** State consumed by popup and dashboard. */
async function getState() {
  const [settings, snapshots, lastSync, registry] = await Promise.all([getSettings(), getSnapshots(), getLastSync(), getRegistry()]);
  const tabs = Object.values(registry);
  return { settings, snapshots, lastSync, tabs, unauthTabs: tabs.filter((e) => !e.authenticated && e.isCabinet).length };
}

/* ===================================================================== */
/* Notifications & badge                                                  */
/* ===================================================================== */

async function notify(id, title, message, route) {
  await initI18n();
  chrome.notifications.create(`ksh:${route}:${id}`, {
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

async function updateBadge() {
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
  return { jobId, results };
}

/** A URL taken from Kaspi's page, accepted only on the store's own https origin. */
function safeStoreUrl(url, origin) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.origin === origin ? u.href : null;
  } catch {
    return null;
  }
}

async function storeInvoice(shopId, res) {
  if (res?.invoice) await lock(() => addInvoices([{ ...res.invoice, shopId }]));
}

const actions = {
  /** "Pack selected": click Упаковать in the store tab and capture the invoice. */
  pack: ({ items }) =>
    runJob('pack', items, async (shopId, { orderId }) => {
      const res = await runInStore(shopId, 'ksh:pack', { orderId }, { navigateTo: fillTemplate(S.urls.orderDetails, { orderId }), timeout: 45000 });
      await storeInvoice(shopId, res);
      return res;
    }),

  /** "Generate invoices": collect Kaspi's invoices for already packed orders. */
  fetchInvoices: ({ items }) =>
    runJob('invoices', items, async (shopId, { orderId }) => {
      const res = await runInStore(shopId, 'ksh:invoice', { orderId }, { navigateTo: fillTemplate(S.urls.orderDetails, { orderId }), timeout: 30000 });
      await storeInvoice(shopId, res);
      return res;
    }),

  /** "Print invoices": hand the selection to print.html. */
  print: async ({ items }) => {
    await setPrintQueue(items);
    await chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/print.html') });
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
    for (const [shopId, list] of Object.entries(groupBy(items, (i) => i.shopId))) {
      const res = await runInStore(shopId, 'ksh:payments', { orderIds: list.map((i) => i.orderId) }, { navigateTo: S.urls.ordersList });
      if (!res?.ok) {
        list.forEach((i) => results.push({ ...i, ok: false, error: res?.error }));
        continue;
      }
      await lock(async () => {
        const all = await getSnapshots();
        const items = all[shopId]?.sections?.orders?.items || [];
        for (const st of res.statuses) {
          const it = items.find((o) => o.id === String(st.id));
          if (it && st.paymentStatus) Object.assign(it, { paymentStatus: st.paymentStatus, paymentRaw: st.paymentRaw });
          results.push({ shopId, orderId: st.id, ok: !!st.paymentStatus, error: st.paymentStatus ? undefined : 'orderNotVisible' });
        }
        await setSnapshots(all);
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

async function openDashboard(route = 'orders') {
  // chrome-extension:// URLs are not valid match patterns, so filter manually.
  const tab = (await chrome.tabs.query({})).find((x) => x.url?.startsWith(DASHBOARD_URL));
  const url = `${DASHBOARD_URL}#${route}`;
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true, url });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else await chrome.tabs.create({ url });
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
  await chrome.alarms.create(ALARM_CHAT, { periodInMinutes: Math.max(30, chatPollSec) / 60 });
  await chrome.alarms.create(ALARM_SYNC, { periodInMinutes: 5 });
}

/* ===================================================================== */
/* Wiring                                                                 */
/* ===================================================================== */

/** UI → worker message handlers. */
const uiHandlers = {
  'ui:getState': () => getState(),
  'ui:sync': () => sync(),
  'ui:pack': (p) => actions.pack(p),
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
      const [snaps, chat] = await Promise.all([getSnapshots(), getChat()]);
      delete snaps[shopId];
      delete chat[shopId];
      await Promise.all([setSnapshots(snaps), setChat(chat)]);
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
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg?.type) return false;
  const fromExtensionPage = sender.url?.startsWith(chrome.runtime.getURL(''));

  if (msg.type.startsWith('content:') && sender.tab?.id != null && !fromExtensionPage) {
    const tabId = sender.tab.id;
    if (msg.type === 'content:hello') registerTab(tabId, msg.payload).then(() => broadcast('bg:registryChanged'));
    if (msg.type === 'content:update') registerTab(tabId, msg.payload).then(() => onContentUpdate(msg.payload));
    return false;
  }

  const fn = fromExtensionPage && uiHandlers[msg.type];
  if (!fn) return false;
  Promise.resolve()
    .then(() => fn(msg.payload || {}))
    .then(sendResponse)
    .catch((e) => {
      console.error(LOG, msg.type, e);
      sendResponse({ ok: false, error: e.message || 'workerError' });
    });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => unregisterTab(tabId));
/** Chrome match pattern → RegExp ("https://*.kaspi.kz/*" also matches kaspi.kz itself). */
const patternToRegExp = (p) => {
  const [, scheme, host, path] = p.match(/^(\w+):\/\/([^/]+)(\/.*)$/);
  const esc = (x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const hostRe = host.startsWith('*.') ? `([^/]+\\.)?${esc(host.slice(2))}` : esc(host);
  return new RegExp(`^${esc(scheme)}://${hostRe}${esc(path).replace(/\*/g, '.*')}$`);
};
const TAB_PATTERNS = S.tabMatchPatterns.map(patternToRegExp);

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url && !TAB_PATTERNS.some((re) => re.test(change.url))) unregisterTab(tabId);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_CHAT) pollChat().catch((e) => console.warn(LOG, 'chat poll', e));
  if (alarm.name === ALARM_SYNC) sync().catch((e) => console.warn(LOG, 'sync', e));
});

chrome.notifications.onClicked.addListener((id) => {
  const route = id.split(':')[1] || 'orders';
  openDashboard(route);
  chrome.notifications.clear(id);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[KEYS.settings]) {
    const a = changes[KEYS.settings].oldValue?.chatPollSec;
    const b = changes[KEYS.settings].newValue?.chatPollSec;
    if (a !== b) scheduleAlarms();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  scheduleAlarms();
  discoverTabs().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  scheduleAlarms();
  discoverTabs().catch(() => {});
});
