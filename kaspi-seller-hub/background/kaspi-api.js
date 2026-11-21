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
import { scrub } from '../shared/errorlog.js';

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
 * Outcome of every request after retries (for the API health counts, background/health.js):
 * fn(null) on success, fn(ApiError) on failure. Only the outcome — never the URL, body or token.
 */
let observer = null;
export const setApiObserver = (fn) => (observer = fn);
const observe = (err) => {
  try {
    observer?.(err);
  } catch {
    /* counting must never break a request */
  }
};

/** Pauses between attempts when Kaspi is busy or briefly down. */
export const RETRY_DELAYS = [1500, 4000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let sleeper = sleep;
/** Tests replace the wait so retries run instantly. */
export const _setSleep = (fn) => (sleeper = fn || sleep);
/** Hard limit per request (headers + body): a hung Kaspi answer must not block the sync forever. */
export const API_TIMEOUT_MS = 30000;
let timeoutMs = API_TIMEOUT_MS;
/** Tests shorten the limit. */
export const _setTimeoutMs = (ms) => (timeoutMs = ms || API_TIMEOUT_MS);
const isTimeout = (e) => e?.name === 'TimeoutError' || e?.name === 'AbortError';

/** Seconds from a Retry-After header, capped so a UI action never hangs for long. */
function retryAfter(res, fallback) {
  const s = Number(res.headers.get('Retry-After'));
  return Number.isFinite(s) && s > 0 ? Math.min(s * 1000, 10000) : fallback;
}

/**
 * Low-level request.
 *
 * Retries (2 more attempts, 1.5 s then 4 s apart):
 *   - 429 "too many requests" — Kaspi did not process the request, safe for any method;
 *   - 502/503/504 and network failures — only for GET. A write (accept, assemble,
 *     cancel, card import) may already have been applied by Kaspi before the
 *     connection broke, so it is never repeated automatically.
 * @param {string} token
 * @param {string} pathOrUrl path under the API base, or a full URL from a `links` field
 * @param {{ method?:string, params?:Record<string,string|number>, body?:any, accept?:string, contentType?:string }} [opts]
 */
export async function apiRequest(token, pathOrUrl, { method = 'GET', params, body, accept = 'application/vnd.api+json', contentType = 'application/vnd.api+json' } = {}) {
  const url = new URL(/^https?:/.test(pathOrUrl) ? pathOrUrl : A().base + pathOrUrl);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  // «Только чтение» (settings.readOnly, set by the worker): only reads ever leave the extension.
  // Last line of defence: the worker also refuses the actions before they get here.
  if (method !== 'GET' && globalThis.KSH_READONLY) throw new ApiError('readOnly', 0);
  const idempotent = method === 'GET';
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= RETRY_DELAYS.length;
    let res;
    try {
      res = await fetch(url.href, {
        method,
        headers: { 'X-Auth-Token': token, Accept: accept, 'Content-Type': contentType },
        body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        credentials: 'omit', // the token is the only credential; never send cabinet cookies
        signal: AbortSignal.timeout(timeoutMs), // also covers reading the body later
      });
    } catch (e) {
      if (idempotent && !last) {
        await sleeper(RETRY_DELAYS[attempt]);
        continue;
      }
      // A timed-out write may still have been applied by Kaspi: it is reported, never repeated.
      throw fail(isTimeout(e) ? new ApiError('apiTimeout', 0) : new ApiError('apiNetwork', 0, e.message));
    }
    if (res.status === 401 || res.status === 403) throw fail(new ApiError('apiUnauthorized', res.status));
    const busy = res.status === 429 || (idempotent && [502, 503, 504].includes(res.status));
    if (busy && !last) {
      await sleeper(retryAfter(res, RETRY_DELAYS[attempt]));
      continue;
    }
    if (res.status === 429) throw fail(new ApiError('apiRateLimit', 429));
    if (!res.ok) throw fail(new ApiError('apiHttp', res.status, scrub(await res.text().catch(() => ''))));  // Kaspi body may hold buyer PII
    observe(null);
    return res;
  }
}

const fail = (err) => (observe(err), err);

const json = async (res) => {
  let text;
  try {
    text = await res.text();
  } catch (e) {
    throw fail(isTimeout(e) ? new ApiError('apiTimeout', res.status) : new ApiError('apiNetwork', res.status, e.message));
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    // Kaspi answered 200 with something that is not JSON: the API changed or a proxy page came back
    throw fail(new ApiError('apiFormat', res.status));
  }
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
    : await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) }).then((r) => {
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

/* ---------------- product cards (Content API) ----------------
 * guide.kaspi.kz/partner/ru/shop/api/goods: q3216 categories, q3217 attributes,
 * q3218 attribute values, q3219 POST import, q3221 import status, q3222 import result.
 * A card upload creates the product in Kaspi's catalog (Kaspi checks it); price and
 * stock come from the price list, not from this API.
 */
const P = (path) => A().productsBase + path;

/** @returns {Promise<Array<{code:string,title:string}>>} */
export async function getCategories(token) {
  return json(await apiRequest(token, P('/classification/categories'), { accept: 'application/json' }));
}

/** @returns {Promise<Array<{code:string,type:'boolean'|'enum'|'string'|'number',multiValued:boolean,mandatory:boolean}>>} */
export async function getAttributes(token, category) {
  return json(await apiRequest(token, P('/classification/attributes'), { params: { c: category }, accept: 'application/json' }));
}

/** @returns {Promise<Array<{code:string,name:string}>>} */
export async function getAttributeValues(token, category, attribute) {
  return json(await apiRequest(token, P('/classification/attribute/values'), { params: { c: category, a: attribute }, accept: 'application/json' }));
}

/**
 * Upload product cards. Kaspi documents Content-Type text/plain with a JSON array body.
 * @returns {Promise<{code:string,status:string}>} code = upload id for status/result
 */
export async function importProducts(token, items) {
  // through apiRequest: a 429 is retried; a network failure is not (Kaspi may have queued the upload)
  const res = await apiRequest(token, P('/import'), { method: 'POST', body: JSON.stringify(items), accept: 'application/json', contentType: 'text/plain' });
  return json(res);
}

/** @returns {Promise<{code:string,status:string}>} */
export async function getImportStatus(token, code) {
  return json(await apiRequest(token, P('/import'), { params: { i: code }, accept: 'application/json' }));
}

/** @returns {Promise<{errors:number,warnings:number,skipped:number,total:number,result:Record<string,any>}>} */
export async function getImportResult(token, code) {
  return json(await apiRequest(token, P('/import/result'), { params: { i: code }, accept: 'application/json' }));
}
