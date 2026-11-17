// Which elements are wider than a 390px viewport (horizontal scroll culprits)?
const { chromium } = require('playwright');
const path = require('path');
const EXT = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'wideprof' + Date.now()), { headless: true, channel: 'chromium', viewport: { width: 390, height: 844 }, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  for (const x of ['a', 'b']) { const p = await ctx.newPage(); await p.goto(`file://${EXT}/demo/mc/store-${x}.html`); }
  const d = await ctx.newPage();
  await d.setViewportSize({ width: 390, height: 844 });
  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#home`); await sleep(5000);
  for (const r of (process.argv[3] || 'home').split(',')) {
    await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#${r}`); await sleep(2000);
    const res = await d.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const wide = [...document.querySelectorAll('body *')].filter((e) => { const b = e.getBoundingClientRect(); return b.right > vw + 1 && b.width > 0 && getComputedStyle(e).position !== 'fixed' && !e.closest('.table-wrap, .tabs, .sidebar'); });
      const leaves = wide.filter((e) => !wide.some((o) => o !== e && e.contains(o)));
      return { scrollW: document.documentElement.scrollWidth, vw, culprits: leaves.slice(0, 8).map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')} w=${Math.round(e.getBoundingClientRect().width)} right=${Math.round(e.getBoundingClientRect().right)}`) };
    });
    console.log(r, JSON.stringify(res));
  }
  await ctx.close();
})();
