// Anonymous UX telemetry: the dashboard batches counters in memory, flushes them (timer / page hidden),
// the worker calls track_ux_event (real SQL via mock Supabase). Verifies batching, rage click, abandoned
// form, and that only whitelisted codes (no text, URLs or typed values) reach the database.
// Uses ../billcopy (mock Supabase :8098 with the real SQL).
const { chromium } = require('playwright'); require('./offline');
const path = require('path');
const { Client } = require('pg');
const EXT = path.join(__dirname, '../billcopy');
let fails = 0;
const check = (n, ok, i = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, ok ? '' : i); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EMAIL = 'ux@example.kz';

(async () => {
  const db = new Client({ host: '/tmp', port: 5499, user: 'postgres', database: 'billing' });
  await db.connect();
  const rows = async () => (await db.query("select u.event_type t, u.target_key k, u.screen_key s, u.occurrences n from ux_events u join auth.users a on a.id = u.user_id where a.email = $1 order by 1, 2, 3", [EMAIL])).rows;
  const has = (list, t, k, s) => list.some((r) => r.t === t && r.k === k && (!s || r.s === s));

  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'uxtprof' + Date.now()), { headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 }, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const errs = [];
  const d = await ctx.newPage(); d.on('pageerror', (e) => errs.push(e.message));
  const url = (r) => `chrome-extension://${id}/dashboard/dashboard.html#${r}`;
  const msg = (type, payload) => d.evaluate(([t, p]) => chrome.runtime.sendMessage({ type: t, payload: p }), [type, payload]);

  await d.goto(url('account'));
  await d.evaluate(() => { ['home', 'orders', 'returns', 'settings', 'account', 'help'].forEach((r) => localStorage.setItem(`ksh.guide.${r}`, '1')); localStorage.setItem('ksh.tourDone', '1'); });
  await d.reload(); await d.waitForSelector('input[type=email]');
  await d.fill('input[type=email]', EMAIL); await d.check('label.consent input'); await d.click('button:has-text("Получить код")');
  await d.waitForSelector('input[autocomplete=one-time-code]'); await d.fill('input[autocomplete=one-time-code]', '123456'); await d.click('button:has-text("Войти")');
  await d.waitForSelector('.badge:has-text("Пробный период")', { timeout: 15000 });
  await d.goto(url('home')); await d.reload(); await sleep(1500);
  // login took a while: flush what the first minute collected and start from an empty table
  await d.evaluate(() => dispatchEvent(new Event('pagehide'))); await sleep(2500);
  await db.query('delete from ux_events');

  // sections + clicks on marked controls; 5 quick clicks on one control = rage click
  // (the page may already have sent events from the login phase, so start clean)
  await d.click('a[data-ux-key=nav_orders]'); await sleep(300);
  await d.click('a[data-ux-key=nav_returns]'); await sleep(300);
  await d.click('a[data-ux-key=nav_home]'); await sleep(300);
  await d.evaluate(() => { for (let i = 0; i < 5; i++) document.querySelector('a[data-ux-key=nav_analytics]').click(); });
  await sleep(1200);
  check('1 nothing is sent while the batch window is open (batched, not per click)', (await rows()).length === 0, JSON.stringify(await rows()));

  // a form left open > 15 s without saving; text typed into it must never be sent
  await d.evaluate(() => document.getElementById('connectStoreBtn').click());
  await d.waitForSelector('#connectDialog[open]');
  await d.fill('#connectName', 'Секретный магазин'); await d.fill('#connectToken', 'SECRET-TOKEN-ZZZ-9999');
  await sleep(16500);
  await d.click('#connectCancel'); await sleep(300);

  // the worker ignores anything outside the whitelist even if the page is compromised
  await msg('ui:trackUx', { events: [{ t: 'action_click', k: 'https://kaspi.kz/x?t=1', s: 'home', n: 1 }, { t: 'evil', k: 'abc', s: 'home', n: 1 }, { t: 'action_click', k: '123456', s: 'home', n: 1 }, { t: 'action_click', k: 'Кнопка', s: 'home', n: 1 }] });
  // page hidden → final flush
  await d.evaluate(() => dispatchEvent(new Event('pagehide')));
  await sleep(4000);
  const r = await rows();
  check('2 flush stored screen views', has(r, 'screen_view', 'orders', 'orders') && has(r, 'screen_view', 'returns', 'returns') && has(r, 'screen_view', 'home', 'home'), JSON.stringify(r));
  check('3 clicks on data-ux-key controls', has(r, 'action_click', 'nav_orders') && has(r, 'action_click', 'btn_connect_store'), JSON.stringify(r));
  check('4 rage click detected (5 quick clicks on one nav item)', has(r, 'rage_click', 'nav_analytics'), JSON.stringify(r));
  check('5 abandoned connect form', has(r, 'form_abandoned', 'connectdialog'), JSON.stringify(r));
  check('6 only short codes stored (no text, URLs, typed values)', r.length > 0 && r.every((x) => /^[a-z0-9_:-]{1,64}$/.test(x.k) && /^[a-z0-9_:-]{1,64}$/.test(x.s) && !/^[0-9]+$/.test(x.k)) && !JSON.stringify(r).match(/secret|token|кнопка|http|kaspi/i), JSON.stringify(r));
  check('7 non-whitelisted events from the page were dropped', !has(r, 'evil', 'abc') && !r.some((x) => /^[0-9]+$/.test(x.k) || x.k.includes('kaspi')), JSON.stringify(r));
  check('8 a saved form is not abandoned', !has(r, 'form_abandoned', 'reasondialog') && !has(r, 'form_abandoned', 'settings'), JSON.stringify(r));
  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  await db.end(); await ctx.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('CRASH', e.message); process.exit(1); });
