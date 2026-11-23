const { chromium } = require('playwright'); require('./offline');
const fs = require('fs');
const path = require('path');
const EXT = path.join(__dirname, '../billcopy');
const OUT = __dirname;
let fails = 0; const check = (n, ok, i = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, i); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SUPA = 'http://localhost:8098';
const sql = (q) => fetch(`${SUPA}/__sql`, { method: 'POST', body: JSON.stringify({ sql: q }) }).then((r) => r.json());
const H = { apikey: 'test-anon-key', 'Content-Type': 'application/json' };
async function adminToken() {
  await fetch(`${SUPA}/auth/v1/otp`, { method: 'POST', headers: H, body: JSON.stringify({ email: 'owner@example.kz', create_user: false }) });
  const s = await fetch(`${SUPA}/auth/v1/verify`, { method: 'POST', headers: H, body: JSON.stringify({ type: 'email', email: 'owner@example.kz', token: '123456' }) }).then((r) => r.json());
  return s.access_token;
}
async function adminConfirmPending() {
  const tk = await adminToken();
  const call = (fn, args) => fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { ...H, Authorization: 'Bearer ' + tk }, body: JSON.stringify(args) }).then((r) => r.json());
  const list = (await call('admin_invoices', { p_status: 'pending', p_search: null, p_limit: 100, p_offset: 0 })).rows;
  return list.length ? call('admin_confirm_invoice', { p_id: list[0].id, p_note: 'test', p_expected_amount: list[0].amount, p_expected_stores: list[0].stores }) : null;
}

