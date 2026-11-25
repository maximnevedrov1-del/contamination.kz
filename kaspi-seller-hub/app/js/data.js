/**
 * SaudaPulse phone app — data on the phone (all of it in the encrypted area, see boot.js).
 *
 * Owner: the extension's own storage.js (settings, stores, Kaspi tokens, cost prices, order
 * snapshots) and the extension's own sync (shared/api-sync.js) over the relay.
 * Packer: a separate, smaller set of keys. Orders are stripped of every money field BEFORE they
 * are stored or shown (toStaffOrder), cost prices and profit settings never reach the phone.
 */
import * as K from '../../background/kaspi-api.js';
import * as S from '../../shared/storage.js';
import { apiSnapshot } from '../../shared/api-sync.js';
import { apiTokenHash, apiStoreIdFromHash, findApiStore, storeKey } from '../../shared/store-key.js';
import { nextStoreColor, orderProfit, dayKey, deadlineOf, urgencyOf } from '../../shared/utils.js';

const local = () => chrome.storage.local;
const get = async (k, def = null) => (await local().get(k))[k] ?? def;
const set = (k, v) => local().set({ [k]: v });

export const APP_KEYS = Object.freeze({
  role: 'pwa.role', // 'owner' | 'staff'
  staff: 'pwa.staff', // { ownerId, member, stores:{id:{name,color}}, lastOkAt }
  staffOrders: 'pwa.staffOrders', // { [shopId]: StaffOrder[] } — no money fields
  staffLog: 'pwa.staffLog', // packing journal on this phone
  lastSync: 'pwa.lastSync',
});

export const getRole = () => get(APP_KEYS.role);
export const setRole = (r) => set(APP_KEYS.role, r === 'staff' ? 'staff' : 'owner');

/* ======================= owner ======================= */

export async function ownerStores() {
  const st = await S.getSettings();
  return Object.values(st.stores || {}).filter((s) => s.api?.connected).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
}

/** Store keys for the licence (same double SHA-256 as the extension: shared/store-key.js). */
export const ownerStoreKeys = async () => (await Promise.all((await ownerStores()).map(storeKey))).filter(Boolean);

/** Connect a store by its Kaspi token — the extension's 'ui:connectApi', same ids and hashes. */
export async function connectStore({ name, token }) {
  token = String(token || '').trim();
  if (!token) throw Object.assign(new Error('tokenEmpty'), { code: 'tokenEmpty' });
  await K.verifyToken(token); // through the relay; throws ApiError (apiUnauthorized…)
  return saveStore({ name, token, color: null });
}

async function saveStore({ name, token, color, alias = '' }) {
  const tokenHash = await apiTokenHash(token);
  const settings = await S.getSettings();
  const known = findApiStore(settings.stores, tokenHash);
  const sid = known?.id || apiStoreIdFromHash(tokenHash);
  const existing = settings.stores[sid];
  settings.stores[sid] = {
    ...existing,
    id: sid,
    name: existing?.name || String(name || '').trim() || 'Магазин',
    alias: existing?.alias || alias,
    color: existing?.color || color || nextStoreColor(Object.values(settings.stores).map((s) => s.color)),
    enabled: existing?.enabled ?? true,
    origin: 'https://kaspi.kz',
    addedAt: existing?.addedAt || Date.now(),
    lastSeen: existing?.lastSeen || Date.now(),
    api: { connected: true, last4: token.slice(-4), connectedAt: Date.now(), error: null, tokenHash },
  };
  await S.saveSettings({ stores: settings.stores });
  const tokens = await S.getApiTokens();
  tokens[sid] = token;
  await S.setApiTokens(tokens);
  return sid;
}

export async function removeStore(shopId) {
  const tokens = await S.getApiTokens();
  delete tokens[shopId];
  await S.setApiTokens(tokens);
  const settings = await S.getSettings();
  delete settings.stores[shopId];
  await S.saveSettings({ stores: settings.stores });
  await S.updateSnapshot(shopId, () => null);
}

