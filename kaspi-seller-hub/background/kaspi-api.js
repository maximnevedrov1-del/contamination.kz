/**
 * Kaspi Seller Hub — client for the official Kaspi Shop API (JSON:API).
 *
 * One token per store (cabinet › Настройки › Токен API). Used only by the service
 * worker; tokens never reach extension pages. Endpoints and formats follow
 * guide.kaspi.kz/partner/ru/shop/api/orders/* (q3201 list, q3202 by code,
 * q3211 accept, q3210 assemble/waybill, q3213 cancel).
 *
 * Write calls (accept, assemble) are irreversible on Kaspi's side and are only
 * made after an explicit, confirmed click in the dashboard.
 */
import '../shared/selectors.js';

const A = () => globalThis.KSH_SELECTORS.api;
const DAY = 86400000;

/** Error with a code the UI can translate (errors.<code>). */
export class ApiError extends Error {
  constructor(code, status, detail = '') {
    super(code);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Low-level request.
 * @param {string} token
 * @param {string} pathOrUrl path under the API base, or a full URL from a `links` field
 * @param {{ method?:string, params?:Record<string,string|number>, body?:any, accept?:string }} [opts]
 */
export async function apiRequest(token, pathOrUrl, { method = 'GET', params, body, accept = 'application/vnd.api+json' } = {}) {
  const url = new URL(/^https?:/.test(pathOrUrl) ? pathOrUrl : A().base + pathOrUrl);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  let res;
  try {
    res = await fetch(url.href, {
      method,
      headers: { 'X-Auth-Token': token, Accept: accept, 'Content-Type': 'application/vnd.api+json' },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'omit', // the token is the only credential; never send cabinet cookies
    });
  } catch (e) {
    throw new ApiError('apiNetwork', 0, e.message);
  }
  if (res.status === 401 || res.status === 403) throw new ApiError('apiUnauthorized', res.status);
  if (!res.ok) throw new ApiError('apiHttp', res.status, (await res.text().catch(() => '')).slice(0, 300));
  return res;
}

const json = async (res) => {
  const text = await res.text();
  return text ? JSON.parse(text) : {};
};

/** Run async jobs with a concurrency limit. */
async function pool(jobs, limit) {
  const out = new Array(jobs.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, jobs.length) }, async () => {
      while (i < jobs.length) {
        const n = i++;
        out[n] = await jobs[n]();
      }
    }),
  );
  return out;
}

/** Cheap token check: one tiny list request. Throws ApiError on failure. */
export async function verifyToken(token) {
  const to = Date.now();
  await apiRequest(token, '/orders', {
    params: { 'page[number]': 0, 'page[size]': 1, 'filter[orders][state]': 'NEW', 'filter[orders][creationDate][$ge]': to - A().windowDays * DAY + 1, 'filter[orders][creationDate][$le]': to },
  });
  return true;
}

/**
 * All orders created in the last `days` days, every state, all pages.
 * Kaspi needs a state filter and a creationDate range (≤ windowDays) per request.
 * @returns {Promise<any[]>} raw JSON:API order objects
 */
export async function listOrders(token, days) {
  const now = Date.now();
  const jobs = [];
  for (let end = now; end > now - days * DAY; end -= A().windowDays * DAY) {
    const start = Math.max(end - A().windowDays * DAY + 1, now - days * DAY);
    for (const state of A().states) {
      jobs.push(async () => {
        const all = [];
        for (let page = 0; page < 50; page++) {
          const d = await json(
            await apiRequest(token, '/orders', {
              params: {
                'page[number]': page,
                'page[size]': A().pageSize,
                'filter[orders][state]': state,
                'filter[orders][creationDate][$ge]': start,
                'filter[orders][creationDate][$le]': end,
              },
            }),
          );
          all.push(...(d.data || []));
          if (page + 1 >= (d.meta?.pageCount ?? 0) || !(d.data || []).length) break;
        }
        return all;
      });
    }
  }
  const byId = new Map();
  (await pool(jobs, A().concurrency)).flat().forEach((o) => byId.set(o.id, o));
  return [...byId.values()];
}

/** One order by its number (code). */
export async function getOrderByCode(token, code) {
  const d = await json(await apiRequest(token, '/orders', { params: { 'filter[orders][code]': code } }));
  return (d.data || [])[0] || null;
}

/** Products of an order (name, sku, quantity, price, category). */
export async function getEntries(token, order) {
  const link = order.relationships?.entries?.links?.related;
  if (!link) return [];
  const d = await json(await apiRequest(token, link));
  return (d.data || []).map((e) => {
    const a = e.attributes || {};
    return {
      name: a.offer?.name || a.category?.title || '',
      sku: a.offer?.code || '',
      quantity: a.quantity ?? 1,
      price: a.basePrice ?? null,
      total: a.totalPrice ?? null,
      category: a.category?.title || '',
    };
  });
}

