// Product photos from Kaspi, in the real extension (API test copy, mock Kaspi on :8099):
//  1. ordered products get their photo by themselves: order line → product card (API, with token)
//     → public product page (no token, no cookies) → og:image on Kaspi's CDN;
//  2. a product never sold: «Товары без фото» → 📦 → paste the kaspi.kz product link → photo found → saved.
//   ./mock-up.sh && node photoflow.js
const { chromium } = require('playwright'); require('./offline');
const fs = require('node:fs');
const EXT = __dirname + '/../apicopy';
let fails = 0;
const check = (n, ok, i = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, i); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mlog = () => fetch('http://localhost:8099/__log').then((r) => r.json());
(async () => {
  const prof = __dirname + '/photoprof2';
  fs.rmSync(prof, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(prof, { headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 }, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  // Kaspi's CDN is outside the test sandbox: serve a tiny picture for it
  await ctx.route('https://resources.cdn-kaspi.kz/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#10b981"/></svg>' }));
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const errs = [];
  const d = await ctx.newPage();
  d.on('pageerror', (e) => errs.push(e.message));
  const send = (type, payload) => d.evaluate(([t, p]) => chrome.runtime.sendMessage({ type: t, payload: p }), [type, payload]);
  const photos = () => d.evaluate(async () => (await chrome.storage.local.get('ksh.photos'))['ksh.photos'] || {});
  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#home`);
  await d.waitForFunction(() => !document.querySelector('#refreshBtn').disabled, null, { timeout: 30000 });
  const con = await send('ui:connectApi', { name: 'Склад 1', token: 'GOOD-TOKEN-1234' });
  check('store connected', con?.ok, JSON.stringify(con));
  const shopId = con.shopId;
  await send('ui:sync');

  // 1. automatic: the three products sold in the mock (SKU-0/1/2)
  let ph = {};
  for (let i = 0; i < 40; i++) {
    ph = await photos();
    if (['SKU-0', 'SKU-1', 'SKU-2'].every((s) => ph[s])) break;
    if (i % 8 === 7) await send('ui:sync');
    await sleep(1000);
  }
  check('photos of ordered products found by themselves (SKU-0, SKU-1, SKU-2)', ['SKU-0', 'SKU-1', 'SKU-2'].every((s) => /^https:\/\/resources\.cdn-kaspi\.kz\/img\/m\/p\/mock\/10340329\d\.jpg\?format=gallery-medium$/.test(ph[s] || '')), JSON.stringify(ph));
  const log = await mlog();
  check('product card asked with the token, product page opened without it', log.some((x) => x.productCard) && log.some((x) => x.productPage));
  const pages = log.filter((x) => x.productPage).length;
  await send('ui:sync');
  await sleep(3000);
  check('each product page opened once (not again on the next sync)', (await mlog()).filter((x) => x.productPage).length === pages, String(pages));
  const st = await send('ui:photoFinderState');
  check('finder state: 3 found', st?.found === 3, JSON.stringify(st));

  // photo shows in the order card
  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#products`);
  await d.reload();
  await d.waitForSelector('img.thumb[src*="cdn-kaspi"]', { timeout: 15000 }).catch(() => null);
  check('«Товары» shows the Kaspi photos', (await d.locator('img.thumb[src*="cdn-kaspi"]').count()) > 0);
  await d.locator('table').first().screenshot({ path: __dirname + '/photo-products.png' }).catch(() => {});

  // 2. a product never sold: paste the product link
  const imp = await send('ui:catalogImport', { shopId, offers: [{ sku: 'SKU-NEW', title: 'Новый фильтр', brand: '', price: 4000, stock: 5, warehouses: ['PP1'] }], merchantId: 'M1', company: 'Тест', warehouses: ['PP1'] });
  check('price list with a never-sold product imported', imp?.ok, JSON.stringify(imp));
  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#catalog`);
  await d.reload();
  await d.waitForSelector('[data-card=no-photo]', { timeout: 15000 });
  const card = await d.textContent('[data-card=no-photo]');
  check('«Товары без фото: 1» lists SKU-NEW', /Товары без фото: 1/.test(card) && card.includes('SKU-NEW'), card.slice(0, 160));
  await d.locator('[data-card=no-photo]').screenshot({ path: __dirname + '/photo-missing.png' });
  await d.click('[data-card=no-photo] [data-photo="SKU-NEW"]');
  await d.waitForSelector('#photoDialog[open]');
  await d.fill('[data-field=photo-url]', 'https://kaspi.kz/shop/p/novyi-filtr-999111/');
  await d.waitForSelector('#photoDialog .photo-preview img[src*="999111"]', { timeout: 15000 });
  await d.locator('#photoDialog').screenshot({ path: __dirname + '/photo-dialog.png' });
  await d.click('[data-action=photo-save]');
  await sleep(800);
  ph = await photos();
  check('pasted product link → its photo saved for SKU-NEW', /mock\/999111\.jpg/.test(ph['SKU-NEW'] || ''), ph['SKU-NEW']);
  await d.waitForFunction(() => /Товары без фото: 0/.test(document.querySelector('[data-card=no-photo]')?.textContent || ''), null, { timeout: 10000 }).catch(() => null);
  check('«Товары без фото: 0»', /Товары без фото: 0/.test(await d.textContent('[data-card=no-photo]')));
  await d.click('[data-card=no-photo] h2'); // focus away
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
  fs.rmSync(prof, { recursive: true, force: true });
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('CRASH', e.message); process.exit(1); });
