/**
 * SaudaPulse — stock write-off from orders (pure, no chrome.*; unit-tested).
 *
 * The seller's catalog (price list imported from the Kaspi cabinet) holds the stock of every
 * product per store. Kaspi reads that stock from our price list every hour, so it must follow
 * real shipments:
 *   - an order that reached «Собран» (packed), «У курьера» (delivering) or «Выдан» (delivered)
 *     → its lines are written off: stock − quantity (never below 0);
 *   - the same order cancelled afterwards → the lines come back (goods are still on the shelf);
 *   - a return is NOT put back automatically (the item may be damaged): the seller adds it by hand.
 * Every order is written off at most once (ledger keyed by store + order number), whether it was
 * packed in SaudaPulse, in the Kaspi cabinet or on the phone.
 * The imported price list already reflects everything shipped before the import: at that moment
 * the orders already packed / delivered are recorded as «seen» (seedLedger) and never written off.
 * An order that came in before the import but ships after it IS written off. Orders created more
 * than LOOKBACK_DAYS before the import are ignored (history, not stock).
 */

export const SHIPPED = new Set(['packed', 'delivering', 'delivered']);
export const LEDGER_DAYS = 120;
export const MOVES_MAX = 300;
export const LOOKBACK_DAYS = 14;
const DAY = 86400000;

const isCancelled = (it) => it.status === 'cancelled' || it.kind === 'refusal';

/**
 * @param {{
 *   catalog: Record<string, any>,                    // sku → Product (shared/catalog.js)
 *   ledger: Record<string, { at:number, lines:Array<[string, number]>, back?:number }>,
 *   ordersByShop: Record<string, any[]>,              // shopId → OrderItem[] (with entries)
 *   importedAt: Record<string, number>,               // shopId → when its price list was imported
 *   moves?: any[],                                    // previous movement log (newest last)
 *   now?: number,
 * }} input
 * @returns {{ catalog, ledger, moves, changedShops: string[], count: number }}
 */
export function applyOrderStock({ catalog, ledger, ordersByShop, importedAt, moves = [], now = Date.now() }) {
  const nextCatalog = { ...catalog };
  const nextLedger = {};
  const keepFrom = now - LEDGER_DAYS * DAY;
  for (const [k, e] of Object.entries(ledger || {})) if (e && e.at >= keepFrom) nextLedger[k] = e;
  const nextMoves = [...moves];
  const changed = new Set();
  const touched = new Set(); // skus already copied (copy on write)
  let count = 0;

  const offerOf = (sku, shopId) => {
    const p = nextCatalog[sku];
    if (!p?.stores?.[shopId]) return null;
    if (!touched.has(sku)) {
      nextCatalog[sku] = { ...p, stores: { ...p.stores } };
      touched.add(sku);
    }
    if (!touched.has(`${sku}|${shopId}`)) {
      nextCatalog[sku].stores[shopId] = { ...nextCatalog[sku].stores[shopId] };
      touched.add(`${sku}|${shopId}`);
    }
    return { product: nextCatalog[sku], offer: nextCatalog[sku].stores[shopId] };
  };
  const shift = (shopId, orderId, lines, sign) => {
    const done = [];
    for (const [sku, qty] of lines) {
      const hit = offerOf(sku, shopId);
      if (!hit) continue; // not in this store's price list: nothing to change
      const before = hit.offer.stock ?? hit.product.stock ?? 0;
      const after = Math.max(0, before + sign * qty);
      if (after === before) {
        nextMoves.push({ at: now, shopId, orderId, sku, qty: 0, left: after, note: 'empty' }); // was already 0: Kaspi sold more than the list said
        continue;
      }
      hit.offer.stock = after;
      hit.product.updatedAt = now;
      nextMoves.push({ at: now, shopId, orderId, sku, qty: after - before, left: after });
      done.push(sku);
    }
    if (done.length) changed.add(shopId);
  };

  for (const [shopId, items] of Object.entries(ordersByShop || {})) {
    if (!importedAt?.[shopId]) continue; // no price list imported for this store yet
    const since = importedAt[shopId] - LOOKBACK_DAYS * DAY;
    for (const it of items || []) {
      if (!it?.id || !it.date || new Date(it.date).getTime() < since) continue;
      if (it.kind === 'return') continue;
      const key = `${shopId}::${it.id}`;
      const e = nextLedger[key];
      if (!e && SHIPPED.has(it.status) && it.kind === 'order') {
        if (!Array.isArray(it.entries) || !it.entries.length) continue; // contents not loaded yet: next sync
        const lines = [];
        for (const en of it.entries) {
          const sku = String(en?.sku || '').trim();
          const qty = Math.max(0, Math.round(Number(en?.quantity) || 0));
          if (sku && qty) lines.push([sku, qty]);
        }
        if (!lines.length) continue;
        shift(shopId, it.id, lines, -1);
        nextLedger[key] = { at: now, lines };
        count++;
      } else if (e && !e.back && isCancelled(it)) {
        shift(shopId, it.id, e.lines, +1); // cancelled after packing: the goods are still here
        nextLedger[key] = { ...e, back: now };
        count++;
      }
    }
  }
  return { catalog: nextCatalog, ledger: nextLedger, moves: nextMoves.slice(-MOVES_MAX), changedShops: [...changed], count };
}

/**
 * At the moment a store's price list is imported: every order of that store already packed,
 * with the courier, delivered or cancelled is marked as seen, so it is never written off later
 * (the imported stock already accounts for it).
 */
export function seedLedger(ledger, shopId, items, now = Date.now()) {
  const next = { ...(ledger || {}) };
  for (const it of items || []) {
    if (!it?.id) continue;
    const key = `${shopId}::${it.id}`;
    if (next[key]) continue;
    if (SHIPPED.has(it.status) || isCancelled(it) || it.kind === 'return') next[key] = { at: now, lines: [], seed: true };
  }
  return next;
}
