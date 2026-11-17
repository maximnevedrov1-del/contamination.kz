// Unit tests of shared/catalog.js, run inside Chromium (DOMParser, DecompressionStream).
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '../..');
const FIX = path.join(__dirname, '../fixtures');

const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const file = u.startsWith('/fixtures/') ? path.join(FIX, u.slice(10)) : path.join(ROOT, u);
  if (!fs.existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}).listen(8124);

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto('http://localhost:8124/fixtures/none');
  const out = await p.evaluate(async () => {
    const C = await import('/shared/catalog.js');
    const r = [];
    const ok = (n, c, i = '') => r.push([c ? 'PASS' : 'FAIL', n, i]);

    // validation
    ok('valid product', C.validateProduct({ sku: 'NB48', title: 'Тетрадь', brand: 'Erich', price: '1 200 ₸', stock: '5' }).errors.length === 0);
    const bad = C.validateProduct({ sku: 'нет-латиницы', title: '', brand: '', price: 0, stock: -1, preOrder: 31, images: ['http://x'] }).errors;
    ok('invalid fields reported', ['sku', 'title', 'brand', 'price', 'stock', 'preOrder', 'images'].every((f) => bad.includes(f)), bad.join(','));
    ok('sku > 20 chars rejected for new products', C.validateProduct({ sku: 'A'.repeat(21), title: 'x', brand: 'y', price: 1 }).errors.includes('sku'));
    ok('imported sku with dash kept', C.validateProduct({ sku: 'FLT-7', title: 'x', brand: 'y', price: 1, imported: true }).errors.length === 0);
    ok('card needs category + photo', C.validateProduct({ sku: 'A1', title: 'x', brand: 'y', price: 1 }, { requireCard: true }).errors.join() === 'category,images');
    ok('price parsed from "12 990 ₸"', C.validateProduct({ sku: 'A1', title: 'x', brand: 'y', price: '12 990 ₸' }).product.price === 12990);

    // per-store offers
    const prod = { sku: 'A1', title: 'Колодки & <Chery> "T11"', brand: 'Chery', price: 15000, stock: 3, preOrder: null, stores: { s1: { on: true }, s2: { on: true, price: 16000, stock: 0, preOrder: 5 }, s3: { on: false } } };
    ok('store default = product price', C.offerFor(prod, 's1').price === 15000 && C.offerFor(prod, 's1').stock === 3);
    ok('store override price/stock', C.offerFor(prod, 's2').price === 16000 && C.offerFor(prod, 's2').stock === 0);

    // XML price list
    const feed = { merchantId: '30123456', company: 'ТОО "Ромашка" & Ко', warehouses: ['PP1', 'PP2', 'bad id!'] };
    const other = { sku: 'B2', title: 'Фильтр', brand: 'Mann', price: 4500, stock: 0, stores: { s1: { on: true } } };
    const xml1 = C.buildPriceListXml(feed, [prod, other], 's1');
    const doc = new DOMParser().parseFromString(xml1, 'application/xml');
    ok('XML is well-formed', !doc.getElementsByTagName('parsererror').length);
    ok('root, namespace, merchant', doc.documentElement.localName === 'kaspi_catalog' && doc.documentElement.namespaceURI === 'kaspiShopping' && doc.getElementsByTagNameNS('*', 'merchantid')[0].textContent === '30123456');
    ok('special characters escaped and restored', doc.getElementsByTagNameNS('*', 'model')[0].textContent === 'Колодки & <Chery> "T11"' && doc.getElementsByTagNameNS('*', 'company')[0].textContent === 'ТОО "Ромашка" & Ко');
    const av = [...doc.getElementsByTagNameNS('*', 'offer')[0].getElementsByTagNameNS('*', 'availability')];
    ok('one availability per valid warehouse', av.length === 2 && av[0].getAttribute('storeId') === 'PP1' && av[0].getAttribute('available') === 'yes' && av[0].getAttribute('stockCount') === '3' && !av[0].hasAttribute('preOrder'));
    const av2 = doc.getElementsByTagNameNS('*', 'offer')[1].getElementsByTagNameNS('*', 'availability')[0];
    ok('out of stock → available="no"', av2.getAttribute('available') === 'no');
    const xml2 = new DOMParser().parseFromString(C.buildPriceListXml(feed, [prod, other], 's2'), 'application/xml');
    const a2 = xml2.getElementsByTagNameNS('*', 'availability')[0];
    ok('store 2: own price, pre-order → available', xml2.getElementsByTagNameNS('*', 'price')[0].textContent === '16000' && a2.getAttribute('available') === 'yes' && a2.getAttribute('preOrder') === '5');
    ok('store 2 does not list the product switched on only in store 1', xml2.getElementsByTagNameNS('*', 'offer').length === 1);
    ok('store 3 (off) → empty offers', new DOMParser().parseFromString(C.buildPriceListXml(feed, [prod], 's3'), 'application/xml').getElementsByTagNameNS('*', 'offer').length === 0);
    let thrown = '';
    try { C.buildPriceListXml({ ...feed, warehouses: ['!!'] }, [prod], 's1'); } catch (e) { thrown = e.message; }
    ok('no valid warehouse → refused', thrown === 'noWarehouses');
    ok('control characters dropped', !/\u0007/.test(C.buildPriceListXml(feed, [{ ...prod, title: 'a\u0007b' }], 's1')));
    ok('offerCount', C.offerCount([prod, other], 's1') === 2 && C.offerCount([prod, other], 's3') === 0);

    // round trip: our XML read back by our importer
    const back = C.parseXmlPriceList(xml1);
    ok('round trip XML → offers', back.offers.length === 2 && back.offers[0].sku === 'A1' && back.offers[0].price === 15000 && back.merchantId === '30123456');

    // Kaspi sample XML (guide example) import
    const xmlBuf = await (await fetch('/fixtures/pricelist.xml')).arrayBuffer();
    const kx = await C.readPriceListFile(xmlBuf);
    ok('Kaspi XML: 2 offers', kx.offers.length === 2, JSON.stringify(kx.offers));
    ok('Kaspi XML: price, stock = max of warehouses, pre-order, warehouses', kx.offers[0].price === 6418 && kx.offers[0].stock === 234 && kx.offers[0].preOrder === 20 && kx.offers[0].warehouses.join() === 'PP1,PP2');
    ok('Kaspi XML: city prices → lowest', kx.offers[1].price === 193000 && kx.offers[1].stock === 0);
    ok('Kaspi XML: company and merchant', kx.company === 'ТОО Ромашка' && kx.merchantId === '30123456');

    // Excel (.xlsx) import
    const xlBuf = await (await fetch('/fixtures/pricelist.xlsx')).arrayBuffer();
    const kxl = await C.readPriceListFile(xlBuf);
    ok('Excel: 3 offers, title row skipped', kxl.offers.length === 3, JSON.stringify(kxl.offers));
    ok('Excel: columns by header', kxl.offers[0].sku === 'BP100' && kxl.offers[0].title === 'Колодки Chery T11' && kxl.offers[0].brand === 'Chery' && kxl.offers[0].price === 15000 && kxl.offers[0].stock === 1);
    ok('Excel: "12 990" price, special chars, pre-order', kxl.offers[2].price === 12990 && kxl.offers[2].title === 'Свечи <NGK>' && kxl.offers[1].preOrder === 5 && kxl.offers[1].stock === 0);
    let e2 = '';
    try { await C.readPriceListFile(new TextEncoder().encode('just text').buffer); } catch (e) { e2 = e.message; }
    ok('garbage file → badFile', e2 === 'badFile');

    // merge into catalog
    const m = C.mergeImport({ A1: prod }, [...kxl.offers, { sku: 'A1', price: 14000, stock: 9 }], 's9');
    ok('merge: 3 new + 1 updated', m.added === 3 && m.updated === 1);
    ok('merge: existing product switched on in the store with imported price', m.catalog.A1.stores.s9.on && m.catalog.A1.stores.s9.price === 14000 && m.catalog.A1.stores.s1.on);
    ok('merge: new product imported flag', m.catalog.BP100.imported && m.catalog.BP100.stores.s9.on);

    // card upload body
    const item = C.toImportItem({ sku: 'NB48', title: 'Тетрадь', brand: 'Erich', category: 'Master - Exercise notebooks', description: 'd', images: ['https://x/1.jpg'], attributes: { a: 'мягкая', b: '', c: 48, d: false } });
    ok('card body: attributes as code/value, empty dropped, false kept', JSON.stringify(item.attributes) === '[{"code":"a","value":"мягкая"},{"code":"c","value":48},{"code":"d","value":false}]');
    ok('card body: images as {url}', item.images[0].url === 'https://x/1.jpg' && item.category === 'Master - Exercise notebooks');
    ok('shop slug is stable and safe', C.shopSlug('1001') === C.shopSlug('1001') && /^shop-[a-z0-9]{1,13}$/.test(C.shopSlug('api-w4rj63ye')) && C.shopSlug('a') !== C.shopSlug('b'));
    return r;
  });
  out.forEach(([s, n, i]) => console.log(s, n, i));
  const f = out.filter((x) => x[0] === 'FAIL').length;
  console.log(f ? f + ' FAILED' : `ALL PASS (${out.length})`);
  await b.close();
  srv.close();
})();
