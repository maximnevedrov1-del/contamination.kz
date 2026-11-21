// Kaspi Shop API mock with a LOT of orders — load test of the extension (not of Kaspi).
//   ORDERS=5000 STORES=5 RATE429=0 node loadmock.js
// Every token GOOD-TOKEN-L<n> is a separate store with ORDERS orders over 90 days.
// Same formats and limits as tests/e2e/mockapi.js: state filter required, creationDate range
// ≤ 14 days, page size ≤ 100. RATE429=N answers 429 to every N-th list request (Kaspi busy).
const http = require('http');
const PORT = 8099, DAY = 86400000;
const ORDERS = +process.env.ORDERS || 5000, STORES = +process.env.STORES || 5, RATE429 = +process.env.RATE429 || 0;
const now = Date.now();
const stats = { requests: 0, list: 0, entries: 0, byToken: {}, r429: 0, maxConcurrent: 0 };
let inFlight = 0;

// deterministic pseudo-random per store
const rnd = (seed) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const PRODUCTS = Array.from({ length: 400 }, (_, i) => ({ code: `SKU${String(i).padStart(4, '0')}`, name: `Товар ${i} — ${['колодки', 'фильтр', 'свечи', 'масло', 'щётки', 'лампа', 'датчик', 'ремень'][i % 8]}`, cat: ['Автозапчасти', 'Масла', 'Электрика', 'Аксессуары'][i % 4] }));
const stores = {};
for (let s = 1; s <= STORES; s++) {
  const r = rnd(s * 7919);
  const orders = [];
  for (let i = 0; i < ORDERS; i++) {
    const code = String(700000000 + s * 10000000 + i);
    const age = r() * 89.5 * DAY;
    const x = r();
    // ~2 % active (new / to sign / pickup / delivery), the rest archive (completed / cancelled / returned)
    const [state, status] = age < 3 * DAY && x < 0.25 ? [['NEW', 'SIGN_REQUIRED', 'PICKUP', 'DELIVERY', 'KASPI_DELIVERY'][Math.floor(r() * 5)], 'APPROVED_BY_BANK'] : ['ARCHIVE', x < 0.08 ? 'CANCELLED' : x < 0.12 ? 'RETURNED' : 'COMPLETED'];
    const lines = 1 + Math.floor(r() * r() * 3);
    const entries = Array.from({ length: lines }, () => {
      const p = PRODUCTS[Math.floor(r() * PRODUCTS.length)];
      const q = 1 + Math.floor(r() * r() * 3), price = 1000 + Math.floor(r() * 40) * 500;
      return { quantity: q, basePrice: price, totalPrice: price * q, offer: { code: p.code, name: p.name }, category: { title: p.cat } };
    });
    orders.push({
      type: 'orders',
      id: Buffer.from(code).toString('base64'),
      attributes: {
        code, creationDate: Math.round(now - age), totalPrice: entries.reduce((n, e) => n + e.totalPrice, 0), deliveryCostForSeller: 0,
        isKaspiDelivery: x > 0.2, preOrder: false, approvedByBankDate: Math.round(now - age + 60000), signatureRequired: state === 'SIGN_REQUIRED',
        status, state, paymentMode: 'PREPAID', deliveryMode: 'DELIVERY_PICKUP', customer: { name: `Покупатель ${i}`, cellPhone: '7000000000' },
        assembled: false, cancellationReason: status === 'CANCELLED' ? 'BUYER_CANCELLATION_BY_MERCHANT' : undefined,
        kaspiDelivery: { waybill: null, waybillNumber: null, courierTransmissionPlanningDate: now + DAY },
      },
      _entries: entries,
    });
  }
  stores[`GOOD-TOKEN-L${s}`] = { orders, byId: new Map(orders.map((o) => [o.id, o])) };
}
const pub = (o) => { const { _entries, ...rest } = o; return { ...rest, relationships: { entries: { links: { related: `http://localhost:${PORT}/shop/api/v2/orders/${o.id}/entries` } } } }; };

http.createServer((req, res) => {
  inFlight++; stats.maxConcurrent = Math.max(stats.maxConcurrent, inFlight);
  const send = (code, obj) => { inFlight--; res.writeHead(code, { 'Content-Type': 'application/vnd.api+json' }); res.end(JSON.stringify(obj)); };
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname === '/__stats') return send(200, stats);
  if (u.pathname === '/__reset') { Object.assign(stats, { requests: 0, list: 0, entries: 0, byToken: {}, r429: 0, maxConcurrent: 0 }); return send(200, {}); }
  const tok = req.headers['x-auth-token'] || '';
  const st = stores[tok];
  if (!st) return send(401, { message: 'Full authentication is required to access this resource.' });
  stats.requests++; stats.byToken[tok] = (stats.byToken[tok] || 0) + 1;
  const m = u.pathname.match(/^\/shop\/api\/v2\/orders(?:\/([^/]+)\/entries)?$/);
  if (!m) return send(404, {});
  if (m[1]) {
    stats.entries++;
    const o = st.byId.get(m[1]);
    return send(200, { data: (o?._entries || []).map((a, i) => ({ type: 'orderentries', id: `${m[1]}-${i}`, attributes: a })) });
  }
  const p = Object.fromEntries(u.searchParams);
  if (p['filter[orders][code]']) return send(200, { data: st.orders.filter((o) => o.attributes.code === p['filter[orders][code]']).map(pub), meta: { pageCount: 1, totalCount: 1 } });
  stats.list++;
  if (RATE429 && stats.list % RATE429 === 0) { stats.r429++; inFlight--; res.writeHead(429, { 'Retry-After': '1' }); return res.end('{}'); }
  const state = p['filter[orders][state]'], ge = +p['filter[orders][creationDate][$ge]'], le = +p['filter[orders][creationDate][$le]'];
  if (!state || !ge || !le) return send(200, { data: [], meta: { pageCount: 0, totalCount: 0 } });
  if (le - ge > 14 * DAY) return send(400, { message: 'range too big' });
  const size = Math.min(100, +p['page[size]'] || 20), page = +p['page[number]'] || 0;
  const hits = st.orders.filter((o) => o.attributes.state === state && o.attributes.creationDate >= ge && o.attributes.creationDate <= le);
  setTimeout(() => send(200, { data: hits.slice(page * size, page * size + size).map(pub), included: [], meta: { pageCount: Math.ceil(hits.length / size), totalCount: hits.length } }), 40); // Kaspi-like latency
}).listen(PORT, () => console.log(`load mock on ${PORT}: ${STORES} stores × ${ORDERS} orders`));
