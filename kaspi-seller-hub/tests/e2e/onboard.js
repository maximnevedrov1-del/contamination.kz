// «Первые шаги» on Home: progress, the right button for each step, steps done in other tabs
// (test print) update Home by themselves; «why the token is safe» and «send to the owner».
const { chromium } = require('playwright');
const path = require('path');
const EXT = path.join(__dirname, '../apicopy');
let fails = 0;
const check = (n, ok, i = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, ok ? '' : i); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'onbprof' + Date.now()), { headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 }, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const errs = [];
  const d = await ctx.newPage();
  d.on('pageerror', (e) => errs.push(e.message));
  const url = (r) => `chrome-extension://${id}/dashboard/dashboard.html#${r}`;
  const msg = (type, payload) => d.evaluate(([t, p]) => chrome.runtime.sendMessage({ type: t, payload: p }), [type, payload]);
  const card = d.locator('[data-card=onboarding]');
  const doneSteps = async () => (await card.locator('.onboard__step.is-done').evaluateAll((l) => l.map((x) => x.dataset.step))).join(',');
  await d.goto(url('home'));
  await d.evaluate(() => { ['home', 'orders', 'settings', 'products'].forEach((r) => localStorage.setItem(`ksh.guide.${r}`, '1')); localStorage.setItem('ksh.tourDone', '1'); });
  await d.reload(); await sleep(1200);

  // 1. new seller: 0 of 5, «Подключить» is the next step
  check('1 card shown with 0 of 5', (await card.count()) === 1 && (await card.innerText()).includes('0 из 5'), await card.innerText().catch(() => ''));
  check('1 next step = connect a store', (await card.locator('.onboard__step.is-next').getAttribute('data-step')) === 'store');

  // 2. connect dialog: why the token is safe + instruction for the owner
  await card.locator('[data-action=onboard-store]').click(); await d.waitForSelector('#connectDialog[open]');
  await d.click('[data-block=token-safe] summary');
  check('2 «почему безопасно» explains', (await d.locator('[data-block=token-safe]').innerText()).includes('отправляется только на сервер Kaspi'));
  const wa = await d.locator('[data-block=owner-help] a', { hasText: 'WhatsApp' }).getAttribute('href');
  check('2 ready message for the store owner (WhatsApp)', wa.startsWith('https://wa.me/?text=') && decodeURIComponent(wa).includes('Токен API') && decodeURIComponent(wa).includes('Сформировать'), wa.slice(0, 120));
  await d.fill('#connectName', 'Мой магазин'); await d.fill('#connectToken', 'GOOD-TOKEN-1234');
  await d.click('#connectSubmit'); await sleep(6000);
  await d.goto(url('home')); await d.reload(); await sleep(1500);
  check('2 store + orders done after connecting', (await doneSteps()) === 'store,orders', await doneSteps());
  check('2 next step = printing', (await card.locator('.onboard__step.is-next').getAttribute('data-step')) === 'print');

  // 3. «Настроить» → Settings, print card highlighted; test print in its tab → Home updates by itself
  await card.locator('[data-action=onboard-print]').click(); await sleep(900);
  check('3 opens Settings at the print card', d.url().endsWith('#settings') && (await d.locator('[data-card=print]').evaluate((e) => e.classList.contains('is-highlight') && e.getBoundingClientRect().top < 400)));
  await d.goto(url('home')); await sleep(800);
  const p = await ctx.newPage();
  await p.evaluate(() => (window.print = () => {})).catch(() => {});
  await p.addInitScript(() => (window.print = () => {}));
  await p.goto(`chrome-extension://${id}/dashboard/print.html?mode=test`); await sleep(1200); await p.close();
  await sleep(800);
  check('3 test print marks the step, Home updated without reload', (await doneSteps()).includes('print'), await doneSteps());

  // 4. cost price → step done
  await card.locator('[data-action=onboard-costs]').click(); await sleep(600);
  check('4 «Указать» opens the cost-price section', d.url().endsWith('#products'));
  await msg('ui:saveCost', { sku: 'TEST-SKU', cost: 1500 }); await sleep(300);
  await d.goto(url('home')); await sleep(1000);
  check('4 costs done', (await doneSteps()).includes('costs'));

  // 5. backup → all done → «Всё настроено» → closed for good
  await card.locator('[data-action=onboard-backup]').click(); await sleep(900);
  const [dl] = await Promise.all([d.waitForEvent('download'), d.click('[data-action=backup-save]')]);
  check('5 backup saved from the highlighted card', !!dl);
  await d.goto(url('home')); await sleep(1000);
  check('5 all done: «Всё настроено», no step list', (await card.innerText()).includes('Всё настроено') && (await card.locator('.onboard__step').count()) === 0);
  await card.locator('[data-action=onboard-hide]').click(); await sleep(500);
  await d.reload(); await sleep(1200);
  check('5 closed → stays closed after reload', (await card.count()) === 0);

  // 6. phone width: no horizontal scroll with the card (fresh flags)
  await d.evaluate(() => chrome.storage.local.remove('ksh.onboarding'));
  await d.setViewportSize({ width: 360, height: 760 }); await d.reload(); await sleep(1200);
  check('6 phone: card visible, no horizontal scroll', (await card.count()) === 1 && (await d.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)));
  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  await ctx.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('CRASH', e.message); process.exit(1); });
