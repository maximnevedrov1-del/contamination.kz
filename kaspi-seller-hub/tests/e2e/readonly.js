// «Только чтение»: with the switch on nothing is sent to Kaspi except reads.
const { chromium } = require('playwright');
const path = require('path');
const EXT = path.join(__dirname, '../apicopy');
let fails = 0;
const check = (n, ok, i = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, ok ? '' : i); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const posts = () => fetch('http://localhost:8099/__log').then((r) => r.json()).then((l) => l.filter((x) => x.post));
(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'roprof' + Date.now()), { headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 }, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const errs = [];
  const d = await ctx.newPage();
  d.on('pageerror', (e) => errs.push(e.message));
  const url = (r) => `chrome-extension://${id}/dashboard/dashboard.html#${r}`;
  const msg = (type, payload) => d.evaluate(([t, p]) => chrome.runtime.sendMessage({ type: t, payload: p }), [type, payload]);
  await d.goto(url('settings')); await sleep(800);
  await d.evaluate(() => { ['home', 'orders', 'settings'].forEach((r) => localStorage.setItem(`ksh.guide.${r}`, '1')); localStorage.setItem('ksh.tourDone', '1'); });
  await msg('ui:connectApi', { shopId: null, name: 'Рабочий магазин', token: 'GOOD-TOKEN-1234' });
  await sleep(5000);
  const shopId = Object.keys((await msg('ui:getState')).settings.stores)[0];

  // 1. switch on in Settings
  await d.reload(); await sleep(1200);
  await d.check('input[data-setting=readOnly]'); await sleep(800);
  check('1 banner «Только чтение» shown on every page', (await d.locator('[data-banner=readonly]').count()) === 1);
  const before = (await posts()).length;

  // 2. reads still work
  const sync = await msg('ui:sync');
  check('2 orders still load (reads allowed)', !!sync?.settings && (await d.evaluate(async () => Object.values((await chrome.storage.local.get('ksh.snapshots'))['ksh.snapshots'])[0]?.sections?.orders?.items?.length)) > 0);

  // 3. accept through the UI → refused, nothing sent
  await d.goto(url('orders')); await d.reload(); await sleep(1500);
  await d.click('.tabs .tab:has-text("Все")'); await sleep(300);
  await d.locator('#view tbody tr', { hasText: '800002001' }).first().locator('button.link').click();
  await d.waitForSelector('#orderDialog[open]');
  await d.locator('#orderDialog button', { hasText: /^Принять$/ }).click();
  await d.waitForSelector('#confirmDialog[open]'); await d.click('#confirmDialog button[value=ok]'); await sleep(1500);
  const toasts = await d.$$eval('.toast', (t) => t.map((x) => x.innerText).join(' | '));
  check('3 «Принять» refused with a clear message', toasts.includes('Только чтение'), toasts);
  // 4. direct worker messages (as a bug or a forged page would send) → refused
  const item = [{ shopId, orderId: '800002001' }];
  const r1 = await msg('ui:accept', { items: item });
  const r2 = await msg('ui:pack', { items: item });
  const r3 = await msg('ui:catalogPublish', { skus: ['X'], shopIds: [shopId], on: true });
  check('4 accept / pack / publish refused by the worker', [r1, r2, r3].every((r) => r?.error === 'readOnly'), JSON.stringify([r1, r2, r3]));
  // 5. even the API client itself refuses a write
  // (the API client's own refusal is unit-tested in tests/unit/robust.test.mjs)
  check('5 the API client is in read-only mode', (await sw.evaluate(() => globalThis.KSH_READONLY)) === true);
  check('5 not a single change request reached Kaspi', (await posts()).length === before, `${(await posts()).length - before} POSTs`);

  // 6. switch off → actions work again
  await d.goto(url('settings')); await d.reload(); await sleep(1000);
  await d.uncheck('input[data-setting=readOnly]'); await sleep(800);
  const r5 = await msg('ui:accept', { items: item });
  check('6 off again: accept goes to Kaspi', (await posts()).length === before + 1, JSON.stringify(r5).slice(0, 200));
  check('6 banner gone', (await d.locator('[data-banner=readonly]').count()) === 0);
  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  await ctx.close();
})().catch((e) => { console.error('CRASH', e.message.split('\n')[0]); process.exit(1); });
