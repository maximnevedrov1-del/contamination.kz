// «Пульт»: usage counts and first steps reach the server; NPS card → answer; «Ответ помог?»;
// «Почему не продлеваете?» inside the blocking payment window; the admin panel shows it all.
// Uses ../billcopy (mock Supabase on :8098 with the REAL 001–004 SQL, mock Kaspi on :8099).
const { chromium } = require('playwright');
const path = require('path');
const { Client } = require('pg');
const EXT = path.join(__dirname, '../billcopy');
let fails = 0;
const check = (n, ok, i = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, ok ? '' : i); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const db = new Client({ host: '/tmp', port: 5499, user: 'postgres', database: 'billing' });
  await db.connect();
  const q = async (sql, a) => (await db.query(sql, a)).rows;
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'insprof' + Date.now()), { headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 }, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const errs = [];
  const d = await ctx.newPage(); d.on('pageerror', (e) => errs.push(e.message));
  const url = (r) => `chrome-extension://${id}/dashboard/dashboard.html#${r}`;
  const msg = (type, payload) => d.evaluate(([t, p]) => chrome.runtime.sendMessage({ type: t, payload: p }), [type, payload]);
  const flush = async () => { await sw.evaluate(() => chrome.alarms.create('ksh-health', { when: Date.now() + 100 })); await sleep(2500); };
  const freshDue = () => d.evaluate(() => chrome.storage.session.remove('ksh.feedbackDue'));

  // seller: sign in, connect, use a few sections
  await d.goto(url('account'));
  await d.evaluate(() => { ['home', 'orders', 'settings', 'account', 'help', 'analytics'].forEach((r) => localStorage.setItem(`ksh.guide.${r}`, '1')); localStorage.setItem('ksh.tourDone', '1'); });
  await d.reload(); await d.waitForSelector('input[type=email]');
  await d.fill('input[type=email]', 'seller@example.kz'); await d.check('label.consent input'); await d.click('button:has-text("Получить код")');
  await d.waitForSelector('input[autocomplete=one-time-code]'); await d.fill('input[autocomplete=one-time-code]', '123456'); await d.click('button:has-text("Войти")');
  await d.waitForSelector('.badge:has-text("Пробный период")', { timeout: 15000 });
  await msg('ui:connectApi', { shopId: null, name: 'Магазин А', token: 'GOOD-TOKEN-1234' }); await sleep(4000);
  for (const r of ['orders', 'analytics', 'orders', 'home']) { await d.goto(url(r)); await sleep(500); }
  const p = await ctx.newPage(); await p.addInitScript(() => (window.print = () => {}));
  await p.goto(`chrome-extension://${id}/dashboard/print.html?mode=test`); await sleep(1000); await p.close();

  // 1. counts and steps reach the server
  await flush();
  const u = (await q("select sections, actions from usage_daily u join auth.users a on a.id = u.user_id where a.email='seller@example.kz'"))[0];
  check('1 sections counted (orders ×2, analytics)', u?.sections?.orders >= 2 && u?.sections?.analytics >= 1, JSON.stringify(u));
  check('1 actions counted (connect)', u?.actions?.connect === 1, JSON.stringify(u?.actions));
  const st = (await q("select steps from user_progress p join auth.users a on a.id = p.user_id where a.email='seller@example.kz'"))[0]?.steps || {};
  check('1 first steps: store, orders, print; not costs', st.store && st.orders && st.print && !st.costs, JSON.stringify(st));
  const left = await d.evaluate(async () => (await chrome.storage.local.get('ksh.usage'))['ksh.usage']);
  check('1 sent counts removed locally (nothing sent twice)', Object.keys(left?.days || {}).length === 0, JSON.stringify(left));
  await flush();
  const u2 = (await q("select sections from usage_daily u join auth.users a on a.id = u.user_id where a.email='seller@example.kz'"))[0];
  check('1 second send adds nothing', u2?.sections?.orders === u.sections.orders, JSON.stringify(u2));

  // 2. NPS after 14 days and 5 active days
  await q("update accounts set created_at = now() - interval '15 days' where email='seller@example.kz'");
  await q("insert into usage_daily (user_id, day, sections) select a.id, current_date - g, '{\"orders\": 2}' from auth.users a, generate_series(1, 5) g where a.email='seller@example.kz'");
  await freshDue(); await d.goto(url('home')); await d.reload(); await sleep(1800);
  const nps = d.locator('[data-card=nps]');
  check('2 NPS card on Home', (await nps.count()) === 1 && (await nps.innerText()).includes('порекомендуете'));
  await nps.locator('[data-score="4"]').click(); await sleep(200);
  check('2 low score asks «что улучшить»', (await nps.innerText()).includes('Что нам улучшить'));
  await nps.locator('[data-field=npsComment]').fill('Нужен демпинг-бот');
  await nps.locator('[data-action=nps-send]').click(); await sleep(1000);
  const fb = (await q("select score, comment from feedback where kind='nps'"))[0];
  check('2 answer stored: 4 + comment', fb?.score === 4 && fb.comment === 'Нужен демпинг-бот', JSON.stringify(fb));
  check('2 thanks shown', (await nps.innerText()).includes('Спасибо'));
  await freshDue(); await d.reload(); await sleep(1500);
  check('2 not asked again', (await d.locator('[data-card=nps]').count()) === 0);

  // 3. «Ответ помог?»
  await d.goto(url('help')); await sleep(1000);
  await msg('ui:ticketSend', { topic: 'print', message: 'Как напечатать на термопринтере?' });
  await q("update support_tickets set reply = 'Настройки → Печать → Этикетка 100×150', status = 'answered', replied_at = now()");
  await d.reload(); await sleep(1800);
  const tk = d.locator('[data-block=tickets] details').first();
  if ((await tk.getAttribute('open')) === null) await tk.locator('summary').click();
  await sleep(500);
  await tk.locator('[data-action=csat-yes]').click(); await sleep(1200);
  check('3 «Ответ помог? Да» stored', (await q("select score from feedback where kind='csat'"))[0]?.score === 1);
  check('3 thanks instead of buttons', (await d.locator('[data-block=tickets] [data-block=csat]').first().innerText()).includes('Спасибо'));

  // 4. trial over → blocking payment window has «почему не продлеваете»
  await q("update accounts set trial_ends_at = now() - interval '1 hour' where email='seller@example.kz'");
  await msg('ui:billingState', { force: true }); await freshDue();
  await d.goto(url('home')); await d.reload();
  await d.waitForFunction(() => document.getElementById('payDialog').open, null, { timeout: 30000 }); await sleep(800);
  const ex = d.locator('#payDialog [data-block=pay-exit]');
  check('4 blocking window offers «Не планируете продлевать?»', (await ex.count()) === 1);
  await ex.locator('summary').click();
  await ex.locator('label', { hasText: 'Нет нужной функции' }).locator('input').check();
  await ex.locator('[data-field=exitComment]').fill('Нет мобильной версии');
  await ex.locator('[data-action=exit-send]').click(); await sleep(1000);
  const exr = (await q("select reason, comment from feedback where kind='exit'"))[0];
  check('4 reason + comment stored', exr?.reason === 'missing' && exr.comment === 'Нет мобильной версии', JSON.stringify(exr));
  check('4 thanks inside the window', (await ex.innerText()).includes('Спасибо'));

  // 5. the owner's panel
  await q("insert into auth.users (id, email) values ('b0000000-0000-0000-0000-000000000001', 'stuck@example.kz'), ('b0000000-0000-0000-0000-000000000002', 'stuck2@example.kz'), ('b0000000-0000-0000-0000-000000000003', 'stuck3@example.kz')");
  await q("update accounts set created_at = now() - interval '3 days' where email='stuck@example.kz'");
  const a = await ctx.newPage(); a.on('pageerror', (e) => errs.push('[admin] ' + e.message));
  await a.goto(`file://${EXT}/billing/admin/index.html`);
  await a.fill('#url', 'http://localhost:8098'); await a.fill('#key', 'test-anon-key'); await a.click('#saveConn');
  await a.fill('#email', 'owner@example.kz'); await a.click('#sendCode'); await a.waitForSelector('#codeRow:not([hidden])');
  await a.fill('#code', '123456'); await a.click('#verify');
  await a.waitForSelector('#app:not([hidden])', { timeout: 15000 }); await sleep(800);
  await a.click('[data-tab=insights]'); await a.waitForSelector('.tiles', { timeout: 15000 });
  const text = await a.locator('#panel').innerText();
  check('5 NPS tile −100 (one critic)', /NPS\s*−?-?100/.test(text.replace(/\n/g, ' ')), text.slice(0, 300));
  check('5 funnel: 3 of 4 never connected a store → that step is the bottleneck', (await a.locator('.funnel tr.is-worst').getAttribute('data-step').catch(() => null)) === 'store');
  check('5 sections: «Заказы» used, «Чат» nobody', text.includes('Заказы') && (await a.locator('tr:has-text("никто не пользуется")').count()) > 0);
  check('5 NPS comment and exit reason visible', text.includes('Нужен демпинг-бот') && text.includes('Нет нужной функции') && text.includes('Нет мобильной версии'));
  check('5 risk list: stuck seller «Не подключил магазин» with «Написать»', (await a.locator('tr[data-risk=noStore]', { hasText: 'stuck@example.kz' }).count()) === 1 && (await a.locator('tr[data-risk=noStore] a[href^="mailto:stuck@example.kz"]').count()) === 1);
  check('5 «Ответ помог» 100 %', text.replace(/\s+/g, ' ').includes('«Ответ помог» 100 %'));
  await a.setViewportSize({ width: 390, height: 800 }); await sleep(300);
  const wide = await a.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest('#panel')).slice(0, 5).map((e) => e.tagName + '.' + e.className + '#' + e.id + ':' + Math.round(e.getBoundingClientRect().right)));
  check('5 panel fits a phone (no horizontal page scroll)', await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), JSON.stringify(wide));
  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  await db.end();
  await ctx.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('CRASH', e.message); process.exit(1); });
