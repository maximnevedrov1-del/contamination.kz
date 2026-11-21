// Screenshots of the real extension UI for the landing page (site/assets/).
// Demo data only: mock Kaspi API (tests/e2e/mockapi.js on :8099), invented store names,
// no buyer data. Product "photos" are icons drawn on a canvas.
//   cd tests/e2e && node mockapi.js &
//   node ../../tools/site-shots/shots.js        (needs tests/apicopy — see tests/e2e/regress.sh)
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const EXT = path.join(__dirname, '../../tests/apicopy');
const OUT = path.join(__dirname, 'raw');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'prof' + Date.now()), { headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light', args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const d = await ctx.newPage();
  const url = (r) => `chrome-extension://${id}/dashboard/dashboard.html#${r}`;
  const msg = (type, payload) => d.evaluate(([t, p]) => chrome.runtime.sendMessage({ type: t, payload: p }), [type, payload]);
  await d.goto(url('home')); await sleep(800);
  await d.evaluate(() => { ['home', 'orders', 'returns', 'refusals', 'payments', 'analytics', 'products', 'catalog', 'chat', 'settings', 'account', 'help'].forEach((r) => localStorage.setItem(`ksh.guide.${r}`, '1')); localStorage.setItem('ksh.tourDone', '1'); });
  for (const [name, token] of [['Автозапчасти', 'GOOD-TOKEN-S1'], ['Шины Астана', 'GOOD-TOKEN-S2'], ['Масла и фильтры', 'GOOD-TOKEN-S3']]) {
    await msg('ui:connectApi', { shopId: null, name, token });
    await sleep(2500);
  }
  await sleep(6000);
  // product photos: an icon on a soft background per SKU of the mock
  const photos = await d.evaluate(() => {
    const draw = (emoji, bg) => {
      const c = document.createElement('canvas');
      c.width = c.height = 320;
      const x = c.getContext('2d');
      x.fillStyle = bg; x.fillRect(0, 0, 320, 320);
      x.font = '190px "Noto Color Emoji", "Apple Color Emoji", sans-serif';
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(emoji, 160, 175);
      return c.toDataURL('image/jpeg', 0.85);
    };
    return { 'SKU-0': draw('🛞', '#eef2f7'), 'SKU-1': draw('🛢️', '#f6f1e7'), 'SKU-2': draw('🔌', '#eef6f0') };
  });
  for (const [sku, src] of Object.entries(photos)) await msg('ui:setPhoto', { sku, src });
  // cost prices → profit visible
  for (const [sku, cost] of Object.entries({ 'SKU-0': 21000, 'SKU-1': 6500, 'SKU-2': 9800 })) await msg('ui:saveCost', { sku, cost });
  // a few products in «Выгрузка товаров»
  const shops = Object.keys((await msg('ui:getState')).settings.stores);
  const product = (sku, title, brand, price, stock) => ({ sku, title, brand, price, stock, stores: Object.fromEntries(shops.map((s, i) => [s, { on: i !== 2 || sku !== 'BP100' }])) });
  for (const p of [product('BP100', 'Колодки тормозные передние', 'Chery', 15000, 8), product('OF220', 'Фильтр масляный', 'Mann', 4200, 24), product('SP14', 'Свечи зажигания, комплект 4 шт.', 'NGK', 9800, 12), product('WB55', 'Щётки стеклоочистителя 55 см', 'Bosch', 6900, 30)]) {
    await msg('ui:catalogSave', { product: p });
  }
  await sleep(800);

  const shot = async (name, route, prep) => {
    await d.goto(url(route)); await d.reload(); await sleep(1600);
    if (prep) await prep();
    await d.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    await sleep(300);
    await d.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log('shot', name);
  };
  await shot('home', 'home');
  await shot('orders', 'orders', async () => { await d.click('.tabs .tab:has-text("Все")'); await sleep(500); });
  await shot('analytics', 'analytics', async () => { await d.click('#rangeSeg button[data-preset="30"]'); await sleep(1500); });
  await shot('catalog', 'catalog');
  // order card with photos
  await d.goto(url('orders')); await d.reload(); await sleep(1500);
  await d.click('.tabs .tab:has-text("Все")'); await sleep(400);
  await d.locator('#view tbody tr', { hasText: '803102002' }).first().locator('button.link').click();
  await d.waitForSelector('#orderDialog[open]'); await sleep(600);
  await d.locator('#orderDialog').screenshot({ path: path.join(OUT, 'order-card.png') });
  console.log('shot order-card');
  await d.keyboard.press('Escape');
  // printer settings card (thermal printer chosen)
  await msg('ui:saveSettings', { patch: { print: { paper: 'label', labelW: 100, labelH: 150 } } });
  await d.goto(url('settings')); await d.reload(); await sleep(1500);
  await d.locator('[data-card=print]').screenshot({ path: path.join(OUT, 'print-card.png') });
  console.log('shot print-card');
  // pick list with photos
  const [pick] = await Promise.all([ctx.waitForEvent('page'), (async () => { await d.goto(url('orders')); await d.reload(); await sleep(1500); await d.click('button:has-text("Сборочный лист")'); })()]);
  await pick.addInitScript(() => (window.print = () => {}));
  await pick.setViewportSize({ width: 1000, height: 900 });
  await pick.reload(); await sleep(1500);
  await pick.locator('.page.pick table').screenshot({ path: path.join(OUT, 'picklist.png') });
  console.log('shot picklist');
  await ctx.close();
})().catch((e) => { console.error('CRASH', e.message.split('\n')[0]); process.exit(1); });