/** Owner .spbackup → stores, tokens, cost prices, profit and deadline settings on this phone. */
export async function importOwnerBackup(payload) {
  let stores = 0;
  for (const [id, st] of Object.entries(payload.stores || {})) {
    const token = payload.tokens?.[id];
    if (!token) continue;
    await saveStore({ name: st.name, token, color: st.color, alias: st.alias });
    stores++;
  }
  const costs = { ...(await S.getCosts()), ...(payload.costs || {}) };
  await S.setCosts(costs);
  const patch = {};
  const cur = (await S.getSettings()).profit;
  // the file wins per category; an empty commission in the file never erases one set on the phone
  if (payload.profit) patch.profit = { ...cur, defaultCommission: payload.profit.defaultCommission ?? cur.defaultCommission, byCategory: { ...cur.byCategory, ...payload.profit.byCategory } };
  if (payload.deadlines) patch.deadlines = payload.deadlines;
  if (Object.keys(patch).length) await S.saveSettings(patch);
  return { stores, costs: Object.keys(payload.costs || {}).length };
}

/** What goes into a .spbackup made on this phone (owner → own phone/computer, or for a packer). */
export async function backupPayload(scope, { shopIds = null, ownerId = null } = {}) {
  const settings = await S.getSettings();
  const tokens = await S.getApiTokens();
  const pick = (await ownerStores()).filter((s) => tokens[s.id] && (!shopIds || shopIds.includes(s.id)));
  const payload = {
    stores: Object.fromEntries(pick.map((s) => [s.id, { name: s.name, alias: s.alias || '', color: s.color }])),
    tokens: Object.fromEntries(pick.map((s) => [s.id, tokens[s.id]])),
  };
  if (scope === 'staff') return { ...payload, ownerId };
  return { ...payload, costs: await S.getCosts(), profit: settings.profit, deadlines: settings.deadlines };
}

/** Re-read orders of every allowed store from Kaspi (the extension's own apiSnapshot). */
export async function syncOwner(allowedIds) {
  const tokens = await S.getApiTokens();
  const stores = (await ownerStores()).filter((s) => !allowedIds || allowedIds.includes(s.id));
  const errors = {};
  for (const store of stores) {
    const token = tokens[store.id];
    if (!token) continue;
    try {
      const prev = await S.getSnapshot(store.id);
      const snap = await apiSnapshot(K, store.id, token, prev, store);
      await S.updateSnapshot(store.id, () => ({ ...snap, ts: Date.now(), status: 'ok' }));
    } catch (e) {
      errors[store.id] = e.code || 'apiNetwork';
    }
  }
  await set(APP_KEYS.lastSync, Date.now());
  return { errors };
}

/** Owner home numbers: today, last 7 days, per store; profit where cost prices are known. */
export async function ownerSummary(allowedIds) {
  const [snaps, costs, settings, stores] = await Promise.all([S.getSnapshots(), S.getCosts(), S.getSettings(), ownerStores()]);
  const today = dayKey(Date.now());
  const weekFrom = Date.now() - 7 * 86400000;
  const tot = { todayRevenue: 0, todayOrders: 0, todayProfit: 0, todayProfitComplete: true, todayWithProfit: 0, weekRevenue: 0, weekOrders: 0, newOrders: 0, toPack: 0, returns: 0 };
  const perStore = [];
  const orders = [];
  for (const st of stores.filter((s) => !allowedIds || allowedIds.includes(s.id))) {
    const items = snaps[st.id]?.sections?.orders?.items || [];
    const row = { id: st.id, name: st.alias || st.name, color: st.color, todayRevenue: 0, todayOrders: 0, newOrders: 0, ts: snaps[st.id]?.ts || null };
    for (const it of items) {
      orders.push({ ...it, shopId: st.id, shopName: row.name, shopColor: st.color });
      const live = it.kind === 'order' && !['cancelled', 'returned'].includes(it.status);
      if (it.status === 'new') (row.newOrders++, tot.newOrders++);
      if (it.status === 'accepted') tot.toPack++;
      if (it.kind === 'return') tot.returns++;
      if (!live || !it.date) continue;
      const amt = Number(it.amount) || 0;
      if (dayKey(it.date) === today) {
        row.todayRevenue += amt;
        row.todayOrders++;
        tot.todayRevenue += amt;
        tot.todayOrders++;
        // margin only from orders whose cost price and commission are all known — never guessed
        const p = orderProfit(it, costs, settings.profit);
        if (p?.complete) {
          tot.todayProfit += p.profit;
          tot.todayWithProfit += p.revenue;
        } else tot.todayProfitComplete = false;
      }
      if (new Date(it.date).getTime() >= weekFrom) (tot.weekRevenue += amt), tot.weekOrders++;
    }
    perStore.push(row);
  }
  tot.todayMargin = tot.todayWithProfit ? tot.todayProfit / tot.todayWithProfit : null;
  orders.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return { tot, perStore, orders, settings, costs, lastSync: await get(APP_KEYS.lastSync, 0) };
}

