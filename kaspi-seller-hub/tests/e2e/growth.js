// Plans and retention in the extension: store meter in the top bar, soft paywall on «Старт»
// (24 h boost, upgrade with proration), cancellation flow (discount / freeze / cancel / resume),
// grace days, Telegram card (link → linked → switches), digest numbers and a real deadline alert
// through the bot function, Kaspi circuit breaker banner, smart polling alarm.
// Uses ../billcopy (mock Supabase :8098 with the real SQL and the real bot function, mock Kaspi :8099,
// mock Telegram :8095).
const { chromium } = require('playwright');
const path = require('path');
const http = require('http');
const { Client } = require('pg');
const EXT = path.join(__dirname, '../billcopy');
let fails = 0;
const check = (n, ok, i = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, ok ? '' : i); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BOT_KEY = 'bot-key-0123456789abcdef0123456789abcdef';

(async () => {
  const db = new Client({ host: '/tmp', port: 5499, user: 'postgres', database: 'billing' });
  await db.connect();
  const q = async (sql, a) => (await db.query(sql, a)).rows;
  const tgSent = [];
  const tg = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { tgSent.push(JSON.parse(b || '{}')); res.end('{"ok":true,"result":{}}'); }); }).listen(8095);
  await fetch('http://localhost:8099/__down?on=0');
  await q("update ops_settings set bot_key_hash = encode(sha256(convert_to($1, 'utf8')), 'hex')", [BOT_KEY]);
  await q("update billing_config set bot_username = 'SellerHubBot', app_url = 'https://sellerhub.example.kz', support_url = 'https://t.me/sh_support'");

  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'growprof' + Date.now()), { headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 }, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  await ctx.route('https://t.me/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>Telegram</p>' })); // no internet in tests
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const errs = [];
  const d = await ctx.newPage(); d.on('pageerror', (e) => errs.push(e.message));
  const url = (r) => `chrome-extension://${id}/dashboard/dashboard.html#${r}`;
  const msg = (type, payload) => d.evaluate(([t, p]) => chrome.runtime.sendMessage({ type: t, payload: p }), [type, payload]);
  const fresh = async (route) => { await msg('ui:billingState', { force: true }); await d.goto(url(route)); await d.reload(); await sleep(1500); };

  await d.goto(url('account'));
  await d.evaluate(() => { ['home', 'orders', 'settings', 'account', 'help'].forEach((r) => localStorage.setItem(`ksh.guide.${r}`, '1')); localStorage.setItem('ksh.tourDone', '1'); });
  await d.reload(); await d.waitForSelector('input[type=email]');
  await d.fill('input[type=email]', 'start@example.kz'); await d.check('label.consent input'); await d.click('button:has-text("Получить код")');
  await d.waitForSelector('input[autocomplete=one-time-code]'); await d.fill('input[autocomplete=one-time-code]', '123456'); await d.click('button:has-text("Войти")');
  await d.waitForSelector('.badge:has-text("Пробный период")', { timeout: 15000 });
  // paid «Старт»: 1 store, 15 days left
  await q("update accounts set paid_until = now() + interval '15 days', trial_ends_at = now() - interval '15 days', store_limit = 1 where email = 'start@example.kz'");
  await msg('ui:connectApi', { shopId: null, name: 'Магазин А', token: 'GOOD-TOKEN-1234' }); await sleep(4000);
  await fresh('home');

  // 1. top bar: «Магазин: Все магазины (1/1)» + «+ Добавить магазин»
  const meter = await d.locator('[data-block=store-meter]').innerText().catch(() => '');
  check('1 store meter in the top bar', meter.includes('Магазин: Все магазины (1/1)') && meter.includes('+ Добавить магазин'), meter);

  // 2. «+ Добавить магазин» on «Старт» → soft paywall with the offer and the proration
  await d.click('[data-action=add-store]'); await d.waitForSelector('#upsellDialog[open]'); await sleep(800);
  const up = (await d.locator('#upsellDialog').innerText()).replace(/[\u00a0\u202f]/g, ' ');
  check('2 offer: +8 000 ₸/мес for «Мульти» up to 3', /ещё 2 магазина всего за \+8\s?000 ₸\/мес/.test(up) && up.includes('до 3 магазинов'), up);
  check('2 proration shown: 8 000 / 30 × days left', /Сейчас к оплате 4\s?[0-3]00 ₸ — только за оставшиеся 1[56] дн/.test(up), up);
  check('2 three buttons (try 24 h / upgrade / later)', (await d.locator('#upsellDialog [data-action=boost]').count()) === 1 && (await d.locator('#upsellDialog [data-action=upgrade]').count()) === 1);
  await d.click('#upsellDialog [data-action=boost]'); await sleep(1500);
  check('2 boost: connect form opens right away', await d.evaluate(() => document.getElementById('connectDialog').open));
  await d.click('#connectCancel');
  await fresh('home');
  const meter2 = await d.locator('[data-block=store-meter]').innerText();
  check('2 boost: limit 3 for 24 h, badge shown', meter2.includes('(1/3)') && meter2.includes('3 магазина · 24 ч'), meter2);
  check('2 boost is signed in the token (the extension does not trust storage)', (await q("select boost_until > now() + interval '23 hours' ok from accounts where email='start@example.kz'"))[0]?.ok);

  // 3. boost over → upgrade now → payment window with the prorated add-on
  await q("update accounts set boost_until = now() - interval '1 minute' where email = 'start@example.kz'");
  await fresh('home');
  await d.click('[data-action=add-store]'); await d.waitForSelector('#upsellDialog[open]'); await sleep(600);
  check('3 boost only once: no «попробовать» button now', (await d.locator('#upsellDialog [data-action=boost]').count()) === 0);
  await d.click('#upsellDialog [data-action=upgrade]');
  await d.waitForFunction(() => document.getElementById('payDialog').open, null, { timeout: 15000 }); await sleep(800);
  const inv = (await q("select kind, stores, amount from invoices i join accounts a using (user_id) where a.email='start@example.kz' and i.status='pending'"))[0];
  check('3 add-on invoice: 3 stores, (20 000 − 12 000) / 30 × days', inv?.kind === 'addon' && inv.stores === 3 && inv.amount >= 4000 && inv.amount <= 4300, JSON.stringify(inv));
  check('3 payment window shows that amount', (await d.locator('#payDialog').innerText()).replace(/\s/g, '').includes(`${inv?.amount}`.replace(/\B(?=(\d{3})+(?!\d))/g, '') + '₸') || (await d.locator('#payDialog').innerText()).replace(/\s/g, '').includes(String(inv?.amount)));
  await d.click('#payDialog button:has-text("Позже")').catch(() => {});
  await q("update invoices set status = 'cancelled' where status = 'pending'");

  // 4. cancellation flow: «Дорого» → 30 % on 2 invoices
  await fresh('account');
  check('4 plan shown on the account page', (await d.locator('[data-card=subscription]').innerText()).includes('«Старт» — 1 магазин'));
  await d.click('[data-action=cancel-subscription]'); await d.waitForSelector('#cancelDialog[open]');
  await d.locator('#cancelDialog label', { hasText: 'Дорого' }).locator('input').check(); await d.click('#cancelDialog [data-action=cancel-next]');
  check('4 «Дорого»: 30 % offer; no «Старт» offer on «Старт»', (await d.locator('#cancelDialog [data-offer=discount]').count()) === 1 && (await d.locator('#cancelDialog [data-offer=downgrade]').count()) === 0);
  await d.click('#cancelDialog [data-action=offer-discount]'); await sleep(1200);
  check('4 discount taken, thanks shown', (await d.locator('#cancelDialog').innerText()).includes('Скидка 30 % применится'));
  check('4 server: 30 % on the next 2 invoices', (await q("select discount_pct, discount_left from accounts where email='start@example.kz'"))[0]?.discount_left === 2);
  await d.keyboard.press('Escape');

  // 5. «Закрыл магазин» → freeze → frozen banner → unfreeze
  await fresh('account');
  await d.click('[data-action=cancel-subscription]'); await d.waitForSelector('#cancelDialog[open]');
  await d.locator('#cancelDialog label', { hasText: 'Закрыл магазин' }).locator('input').check(); await d.click('#cancelDialog [data-action=cancel-next]');
  await d.click('#cancelDialog [data-action=offer-freeze]'); await sleep(1200);
  check('5 frozen for 30 days', (await d.locator('#cancelDialog').innerText()).includes('заморожен на 30 дней'));
  await d.keyboard.press('Escape');
  await fresh('orders');
  check('5 frozen: banner + paywall, no pay window', (await d.locator('[data-banner=frozen]').count()) === 1 && (await d.locator('#view').innerText()).includes('заморожен') && !(await d.evaluate(() => document.getElementById('payDialog').open)));
  const packFrozen = await msg('ui:pack', { items: [{ shopId: 'x', orderId: '1' }] });
  check('5 frozen: actions refused by the worker', packFrozen?.error === 'subscriptionRequired', JSON.stringify(packFrozen));
  await d.click('[data-banner=frozen] [data-action=unfreeze]'); await sleep(2000);
  check('5 «Разморозить» → works again', (await d.locator('[data-banner=frozen]').count()) === 0 && !(await d.locator('#view').innerText()).includes('заморожен'));

  // 6. «Не хватает функций» → cancel anyway → cancelled notice → resume
  await fresh('account');
  await d.click('[data-action=cancel-subscription]'); await d.waitForSelector('#cancelDialog[open]');
  await d.locator('#cancelDialog label', { hasText: 'Не хватает функций' }).locator('input').check(); await d.click('#cancelDialog [data-action=cancel-next]');
  await d.fill('#cancelDialog [data-field=cancelComment]', 'Нужен демпинг-бот');
  await d.click('#cancelDialog [data-action=cancel-anyway]'); await sleep(1200);
  check('6 cancelled: access until the end, no renewal', (await d.locator('#cancelDialog').innerText()).includes('Подписка отменена'));
  check('6 the comment reached support', (await q("select count(*)::int n from support_tickets where topic = 'idea' and message like '%демпинг%'"))[0].n === 1);
  await d.keyboard.press('Escape');
  await fresh('home');
  check('6 «Подписка отменена» banner with «Возобновить»', (await d.locator('[data-banner=cancelled]').count()) === 1);
  await d.click('[data-banner=cancelled] [data-action=resume]'); await sleep(2000);
  check('6 resumed', (await d.locator('[data-banner=cancelled]').count()) === 0 && (await q("select cancel_at from accounts where email='start@example.kz'"))[0].cancel_at === null);

  // 7. grace: paid period over 1 day ago → still works, banner says until when
  await q("update accounts set paid_until = now() - interval '1 day' where email = 'start@example.kz'");
  await fresh('orders');
  check('7 grace: banner, orders still shown (no paywall)', (await d.locator('[data-banner=grace]').count()) === 1 && !(await d.locator('#view').innerText()).includes('Нужна подписка'));
  check('7 grace: no blocking window', !(await d.evaluate(() => document.getElementById('payDialog').open)) || (await d.locator('#payDialog button:has-text("Позже")').count()) === 1);
  await d.click('#payDialog button:has-text("Позже")').catch(() => {});
  await q("update accounts set paid_until = now() + interval '15 days' where email = 'start@example.kz'");

  // 8. Telegram card: link → bot /start → linked → switches
  await fresh('settings');
  const card = d.locator('[data-card=telegram]');
  check('8 Telegram card with what it gives', (await card.innerText()).includes('В 09:00') && (await card.locator('[data-action=tg-link]').count()) === 1);
  const [popup] = await Promise.all([ctx.waitForEvent('page'), card.locator('[data-action=tg-link]').click()]);
  const link = popup.url(); await popup.close().catch(() => {});
  check('8 opens t.me/SellerHubBot?start=<token>', /^https:\/\/t\.me\/SellerHubBot\?start=[0-9a-f]{64}$/.test(link), link);
  check('8 waiting for «Start»', (await card.innerText()).includes('Нажмите «Start»'));
  await fetch('http://localhost:8098/functions/v1/telegram-bot/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'webhook-secret-0123456789' }, body: JSON.stringify({ message: { chat: { id: 7001, type: 'private' }, from: { first_name: 'Алишер' }, text: `/start ${link.split('=')[1]}` } }) });
  await d.waitForSelector('[data-card=telegram] [data-block=tg-linked]', { timeout: 15000 }).catch(() => {});
  check('8 card shows «Подключено: Алишер»', (await card.innerText()).includes('Подключено: Алишер'));
  check('8 bot confirmed in Telegram', tgSent.some((m) => m.chat_id === 7001 && /Уведомления успешно подключены/.test(m.text)));
  await card.locator('[data-setting=tg-digest]').uncheck(); await sleep(800);
  check('8 switch «Утренняя сводка» off → saved', (await q('select digest from tg_links'))[0]?.digest === false);
  await card.locator('[data-setting=tg-digest]').check(); await sleep(800);

  // 9. digest numbers + a real deadline alert after a sync (order 800002001 must be accepted within the hour)
  tgSent.length = 0;
  await d.evaluate(() => chrome.storage.session.remove('ksh.deadlineNotified'));
  await msg('ui:sync'); await sleep(5000);
  const alert = tgSent.find((m) => /🚨 Внимание! Заказ №800002001 в магазине Магазин А под угрозой просрочки/.test(m.text || ''));
  check('9 deadline alert in Telegram with the order and the store', !!alert, JSON.stringify(tgSent.map((m) => m.text)));
  check('9 alert buttons: orders + support', alert?.reply_markup?.inline_keyboard?.[0]?.length === 2);
  await msg('ui:sync'); await sleep(3000);
  check('9 not repeated for the same order', tgSent.filter((m) => /Заказ №800002001/.test(m.text || '')).length === 1);
  await (await ctx.serviceWorkers()[0]).evaluate(() => chrome.alarms.create('ksh-health', { when: Date.now() + 50 })); await sleep(3000);
  const ds = await q("select day, stats from digest_stats ds join accounts a using (user_id) where a.email='start@example.kz' order by day");
  check('9 digest numbers sent for yesterday and today', ds.length === 2 && ds[1].stats.shops?.[0] === 'Магазин А' && ds.every((r) => !JSON.stringify(r.stats).includes('SECRET')), JSON.stringify(ds).slice(0, 300));

  // 10. Kaspi down 3 times → banner «показываем данные от …», the 4th sync does not call Kaspi
  await fetch('http://localhost:8099/__down?on=1');
  for (let i = 0; i < 3; i++) { await msg('ui:sync'); await sleep(7000); }
  const before = (await (await fetch('http://localhost:8099/__log')).json()).length;
  await msg('ui:sync'); await sleep(1500);
  const after = (await (await fetch('http://localhost:8099/__log')).json()).length;
  check('10 resting: no requests to Kaspi for 10 minutes', after === before, `${before} → ${after}`);
  await d.goto(url('orders')); await d.reload(); await sleep(1500);
  check('10 banner: «Kaspi API временно недоступен, показываем последние актуальные данные от …»', /Kaspi API временно недоступен, показываем последние актуальные данные от \d\d\.\d\d\.\d{4}/.test(await d.locator('[data-banner=kaspi-down]').innerText().catch(() => '')));
  await fetch('http://localhost:8099/__down?on=0');
  await (await ctx.serviceWorkers()[0]).evaluate(async () => { const s = (await chrome.storage.local.get('ksh.settings'))['ksh.settings']; Object.values(s.stores).forEach((x) => x.api && (x.api.errorAt = Date.now() - 11 * 60000)); await chrome.storage.local.set({ 'ksh.settings': s }); });
  await msg('ui:sync'); await sleep(4000);
  await d.reload(); await sleep(1200);
  check('10 after the pause Kaspi answers → back to normal', (await d.locator('[data-banner=kaspi-down]').count()) === 0);

  // 11. smart polling: the alarm ticks every minute, the interval is decided by the time of day
  const alarm = await (await ctx.serviceWorkers()[0]).evaluate(() => chrome.alarms.get('ksh-sync'));
  check('11 sync alarm every minute (2 min by day / 10 at night decided at each tick)', alarm?.periodInMinutes === 1, JSON.stringify(alarm));
  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  tg.close(); await db.end(); await ctx.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('CRASH', e.message); process.exit(1); });
