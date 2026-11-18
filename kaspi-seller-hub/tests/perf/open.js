// Opening speed with a real network delay (mock Supabase with LATENCY=250, mock Kaspi):
// dashboard first paint, every section, popup, the worker waking up, the admin page «Пульт».
// Run: cd tests/e2e && ./resetdb.sh && LATENCY=250 node mocksupa.js & node mockapi.js & ./mkbillcopy.sh && node ../perf/open.js
const { chromium } = require('playwright');
const path = require('path');
const EXT = path.join(__dirname, '../billcopy');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'openprof' + Date.now()), { headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 }, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const d = await ctx.newPage();
  const url = (r) => `chrome-extension://${id}/dashboard/dashboard.html#${r}`;
  const msg = (type, payload) => d.evaluate(([t, p]) => chrome.runtime.sendMessage({ type: t, payload: p }), [type, payload]);
  await d.goto(url('account'));
  await d.evaluate(() => { ['home', 'orders', 'returns', 'refusals', 'payments', 'analytics', 'products', 'catalog', 'settings', 'account', 'help'].forEach((r) => localStorage.setItem(`ksh.guide.${r}`, '1')); localStorage.setItem('ksh.tourDone', '1'); });
  await d.reload(); await d.waitForSelector('input[type=email]');
  await d.fill('input[type=email]', 'speed@example.kz'); await d.check('label.consent input'); await d.click('button:has-text("Получить код")');
  await d.waitForSelector('input[autocomplete=one-time-code]'); await d.fill('input[autocomplete=one-time-code]', '123456'); await d.click('button:has-text("Войти")');
  await d.waitForSelector('.badge:has-text("Пробный период")', { timeout: 20000 });
  await msg('ui:connectApi', { shopId: null, name: 'Магазин А', token: 'GOOD-TOKEN-1234' }); await sleep(3000);
  await msg('ui:connectApi', { shopId: null, name: 'Магазин Б', token: 'GOOD-TOKEN-B' }); await sleep(5000);

  // 1. dashboard: new tab → first paint (Home with numbers), 5 times
  const paints = [];
  for (let i = 0; i < 5; i++) {
    const p = await ctx.newPage();
    const t0 = Date.now();
    await p.goto(url('home'));
    await p.waitForSelector('#view .home .card', { timeout: 20000 });
    paints.push(Date.now() - t0);
    await p.close();
  }
  out.dashboardFirstPaintMs = median(paints);

  // 2. sections (hash change), each twice
  await d.goto(url('home')); await sleep(1500);
  out.sectionMs = {};
  for (const r of ['orders', 'returns', 'payments', 'analytics', 'products', 'catalog', 'settings', 'account', 'help', 'home']) {
    const t = [];
    for (let i = 0; i < 2; i++) {
      await d.goto(url('home')); await sleep(200);
      t.push(await d.evaluate(async (r) => { const t0 = performance.now(); location.hash = r; await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))); return Math.round(performance.now() - t0); }, r));
    }
    out.sectionMs[r] = median(t);
  }

  // 3. popup
  const pops = [];
  for (let i = 0; i < 5; i++) {
    const p = await ctx.newPage(); const t0 = Date.now();
    await p.goto(`chrome-extension://${id}/popup/popup.html`); await p.waitForLoadState('load'); await sleep(50);
    await p.waitForFunction(() => document.body.innerText.trim().length > 20, null, { timeout: 10000 });
    pops.push(Date.now() - t0); await p.close();
  }
  out.popupMs = median(pops);

  // 4. worker asleep → first answer (Chrome stops it after ~30 s idle)
  const cdp = await ctx.newCDPSession(d);
  const wakes = [];
  for (let i = 0; i < 3; i++) {
    await cdp.send('ServiceWorker.enable').catch(() => {}); await cdp.send('ServiceWorker.stopAllWorkers').catch(() => {}); await sleep(700);
    const t0 = Date.now(); await msg('ui:getState'); wakes.push(Date.now() - t0);
  }
  out.workerWakeMs = median(wakes);
  const warm = []; for (let i = 0; i < 5; i++) { const t0 = Date.now(); await msg('ui:getState'); warm.push(Date.now() - t0); }
  out.workerWarmMs = median(warm);

  // 5. admin page: open → login screen; «Пульт» rendered
  const a = await ctx.newPage();
  await a.goto(`file://${EXT}/billing/admin/index.html`);
  await a.fill('#url', 'http://localhost:8098'); await a.fill('#key', 'test-anon-key'); await a.click('#saveConn');
  await a.fill('#email', 'owner@example.kz'); await a.click('#sendCode'); await a.waitForSelector('#codeRow:not([hidden])');
  await a.fill('#code', '123456'); await a.click('#verify'); await a.waitForSelector('#app:not([hidden])', { timeout: 20000 }); await sleep(1500);
  const pult = [];
  for (let i = 0; i < 3; i++) { const t0 = Date.now(); await a.click('[data-tab=pending]'); await a.waitForSelector('#panel table, #panel p'); await a.click('[data-tab=insights]'); await a.waitForSelector('.tiles', { timeout: 30000 }); pult.push(Date.now() - t0); }
  out.adminPultMs = median(pult);
  const reload = []; for (let i = 0; i < 3; i++) { const t0 = Date.now(); await a.reload(); await a.waitForSelector('#app:not([hidden]) #panel :is(table, p, .tiles)', { timeout: 30000 }); reload.push(Date.now() - t0); }
  out.adminOpenMs = median(reload);
  console.log('REPORT ' + JSON.stringify(out));
  await ctx.close();
})().catch((e) => { console.log('CRASH', e.message); process.exit(1); });
