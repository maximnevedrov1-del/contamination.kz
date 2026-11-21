// Order card + backup/restore (developer-mode copy, mock Kaspi API).
const { chromium } = require('playwright');
const path = require('path'); const fs = require('fs');
const EXT = path.join(__dirname, '../apicopy');
let fails = 0; const check = (n, ok, i = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, i); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const launch = async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'uxprof' + Date.now() + Math.random()), { headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, acceptDownloads: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const d = await ctx.newPage(); const errs = [];
  d.on('pageerror', (e) => errs.push(e.message));
  await d.goto(`chrome-extension://${sw.url().split('/')[2]}/dashboard/dashboard.html#home`); await sleep(1200);
  const msg = (type, payload) => d.evaluate(([t, p]) => chrome.runtime.sendMessage({ type: t, payload: p }), [type, payload]);
  await msg('ui:connectApi', { shopId: null, name: 'Автозапчасти', token: 'GOOD-TOKEN-1234' });
  await msg('ui:sync').catch(() => {}); await sleep(5000);
  return { ctx, d, msg, errs };
};
(async () => {
  let { ctx, d, msg, errs } = await launch();
  // ---- order card ----
  await d.evaluate(() => (location.hash = 'orders')); await sleep(1500);
  await d.click('.tabs .tab:has-text("Новые")'); await sleep(400);
  await d.locator('tbody tr', { hasText: '800002001' }).locator('button.link').click();
  await d.waitForSelector('#orderDialog[open]');
  const txt = await d.locator('#orderDialog').innerText();
  check('1 card: title, store, amount, payment', txt.includes('Заказ 800002001') && txt.includes('Автозапчасти') && txt.replace(/\s/g, '').includes('53371') && txt.includes('Оплачен'), txt.slice(0, 120).replace(/\n/g, ' '));
  check('1 card: order contents with sku and quantity', /Фильтр масляный|Тормозные колодки|Свечи зажигания/.test(txt) && /SKU-\d/.test(txt));
  check('1 card: deadline badge + actions for a new order', /принять через|просрочен/.test(txt) && (await d.locator('#orderDialog button:has-text("Принять")').count()) === 1 && (await d.locator('#orderDialog button:has-text("Упаковать")').count()) === 1);
  check('1 card: link to Kaspi', (await d.locator('#orderDialog a:has-text("Открыть в Kaspi")').getAttribute('href')).includes('800002001'));
  await d.screenshot({ path: path.join(__dirname, 'ux-order.png') });
  await d.click('#orderDialog button:has-text("Принять")');
  await d.waitForSelector('#confirmDialog[open]');
  check('1 accept from the card still asks for confirmation', (await d.locator('#confirmDialog').innerText()).length > 10);
  await d.click('#confirmDialog button[value=cancel]').catch(() => d.keyboard.press('Escape')); await sleep(300);

  // ---- export to Excel (CSV) ----
  await d.click('.tabs .tab:has-text("Все")'); await sleep(400);
  // all matching orders (the table shows them 100 per page; export takes every one)
  const total = Number((await d.locator('.toolbar__count').innerText()).replace(/\D/g, ''));
  const [csvDl] = await Promise.all([d.waitForEvent('download'), d.click('button[data-action=export]')]);
  const csvFile = path.join(__dirname, 'export-test.csv'); await csvDl.saveAs(csvFile);
  const raw = fs.readFileSync(csvFile);
  const csv = raw.toString('utf8');
  const lines = csv.trim().split('\r\n');
  check('1b export: UTF-8 BOM, header, one line per matching order (all pages)', raw[0] === 0xef && raw[1] === 0xbb && lines[0].includes('Заказ') && lines.length === total + 1, `${lines.length - 1} of ${total}`);
  check('1b export: store, status, amount as a number, products', lines.some((l) => l.startsWith('800002001;Автозапчасти;') && l.includes(';Новый;53371;Оплачен;') && /SKU-\d\] × \d/.test(l)), lines.find((l) => l.startsWith('800002001')));
  check('1b export: no buyer names in the file', !csv.includes('SECRET NAME'));
  // ---- data that lives only in the browser ----
  const noSku = await msg('ui:saveCost', { cost: 4200 });
  check('2 cost price without a sku is refused', noSku?.ok === false);
  await msg('ui:saveCost', { sku: 'SKU-1', cost: 1500 });
  const shopId = Object.keys((await msg('ui:getState')).settings.stores)[0];
  await msg('ui:catalogSave', { product: { sku: 'NB48', title: 'Тетрадь "48" & <клетка>', brand: 'Erich', price: 1200, stock: 7, stores: { [shopId]: { on: true, price: 1300 } } } });
  await msg('ui:feedSettings', { shopId, merchantId: '30123456', company: 'ТОО Ромашка', warehouses: 'PP1, PP2', confirmed: false });
  await msg('ui:saveSettings', { patch: { deadlines: { acceptHours: 3, warnHours: 1 }, profit: { defaultCommission: 12, byCategory: { 'Автозапчасти': 9 } } } });
  await msg('ui:updateStore', { shopId, patch: { alias: 'Мои запчасти' } });
  // ---- backup ----
  await d.evaluate(() => (location.hash = 'settings')); await sleep(800);
  const [dl] = await Promise.all([d.waitForEvent('download'), d.click('button[data-action=backup-save]')]);
  const file = path.join(__dirname, 'backup-test.json'); await dl.saveAs(file);
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('2 backup file: catalog, costs, settings, price-list settings', b.app === 'kaspi-seller-hub' && b.catalog.NB48?.price === 1200 && Object.keys(b.costs).length >= 1 && b.settings.deadlines.acceptHours === 3 && b.feeds[shopId].merchantId === '30123456', dl.suggestedFilename());
  check('2 backup has NO API tokens', !fs.readFileSync(file, 'utf8').includes('GOOD-TOKEN'));
  await d.screenshot({ path: path.join(__dirname, 'ux-backup.png') });
  check('no page errors (1)', errs.length === 0, errs.join(' | '));
  await ctx.close();

  // ---- "new computer": fresh browser profile, store re-connected (new id), restore ----
  ({ ctx, d, msg, errs } = await launch());
  const newId = Object.keys((await msg('ui:getState')).settings.stores)[0];
  check('3 fresh profile: store has a different id, no catalog', newId !== shopId && (await msg('ui:catalogState')).products.length === 0, `${shopId} → ${newId}`);
  await d.evaluate(() => (location.hash = 'settings')); await sleep(800);
  await d.locator('input[data-action=backup-file]').setInputFiles(file);
  await d.waitForSelector('#confirmDialog[open]');
  check('3 restore asks first and shows what is inside', /товаров — 1/.test(await d.locator('#confirmDialog').innerText()));
  await d.click('#confirmDialog button[value=ok]'); await sleep(1500);
  const cat = await msg('ui:catalogState');
  const p = cat.products.find((x) => x.sku === 'NB48');
  check('3 product restored with special characters intact', p?.title === 'Тетрадь "48" & <клетка>' && p.price === 1200 && p.stock === 7);
  check('3 per-store price moved to the re-connected store (matched by name)', p?.stores?.[newId]?.on === true && p.stores[newId].price === 1300, JSON.stringify(p?.stores));
  check('3 price-list settings restored but NOT switched on', cat.feeds[newId].merchantId === '30123456' && cat.feeds[newId].warehouses.join() === 'PP1,PP2' && cat.feeds[newId].confirmed === false);
  const st = (await msg('ui:getState')).settings;
  check('3 settings restored: deadlines, commission, store alias', st.deadlines.acceptHours === 3 && st.profit.defaultCommission === 12 && st.profit.byCategory['Автозапчасти'] === 9 && st.stores[newId].alias === 'Мои запчасти');
  const costs = await d.evaluate(async () => (await chrome.storage.local.get('ksh.costs'))['ksh.costs']);
  check('3 cost prices restored', Object.keys(costs || {}).length === Object.keys(b.costs).length, JSON.stringify(costs));
  // ---- bad files ----
  fs.writeFileSync(file + '.bad', JSON.stringify({ app: 'other', catalog: {} }));
  await d.locator('input[data-action=backup-file]').setInputFiles(file + '.bad'); await sleep(600);
  check('4 foreign file refused with a clear message', (await d.$$eval('.toast', (t) => t.map((x) => x.innerText))).some((x) => x.includes('не файл резервной копии')));
  const evil = await msg('ui:backupImport', { backup: { app: 'kaspi-seller-hub', version: 1, catalog: { x: { sku: '<script>', title: 'x', brand: 'y', price: -5 } }, costs: { a: 'NaN', b: -1 }, stores: {}, settings: { lang: 'xx', theme: 'evil' } } });
  const after = await msg('ui:getState');
  check('4 invalid products / costs / settings in a file are skipped', evil.ok && evil.products === 0 && evil.costs === 0 && after.settings.lang !== 'xx' && after.settings.theme !== 'evil', JSON.stringify(evil));
  check('no page errors (2)', errs.length === 0, errs.join(' | '));
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  await ctx.close();
})().catch((e) => { console.error('CRASH', e.message.split('\n')[0]); process.exit(1); });
