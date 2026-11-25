// Mock of the Kaspi Shop API (formats from guide.kaspi.kz q3201/q3202/q3209/q3210/q3211/q3213).
const http = require('http');
const PORT = 8099, TOKEN = 'GOOD-TOKEN-1234', DAY = 86400000;
const now = Date.now();
const log = [];
const imports = new Map();
let importSeq = 0;
const orders = [];
const mk = (i, over) => {
  const code = String(800000000 + i);
  const id = Buffer.from(code).toString('base64');
  return { type: 'orders', id, attributes: { code, creationDate: now - (i % 85) * DAY - 3600000, totalPrice: 10000 + (i * 1371) % 50000, deliveryCostForSeller: 0, isKaspiDelivery: i % 5 !== 0, preOrder: false, approvedByBankDate: now - (i % 85) * DAY, signatureRequired: false, status: 'COMPLETED', state: 'ARCHIVE', paymentMode: 'PREPAID', deliveryMode: 'DELIVERY_PICKUP', customer: { name: 'SECRET NAME', cellPhone: '7000000000' }, assembled: false, kaspiDelivery: { waybill: null, waybillNumber: null, courierTransmissionDate: null, courierTransmissionPlanningDate: now + DAY }, ...over } };
};
// 130 archive orders (pagination >100 in one window? spread over 85 days) + active ones
for (let i = 0; i < 130; i++) orders.push(mk(i, i % 9 === 0 ? { status: 'CANCELLED', cancellationReason: 'MERCHANT_OUT_OF_STOCK', approvedByBankDate: null } : i % 11 === 0 ? { status: 'RETURNED' } : {}));
// put >100 orders inside one 14-day window to force paging
for (let i = 0; i < 105; i++) orders.push(mk(1000 + i, { creationDate: now - 2 * DAY - i * 60000 }));
orders.push(mk(2001, { status: 'APPROVED_BY_BANK', state: 'KASPI_DELIVERY', creationDate: now - 3600000, isKaspiDelivery: true }));
orders.push(mk(2002, { status: 'APPROVED_BY_BANK', state: 'KASPI_DELIVERY', creationDate: now - 7200000, isKaspiDelivery: true }));
orders.push(mk(2003, { status: 'APPROVED_BY_BANK', state: 'SIGN_REQUIRED', signatureRequired: true, creationDate: now - 5400000, paymentMode: 'PAY_WITH_CREDIT' }));
orders.push(mk(2004, { status: 'ACCEPTED_BY_MERCHANT', state: 'DELIVERY', creationDate: now - 9000000, isKaspiDelivery: false }));
const byId = new Map(orders.map((o) => [o.id, o]));
const withLinks = (o) => ({ ...o, relationships: { entries: { links: { related: `http://localhost:${PORT}/shop/api/v2/orders/${o.id}/entries` } }, user: { data: { id: 'x', type: 'customers' } } }, links: { self: `http://localhost:${PORT}/shop/api/v2/orders/${o.id}` } });
// odd order numbers get a 100×150 mm label (thermal printers), even ones an A4 sheet
const PDF = (code) => Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 ${Number(String(code).replace(/\D/g, '')) % 2 ? '283.46 425.2' : '595 842'}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n4 0 obj << /Length 60 >> stream\nBT /F1 28 Tf 60 700 Td (KASPI WAYBILL ${code}) Tj ET\nendstream endobj\n5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF`, 'latin1');
http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  // Demo tokens GOOD-TOKEN-S<n> (landing-page screenshots): same orders, but their own order
  // numbers and amounts, so several demo stores do not look identical. Tests don't use them.
  const demo = /^GOOD-TOKEN-S(\d)$/.exec(req.headers['x-auth-token'] || '');
  const OFF = demo ? Number(demo[1]) * 3100000 : 0;
  const F = demo ? [1, 0.83, 1.27, 0.64][Number(demo[1]) % 4] : 1;
  const demoOut = (obj) => {
    for (const it of obj?.data ? [].concat(obj.data) : []) {
      const a = it.attributes || {};
      if (it.type === 'orders' && a.code) Object.assign(a, { code: String(Number(a.code) + OFF), totalPrice: Math.round(a.totalPrice * F) });
      if (it.type === 'orderentries') Object.assign(a, { basePrice: Math.round(a.basePrice * F), totalPrice: Math.round(a.totalPrice * F) });
    }
    return obj;
  };
  if (demo && u.searchParams.get('filter[orders][code]')) u.searchParams.set('filter[orders][code]', String(Number(u.searchParams.get('filter[orders][code]')) - OFF));
  const send = (code, obj, type = 'application/vnd.api+json') => { if (demo && obj && typeof obj === 'object' && !Buffer.isBuffer(obj)) obj = demoOut(structuredClone(obj)); res.writeHead(code, { 'Content-Type': type }); res.end(typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj)); };
  if (u.pathname === '/__log') return send(200, log);
  // public product page on kaspi.kz (no token): its og:image is the product photo
  const pp = u.pathname.match(/^\/shop\/p\/-(\d+)\/$/);
  if (pp) { log.push({ productPage: pp[1] }); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(`<html><head><meta property="og:image" content="https://resources.cdn-kaspi.kz/img/m/p/mock/${pp[1]}.jpg?format=gallery-large"></head><body>товар</body></html>`); }
  // outage simulation for the API health tests: /__down?on=1 → every API call answers 502
  if (u.pathname === '/__down') { globalThis.DOWN = u.searchParams.get('on') === '1'; return send(200, { down: globalThis.DOWN }); }
  if (globalThis.DOWN && u.pathname.startsWith('/shop/api/')) return send(502, '<html>Bad Gateway</html>', 'text/html');
  if (u.pathname.startsWith('/waybill/')) { log.push({ waybillToken: req.headers['x-auth-token'] || null }); return send(200, PDF(u.pathname.split('/')[2]), 'application/pdf'); }
  if (!/^GOOD-TOKEN-/.test(req.headers['x-auth-token'] || '')) return send(401, { message: 'Full authentication is required to access this resource.' });
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    // ---- Content API (guide.kaspi.kz/partner/ru/shop/api/goods q3216–q3222) ----
    if (u.pathname.startsWith('/shop/api/products/')) {
      const tok = req.headers['x-auth-token'];
      const P = u.pathname.replace('/shop/api/products', '');
      if (P === '/classification/categories') return send(200, [{ code: 'Master - Exercise notebooks', title: 'Тетради' }, { code: 'Master - Brake pads', title: 'Тормозные колодки' }], 'application/json');
      if (P === '/classification/attributes') {
        if (u.searchParams.get('c') !== 'Master - Exercise notebooks') return send(200, [], 'application/json');
        const pre = 'Exercise notebooks*Obsie harakteristiki.exercise notebooks*';
        return send(200, [{ code: pre + 'cover', type: 'enum', multiValued: false, mandatory: true }, { code: pre + 'fields', type: 'boolean', multiValued: false, mandatory: true }, { code: pre + 'number of sheets', type: 'number', multiValued: false, mandatory: true }, { code: pre + 'notice', type: 'string', multiValued: false, mandatory: false }], 'application/json');
      }
      if (P === '/classification/attribute/values') return send(200, [{ code: 'мягкая', name: 'мягкая' }, { code: 'твердая', name: 'твердая' }], 'application/json');
      if (P === '/import' && req.method === 'POST') {
        let items; try { items = JSON.parse(body); } catch { return send(400, { message: 'bad json' }, 'application/json'); }
        const code = 'imp-' + (++importSeq);
        imports.set(code, { tok, items, polls: 0 });
        log.push({ cardImport: code, token: tok, contentType: req.headers['content-type'], items });
        return send(200, { code, status: 'UPLOADED' }, 'application/json');
      }
      const imp = imports.get(u.searchParams.get('i'));
      if (!imp || imp.tok !== tok) return send(404, { message: 'not found' }, 'application/json');
      if (P === '/import') return send(200, { code: u.searchParams.get('i'), status: ++imp.polls >= 1 ? 'FINISHED' : 'PROCESSING' }, 'application/json');
      if (P === '/import/result') return send(200, { errors: 0, warnings: 0, skipped: 0, total: imp.items.length, result: Object.fromEntries(imp.items.map((i) => [i.sku, { state: 'FINISHED' }])) }, 'application/json');
      return send(404, {}, 'application/json');
    }
    // product card of an order line (q3207) and the public product page with its og:image
    const pc = u.pathname.match(/^\/shop\/api\/v2\/orderentries\/e-(\d)\/product$/);
    if (pc) { log.push({ productCard: pc[1] }); return send(200, { data: { type: 'masterproducts', id: 'mp' + pc[1], attributes: { code: `10340329${pc[1]}`, name: 'x', category: 'Автозапчасти' } } }); }
    const m = u.pathname.match(/^\/shop\/api\/v2\/orders(?:\/([^/]+)\/entries)?$/);
    if (!m) return send(404, {});
    if (m[1]) { const o = byId.get(m[1]); const n = Number(o.attributes.code) % 3; return send(200, { data: [{ type: 'orderentries', id: 'e', relationships: { product: { links: { related: `http://localhost:${PORT}/shop/api/v2/orderentries/e-${n}/product` } } }, attributes: { quantity: 1 + (n === 2), basePrice: o.attributes.totalPrice, totalPrice: o.attributes.totalPrice, offer: { code: `SKU-${n}`, name: ['Тормозные колодки', 'Фильтр масляный', 'Свечи зажигания'][n] }, category: { title: 'Автозапчасти' } } }] }); }
    if (req.method === 'POST') {
      const d = JSON.parse(body).data; const o = byId.get(d.id); log.push({ post: d.attributes, id: d.id });
      if (!o) return send(400, { message: 'not found' });
      const a = o.attributes, want = d.attributes.status;
      if (want === 'ACCEPTED_BY_MERCHANT') { if (a.status !== 'APPROVED_BY_BANK' || d.attributes.code !== a.code) return send(400, { message: 'bad state' }); a.status = 'ACCEPTED_BY_MERCHANT'; }
      else if (want === 'ASSEMBLE') { if (a.status !== 'ACCEPTED_BY_MERCHANT' || !d.attributes.numberOfSpace) return send(400, { message: 'bad state' }); a.assembled = true; setTimeout(() => (a.kaspiDelivery.waybill = `http://localhost:${PORT}/waybill/${a.code}.pdf`, a.kaspiDelivery.waybillNumber = '42' + a.code), 3000); }
      else return send(400, { message: 'unsupported in mock' });
      return send(200, { data: { type: 'orders', id: o.id, attributes: { code: a.code, status: a.status } }, included: [] });
    }
    const p = Object.fromEntries(u.searchParams);
    if (p['filter[orders][code]']) return send(200, { data: orders.filter((o) => o.attributes.code === p['filter[orders][code]']).map(withLinks), meta: { pageCount: 1, totalCount: 1 } });
    const st = p['filter[orders][state]'], ge = +p['filter[orders][creationDate][$ge]'], le = +p['filter[orders][creationDate][$le]'];
    log.push({ list: st, days: Math.round((le - ge) / DAY) });
    if (!st || !ge || !le) return send(200, { data: [], meta: { pageCount: 0, totalCount: 0 } });
    if (le - ge > 14 * DAY) return send(400, { message: 'range too big' });
    const size = Math.min(100, +p['page[size]'] || 20), page = +p['page[number]'] || 0;
    const hits = orders.filter((o) => o.attributes.state === st && o.attributes.creationDate >= ge && o.attributes.creationDate <= le);
    send(200, { data: hits.slice(page * size, page * size + size).map(withLinks), included: [], meta: { pageCount: Math.ceil(hits.length / size), totalCount: hits.length } });
  });
}).listen(PORT, () => console.log('mock api on', PORT));
