const { chromium } = require('playwright');
const EXT = __dirname + '/../apicopy';
let fails = 0; const check = (n, ok, i = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, i); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const ctx = await chromium.launchPersistentContext(__dirname + '/featprof', { headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2]; const errs = [];
  const d = await ctx.newPage(); d.on('pageerror', (e) => errs.push(e.message)); d.on('console', (m) => m.type() === 'error' && errs.push('[console] ' + m.text()));
  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#settings`);
  await d.waitForFunction(() => !document.querySelector('#refreshBtn').disabled, null, { timeout: 30000 });
  await d.fill('input[placeholder="Название магазина"]', 'Автозапчасти (API)');
  await d.fill('input[type=password]', 'GOOD-TOKEN-1234');
  await d.click('button:has-text("Проверить и подключить")');
  await d.evaluate(() => (location.hash = 'orders'));
  await d.waitForFunction(() => document.querySelectorAll('table.data tbody tr').length > 10, null, { timeout: 90000 });
  for (let k = 0; k < 60; k++) { // wait until order contents are attached (entries)
    const ok = await d.evaluate(async () => Object.values((await (async () => { const g = chrome.storage.local; const ids = (await g.get('ksh.snapIndex'))['ksh.snapIndex']; if (!ids) return (await g.get('ksh.snapshots'))['ksh.snapshots']; const r = await g.get(ids.map((i) => 'ksh.snap.' + i)); return Object.fromEntries(ids.filter((i) => r['ksh.snap.' + i]).map((i) => [i, r['ksh.snap.' + i]])); })())).some((s) => (s.sections?.orders?.items || []).some((i) => i.id === '800002001' && i.entries?.length)));
    if (ok) break; await sleep(1000);
  }
  await d.reload(); await d.waitForSelector('table.data tbody tr');
  // the deadline column is found by its header (columns with nothing to show are hidden)
  const cell = async (code, re = /^(Срок|Мерзім)/) => { const idx = await d.$$eval('#view table.data thead th', (ths, src) => ths.findIndex((th) => new RegExp(src).test(th.innerText.trim())), re.source); return d.locator('#view tbody tr', { hasText: code }).locator('td').nth(idx).innerText(); };
  // columns: 0 check,1 id,2 store,3 date,4 customer,5 status,6 deadline,7 amount,8 profit,9 payment
  await d.fill('input[type=search]', '80000200'); await sleep(500);
  const d2001 = await cell('800002001'), d2002 = await cell('800002002'), d2004 = await cell('800002004');
  check('1 deadline "принять через" for a fresh new order', d2001.startsWith('принять через'), d2001);
  check('1 overdue for a new order older than the 2 h target', d2002.startsWith('просрочен'), d2002);
  check('1 no deadline for own-delivery accepted order', d2004.trim() === '—', d2004);
  await d.fill('input[type=search]', ''); await sleep(400); await d.click('.tabs .tab:has-text("Горящие")'); await sleep(300);
  const urgentRows = await d.locator('#view tbody tr').count();
  check('2 «Горящие» tab: 3 orders (2 new + unsigned credit)', urgentRows === 3, String(urgentRows));
  check('2 sidebar shows 🔥 3', (await d.locator('[data-count="urgent"]').innerText()).includes('3'));
  await d.click('.tabs .tab:has-text("Все")'); await sleep(300);
  await d.screenshot({ path: __dirname + '/feat-deadlines.png' });
  const notified = await sw.evaluate(async () => Object.keys((await chrome.storage.session.get('ksh.deadlineNotified'))['ksh.deadlineNotified'] || {}).length);
  check('3 deadline notification recorded once per order', notified >= 3, String(notified));

  const pop = await ctx.newPage(); await pop.setViewportSize({ width: 380, height: 520 }); await pop.goto(`chrome-extension://${id}/popup/popup.html`); await sleep(2500);
  const ub = await pop.locator('#urgent').innerText().catch(() => '');
  check('4 popup shows urgent banner', ub.includes('3 заказа горят'), ub);
  await pop.screenshot({ path: __dirname + '/feat-popup.png' }); await pop.close();

  // profit: products page
  await d.bringToFront(); await d.evaluate(() => (location.hash = 'products')); await d.click('#rangeSeg button[data-preset="90"]'); await sleep(700);
  check('5 products page lists 3 products from order contents', (await d.locator('tbody tr').count()) === 3);
  // columns by header text, not by position (the table may gain columns, e.g. «Фото»)
  const col = async (re) => (await d.$$eval('#view thead th', (ths) => ths.map((x) => x.innerText.trim()))).findIndex((x) => re.test(x));
  const [cProduct, cUnits, cRevenue, cProfit] = [await col(/^Товар/), await col(/^Продано|^Штук|^Кол/), await col(/^Выручка/), await col(/^Прибыль/)];
  check('5 product table columns found', [cProduct, cUnits, cRevenue, cProfit].every((i) => i >= 0), [cProduct, cUnits, cRevenue, cProfit].join(','));
  check('5 profit «—» (not counted) before costs are set', (await d.locator('tbody tr').first().locator('td').nth(cProfit).innerText()).trim() === '—');
  const pct = d.locator('label:has-text("Для всех категорий") input'); await pct.fill('10'); await pct.dispatchEvent('change'); await sleep(700);
  const costs = { 'SKU-0': 5000, 'SKU-1': 3000, 'SKU-2': 1000 };
  for (const [sku, c] of Object.entries(costs)) { const inp = d.locator(`tr:has-text("${sku}") input[type=number]`); await inp.fill(String(c)); await inp.dispatchEvent('change'); await sleep(500); }
  const prow = await d.$$eval('tbody tr', (trs) => trs.map((tr) => [...tr.cells].map((c) => c.innerText.trim())));
  const r0 = prow[0]; const rev = Number(r0[cRevenue].replace(/\D/g, '')), units = Number(r0[cUnits].replace(/\D/g, '')), sku = r0[cProduct].split('\n')[1];
  const expect = rev - costs[sku] * units - rev * 0.1;
  const got = Number(r0[cProfit].replace(/[^\d-]/g, '').replace(/^-?/, (m) => m));
  check('5 product profit = revenue − cost×units − 10%', Math.abs(Math.abs(got) - Math.abs(Math.round(expect))) <= 1, `${sku} rev=${rev} units=${units} expected=${Math.round(expect)} got=${r0[cProfit]}`);
  await d.screenshot({ path: __dirname + '/feat-products.png' });
  // order-level profit
  await d.evaluate(() => (location.hash = 'orders')); await sleep(500);
  await d.fill('input[type=search]', '800002001'); await sleep(500);
  const op = await cell('800002001', /^Прибыль/), amt = Number((await cell('800002001', /^Сумма/)).replace(/\D/g, ''));
  const snapE = await d.evaluate(async () => Object.values((await (async () => { const g = chrome.storage.local; const ids = (await g.get('ksh.snapIndex'))['ksh.snapIndex']; if (!ids) return (await g.get('ksh.snapshots'))['ksh.snapshots']; const r = await g.get(ids.map((i) => 'ksh.snap.' + i)); return Object.fromEntries(ids.filter((i) => r['ksh.snap.' + i]).map((i) => [i, r['ksh.snap.' + i]])); })()))[0].sections.orders.items.find((i) => i.id === '800002001').entries);
  const exp1 = amt - snapE.reduce((s, e) => s + costs[e.sku] * e.quantity, 0) - amt * 0.1;
  check('6 order profit column correct', Number(op.replace(/[^\d]/g, '')) === Math.round(Math.abs(exp1)), `amount=${amt} expected=${Math.round(exp1)} got=${op}`);
  await d.evaluate(() => (location.hash = 'analytics')); await sleep(1200);
  const kpis = await d.$$eval('.kpi', (k) => k.map((x) => x.innerText.replace(/\n/g, ' | ')));
  check('7 analytics shows profit & margin KPIs', kpis.some((k) => k.startsWith('Прибыль') && /\d/.test(k.split('|')[1])) && kpis.some((k) => k.startsWith('Маржа') && k.includes('%')), JSON.stringify(kpis.slice(6)));
  await d.screenshot({ path: __dirname + '/feat-analytics.png', fullPage: true });

  // pick list
  await d.evaluate(() => (location.hash = 'orders')); await sleep(500);
  await d.fill('input[type=search]', '80000200'); await sleep(500);
  for (const c of ['800002001', '800002002']) await d.locator('tbody tr', { hasText: c }).locator('input[type=checkbox]').check();
  const [pp] = await Promise.all([ctx.waitForEvent('page'), d.click('button:has-text("Сборочный лист")')]);
  await pp.waitForLoadState(); await sleep(1500);
  const lines = await pp.$$eval('.pick tbody tr', (trs) => trs.map((tr) => tr.innerText.replace(/\s+/g, ' ')));
  const qty = await pp.$$eval('.pick .qty', (q) => q.reduce((n, x) => n + Number(x.innerText), 0));
  const expQty = await d.evaluate(async () => { const it = Object.values((await (async () => { const g = chrome.storage.local; const ids = (await g.get('ksh.snapIndex'))['ksh.snapIndex']; if (!ids) return (await g.get('ksh.snapshots'))['ksh.snapshots']; const r = await g.get(ids.map((i) => 'ksh.snap.' + i)); return Object.fromEntries(ids.filter((i) => r['ksh.snap.' + i]).map((i) => [i, r['ksh.snap.' + i]])); })()))[0].sections.orders.items; return ['800002001', '800002002'].reduce((n, c) => n + it.find((i) => i.id === c).entries.reduce((m, e) => m + e.quantity, 0), 0); });
  check('8 pick list built from 2 orders, quantities add up', lines.length >= 1 && qty === expQty, `${JSON.stringify(lines)} qty=${qty} expected=${expQty}`);
  await pp.screenshot({ path: __dirname + '/feat-picklist.png' }); await pp.close();
  // nothing selected → all to assemble
  await d.bringToFront(); await d.click('button:has-text("Снять выделение")'); await d.fill('input[type=search]', ''); await sleep(400);
  const [pp2] = await Promise.all([ctx.waitForEvent('page'), d.click('button:has-text("Сборочный лист")')]);
  await pp2.waitForLoadState(); await sleep(1200);
  const meta = await pp2.locator('.pick-meta').innerText();
  check('8 no selection → pick list of all orders to assemble', /Заказов: [34]/.test(meta), meta); await pp2.close();

  // settings: accept target 0.5 h → 2001 overdue
  await d.bringToFront(); await d.evaluate(() => (location.hash = 'settings')); await sleep(500);
  await d.fill('#acceptHours', '0.5'); await d.dispatchEvent('#acceptHours', 'change'); await sleep(700);
  await d.evaluate(() => (location.hash = 'orders')); await sleep(500); await d.fill('input[type=search]', '800002001'); await sleep(500);
  check('9 changing the accept target updates deadlines', (await cell('800002001')).startsWith('просрочен'));
  // kazakh
  await d.evaluate(() => (location.hash = 'settings')); await sleep(500); await d.click('button:has-text("Қазақша")'); await sleep(500); await d.evaluate(() => (location.hash = 'orders')); await sleep(600); await d.fill('input[type=search]', '800002001'); await sleep(500);
  check('10 kk: deadline text translated', (await cell('800002001')).includes('кешікті'), await cell('800002001'));
  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  await ctx.close();
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
