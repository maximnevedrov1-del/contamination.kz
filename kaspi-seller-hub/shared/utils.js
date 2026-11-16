/**
 * Kaspi Seller Hub — shared helpers (ES module).
 * Used by the service worker, the dashboard, the popup and the print page.
 * The content script is a classic script and keeps its own tiny parsers.
 */

/** @param {number} ms */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Debounce a function.
 * @template {(...a:any[])=>void} F
 * @param {F} fn
 * @param {number} wait
 * @returns {F}
 */
export function debounce(fn, wait = 250) {
  let t;
  return /** @type {F} */ ((...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  });
}

/**
 * Reject a promise if it does not settle in time.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} [code]
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, code = 'timeout') {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(code)), ms);
    }),
  ]);
}

/**
 * Minimal async mutex — serializes read-modify-write cycles on storage.
 * @returns {<T>(fn: () => Promise<T>) => Promise<T>}
 */
export function createMutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

/** Random id. */
export const uid = (p = 'id') => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * Normalize anything date-like to an ISO string, or null.
 * @param {string|number|Date|null|undefined} v
 */
export function toISO(v) {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Local YYYY-MM-DD for a date (used as day bucket key and <input type=date> value). */
export function dayKey(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Start of local day. */
export function startOfDay(v) {
  const d = new Date(v);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** End of local day. */
export function endOfDay(v) {
  const d = new Date(v);
  d.setHours(23, 59, 59, 999);
  return d;
}

/** Date range for a "last N days" preset, inclusive of today. */
export function presetRange(days) {
  const to = endOfDay(new Date());
  const from = startOfDay(new Date(Date.now() - (days - 1) * 86400000));
  return { from, to };
}

/** All day keys between two dates, inclusive. */
export function eachDay(from, to) {
  const out = [];
  for (let d = startOfDay(from); d <= to; d = new Date(d.getTime() + 86400000)) out.push(dayKey(d));
  return out;
}

/**
 * Is an ISO date inside [from, to]? Items without a date are kept.
 * @param {string|null} iso
 * @param {{from?:Date,to?:Date}} range
 */
export function inRange(iso, { from, to } = {}) {
  if (!iso) return true;
  const t = new Date(iso).getTime();
  return (!from || t >= from.getTime()) && (!to || t <= to.getTime());
}

/**
 * Group an array by key.
 * @template T
 * @param {T[]} arr
 * @param {(x:T)=>string} keyFn
 * @returns {Record<string,T[]>}
 */
export function groupBy(arr, keyFn) {
  return arr.reduce((acc, x) => {
    (acc[keyFn(x)] ??= []).push(x);
    return acc;
  }, /** @type {Record<string,T[]>} */ ({}));
}

/** Sum numeric values (ignores null/NaN). */
export const sumBy = (arr, fn) => arr.reduce((s, x) => s + (Number.isFinite(fn(x)) ? fn(x) : 0), 0);

/** Safe division → null when denominator is 0/unknown. */
export const ratio = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b > 0 ? a / b : null);

/**
 * Comparator for table sorting: numbers, ISO dates and strings; nulls last.
 * @param {any} a
 * @param {any} b
 */
export function compareValues(a, b) {
  const na = a == null || a === '';
  const nb = b == null || b === '';
  if (na || nb) return na === nb ? 0 : na ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Fill a URL template like "/mc/#/orders/{orderId}". Values are URI-encoded. */
export function fillTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ''));
}

/**
 * Tiny hyperscript helper — builds DOM without innerHTML, so text coming from
 * Kaspi (customer names, chat messages) can never inject markup.
 * @param {string} tag
 * @param {Record<string, any>|null} [props]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object')
      Object.entries(v).forEach(([prop, val]) => (prop.startsWith('--') ? el.style.setProperty(prop, val) : (el.style[prop] = val)));
    else if (k === 'value') el.value = v; // property, so <textarea> and live inputs work
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** SVG flavour of h(). */
export function s(tag, attrs, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, String(v));
  appendChildren(el, children);
  return el;
}

/** Remove all children. */
export const clear = (el) => {
  while (el.firstChild) el.firstChild.remove();
  return el;
};

/**
 * Categorical store colors — fixed order, validated for colour-vision
 * deficiency as adjacent pairs (see README › Charts). Assigned to a store once
 * and persisted, so a store keeps its colour when others are filtered out.
 */
export const STORE_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];

/** Pick the first palette colour not yet used. */
export function nextStoreColor(used) {
  return STORE_COLORS.find((c) => !used.includes(c)) ?? STORE_COLORS[used.length % STORE_COLORS.length];
}

