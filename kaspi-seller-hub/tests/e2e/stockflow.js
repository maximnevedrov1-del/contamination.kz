// Stock follows shipments, in the real extension (API test copy, mock Kaspi on :8099):
// token connected → Home asks for the price list → price list imported (orders already shipped are
// not written off) → an order is accepted and packed in SaudaPulse → its quantity is taken off that
// store's stock at once, logged in «Движение остатков», the price list Kaspi reads carries the new stock.
//   ./mock-up.sh && node stockflow.js
const { chromium } = require('playwright'); require('./offline');
const fs = require('node:fs');
const EXT = __dirname + '/../apicopy';
let fails = 0;
const check = (n, ok, i = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, i); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const prof = __dirname + '/stockprof';
  fs.rmSync(prof, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(prof, { headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 }, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const errs = [];
  const d = await ctx.newPage();
  d.on('pageerror', (e) => errs.push(e.message));
  const send = (type, payload) => d.evaluate(([t, p]) => chrome.runtime.sendMessage({ type: t, payload: p }), [type, payload]);
  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#home`);
  await d.waitForFunction(() => !document.querySelector('#refreshBtn').disabled, null, { timeout: 30000 });

  const con = await send('ui:connectApi', { name: 'Склад 1', token: 'GOOD-TOKEN-1234' });
  check('store connected by token', con?.ok, JSON.stringify(con));
  const shopId = con.shopId;
  await send('ui:sync');
  // order contents load up to 300 per sync, active orders first
  for (let i = 0; i < 3; i++) await send('ui:sync');
  await d.reload();
  await d.waitForSelector('[data-card=pricelist]', { timeout: 20000 });
  const card = await d.textContent('[data-card=pricelist]');
  check('Home: «Заказы загружены… загрузите прайс-лист из кабинета Kaspi — 1 минута» with the 3 steps', /Заказы загружены/.test(card) && /1 минута/.test(card) && /Управление товарами → Прайс-лист → Скачать/.test(card) && /после первой продажи/.test(card) && /Склад 1/.test(card), card.slice(0, 160));
  await d.screenshot({ path: __dirname + '/stock-home-card.png', clip: await d.locator('[data-card=pricelist]').boundingBox() });
  await d.click('[data-action=pricelist-import]');
  await d.waitForFunction(() => location.hash === '#catalog');
  check('button opens «Выгрузка товаров»', true);

  // the price list downloaded from the Kaspi cabinet: 20 of each product
  const offers = ['SKU-0', 'SKU-1', 'SKU-2'].map((sku) => ({ sku, title: sku, brand: '', price: 5000, stock: 20, warehouses: ['PP1'] }));
  const imp = await send('ui:catalogImport', { shopId, offers, merchantId: 'M1', company: 'Тест', warehouses: ['PP1'] });
  check('price list imported', imp?.ok && imp.added === 3, JSON.stringify(imp));
  const stockOf = async () => Object.fromEntries(Object.values(await d.evaluate(async () => (await chrome.storage.local.get('ksh.catalog'))['ksh.catalog'])).map((p) => [p.sku, p.stores[Object.keys(p.stores)[0]].stock]));
  await send('ui:sync');
  check('after import + sync: orders already delivered before the import are NOT written off', JSON.stringify(await stockOf()) === JSON.stringify({ 'SKU-0': 20, 'SKU-1': 20, 'SKU-2': 20 }), JSON.stringify(await stockOf()));
  await d.reload();
  await sleep(1500);
  check('Home card gone once the price list is in', (await d.locator('[data-card=pricelist]').count()) === 0);

  // a new Kaspi Delivery order (came in before the import) is accepted and packed in SaudaPulse
  const code = '800002001';
  const n = Number(code) % 3; // mock: SKU-n, quantity 1 (2 for SKU-2)
  const qty = 1 + (n === 2);
  const acc = await send('ui:accept', { items: [{ shopId, orderId: code }] });
  check('order accepted', acc?.results?.[0]?.ok ?? acc?.ok, JSON.stringify(acc).slice(0, 160));
  const pk = await send('ui:pack', { items: [{ shopId, orderId: code }] });
  check('order packed (waybill)', pk?.results?.[0]?.ok ?? pk?.ok, JSON.stringify(pk).slice(0, 200));
  let st = {};
  for (let i = 0; i < 20; i++) {
    st = await stockOf();
    if (st[`SKU-${n}`] === 20 - qty) break;
    await sleep(500);
  }
  check(`packed → SKU-${n}: 20 → ${20 - qty} at once; the other products untouched`, st[`SKU-${n}`] === 20 - qty && Object.entries(st).every(([k, v]) => k === `SKU-${n}` || v === 20), JSON.stringify(st));
  await send('ui:sync');
  await send('ui:sync');
  check('later syncs do not write it off twice', (await stockOf())[`SKU-${n}`] === 20 - qty, JSON.stringify(await stockOf()));
  const xml = await send('ui:feedXml', { shopId });
  const line = (xml?.xml || '').split('<offer ').find((o) => o.includes(`sku="SKU-${n}"`)) || '';
  check(`the price list Kaspi reads carries stockCount="${20 - qty}"`, line.includes(`stockCount="${20 - qty}"`), line.slice(0, 200));

  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#catalog`);
  await d.reload();
  await d.waitForSelector('[data-card=stock-moves] table', { timeout: 15000 });
  const moves = await d.textContent('[data-card=stock-moves]');
  check('«Движение остатков»: order, SKU, −qty, left', moves.includes(`№ ${code}`) && moves.includes(`SKU-${n}`) && moves.includes(`-${qty}`) && moves.includes(String(20 - qty)), moves.slice(0, 220));
  await d.locator('[data-card=stock-moves]').screenshot({ path: __dirname + '/stock-moves.png' });
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
  fs.rmSync(prof, { recursive: true, force: true });
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('CRASH', e.message); process.exit(1); });
