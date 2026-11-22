// Screenshots of every screen (developer mode copy + mock Kaspi API + demo store tabs).
const { chromium } = require('playwright'); require('./offline');
const path = require('path');
const EXT = process.argv[2] || path.join(__dirname, '../apicopy');
const OUT = process.argv[3] || path.join(__dirname, '../ui-before');
const W = Number(process.argv[4] || 1440);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  require('fs').mkdirSync(OUT, { recursive: true });
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'uiprof' + Date.now()), { headless: true, channel: 'chromium', viewport: { width: W, height: W < 500 ? 844 : 900 }, deviceScaleFactor: 2, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  for (const x of ['a', 'b']) { const p = await ctx.newPage(); await p.goto(`file://${EXT}/demo/mc/store-${x}.html`); }
  const d = await ctx.newPage();
  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#orders`);
  await sleep(1500);
  await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:connectApi', payload: { shopId: null, name: 'Автозапчасти API', token: 'GOOD-TOKEN-1234' } }));
  await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:sync' })).catch(() => {});
  await sleep(6000);
  for (const r of (process.env.ROUTES || 'home,orders,returns,payments,analytics,products,catalog,chat,settings,account').split(',')) {
    await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#${r}`);
    await sleep(2500);
    await d.screenshot({ path: `${OUT}/${r}.png`, fullPage: false });
  }
  if (W < 500) {
    await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#home`); await sleep(2000);
    await d.click('#menuBtn'); await sleep(500);
    await d.screenshot({ path: `${OUT}/menu-open.png` });
  }
  const pop = await ctx.newPage();
  await pop.setViewportSize({ width: 380, height: 600 });
  await pop.goto(`chrome-extension://${id}/popup/popup.html`); await sleep(2000);
  await pop.screenshot({ path: `${OUT}/popup.png` });
  await ctx.close();
  console.log('saved to', OUT);
})();
