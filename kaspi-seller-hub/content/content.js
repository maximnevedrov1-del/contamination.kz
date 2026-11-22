/**
 * SaudaPulse — content script (isolated world, one instance per Kaspi tab).
 *
 * Responsibilities
 *  - Identify the store and session state of this tab.
 *  - Parse what the seller's authenticated page shows: orders, returns, refusals,
 *    payment statuses, analytics, chat. Sources, in order: visible DOM, then JSON
 *    the page itself loaded (network-tap.js). Nothing is invented — sections that
 *    are not visible are reported as `notVisible`.
 *  - Execute commands from the service worker (pack, capture invoice, chat reply…)
 *    by clicking the existing Kaspi UI. Commands only ever arrive as a result of an
 *    explicit user click in the extension.
 *  - Report every selector that failed, so it can be fixed in shared/selectors.js.
 *
 * All selectors come from globalThis.KSH_SELECTORS (shared/selectors.js).
 */
(() => {
  /** Is this script's extension context still alive (false after the extension is reloaded)? */
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };
  // Skip if a live instance already runs in this tab. An orphaned instance from a
  // previous extension version must not block a fresh injection.
  if (globalThis.__KSH_CONTENT_ALIVE__?.()) return;
  globalThis.__KSH_CONTENT_ALIVE__ = alive;

  const S = globalThis.KSH_SELECTORS;
  const LOG = '[KSH]';
  if (!S) {
    console.error(LOG, 'selectors.js not loaded — content script disabled');
    return;
  }

  /** Selector keys that returned nothing during the current operation. */
  const missing = new Set();

  /* ================= DOM query helpers ================= */

  /**
   * Resolve a list of candidate selectors (CSS or "xpath:…") to elements.
   * The first candidate that matches anything wins.
   * @param {string[]|string} candidates
   * @param {ParentNode} [root]
   * @returns {Element[]}
   */
  function queryAll(candidates, root = document) {
    for (const c of [].concat(candidates || [])) {
      try {
        if (c.startsWith('xpath:')) {
          const snap = document.evaluate(c.slice(6), root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          const out = [];
          for (let i = 0; i < snap.snapshotLength; i++) out.push(snap.snapshotItem(i));
          if (out.length) return out;
        } else {
          const list = root.querySelectorAll(c);
          if (list.length) return [...list];
        }
      } catch (e) {
        console.warn(LOG, 'invalid selector', c, e.message);
      }
    }
    return [];
  }

  /**
   * First element for a selector list; records `key` as missing if `required`.
   * @param {string[]} candidates
   * @param {ParentNode} [root]
   * @param {string} [key] name reported in diagnostics
   * @param {boolean} [required]
   */
  /** First element matching the selectors AND an optional predicate. */
  const findFirst = (candidates, root = document, filter = null) => queryAll(candidates, root).find((el) => !filter || filter(el)) || null;

  function queryOne(candidates, root = document, key = '', required = false) {
    const el = queryAll(candidates, root)[0] || null;
    if (!el && required && key) missing.add(key);
    return el;
  }

  /**
   * Read a field spec ({ sel, attr, regex }) relative to a root element.
   * @returns {string} trimmed value or ''
   */
  function readField(root, spec, key, required = false) {
    if (!spec) return '';
    const el = queryOne(spec.sel, root, key, required);
    if (!el) return '';
    let v = spec.attr ? el.getAttribute(spec.attr) || '' : el.textContent || '';
    v = v.replace(/\s+/g, ' ').trim();
    if (spec.regex && v) {
      const m = v.match(new RegExp(spec.regex));
      v = m ? (m[1] ?? m[0]) : '';
    }
    return v;
  }

  const matchesAny = (el, candidates) =>
    [].concat(candidates || []).some((c) => {
      if (c.startsWith('xpath:')) return false;
      try {
        return el.matches(c) || !!el.closest(c);
      } catch {
        return false;
      }
    });

  /**
   * Wait for an element to appear (MutationObserver + timeout).
   * @returns {Promise<Element|null>}
   */
  function waitFor(candidates, timeout = S.timing.waitTimeoutMs, root = document, filter = null) {
    return new Promise((resolve) => {
      const found = findFirst(candidates, root, filter);
      if (found) return resolve(found);
      const obs = new MutationObserver(() => {
        const el = findFirst(candidates, root, filter);
        if (el) {
          obs.disconnect();
          clearTimeout(timer);
          resolve(el);
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      const timer = setTimeout(() => {
        obs.disconnect();
        resolve(null);
      }, timeout);
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ================= value parsers ================= */

  /** "12 345 ₸" → 12345, "1 234,50" → 1234.5 */
  function parseMoney(text) {
    if (text == null || text === '') return null;
    if (typeof text === 'number') return text;
    const cleaned = String(text).replace(/[^\d,.-]/g, '').replace(/,(\d{1,2})$/, '.$1').replace(/,/g, '');
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  /** Month stems (RU, KK) for dates written with words: "16 ноября 2026", "16 қараша". */
  const MONTHS = [
    ['янв', 'қаң'], ['фев', 'ақп'], ['мар', 'нау'], ['апр', 'сәу'], ['мая', 'май', 'мам'], ['июн', 'мау'],
    ['июл', 'шіл'], ['авг', 'там'], ['сен', 'қыр'], ['окт', 'қаз'], ['ноя', 'қар'], ['дек', 'жел'],
  ];

  /**
   * "16.11.2026 14:30", "16.11.26", ISO 8601, epoch ms/s, "16 ноября 2026",
   * "сегодня 14:30", "кеше 09:10" → ISO string (or null).
   */
  function parseDate(text) {
    if (text == null || text === '') return null;
    if (typeof text === 'number') return new Date(text < 1e12 ? text * 1000 : text).toISOString();
    const s = String(text).trim().toLowerCase();
    if (/^\d{10,13}$/.test(s)) return parseDate(Number(s));
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      const iso = new Date(String(text).trim());
      return Number.isNaN(iso.getTime()) ? null : iso.toISOString();
    }
    const time = s.match(/(\d{1,2}):(\d{2})/);
    const setTime = (d) => {
      if (time) d.setHours(+time[1], +time[2], 0, 0);
      return d.toISOString();
    };
    if (/сегодня|бүгін/.test(s)) return setTime(new Date());
    if (/вчера|кеше/.test(s)) return setTime(new Date(Date.now() - 86400000));
    const dmy = s.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
    if (dmy) {
      const y = dmy[3].length === 2 ? 2000 + +dmy[3] : +dmy[3];
      return setTime(new Date(y, +dmy[2] - 1, +dmy[1]));
    }
    const words = s.match(/(\d{1,2})\s+([а-яәіңғүұқөһ]+)\.?(?:\s+(\d{4}))?/);
    if (words) {
      const m = MONTHS.findIndex((stems) => stems.some((st) => words[2].startsWith(st)));
      if (m >= 0) {
        const now = new Date();
        let y = words[3] ? +words[3] : now.getFullYear();
        if (!words[3] && new Date(y, m, +words[1]) > now) y -= 1; // "15 декабря" seen in January
        return setTime(new Date(y, m, +words[1]));
      }
    }
    if (time && s.length <= 5) return setTime(new Date());
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  /**
   * Map raw text onto a normalized key using a { key: [substrings] } map.
   * The LONGEST matching substring wins, so "не оплачен" (failed) beats
   * "оплачен" (paid) and "бас тарту" (refused) beats "бас тарт".
   */
  function normalize(raw, map, fallback = 'unknown') {
    const s = String(raw || '').toLowerCase().replace(/\s+/g, ' ');
    if (!s) return fallback;
    let best = fallback;
    let bestLen = 0;
    for (const [key, needles] of Object.entries(map))
      for (const n of needles)
        if (n.length > bestLen && s.includes(n)) {
          best = key;
          bestLen = n.length;
        }
    return best;
  }

  const getPath = (obj, path) => (path ? path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj) : obj);

  const absUrl = (href) => {
    try {
      return href ? new URL(href, location.href).href : '';
    } catch {
      return '';
    }
  };

  /* ================= page & session ================= */

  /** @returns {string} page type key from selectors.pages, or 'other' */
  function detectPage() {
    const href = location.href;
    // order details must be tested before the orders list
    const order = ['login', 'orderDetails', 'orders', 'returns', 'refusals', 'analytics', 'chat'];
    for (const key of order) if ((S.pages[key] || []).some((p) => href.includes(p))) {
      if (key === 'orderDetails' && !/\d{6,}/.test(href)) continue;
      return key;
    }
    return 'other';
  }

  /** Cheap stable hash for a fallback store id. */
  const hash = (str) => {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    return `n${(h >>> 0).toString(36)}`;
  };

  /**
   * @returns {{ authenticated:boolean, shopId:string|null, shopName:string, pageType:string, url:string, origin:string }}
   */
  function sessionInfo() {
    const pageType = detectPage();
    const hasLogin = !!queryOne(S.session.loginForm);
    const hasAuth = !!queryOne(S.session.authMarker, document, 'session.authMarker', true);
    const authenticated = hasAuth && !hasLogin && pageType !== 'login';
    const shopName = readField(document, S.session.shopName, 'session.shopName', authenticated);
    const rawId = readField(document, S.session.shopId, 'session.shopId', false);
    const shopId = rawId || (shopName ? hash(shopName) : null);
    // Only seller-cabinet tabs (or Kaspi's login page) count as "store tabs".
    const isCabinet = authenticated || pageType === 'login' || (S.pages.cabinet || []).some((m) => location.href.includes(m));
    return { authenticated, isCabinet, shopId: authenticated ? shopId : null, shopName, pageType, url: location.href, origin: location.origin };
  }

  /* ================= network cache (from network-tap.js) ================= */

  /** @type {Record<string, {ts:number, items:any[]}>} */
  const netCache = {};

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const msg = ev.data;
    if (!msg || msg.__ksh !== 'net' || typeof msg.body !== 'string') return;
    for (const [kind, cfg] of Object.entries(S.network)) {
      if (!cfg.url) continue;
      try {
        if (!new RegExp(cfg.url).test(msg.url)) continue;
        const json = JSON.parse(msg.body);
        const list = getPath(json, cfg.list);
        if (!Array.isArray(list)) continue;
        const items = list.map((raw) => Object.fromEntries(Object.entries(cfg.fields).map(([k, p]) => [k, getPath(raw, p)])));
        netCache[kind] = { ts: Date.now(), items };
        scheduleUpdate();
      } catch (e) {
        console.warn(LOG, 'network parse failed', kind, e.message);
      }
    }
  });

  /* ================= parsers ================= */

  /**
   * Build a normalized OrderItem from raw field values.
   * @param {'order'|'return'|'refusal'} kind
   */
  function toItem(kind, raw) {
    const statusRaw = String(raw.status ?? '');
    const paymentRaw = String(raw.payment ?? '');
    const fallbackStatus = kind === 'return' ? 'returned' : kind === 'refusal' ? 'refused' : 'unknown';
    return {
      id: String(raw.id ?? '').trim(),
      kind,
      date: parseDate(raw.date),
      status: normalize(statusRaw, S.statusMap, fallbackStatus),
      statusRaw,
      amount: parseMoney(raw.amount),
      paymentStatus: normalize(paymentRaw, S.paymentMap, 'unknown'),
      paymentRaw,
      customer: raw.customer ? String(raw.customer) : undefined,
      reason: raw.reason ? String(raw.reason) : undefined,
      url: raw.link ? absUrl(raw.link) : undefined,
    };
  }

  /**
   * Parse a list section (orders/returns/refusals) from DOM, then network.
   * @param {'orders'|'returns'|'refusals'} section
   */
  function parseList(section) {
    const kind = { orders: 'order', returns: 'return', refusals: 'refusal' }[section];
    const cfg = S[section];
    const rows = queryAll(cfg.row);
    const onPage = detectPage() === section;
    if (rows.length) {
      const items = rows
        .map((row) => {
          const raw = {};
          for (const [k, spec] of Object.entries(cfg.fields)) raw[k] = readField(row, spec, `${section}.fields.${k}`, k === 'id');
          return toItem(kind, raw);
        })
        .filter((x) => x.id);
      return { status: 'ok', source: 'dom', items };
    }
    if (netCache[section]) return { status: 'ok', source: 'network', items: netCache[section].items.map((r) => toItem(kind, r)).filter((x) => x.id) };
    if (onPage) missing.add(`${section}.row`);
    return { status: 'notVisible' };
  }

  function parseAnalytics() {
    const A = S.analytics;
    const kpi = {};
    let found = false;
    for (const [k, spec] of Object.entries(A.kpi)) {
      const v = parseMoney(readField(document, spec, `analytics.kpi.${k}`, detectPage() === 'analytics'));
      kpi[k] = v;
      if (v != null) found = true;
    }
    const series = queryAll(A.seriesRow)
      .map((row) => ({
        date: parseDate(readField(row, A.seriesFields.date)),
        revenue: parseMoney(readField(row, A.seriesFields.revenue)),
        orders: parseMoney(readField(row, A.seriesFields.orders)),
      }))
      .filter((p) => p.date);
    if (!series.length && netCache.analytics) {
      netCache.analytics.items.forEach((r) => series.push({ date: parseDate(r.date), revenue: parseMoney(r.revenue), orders: parseMoney(r.orders) }));
    }
    const topProducts = queryAll(A.productRow)
      .map((row) => {
        const p = {};
        for (const [k, spec] of Object.entries(A.productFields)) p[k] = readField(row, spec);
        const revenue = parseMoney(p.revenue);
        const units = parseMoney(p.units);
        const returns = parseMoney(p.returns);
        return { sku: p.sku, name: p.name, revenue, units, returns, returnRate: units ? (returns ?? 0) / units : null };
      })
      .filter((p) => p.name || p.sku);
    if (!found && !series.length && !topProducts.length) return { status: 'notVisible' };
    return { status: 'ok', source: series.length && !found ? 'network' : 'dom', data: { kpi, series, topProducts } };
  }

  function parseConversations() {
    const C = S.chat;
    const items = queryAll(C.conversationItem);
    if (items.length) {
      return {
        status: 'ok',
        source: 'dom',
        items: items
          .map((el) => {
            const f = C.conversationFields;
            const id = conversationIdOf(el);
            return {
              id,
              stableId: !id.startsWith('~'),
              customer: readField(el, f.customer, 'chat.customer', true),
              preview: readField(el, f.preview),
              time: parseDate(readField(el, f.time)),
              unread: parseInt(readField(el, f.unread) || '0', 10) || 0,
              orderId: readField(el, f.orderId) || undefined,
            };
          })
          .filter((c) => c.id),
      };
    }
    if (netCache.chat) {
      return {
        status: 'ok',
        source: 'network',
        items: netCache.chat.items.map((r) => ({ id: String(r.id), customer: r.customer || '', preview: r.preview || '', time: parseDate(r.time), unread: +r.unread || 0 })),
      };
    }
    if (detectPage() === 'chat') missing.add('chat.conversationItem');
    return { status: 'notVisible' };
  }

  /**
   * Conversation id: the configured attribute, else a hash of customer + order
   * prefixed with "~" (unstable — replies are refused for such ids, see chatSend).
   */
  function conversationIdOf(el) {
    const f = S.chat.conversationFields;
    const id = readField(el, f.id) || el.getAttribute('data-id');
    if (id) return id;
    if (!missing.has('chat.conversationFields.id')) missing.add('chat.conversationFields.id');
    return `~${hash(`${readField(el, f.customer)}|${readField(el, f.orderId)}`)}`;
  }

  /** Parse the currently open chat thread. */
  function parseThread() {
    const C = S.chat;
    const root = queryOne(C.threadRoot, document, 'chat.threadRoot', true);
    if (!root) return null;
    const id = readField(document, C.threadId) || null;
    const messages = queryAll(C.message, root).map((el, i) => ({
      id: readField(el, C.messageFields.id) || `m${i}`,
      text: readField(el, C.messageFields.text, 'chat.messageFields.text', true) || (el.textContent || '').trim(),
      time: parseDate(readField(el, C.messageFields.time)),
      from: matchesAny(el, C.outgoingMarker) ? 'seller' : 'customer',
    }));
    return { conversationId: id, messages };
  }

  /** Full snapshot of everything this tab can see. */
  function snapshot() {
    missing.clear();
    const info = sessionInfo();
    if (!info.authenticated) return { ok: true, ...info, sections: {}, missingSelectors: [...missing] };
    const sections = {
      orders: parseList('orders'),
      returns: parseList('returns'),
      refusals: parseList('refusals'),
      analytics: parseAnalytics(),
      chat: parseConversations(),
    };
    return { ok: true, ...info, sections, missingSelectors: [...missing], selectorsVersion: S.version };
  }

  /* ================= actions ================= */

  function findOrderRow(orderId) {
    return queryAll(S.orders.row).find((row) => readField(row, S.orders.fields.id) === String(orderId)) || null;
  }

  /** Is the order details page for this order open? */
  function onOrderDetails(orderId) {
    const root = queryOne(S.orderDetails.root);
    if (!root) return null;
    const id = readField(root, S.orderDetails.id) || (location.href.match(/(\d{6,})/) || [])[1];
    return id === String(orderId) ? root : null;
  }

  /**
   * Click "Упаковать" for one order, then capture the invoice.
   * @returns {Promise<object>} { ok, invoice? } or { ok:false, error, needsNavigation? }
   */
  async function packOrder({ orderId }) {
    missing.clear();
    let btn = null;
    const row = findOrderRow(orderId);
    if (row) btn = queryOne(S.orders.packButton, row);
    if (!btn) {
      const details = onOrderDetails(orderId) || (await waitFor(S.orderDetails.root, 4000)) && onOrderDetails(orderId);
      if (details) btn = queryOne(S.orderDetails.packButton, document, 'orderDetails.packButton', true);
    }
    if (!btn) return { ok: false, error: 'packButtonNotFound', needsNavigation: !row, missingSelectors: [...missing] };
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return { ok: false, error: 'packDisabled' };

    // Invoices already on the page belong to earlier orders — only a new one counts.
    const before = new Set(queryAll([...S.invoice.link, ...S.invoice.container]));
    btn.click();
    const confirm = await waitFor(S.orders.packConfirm, 3000);
    if (confirm) confirm.click();

    // Proof that Kaspi accepted it: the button went away, a success marker or a
    // new invoice appeared, or the row's status now reads "packed".
    const packedProof = await new Promise((resolve) => {
      const check = () =>
        !btn.isConnected ||
        btn.disabled ||
        !!findFirst(S.orders.packedMarker) ||
        !!findFirst([...S.invoice.link, ...S.invoice.container], document, (el) => !before.has(el)) ||
        (row?.isConnected && normalize(readField(row, S.orders.fields.status), S.statusMap) === 'packed');
      if (check()) return resolve(true);
      const obs = new MutationObserver(() => check() && (obs.disconnect(), clearTimeout(timer), resolve(true)));
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      const timer = setTimeout(() => (obs.disconnect(), resolve(check())), S.timing.waitTimeoutMs);
    });
    if (!packedProof) return { ok: false, error: 'packNotConfirmed', missingSelectors: [...missing] };
    const invoice = await captureInvoice(orderId, { before, scope: row }).catch((e) => ({ error: e.message }));
    return { ok: true, invoice: invoice && !invoice.error ? invoice : null, invoiceError: invoice?.error, missingSelectors: [...missing] };
  }

  const blobToDataUrl = (blob) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });

  /**
   * Capture the invoice that Kaspi shows for the current order: a link to a
   * same-origin/allowed file (fetched with the page's own session) or inline markup.
   * An element counts as this order's invoice when its link mentions the order id,
   * when it sits inside the order's row, or when it appeared after the click
   * (i.e. it is not in `before`). With `strict`, only the first two count.
   * @param {string} orderId
   * @param {{ before?: Set<Element>, scope?: Element|null, strict?: boolean }} [opts]
   * @returns {Promise<{orderId:string, kind:'pdf'|'html', data:string, ts:number}>}
   */
  async function captureInvoice(orderId, { before = new Set(), scope = null, strict = false } = {}) {
    const cands = [...S.invoice.link, ...S.invoice.container];
    const mine = (el) => (el.getAttribute('href') || '').includes(String(orderId)) || (!!scope && scope.contains(el));
    const el = findFirst(cands, document, mine) || (await waitFor(cands, S.invoice.waitTimeoutMs, document, (x) => mine(x) || (!strict && !before.has(x))));
    if (!el) {
      missing.add('invoice.link');
      throw new Error('invoiceNotFound');
    }
    const href = el.getAttribute('href');
    if (href) {
      const url = new URL(href, location.href);
      const allowed = [location.origin, ...S.invoice.allowedOrigins];
      if (!allowed.includes(url.origin)) throw new Error('invoiceOriginNotAllowed');
      const res = await fetch(url.href, { credentials: 'include' });
      if (!res.ok) throw new Error(`invoiceHttp${res.status}`);
      const blob = await res.blob();
      const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
      const isPdf = blob.type.includes('pdf') || String.fromCharCode(...head) === '%PDF';
      if (isPdf) return { orderId: String(orderId), kind: 'pdf', data: await blobToDataUrl(blob), ts: Date.now() };
      return { orderId: String(orderId), kind: 'html', data: await blob.text(), ts: Date.now() };
    }
    return { orderId: String(orderId), kind: 'html', data: el.outerHTML, ts: Date.now() };
  }

  /** Fetch the invoice of an already packed order (order must be open/visible). */
  async function fetchInvoice({ orderId }) {
    missing.clear();
    const row = findOrderRow(orderId);
    const details = row ? null : onOrderDetails(orderId);
    if (!row && !details) return { ok: false, error: 'orderNotVisible', needsNavigation: true };
    // In a list, only accept a link that clearly belongs to this order; on the
    // order's own details page any invoice element is this order's.
    const invoice = await captureInvoice(orderId, { scope: row || details, strict: !!row }).catch((e) => ({ error: e.message }));
    return invoice.error ? { ok: false, error: invoice.error, missingSelectors: [...missing] } : { ok: true, invoice };
  }

  /** Current payment statuses for a list of order ids (from visible data). */
  function paymentStatuses({ orderIds }) {
    const list = parseList('orders');
    if (list.status !== 'ok') return { ok: false, error: 'ordersNotVisible', needsNavigation: true };
    const map = new Map(list.items.map((i) => [i.id, i]));
    return {
      ok: true,
      statuses: orderIds.map((id) => ({ id, paymentStatus: map.get(String(id))?.paymentStatus ?? null, paymentRaw: map.get(String(id))?.paymentRaw ?? '' })),
    };
  }

  /** Open a conversation by clicking it in Kaspi's list (also marks it read in Kaspi). */
  async function openConversation(conversationId) {
    const current = parseThread();
    if (current && current.conversationId === String(conversationId)) return true;
    const item = queryAll(S.chat.conversationItem).find((el) => conversationIdOf(el) === String(conversationId));
    if (!item) return false;
    (item.querySelector('a,button') || item).click();
    await waitFor(S.chat.threadRoot, 5000);
    await sleep(400); // let messages render
    return true;
  }

  async function chatThread({ conversationId }) {
    missing.clear();
    if (!(await openConversation(conversationId))) return { ok: false, error: 'conversationNotVisible', needsNavigation: true };
    const thread = parseThread();
    if (!thread) return { ok: false, error: 'threadNotFound', missingSelectors: [...missing] };
    return { ok: true, conversationId, messages: thread.messages, missingSelectors: [...missing] };
  }

  /** Put text into Kaspi's composer in a way frameworks (React/Vue) notice. */
  function insertText(input, text) {
    input.focus();
    if (input.isContentEditable) {
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, text);
      return;
    }
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Send a reply through Kaspi's own chat UI, then verify it appears. */
  async function chatSend({ conversationId, text }) {
    missing.clear();
    if (!text || !text.trim()) return { ok: false, error: 'emptyMessage' };
    if (String(conversationId).startsWith('~')) return { ok: false, error: 'conversationIdUnstable', missingSelectors: ['chat.conversationFields.id'] };
    if (!(await openConversation(conversationId))) return { ok: false, error: 'conversationNotVisible', needsNavigation: true };
    // Never type into a thread we cannot prove is the requested one.
    const opened = parseThread();
    if (!opened || opened.conversationId !== String(conversationId)) {
      return { ok: false, error: 'conversationIdUnstable', missingSelectors: [...missing, 'chat.threadId'] };
    }
    const needle = text.trim().slice(0, 40);
    const countMine = (th) => (th?.messages || []).filter((m) => m.from === 'seller' && m.text.includes(needle)).length;
    const before = countMine(opened);
    const input = queryOne(S.chat.input, document, 'chat.input', true);
    if (!input) return { ok: false, error: 'chatInputNotFound', missingSelectors: [...missing] };
    insertText(input, text);
    await sleep(150);
    const send = queryOne(S.chat.sendButton, document, 'chat.sendButton', true);
    if (!send) return { ok: false, error: 'chatSendNotFound', missingSelectors: [...missing] };
    send.click();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const thread = parseThread();
      if (countMine(thread) > before) return { ok: true, verified: true, messages: thread.messages };
      await sleep(400);
    }
    return { ok: true, verified: false };
  }

  /* ================= messaging ================= */

  const handlers = {
    'ksh:ping': () => ({ ok: true, ...sessionInfo() }),
    'ksh:snapshot': () => snapshot(),
    'ksh:pack': packOrder,
    'ksh:invoice': fetchInvoice,
    'ksh:payments': paymentStatuses,
    'ksh:chatList': () => {
      missing.clear();
      const info = sessionInfo();
      return { ok: true, ...info, chat: info.authenticated ? parseConversations() : { status: 'notVisible' }, missingSelectors: [...missing] };
    },
    'ksh:chatThread': chatThread,
    'ksh:chatSend': chatSend,
  };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    const fn = handlers[msg?.type];
    if (!fn) return false;
    Promise.resolve()
      .then(() => fn(msg.payload || {}))
      .then(sendResponse)
      .catch((e) => {
        console.error(LOG, msg.type, e);
        sendResponse({ ok: false, error: e.message || 'contentError', missingSelectors: [...missing] });
      });
    return true; // async response
  });

  /* ================= announcements & live updates ================= */

  /** Message the worker; after an extension reload this instance shuts itself down. */
  const send = (msg) => {
    if (!alive()) return shutdown();
    try {
      chrome.runtime.sendMessage(msg).catch(() => {}); // the worker may be asleep — it re-pings on demand
    } catch {
      shutdown();
    }
  };

  let lastHref = '';
  function hello() {
    lastHref = location.href;
    send({ type: 'content:hello', payload: sessionInfo() });
  }

  let updateTimer = null;
  let lastPushed = '';
  let lastPushAt = 0;
  /** Push a fresh snapshot when the visible data changes (debounced, ≥10 s apart). */
  function scheduleUpdate() {
    if (updateTimer) return; // already scheduled — never starve on pages that mutate constantly
    updateTimer = setTimeout(() => {
      updateTimer = null;
      if (!['orders', 'returns', 'refusals', 'analytics', 'chat'].includes(detectPage()) && !Object.keys(netCache).length) return;
      if (Date.now() - lastPushAt < 10000) return scheduleUpdate();
      const snap = snapshot();
      const sig = JSON.stringify(snap.sections);
      if (sig === lastPushed) return;
      lastPushed = sig;
      lastPushAt = Date.now();
      send({ type: 'content:update', payload: snap });
    }, 4000);
  }

  const observer = new MutationObserver(scheduleUpdate);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const routeTimer = setInterval(() => location.href !== lastHref && hello(), 1000); // SPA route changes

  function shutdown() {
    observer.disconnect();
    clearInterval(routeTimer);
    clearTimeout(updateTimer);
  }

  hello();
})();
