const { chromium } = require('playwright'); require('./offline');
const EXT = process.argv[2];
(async () => {
  const ctx = await chromium.launchPersistentContext(require('path').join(__dirname, 'relprof' + Date.now()), { headless: true, channel: 'chromium', args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2]; const errs = [];
  const d = await ctx.newPage(); d.on('pageerror', (e) => errs.push(e.message)); d.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#account`); await d.waitForTimeout(3000);
  console.log('view:', (await d.locator('#view').innerText()).slice(0, 160).replace(/\s+/g, ' '));
  console.log('consent box:', await d.locator('label.consent input').count());
  const lp = await ctx.newPage(); await lp.goto(`chrome-extension://${id}/legal/terms.html#privacy`); console.log('legal:', await lp.locator('#privacy h1').innerText());
  const csp = errs.filter((e) => /Content Security Policy|Refused/.test(e));
  console.log('CSP violations:', csp.length, csp.join(' | ')); console.log('page errors:', errs.filter((e) => !/Failed to load resource|ERR_/.test(e)).join(' | ') || 'none');
  await ctx.close();
})();
