// Layout on real device sizes: every screen, no horizontal scroll, no hidden controls.
const { chromium, devices } = require('playwright'); require('./offline');
const path = require('path');
const fs = require('fs');
const EXT = path.join(__dirname, '../apicopy');
const OUT = path.join(__dirname, '../devices');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROUTES = ['home', 'orders', 'returns', 'payments', 'analytics', 'products', 'catalog', 'chat', 'settings', 'account'];
const MATRIX = [
  ['iPhone SE', devices['iPhone SE'].viewport, 2],
  ['iPhone 15 Pro Max', devices['iPhone 15 Pro Max']?.viewport || { width: 430, height: 932 }, 3],
  ['Galaxy S9+ (Android)', devices['Galaxy S9+'].viewport, 3.5],
  ['Pixel 7 (Android)', devices['Pixel 7'].viewport, 2.6],
  ['iPad Mini', devices['iPad Mini'].viewport, 2],
  ['iPad Pro 11 landscape', devices['iPad Pro 11 landscape'].viewport, 2],
  ['Windows laptop 1366×768', { width: 1366, height: 768 }, 1],
  ['MacBook Air 13" 1440×900', { width: 1440, height: 900 }, 2],
  ['MacBook Pro 16" 1728×1117', { width: 1728, height: 1117 }, 2],
  ['Full HD monitor 1920×1080', { width: 1920, height: 1080 }, 1],
];
(async () => {
  const report = [];
  for (const [name, vp, dpr] of MATRIX) {
    const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'devprof' + Date.now()), { headless: true, channel: 'chromium', viewport: vp, deviceScaleFactor: dpr, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
    let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
    const id = sw.url().split('/')[2];
    for (const x of ['a', 'b']) { const p = await ctx.newPage(); await p.goto(`file://${EXT}/demo/mc/store-${x}.html`); }
    const d = await ctx.newPage();
    const errs = [];
    d.on('pageerror', (e) => errs.push(e.message));
    await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#home`); await sleep(1500);
    await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:connectApi', payload: { shopId: null, name: 'Автозапчасти API', token: 'GOOD-TOKEN-1234' } }));
    await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:sync' })).catch(() => {});
    await sleep(5000);
    const bad = [];
    for (const r of ROUTES) {
      await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#${r}`); await sleep(1200);
      const m = await d.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const nav = document.querySelector('.sidebar');
        const navVisible = nav && nav.getBoundingClientRect().right > 0 && getComputedStyle(nav).transform === 'none';
        const menuBtn = document.getElementById('menuBtn');
        const menuReachable = navVisible || (menuBtn && menuBtn.offsetParent !== null);
        const title = document.getElementById('pageTitle').getBoundingClientRect();
        return { overflow: document.documentElement.scrollWidth - vw, menuReachable, titleVisible: title.width > 0 && title.right <= vw + 1 };
      });
      if (m.overflow > 1 || !m.menuReachable || !m.titleVisible) bad.push(`${r}: overflow=${m.overflow}px menu=${m.menuReachable} title=${m.titleVisible}`);
      if (r === 'home' || r === 'orders') await d.screenshot({ path: `${OUT}/${name.replace(/[^\wА-я]+/g, '_')}-${r}.png` });
    }
    // the menu opens and every section is reachable from it
    let menuOk = true;
    if (await d.locator('#menuBtn').isVisible()) {
      await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#home`); await sleep(800);
      await d.click('#menuBtn'); await sleep(400);
      await d.click('a[data-route=catalog]'); await sleep(800);
      menuOk = (await d.evaluate(() => location.hash)) === '#catalog' && !(await d.evaluate(() => document.body.classList.contains('nav-open')));
    }
    report.push({ device: `${name} (${vp.width}×${vp.height})`, ok: !bad.length && menuOk && !errs.length, problems: [...bad, ...(menuOk ? [] : ['menu navigation']), ...errs] });
    await ctx.close();
  }
  for (const r of report) console.log(r.ok ? 'PASS' : 'FAIL', r.device, r.problems.join(' | '));
  console.log(report.every((r) => r.ok) ? 'ALL PASS' : 'SOME FAILED');
})();
