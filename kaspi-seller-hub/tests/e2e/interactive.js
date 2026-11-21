// Interactive dashboard: every number leads to its orders, charts are clickable, count-up.
// Uses ../apicopy (API mode) and mockapi.js on :8099.
const { chromium } = require('playwright');
const path = require('path');
const EXT = path.join(__dirname, '../apicopy');
let fails = 0;
const check = (n, ok, i = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, ok ? '' : i); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'interprof' + Date.now()), { headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const errs = [];
  const d = await ctx.newPage();
  d.on('pageerror', (e) => errs.push(e.message));
  d.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errs.push('[console] ' + m.text()));
  const url = (r) => `chrome-extension://${id}/dashboard/dashboard.html#${r}`;
  await d.goto(url('home')); await sleep(1000);
  await d.evaluate(() => { ['home', 'orders', 'analytics'].forEach((r) => localStorage.setItem(`ksh.guide.${r}`, '1')); localStorage.setItem('ksh.tourDone', '1'); });
  await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:connectApi', payload: { shopId: null, name: 'Автозапчасти', token: 'GOOD-TOKEN-1234' } }));
  await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:connectApi', payload: { shopId: null, name: 'Шины Астана', token: 'GOOD-TOKEN-B' } }));
  await sleep(7000);
  const filters = () => d.evaluate(() => JSON.parse(sessionStorage.getItem('__f') || 'null'));

  // 1. Home: numbers count up once, tiles are buttons with sparklines
  await d.reload(); // same #home address: reload, goto would keep the page
  await d.waitForSelector('.tile--link');
  const early = await d.locator('.tile[data-tile=month] .tile__value').innerText();
  await sleep(1000);
  const late = await d.locator('.tile[data-tile=month] .tile__value').innerText();
  check('1 «30 дней» counts up to its value', early !== late && /\d/.test(late), `${early} → ${late}`);
  check('1 four tiles are buttons, week/month with a sparkline', (await d.locator('button.tile--link').count()) === 4 && (await d.locator('.tile .spark').count()) === 2);
  await d.locator('.tile[data-tile=week]').hover(); await sleep(300);
  await d.screenshot({ path: path.join(__dirname, 'interactive-home.png') });
  const lift = await d.locator('.tile[data-tile=week]').evaluate((e) => getComputedStyle(e).transform);
  check('1 tile lifts on hover', lift !== 'none', lift);

  // 2. tile → orders of that period
  await d.click('.tile[data-tile=today]'); await sleep(900);
  const todayRows = await d.$$eval('#view tbody tr td', (tds) => tds.length);
  const st = await d.evaluate(() => ({ hash: location.hash, from: document.querySelector('#dateFrom')?.value, preset: [...document.querySelectorAll('#rangeSeg button')].find((b) => b.getAttribute('aria-pressed') === 'true')?.dataset.preset }));
  check('2 «Сегодня» opens orders for today', st.hash === '#orders' && st.preset === 'custom', JSON.stringify(st));
  await d.goto(url('home')); await sleep(800);
  await d.click('.tile[data-tile=week]'); await sleep(900);
  const st2 = await d.evaluate(() => [...document.querySelectorAll('#rangeSeg button')].find((b) => b.getAttribute('aria-pressed') === 'true')?.dataset.preset);
  check('2 «7 дней» opens orders for 7 days', st2 === '7', String(st2));

  // 3. a store card → that store only
  await d.goto(url('home')); await sleep(800);
  const sid = await d.locator('.home-store--link').first().getAttribute('data-store');
  await d.locator('.home-store--link').first().click(); await sleep(900);
  check('3 store card filters the dashboard to that store', (await d.locator('#storeFilter').inputValue()) === sid && (await d.evaluate(() => location.hash)) === '#orders');
  await d.selectOption('#storeFilter', 'all'); await sleep(500);

  // 4. analytics: click a day on the chart → that day's orders; a store bar → that store
  await d.goto(url('analytics')); await sleep(1500);
  await d.click('#rangeSeg button[data-preset="30"]'); await sleep(800);
  await d.screenshot({ path: path.join(__dirname, 'interactive-analytics.png') });
  const chart = d.locator('.chart-hit--pick').first();
  const box = await chart.boundingBox();
  await d.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2); await sleep(200);
  check('4 tooltip invites to click', (await d.locator('.chart-tip').first().innerText()).includes('Нажмите'));
  await d.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2); await sleep(900);
  const st4 = await d.evaluate(() => ({ hash: location.hash, preset: [...document.querySelectorAll('#rangeSeg button')].find((b) => b.getAttribute('aria-pressed') === 'true')?.dataset.preset }));
  check('4 click on a day opens that day\'s orders', st4.hash === '#orders' && st4.preset === 'custom', JSON.stringify(st4));
  await d.goto(url('analytics')); await sleep(1500);
  const bars = d.locator('rect.chart-hit--pick');
  const nBars = await bars.count();
  // first bar of «Выручка по магазинам» (line charts have one hit rect each: skip 2)
  await bars.nth(2).click(); await sleep(700);
  const picked = await d.locator('#storeFilter').inputValue();
  check('4 click on a store bar shows that store only', nBars >= 4 && picked !== 'all', `${nBars} hits, filter ${picked}`);
  await bars.nth(2).click().catch(() => {}); await sleep(500);

  // 5. reduced motion: no animations
  await d.emulateMedia({ reducedMotion: 'reduce' });
  await d.goto(url('analytics')); await sleep(1200);
  const anim = await d.locator('.chart-line-in').first().evaluate((e) => getComputedStyle(e).animationName).catch(() => 'none');
  check('5 «reduce motion» turns animations off', anim === 'none', anim);

  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  await ctx.close();
})().catch((e) => { console.error('CRASH', e.message.split('\n')[0]); process.exit(1); });