/** Composite key for items coming from different stores. */
export const itemKey = (shopId, id) => `${shopId}::${id}`;

/**
 * Counters shown in the popup, sidebar and action badge for one store snapshot.
 * Only data that was actually parsed is counted; unknown sections give null.
 * @param {import('./storage.js').Snapshot|undefined} snap
 * @returns {{ newOrders:number|null, returns:number|null, refusals:number|null, unpaid:number|null }}
 */
export function storeCounts(snap) {
  const sec = snap?.sections || {};
  const items = (k) => (sec[k]?.items ? sec[k].items : null);
  const orders = items('orders');
  return {
    newOrders: orders ? orders.filter((o) => o.status === 'new').length : null,
    returns: items('returns')?.length ?? null,
    refusals: items('refusals')?.length ?? null,
    unpaid: orders ? orders.filter((o) => o.paymentStatus === 'pending').length : null,
  };
}

/** Sum counters across stores (null stays null only if every store is null). */
export function sumCounts(list) {
  const keys = ['newOrders', 'returns', 'refusals', 'unpaid'];
  return Object.fromEntries(
    keys.map((k) => {
      const vals = list.map((c) => c[k]).filter((v) => v != null);
      return [k, vals.length ? vals.reduce((a, b) => a + b, 0) : null];
    }),
  );
}

/* ===================================================================== */
/* Deadlines                                                               */
/* ===================================================================== */

const HOUR = 3600000;

/**
 * The next deadline of an order, if any:
 *  - "accept": the seller's own target (settings.deadlines.acceptHours) for orders
 *    waiting for acceptance — Kaspi publishes no fixed limit;
 *  - "ship": Kaspi's planned courier hand-over date (API, Kaspi Delivery).
 * @returns {{ kind:'accept'|'ship', at:number, source:'target'|'kaspi' } | null}
 */
export function deadlineOf(item, settings) {
  if (item.kind && item.kind !== 'order') return null;
  if (item.status === 'new') {
    const h = settings?.deadlines?.acceptHours;
    if (!h || !item.date) return null;
    return { kind: 'accept', at: new Date(item.date).getTime() + h * HOUR, source: 'target' };
  }
  // Courier hand-over exists only for Kaspi Delivery orders.
  if ((item.status === 'accepted' || item.status === 'packed') && item.api?.isKaspiDelivery && item.api.courierPlanDate) {
    return { kind: 'ship', at: item.api.courierPlanDate, source: 'kaspi' };
  }
  return null;
}

/** 'overdue' | 'soon' (within warnHours) | 'ok' */
export function urgencyOf(deadline, settings, now = Date.now()) {
  if (!deadline) return null;
  if (deadline.at <= now) return 'overdue';
  return deadline.at - now <= (settings?.deadlines?.warnHours ?? 2) * HOUR ? 'soon' : 'ok';
}

/* ===================================================================== */
/* Profit                                                                  */
/* ===================================================================== */

/** Commission % for a product category (category setting, else the default). */
export function commissionPct(category, profitSettings) {
  const v = profitSettings?.byCategory?.[category];
  return Number.isFinite(v) ? v : Number.isFinite(profitSettings?.defaultCommission) ? profitSettings.defaultCommission : null;
}

/**
 * Profit of one order = revenue − cost of goods − Kaspi commission − seller's delivery cost.
 * Needs the order contents (API orders). `complete` is false when a cost price or a
 * commission % is missing — such orders are counted separately, never guessed.
 * @param {any} item OrderItem with `entries`
 * @param {Record<string, number>} costs cost price per SKU
 * @param {{ defaultCommission:number|null, byCategory:Record<string,number> }} profitSettings
 */
export function orderProfit(item, costs, profitSettings) {
  if (!item.entries?.length || item.kind !== 'order' || ['cancelled', 'returned', 'refused'].includes(item.status)) return null;
  let revenue = 0;
  let cogs = 0;
  let commission = 0;
  let complete = true;
  for (const e of item.entries) {
    const line = e.total ?? (e.price || 0) * (e.quantity || 1);
    revenue += line;
    const cost = costs?.[e.sku];
    if (Number.isFinite(cost)) cogs += cost * (e.quantity || 1);
    else complete = false;
    const pct = commissionPct(e.category, profitSettings);
    if (pct != null) commission += (line * pct) / 100;
    else complete = false;
  }
  const delivery = item.api?.deliveryCostForSeller || 0;
  const profit = revenue - cogs - commission - delivery;
  return { revenue, cogs, commission, delivery, profit, margin: revenue ? profit / revenue : null, complete };
}

/** Human-friendly product key (same SKU in several stores = one product). */
export const productKey = (e) => e.sku || e.name;