/* ======================= packer ======================= */

/**
 * The only shape of an order a packer's phone ever stores or shows: number, store, status,
 * delivery dates and the product lines (name, SKU, quantity). No amount, price, total,
 * payment mode, delivery cost, commission or buyer data.
 */
export function toStaffOrder(it, shopId) {
  return {
    id: String(it.id),
    shopId,
    kind: it.kind,
    date: it.date || null,
    status: it.status,
    api: it.api
      ? {
          id: it.api.id,
          code: it.api.code,
          state: it.api.state,
          status: it.api.status,
          isKaspiDelivery: !!it.api.isKaspiDelivery,
          assembled: !!it.api.assembled,
          courierPlanDate: it.api.courierPlanDate || null,
          plannedDeliveryDate: it.api.plannedDeliveryDate || null,
          entriesUrl: it.api.entriesUrl || null,
        }
      : null,
    entries: Array.isArray(it.entries) ? it.entries.map((e) => ({ name: String(e.name || ''), sku: String(e.sku || ''), quantity: Number(e.quantity) || 1 })) : null,
  };
}

export const getStaff = () => get(APP_KEYS.staff);
export const setStaff = (v) => set(APP_KEYS.staff, v);

/** Packer .spbackup → the stores' tokens only (storage.js keeps them double-encrypted). */
export async function importStaffBackup(payload) {
  const stores = {};
  for (const [id, st] of Object.entries(payload.stores || {})) {
    if (!payload.tokens?.[id]) continue;
    stores[id] = { name: st.alias || st.name, color: st.color };
  }
  await S.setApiTokens(Object.fromEntries(Object.keys(stores).map((id) => [id, payload.tokens[id]])));
  await setStaff({ ownerId: payload.ownerId, stores, member: null, lastOkAt: 0 });
  return { stores: Object.keys(stores).length };
}

const ACTIVE_STATES = new Set(['new', 'accepted', 'packed']);
const STAFF_DAYS = 14;

/** Packer sync: active orders of the allowed stores, their product lines, stripped of money. */
export async function syncStaff(allowedIds) {
  const tokens = await S.getApiTokens();
  const prev = await get(APP_KEYS.staffOrders, {});
  const out = {};
  const errors = {};
  for (const [shopId, token] of Object.entries(tokens)) {
    if (allowedIds && !allowedIds.includes(shopId)) continue;
    try {
      const raw = await K.listOrders(token, STAFF_DAYS);
      const known = new Map((prev[shopId] || []).map((o) => [o.id, o.entries]));
      const list = [];
      for (const o of raw) {
        const it = K.toOrderItem(o);
        if (it.kind !== 'order' || !ACTIVE_STATES.has(it.status)) continue;
        let entries = known.get(it.id) || null;
        if (!entries && it.api?.entriesUrl) entries = await K.getEntries(token, o).catch(() => null);
        list.push(toStaffOrder({ ...it, entries }, shopId)); // money fields dropped here, before storage
      }
      out[shopId] = list.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    } catch (e) {
      errors[shopId] = e.code || 'apiNetwork';
      if (prev[shopId]) out[shopId] = prev[shopId];
    }
  }
  await set(APP_KEYS.staffOrders, out);
  await set(APP_KEYS.lastSync, Date.now());
  return { errors };
}

