// Load test of the extension: 5 stores × thousands of orders (loadmock.js on :8099).
//   node load.js <extension copy pointing at http://localhost:8099>
// Prints timings, request counts, storage size and memory; exits 1 if a budget is exceeded.
const { chromium } = require('playwright');
const path = require('path');
const EXT = process.argv[2] || path.join(__dirname, '../apicopy');
const STORES = +process.env.STORES || 5;
const BUDGET = { firstSyncSec: 120, viewMs: 1500, searchMs: 800, heapMb: 250, resyncSec: 30 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = () => fetch('http://localhost:8099/__stats').then((r) => r.json());
const report = {};
let fails = 0;
const check = (n, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, info); };

(async () => {
  await fetch('http://localhost:8099/__reset');
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'loadprof' + Date.now()), { headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 }, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const errs = [];
  const d = await ctx.newPage();
  d.on('pageerror', (e) => errs.push(e.message));
  const cdp = await ctx.newCDPSession(d);
  await cdp.send('Performance.enable');
  const heapMb = async () => Math.round((await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'JSHeapUsedSize').value / 1048576);
  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#home`); await sleep(1000);
  await d.evaluate(() => { ['home', 'orders', 'returns', 'refusals', 'payments', 'analytics', 'products', 'settings'].forEach((r) => localStorage.setItem(`ksh.guide.${r}`, '1')); localStorage.setItem('ksh.tourDone', '1'); });

  // ---------- 1. a seller connects 5 stores one after another ----------
  const t0 = Date.now();
  for (let s = 1; s <= STORES; s++) {
    const r = await d.evaluate((s) => chrome.runtime.sendMessage({ type: 'ui:connectApi', payload: { shopId: null, name: `Магазин ${s}`, token: `GOOD-TOKEN-L${s}` } }), s);
    if (!r?.ok) console.log('connect failed', s, JSON.stringify(r));
    await sleep(1500); // typing the next token
  }
  const counts = () => sw.evaluate(async () => {
    const snaps = (await chrome.storage.local.get('ksh.snapshots'))['ksh.snapshots'] || {};
    return Object.values(snaps).map((s) => s.sections?.orders?.items?.length || 0);
  });
  let c = [];
  while (Date.now() - t0 < 600000) {
    c = await counts();
    if (c.length >= STORES && c.every((n) => n > 0)) break;
    await sleep(2000);
  }
  await sleep(3000); // a sync that was already running finishes
  report.firstSyncSec = Math.round((Date.now() - t0) / 1000);
  report.ordersPerStore = await counts();
  report.firstSyncRequests = await stats();
  check(`1 first load of ${STORES} stores`, report.firstSyncSec <= BUDGET.firstSyncSec, `${report.firstSyncSec} s, orders ${report.ordersPerStore.join('/')}, requests ${report.firstSyncRequests.requests} (list ${report.firstSyncRequests.list}, entries ${report.firstSyncRequests.entries}), max parallel ${report.firstSyncRequests.maxConcurrent}`);

  // ---------- 2. storage ----------
  report.storageMb = await sw.evaluate(async () => {
    const mb = async (k) => Math.round(((await chrome.storage.local.getBytesInUse(k)) / 1048576) * 10) / 10;
    return { snapshots: await mb('ksh.snapshots'), entries: await mb('ksh.apiEntries'), total: await mb(null) };
  });
  console.log('INFO storage MB', JSON.stringify(report.storageMb));

  // ---------- 3. the dashboard with all of it ----------
  const st = await d.evaluate(async () => { const t = performance.now(); const s = await chrome.runtime.sendMessage({ type: 'ui:getState' }); return { ms: Math.round(performance.now() - t), kb: Math.round(JSON.stringify(s).length / 1024) }; });
  report.getState = st;
  console.log('INFO ui:getState', JSON.stringify(st));
  report.views = {};
  const open = async (route) => {
    const t = Date.now();
    await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#${route}`);
    await d.waitForFunction(() => document.querySelector('#view')?.children.length && !document.querySelector('#view .skeleton'), null, { timeout: 60000 });
    await d.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const ms = Date.now() - t;
    const rows = await d.locator('#view tbody tr').count();
    report.views[route] = { ms, rows, heapMb: await heapMb() };
    check(`3 open «${route}»`, ms <= BUDGET.viewMs, `${ms} ms, ${rows} table rows, heap ${report.views[route].heapMb} MB`);
  };
  for (const r of ['home', 'orders', 'returns', 'payments', 'analytics', 'products']) await open(r);
  // switching periods / tabs
  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#orders`); await sleep(1500);
  let t = Date.now();
  await d.click('#rangeSeg button[data-preset="90"]');
  await d.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  report.period90Ms = Date.now() - t;
  check('3 switch to 90 days', report.period90Ms <= BUDGET.viewMs, `${report.period90Ms} ms, ${await d.locator('#view tbody tr').count()} rows`);
  // typing in the search box
  t = Date.now();
  await d.locator('input[type=search]').first().fill('7100');
  await sleep(350); // debounce
  await d.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  report.searchMs = Date.now() - t - 350;
  check('3 search reacts', report.searchMs <= BUDGET.searchMs, `${report.searchMs} ms after debounce`);
  report.heapMb = await heapMb();
  check('3 dashboard memory', report.heapMb <= BUDGET.heapMb, `${report.heapMb} MB`);

  // ---------- 4. the 5-minute background sync ----------
  await fetch('http://localhost:8099/__reset');
  t = Date.now();
  await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:sync' }));
  report.resyncSec = Math.round((Date.now() - t) / 100) / 10;
  report.resyncRequests = await stats();
  check('4 regular sync', report.resyncSec <= BUDGET.resyncSec, `${report.resyncSec} s, requests ${report.resyncRequests.requests} (list ${report.resyncRequests.list}, entries ${report.resyncRequests.entries}), max parallel ${report.resyncRequests.maxConcurrent}`);
  report.workerHeapMb = await sw.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null)).catch(() => null);

  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('REPORT', JSON.stringify(report));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  await ctx.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CRASH', e.message.split('\n')[0]); process.exit(1); });
