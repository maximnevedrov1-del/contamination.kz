/**
 * SaudaPulse — building a store snapshot from the official Kaspi API.
 *
 * Shared by the extension's service worker and the phone app (app/), so both compute orders,
 * returns, refusals and top products the same way. Moved here unchanged from
 * background/service-worker.js. `K` is background/kaspi-api.js (passed in, so the phone app can
 * use the same client over its relay transport).
 */
import './selectors.js';

const S = globalThis.KSH_SELECTORS;
const DAY = 86400000;

/**
 * Build a store snapshot from the API: orders of the last 28 days (90 on first
 * sync) + older API orders kept from the cache, split into orders / returns /
 * refusals, plus top products from order contents.
 */
export async function apiSnapshot(K, shopId, token, prevSnap, store) {
  const prevItems = prevSnap?.sections?.orders?.items || [];
  const hadApi = prevItems.some((i) => i.api);
  const days = hadApi ? S.api.syncDays : S.api.firstSyncDays;
  const raw = await K.listOrders(token, days);
  const fresh = raw.map(K.toOrderItem);
  const freshIds = new Set(fresh.map((i) => i.id));
  const windowStart = Date.now() - days * DAY;
  const keepFrom = Date.now() - S.api.firstSyncDays * DAY;
  const kept = prevItems.filter((i) => i.api && !freshIds.has(i.id) && i.date && new Date(i.date).getTime() < windowStart && new Date(i.date).getTime() >= keepFrom);
  const { topProducts, entriesOf } = await apiTopProducts(K, shopId, token, [...fresh, ...kept], prevItems);
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
export async function apiTopProducts(K, shopId, token, items, prevItems = []) {
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