(async () => {
  // a QR image the client will scan (data URL so the test needs no web server)
  const qr = 'data:image/png;base64,' + fs.readFileSync(path.join(EXT, 'icons/icon-128.png')).toString('base64');
  await sql(`update billing_config set kaspi_qr_url = '${qr}', payment_instructions = 'Kaspi → QR → отсканируйте и оплатите сумму.'`);

  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'bill2prof'), { headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2]; const errs = [];
  for (const x of ['a', 'b', 'c']) { const p = await ctx.newPage(); await p.goto(`file://${EXT}/demo/mc/store-${x}.html`); }
  const d = await ctx.newPage(); d.on('pageerror', (e) => errs.push(e.message)); d.on('console', (m) => m.type() === 'error' && errs.push('[console] ' + m.text()));
  const refresh = async () => { await d.click('#refreshBtn'); await d.waitForFunction(() => !document.querySelector('#refreshBtn').disabled, null, { timeout: 90000 }); await sleep(500); };
  const payOpen = () => d.evaluate(() => document.getElementById('payDialog').open);
  const payText = () => d.locator('#payDialog').innerText();

  // login (trial, 3 stores)
  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#account`);
  await d.waitForSelector('input[type=email]');
  await d.fill('input[type=email]', 'shop@example.kz'); await d.check('label.consent input'); await d.click('button:has-text("Получить код")');
  await d.waitForSelector('input[autocomplete=one-time-code]'); await d.fill('input[autocomplete=one-time-code]', '123456'); await d.click('button:has-text("Войти")');
  await d.waitForSelector('.badge:has-text("Пробный период")', { timeout: 15000 });
  // the default trial is 14 days now (migration 018); this suite's prorating maths assumes 30 days left
  await sql("update accounts set trial_ends_at = now() + interval '30 days' where email = 'shop@example.kz'");
  await d.evaluate(() => (location.hash = 'orders')); await refresh();
  check('A0 trial: 3 stores, no payment window yet', !(await payOpen()));

  // A. connect a 4th store with the simple form → QR window right away
  await d.click('#connectStoreBtn');
  check('A1 connect form shows the price rule', (await d.locator('#connectPrice').innerText()).replace(/\s/g, '').includes('5000₸'));
  await d.fill('#connectName', 'Автозапчасти'); await d.fill('#connectToken', 'GOOD-TOKEN-1234');
  await d.click('#connectSubmit');
  await d.waitForFunction(() => document.getElementById('payDialog').open, null, { timeout: 30000 });
  const t1 = await payText();
  check('A2 payment window opened right after connecting', t1.includes('Оплатите подключение 1 магазина'), t1.split('\n')[0]);
  check('A2 prorated add-on amount 5 000 ₸ (30 days left), QR shown', t1.replace(/\s/g, '').includes('5000₸') && (await d.locator('#payDialog img.pay__qr').count()) === 1);
  await d.screenshot({ path: `${OUT}/pay-addon.png` });
  await d.click('#payDialog button:has-text("Позже")'); await sleep(300);
  await refresh();
  const overBanner = await d.locator('.banner', { hasText: 'сверх лимита' }).count();
  check('A3 new store NOT active before payment (over limit)', overBanner === 1);
  // owner confirms → window (re-opened) closes by itself, store switched on
  await d.click('.banner button:has-text("Добавить магазины в подписку")');
  await d.waitForFunction(() => document.getElementById('payDialog').open);
  await adminConfirmPending();
  await d.waitForFunction(() => !document.getElementById('payDialog').open, null, { timeout: 30000 });
  check('A4 window closed by itself after payment confirmation', true);
  check('A4 "payment received" message', (await d.locator('.toast').allTextContents()).some((x) => x.includes('Оплата получена')));
  await d.waitForFunction(() => !document.querySelector('#refreshBtn').disabled, null, { timeout: 90000 }); await sleep(800);
  check('A5 4th store active right after payment', (await d.locator('.banner', { hasText: 'сверх лимита' }).count()) === 0);

  // B. 5 days before the end → one invoice for ALL stores, window + Chrome notification with QR
  await sql("update accounts set trial_ends_at = now() + interval '4 days 2 hours' where email = 'shop@example.kz'");
  await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:billingState', payload: { force: true } }));
  await d.evaluate(() => localStorage.clear()); await d.reload();
  await d.waitForFunction(() => document.getElementById('payDialog').open, null, { timeout: 30000 });
  const t2 = await payText();
  check('B1 renewal window: "заканчивается через 5 дней", 4 stores, 25 000 ₸', /через [45] дн/.test(t2) && t2.replace(/\s/g, '').includes('25000₸') && t2.includes('магазинов: 4'), t2.split('\n').slice(0, 4).join(' | '));
  await d.screenshot({ path: `${OUT}/pay-renewal.png` });
  const notes = await sw.evaluate(() => new Promise((r) => chrome.notifications.getAll(r)));
  check('B2 Chrome notification about the payment was shown', Object.keys(notes).some((k) => k.startsWith('ksh:pay:')), JSON.stringify(Object.keys(notes)));
  const inv = await sql("select kind, stores, amount, count(*) over () n from invoices i join accounts a using (user_id) where a.email='shop@example.kz' and i.status='pending'");
  check('B3 exactly one open invoice: renewal for all stores', inv.length === 1 && inv[0].kind === 'renewal' && inv[0].stores === 4 && inv[0].amount === 25000, JSON.stringify(inv));
  await d.click('#payDialog button:has-text("Позже")');
  // popup offers the QR too
  const pop = await ctx.newPage(); await pop.goto(`chrome-extension://${id}/popup/popup.html`); await sleep(1500);
  const pn = await pop.locator('#licenseNotice').innerText();
  check('B4 popup: "Оплата … 25 000 ₸ — Оплатить по QR"', pn.replace(/\s/g, '').includes('25000') && pn.includes('Оплатить по QR'), pn);
  await pop.close();

  // C. not paid in time → cabinet blocked, only the QR window (cannot be closed)
  await sql("update accounts set trial_ends_at = now() - interval '1 hour' where email = 'shop@example.kz'");
  await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:billingState', payload: { force: true } }));
  // the dashboard stays open: the minute check must block it without a reload
  await d.waitForFunction(() => document.getElementById('payDialog').open, null, { timeout: 75000 });
  const t3 = await payText();
  check('C1 expired: blocking QR window, full amount for all stores', t3.includes('Подписка закончилась') && t3.replace(/\s/g, '').includes('25000₸'), t3.split('\n').slice(0, 3).join(' | '));
  check('C2 no "Позже" button', (await d.locator('#payDialog button:has-text("Позже")').count()) === 0);
  await d.keyboard.press('Escape'); await sleep(300);
  check('C3 Escape does not close it', await payOpen());
  check('C4 cabinet blocked behind the window', (await d.locator('#view').innerText()).includes('Нужна подписка'));
  const packTry = await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:pack', payload: { items: [{ shopId: '1001', orderId: '500000' }] } }));
  check('C5 actions refused while blocked', packTry?.error === 'subscriptionRequired');
  await d.screenshot({ path: `${OUT}/pay-blocked.png` });
  // pays → owner confirms → unlocked by itself
  const t0 = Date.now();
  await adminConfirmPending();
  await d.waitForFunction(() => !document.getElementById('payDialog').open, null, { timeout: 30000 });
  await d.waitForFunction(() => document.querySelectorAll('table.data tbody tr').length > 0, null, { timeout: 90000 });
  check('C6 unlocked automatically after confirmation', true, `${Math.round((Date.now() - t0) / 1000)} s`);
  const acc = await sql("select paid_until > now() + interval '27 days' ok, store_limit from accounts where email='shop@example.kz'");
  check('C7 paid for a month, 4 stores', acc[0].ok && acc[0].store_limit === 4, JSON.stringify(acc[0]));

  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  await ctx.close();
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
