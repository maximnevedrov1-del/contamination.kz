// Release build without cabinet mode (node tools/build-release.mjs, no --with-cabinet):
// no chat, no content scripts, a Kaspi page never creates a store, no page errors.
//   node apionly.js <path to dist/kaspi-seller-hub>
const { chromium } = require('playwright'); require('./offline');
const path = require('path');
const EXT = process.argv[2];
let fails = 0;
const check = (n, c, i = '') => { console.log(c ? 'PASS' : 'FAIL', n, c ? '' : i); if (!c) fails++; };
(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'apionlyprof' + Date.now()), { headless: true, channel: 'chromium', args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const errs = [];
  const d = await ctx.newPage();
  d.on('pageerror', (e) => errs.push(e.message));
  d.on('console', (m) => m.type() === 'error' && !/Failed to load resource|ERR_|supabase/.test(m.text()) && errs.push(m.text()));
  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#chat`); await d.waitForTimeout(2500);
  check('#chat opens Home instead', await d.evaluate(() => document.querySelector('a[data-route=home]')?.getAttribute('aria-current') === 'page' || document.querySelector('.nav__item--active, .nav__item[aria-current]')?.dataset.route === 'home'), await d.evaluate(() => [...document.querySelectorAll('.nav__item')].map((a) => a.dataset.route + ':' + a.className + ':' + a.getAttribute('aria-current')).join(' ')));
  check('no «Чат» in the menu', (await d.locator('a[data-route=chat]').count()) === 0);
  check('no-stores text speaks of the API token only', !(await d.locator('#view').innerText()).includes('откройте кабинет'));
  const m = await d.evaluate(() => chrome.runtime.getManifest());
  check('manifest: no content scripts, no scripting permission', !m.content_scripts && !m.permissions.includes('scripting'), JSON.stringify(m.permissions));
  const alarms = await d.evaluate(() => chrome.alarms.getAll().then((a) => a.map((x) => x.name)));
  check('no chat polling alarm', !alarms.includes('ksh-chat-poll'), alarms.join());
  // a content message (as an older install / manual injection would send) must not create a store
  await d.evaluate(() => chrome.runtime.sendMessage({ type: 'content:hello', payload: { shopId: 'phantom', shopName: 'Phantom', authenticated: true, origin: 'https://kaspi.kz' } }).catch(() => {}));
  await d.waitForTimeout(500);
  const stores = await d.evaluate(() => chrome.storage.local.get('ksh.settings').then((s) => Object.keys(s['ksh.settings']?.stores || {})));
  check('a Kaspi page never creates a store', !stores.includes('phantom'), stores.join());
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${id}/popup/popup.html`); await p.waitForTimeout(1200);
  check('popup: connect by API token', (await p.locator('body').innerText()).includes('токену API'));
  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#help`); await d.waitForTimeout(1500);
  check('help: no chat guide', (await d.locator('details[data-guide=chat]').count()) === 0);
  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  await ctx.close();
})().catch((e) => { console.error('CRASH', e.message.split('\n')[0]); process.exit(1); });