/** Change an order's status (POST /orders) — accept (q3211). */
export async function acceptOrder(token, { id, code }) {
  const d = await json(
    await apiRequest(token, '/orders', { method: 'POST', body: { data: { type: 'orders', id, attributes: { code, status: 'ACCEPTED_BY_MERCHANT' } } } }),
  );
  return d.data?.attributes?.status || null;
}

/** Assemble a Kaspi Delivery order → Kaspi generates the waybill (q3210). */
export async function assembleOrder(token, { id }, numberOfSpace = 1) {
  const d = await json(
    await apiRequest(token, '/orders', { method: 'POST', body: { data: { type: 'orders', id, attributes: { status: 'ASSEMBLE', numberOfSpace: String(numberOfSpace) } } } }),
  );
  return d.data?.attributes?.status || null;
}

/** Download the waybill PDF as a data: URL. */
export async function downloadWaybill(token, url) {
  // The token is sent only to the API's own host; any other host gets a plain request.
  const sameHost = new URL(url).host === new URL(A().base).host;
  const res = sameHost
    ? await apiRequest(token, url, { accept: 'application/pdf, */*' })
    : await fetch(url, { credentials: 'omit' }).then((r) => {
        if (!r.ok) throw new ApiError('apiHttp', r.status);
        return r;
      });
  const buf = new Uint8Array(await res.arrayBuffer());
  const isPdf = String.fromCharCode(...buf.slice(0, 4)) === '%PDF';
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return isPdf ? { kind: 'pdf', data: `data:application/pdf;base64,${btoa(bin)}` } : { kind: 'html', data: new TextDecoder().decode(buf) };
}

/* ------------------------------------------------------------------ */
/* Mapping onto the extension's data model (see storage.js › OrderItem) */
/* ------------------------------------------------------------------ */

const RETURNED = new Set(['KASPI_DELIVERY_RETURN_REQUESTED', 'RETURNED']);
const CANCELLED = new Set(['CANCELLED', 'CANCELLING']);

/** Kaspi status/state → normalized status. */
export function mapStatus(a) {
  const st = a.status;
  if (st === 'APPROVED_BY_BANK') return 'new';
  if (st === 'ACCEPTED_BY_MERCHANT') {
    if (a.kaspiDelivery?.courierTransmissionDate) return 'delivering';
    return a.assembled ? 'packed' : 'accepted';
  }
  if (st === 'COMPLETED') return 'delivered';
  if (CANCELLED.has(st)) return 'cancelled';
  if (RETURNED.has(st)) return 'returned';
  return 'unknown';
}

/**
 * Payment: waiting for the buyer's credit signature = pending; a cancelled or
 * returned order's payment is voided/refunded even if the bank once approved it;
 * otherwise bank approval = paid.
 */
export function mapPayment(a) {
  if (a.state === 'SIGN_REQUIRED' || (a.signatureRequired && a.status === 'APPROVED_BY_BANK')) return 'pending';
  if (CANCELLED.has(a.status) || RETURNED.has(a.status)) return a.approvedByBankDate ? 'refunded' : 'failed';
  if (a.approvedByBankDate) return 'paid';
  return 'unknown';
}

/**
 * Raw API order → OrderItem (+ `api` block used by actions and the UI).
 * Buyer name/phone/address are deliberately NOT copied.
 */
export function toOrderItem(o) {
  const a = o.attributes || {};
  const kind = RETURNED.has(a.status) ? 'return' : CANCELLED.has(a.status) ? 'refusal' : 'order';
  return {
    id: String(a.code),
    kind,
    date: a.creationDate ? new Date(a.creationDate).toISOString() : null,
    status: mapStatus(a),
    statusRaw: a.status || '',
    amount: typeof a.totalPrice === 'number' ? a.totalPrice : null,
    paymentStatus: mapPayment(a),
    paymentRaw: a.paymentMode || '',
    reason: a.cancellationReason || undefined,
    url: A().cabinetOrderUrl.replace('{code}', encodeURIComponent(a.code)),
    api: {
      id: o.id,
      code: String(a.code),
      state: a.state,
      status: a.status,
      isKaspiDelivery: !!a.isKaspiDelivery,
      assembled: !!a.assembled,
      waybill: a.kaspiDelivery?.waybill || null,
      waybillNumber: a.kaspiDelivery?.waybillNumber || null,
      courierPlanDate: a.kaspiDelivery?.courierTransmissionPlanningDate || null,
      plannedDeliveryDate: a.plannedDeliveryDate || null,
      deliveryMode: a.deliveryMode || '',
      paymentMode: a.paymentMode || '',
      preOrder: !!a.preOrder,
      deliveryCostForSeller: a.deliveryCostForSeller ?? null,
      entriesUrl: o.relationships?.entries?.links?.related || null,
    },
  };
}