export async function staffQueue(allowedIds, settings) {
  const all = await get(APP_KEYS.staffOrders, {});
  const staff = await getStaff();
  const list = [];
  for (const [shopId, orders] of Object.entries(all)) {
    if (allowedIds && !allowedIds.includes(shopId)) continue;
    for (const o of orders) {
      const dl = deadlineOf(o, settings);
      list.push({ ...o, shopName: staff?.stores?.[shopId]?.name || shopId, shopColor: staff?.stores?.[shopId]?.color || '#2a78d6', urgency: urgencyOf(dl, settings), deadline: dl });
    }
  }
  const rank = { overdue: 0, soon: 1, ok: 2 };
  return list.sort((a, b) => (rank[a.urgency] ?? 3) - (rank[b.urgency] ?? 3) || (a.date || '').localeCompare(b.date || ''));
}

/** Packer marks an order: Kaspi «Собран» (Kaspi Delivery) or «Принят», plus a line in the phone's journal. */
export async function staffAction(action, order, { seconds, checked } = {}) {
  const token = (await S.getApiTokens())[order.shopId];
  if (!token) throw Object.assign(new Error('storeNotAllowed'), { code: 'storeNotAllowed' });
  if (action === 'accept') await K.acceptOrder(token, { id: order.api.id, code: order.api.code });
  else if (action === 'pack' && order.api?.isKaspiDelivery) await K.assembleOrder(token, { id: order.api.id }, 1);
  const raw = await K.getOrderByCode(token, order.api.code).catch(() => null);
  const all = await get(APP_KEYS.staffOrders, {});
  const list = all[order.shopId] || [];
  const i = list.findIndex((o) => o.id === order.id);
  if (raw && i >= 0) {
    const fresh = toStaffOrder({ ...K.toOrderItem(raw), entries: list[i].entries }, order.shopId);
    list[i] = fresh;
  }
  if (action === 'pack' && i >= 0 && !order.api?.isKaspiDelivery) list[i] = { ...list[i], localPacked: true }; // own delivery: Kaspi has no «assembled» step
  all[order.shopId] = list;
  await set(APP_KEYS.staffOrders, all);
  const log = await get(APP_KEYS.staffLog, []);
  log.push({ at: Date.now(), action, shopId: order.shopId, orderId: order.id, seconds: Number.isFinite(seconds) ? Math.round(seconds) : undefined, checked });
  await set(APP_KEYS.staffLog, log.slice(-1000));
  return list[i] || null;
}

/** Find by order number (local first, then Kaspi). */
export async function staffFind(code, allowedIds) {
  code = String(code || '').trim();
  if (!/^[0-9A-Za-z\-]{3,40}$/.test(code)) return null;
  const all = await get(APP_KEYS.staffOrders, {});
  for (const [shopId, list] of Object.entries(all)) {
    if (allowedIds && !allowedIds.includes(shopId)) continue;
    const hit = list.find((o) => o.id === code || o.api?.code === code);
    if (hit) return hit;
  }
  const tokens = await S.getApiTokens();
  for (const [shopId, token] of Object.entries(tokens)) {
    if (allowedIds && !allowedIds.includes(shopId)) continue;
    const raw = await K.getOrderByCode(token, code).catch(() => null);
    if (raw) {
      const entries = await K.getEntries(token, raw).catch(() => null);
      return toStaffOrder({ ...K.toOrderItem(raw), entries }, shopId);
    }
  }
  return null;
}

/** «Стереть всё с телефона»: every record and the encryption key itself. */
export async function wipePhone() {
  await chrome.storage.local.destroy?.();
  await chrome.storage.session.clear();
  try {
    indexedDB.deleteDatabase('ksh-secrets'); // token-crypto's key
  } catch { /* ignore */ }
}
