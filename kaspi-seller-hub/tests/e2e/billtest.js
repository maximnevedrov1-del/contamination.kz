const { chromium } = require('playwright'); require('./offline');
const path = require('path');
const EXT = path.join(__dirname, '../billcopy');
let fails = 0; const check = (n, ok, i = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, i); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => fetch('http://localhost:8098/__sql', { method: 'POST', body: JSON.stringify({ sql: q }) }).then((r) => r.json());
const OUT = __dirname;

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'billprof'), { headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2]; const errs = [];
  const d = await ctx.newPage(); d.on('pageerror', (e) => errs.push(e.message)); d.on('console', (m) => m.type() === 'error' && errs.push('[console] ' + m.text()));
  const toastsClear = () => d.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  const closePay = async () => { if (await d.evaluate(() => document.getElementById('payDialog').open)) { await d.evaluate(() => (window.__payShown = true)); await d.click('#payDialog button:has-text("Позже")'); await sleep(200); } };
  const refresh = async () => { for (let k = 0; k < 5; k++) { await closePay(); try { await d.click('#refreshBtn', { timeout: 3000 }); break; } catch { await sleep(500); } } await d.waitForFunction(() => !document.querySelector('#refreshBtn').disabled, null, { timeout: 60000 }); await sleep(400); };

  // 1. logged out → paywall everywhere except "Подписка"
  for (const x of ['a', 'b', 'c', 'd']) { const p = await ctx.newPage(); await p.goto(`file://${EXT}/demo/mc/store-${x}.html`); }
  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#orders`);
  await d.waitForFunction(() => !document.querySelector('#refreshBtn').disabled, null, { timeout: 30000 }); await sleep(500);
  check('1 logged out: orders replaced by paywall', (await d.locator('#view').innerText()).includes('Нужна подписка'));
  const snapsLoggedOut = await d.evaluate(async () => Object.keys((await (async () => { const g = chrome.storage.local; const ids = (await g.get('ksh.snapIndex'))['ksh.snapIndex']; if (!ids) return (await g.get('ksh.snapshots'))['ksh.snapshots']; const r = await g.get(ids.map((i) => 'ksh.snap.' + i)); return Object.fromEntries(ids.filter((i) => r['ksh.snap.' + i]).map((i) => [i, r['ksh.snap.' + i]])); })()) || {}).length);
  check('1 logged out: no store data was synced', snapsLoggedOut === 0, String(snapsLoggedOut));
  const packTry = await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:pack', payload: { items: [{ shopId: '1001', orderId: '500000' }] } }));
  check('1 logged out: worker refuses actions', packTry?.error === 'subscriptionRequired', JSON.stringify(packTry));
  const pop = await ctx.newPage(); await pop.goto(`chrome-extension://${id}/popup/popup.html`); await sleep(1500);
  check('1 popup shows subscription notice', !(await pop.locator('#licenseNotice').isHidden()) && (await pop.locator('#licenseNotice').innerText()).includes('Перейти к подписке'));
  await pop.close();

  // 2. login with e-mail code; wrong code first
  await d.click('a:has-text("Перейти к подписке")'); await sleep(400);
  await d.screenshot({ path: `${OUT}/bill-login.png` });
  await d.fill('input[type=email]', 'Seller@Example.kz');
  check('2 «Получить код» disabled until the consent box is ticked', await d.locator('button:has-text("Получить код")').isDisabled());
  const consentText = await d.locator('label.consent').innerText();
  check('2 small print names the offer and the privacy policy', consentText.includes('Публичной оферты') && consentText.includes('Политикой конфиденциальности'), consentText);
  const hrefs = await d.$$eval('label.consent a', (as) => as.map((a) => a.href));
  check('2 links open the bundled offer / policy', hrefs[0]?.endsWith('/legal/terms.html#offer') && hrefs[1]?.endsWith('/legal/terms.html#privacy'), hrefs.join(' '));
  const legal = await ctx.newPage(); await legal.goto(hrefs[1]);
  check('2 legal page renders both documents', (await legal.locator('#offer h1').innerText()).includes('Публичная оферта') && (await legal.locator('#privacy h1').innerText()).includes('Политика конфиденциальности'));
  await legal.close();
  await d.check('label.consent input');
  await d.screenshot({ path: `${OUT}/bill-consent.png` });
  await d.click('button:has-text("Получить код")');
  await d.waitForSelector('input[autocomplete=one-time-code]');
  await d.fill('input[autocomplete=one-time-code]', '000000'); await d.click('button:has-text("Войти")'); await sleep(600);
  check('2 wrong code rejected', (await d.locator('#view .banner[role=alert]').innerText().catch(() => '')).includes('неверный'));
  await d.fill('input[autocomplete=one-time-code]', '123456'); await d.click('button:has-text("Войти")');
  await d.waitForSelector('.badge:has-text("Пробный период")', { timeout: 15000 });
  const acc = await sql("select trial_ends_at > now() + interval '29 days' ok from accounts where email='seller@example.kz'");
  const cons = await sql("select c.version, c.ip, c.user_agent, a.terms_version, a.terms_accepted_at is not null acc from consents c join accounts a using (user_id) where a.email='seller@example.kz'");
  check('2 consent saved on the server: version, time, IP, browser', cons.length === 1 && cons[0].version === '2026-11-16' && cons[0].terms_version === '2026-11-16' && cons[0].acc && cons[0].ip === '5.76.0.9' && /Chrome/.test(cons[0].user_agent), JSON.stringify(cons));
  check('2 account created with a 30-day trial', acc[0]?.ok === true);
  check('2 sidebar plan chip shows the trial', (await d.locator('#planChip').innerText()).startsWith('Пробный период до'));
  const tokenLeak = await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:getState' }).then((s) => JSON.stringify(s)));
  check('2 session tokens never sent to pages', !/eyJ[\w-]+\.eyJ[\w-]+|rt-[0-9a-f]{16}/.test(tokenLeak));

  // 3. trial: 3 of 4 stores synced, 4th over limit
  await d.evaluate(() => (location.hash = 'orders')); await refresh();
  const storesInTable = await d.$$eval('tbody tr td:nth-child(3)', (tds) => [...new Set(tds.map((t) => t.innerText.trim()))]);
  check('3 trial: data from exactly 3 stores', storesInTable.length === 3, storesInTable.join(', '));
  const over = await d.locator('.banner', { hasText: 'сверх лимита' }).allTextContents();
  check('3 4th store flagged over the limit', over.length === 1 && over[0].includes('Автосалон'), JSON.stringify(over));
  const reported = await sql("select last_store_count from accounts where email='seller@example.kz'");
  check('3 store count reported to the server', reported[0]?.last_store_count === 4, JSON.stringify(reported));
  await closePay();
  check('3 add-on payment window opened by itself for the 4th store', await d.evaluate(() => !!window.__payShown));
  await d.screenshot({ path: `${OUT}/bill-overlimit.png` });

  // 4. invoice for 4 stores × 2 months
  await d.evaluate(() => (location.hash = 'account')); await sleep(500);
  check('4 open add-on invoice shown above the plan form', (await d.locator('.pending-invoice').innerText()).replace(/\s/g, '').includes('5000₸'));
  check('4 default store count = connected stores (4)', (await d.inputValue('input[data-fkey=acct-stores]')) === '4');
  await d.selectOption('select[data-fkey=acct-months]', '2'); await sleep(300);
  const total = await d.locator('strong:has-text("Итого")').innerText();
  check('4 price shown: (20 000 + 5 000) × 2 = 50 000', total.replace(/\s/g, '').includes('50000'), total);
  await d.fill('input[data-fkey=acct-phone]', '12345'); await d.click('button:has-text("Выставить счёт")'); await sleep(800);
  check('4 invalid phone rejected with a clear message', (await d.locator('#view .banner[role=alert]').innerText().catch(() => '')).includes('+7 7XX'));
  await d.fill('input[data-fkey=acct-phone]', '8 701 123 45 67'); await d.click('button:has-text("Выставить счёт")');
  await d.waitForFunction(() => (document.querySelector('.pending-invoice')?.innerText || '').replace(/\s/g, '').includes('50000'), null, { timeout: 15000 });
  const pend = await d.locator('.pending-invoice').innerText();
  check('4 pending invoice: amount, phone, QR instructions', pend.replace(/\s/g, '').includes('50000') && pend.includes('+7 701 123 45 67'), pend.slice(0, 160));
  const dbInv = await sql("select amount, stores, months, phone, status from invoices where status = 'pending'");
  check('4 manual plan replaced the add-on: one open invoice, same amount on the server', dbInv.length === 1 && dbInv[0].amount === 50000 && dbInv[0].stores === 4 && dbInv[0].phone === '77011234567', JSON.stringify(dbInv[0]));

  // 5. owner confirms in the admin page
  const a = await ctx.newPage(); a.on('pageerror', (e) => errs.push('[admin] ' + e.message));
  a.on('dialog', (dlg) => dlg.accept(dlg.type() === 'prompt' ? 'Kaspi 123456' : undefined));
  await a.goto(`file://${EXT}/billing/admin/index.html`);
  await a.fill('#url', 'http://localhost:8098'); await a.fill('#key', 'test-anon-key'); await a.click('#saveConn');
  await a.fill('#email', 'owner@example.kz'); await a.click('#sendCode'); await a.waitForSelector('#codeRow:not([hidden])');
  await a.fill('#code', '123456'); await a.click('#verify');
  await a.waitForSelector('table', { timeout: 15000 });
  const adminRow = await a.locator('tbody tr').first().innerText();
  check('5 admin sees the pending invoice with email, phone, amount', adminRow.includes('seller@example.kz') && adminRow.includes('+7 701 123 45 67') && adminRow.replace(/\s/g, '').includes('50000'), adminRow.replace(/\s+/g, ' '));
  await a.screenshot({ path: `${OUT}/bill-admin.png` });
  await a.click('button:has-text("Оплата получена")'); await sleep(1500);
  const paid = await sql("select a.paid_until, a.trial_ends_at, a.store_limit, i.status, i.admin_note from accounts a join invoices i using (user_id) where a.email='seller@example.kz' and i.status='paid'");
  check('5 confirmed: paid period starts after the trial, 4 stores, note saved', paid[0] && new Date(paid[0].paid_until) > new Date(paid[0].trial_ends_at) && paid[0].store_limit === 4 && paid[0].admin_note === 'Kaspi 123456', JSON.stringify(paid[0]));
  // admin config: QR + instructions
  await a.click('button[data-tab=config]'); await a.waitForSelector('#panel input[placeholder^="https://"]');
  await a.fill('#panel input[placeholder^="https://"]', `file://${EXT}/icons/icon-128.png`);
  await a.fill('#panel textarea', 'Оплатите по QR в приложении Kaspi.'); await a.click('#panel button:has-text("Сохранить")'); await sleep(800);
  const conf = await sql('select kaspi_qr_url, payment_instructions from billing_config');
  check('5 admin saved QR and instructions', conf[0].payment_instructions === 'Оплатите по QR в приложении Kaspi.', JSON.stringify(conf[0]));
  // non-admin cannot use admin functions even with the page
  const nonAdmin = await a.evaluate(async () => {
    const r = await fetch('http://localhost:8098/auth/v1/otp', { method: 'POST', headers: { apikey: 'test-anon-key', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'seller@example.kz' }) });
    const v = await fetch('http://localhost:8098/auth/v1/verify', { method: 'POST', headers: { apikey: 'test-anon-key', 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'email', email: 'seller@example.kz', token: '123456' }) }).then((x) => x.json());
    const x = await fetch('http://localhost:8098/rest/v1/rpc/admin_accounts', { method: 'POST', headers: { apikey: 'test-anon-key', Authorization: 'Bearer ' + v.access_token, 'Content-Type': 'application/json' }, body: '{}' });
    return { status: x.status, body: await x.text(), otp: r.status };
  });
  check('5 a client cannot call admin functions', nonAdmin.status === 400 && nonAdmin.body.includes('forbidden'), JSON.stringify(nonAdmin));

  // 6. seller: check payment → active, 4 stores synced
  await d.bringToFront(); await d.click('button:has-text("Проверить оплату")').catch(() => {});
  await d.waitForSelector('.badge:has-text("Оплачено до")', { timeout: 15000 });
  await d.evaluate(() => (location.hash = 'orders')); await refresh();
  const stores4 = await d.$$eval('tbody tr td:nth-child(3)', (tds) => [...new Set(tds.map((t) => t.innerText.trim()))]);
  check('6 after payment: all 4 stores synced', stores4.length === 4, stores4.join(', '));
  check('6 no over-limit banner', (await d.locator('.banner', { hasText: 'сверх лимита' }).count()) === 0);
  await d.evaluate(() => (location.hash = 'account')); await sleep(600);
  await d.screenshot({ path: `${OUT}/bill-account.png`, fullPage: true });
  check('6 history shows the paid invoice with its period', (await d.locator('body').innerText()).includes('оплачен'));

  // 6b. owner publishes new texts (version bump) → everyone accepts again
  await sql("update billing_config set terms_version = '2027-01-01' where id = 1");
  await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:billingState', payload: { force: true } }));
  await d.evaluate(() => (location.hash = 'orders')); await d.reload(); await sleep(1500);
  check('6b new version → blocking consent window', await d.evaluate(() => document.getElementById('termsDialog').open) && (await d.locator('#termsDialog').innerText()).includes('обновились'));
  check('6b no payment window on top of it', !(await d.evaluate(() => document.getElementById('payDialog').open)));
  check('6b «Принимаю» disabled until ticked', await d.locator('#termsDialog button:has-text("Принимаю")').isDisabled());
  const packNoConsent = await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:pack', payload: { items: [{ shopId: '1001', orderId: '500000' }] } }));
  check('6b worker refuses actions until accepted', packNoConsent?.ok === false, JSON.stringify(packNoConsent));
  await d.keyboard.press('Escape'); await sleep(200);
  check('6b Esc does not close it', await d.evaluate(() => document.getElementById('termsDialog').open));
  await d.screenshot({ path: `${OUT}/bill-terms.png` });
  await d.check('#termsDialog label.consent input'); await d.click('#termsDialog button:has-text("Принимаю")');
  await d.waitForFunction(() => !document.getElementById('termsDialog').open, null, { timeout: 10000 }); await sleep(800);
  const cons2 = await sql("select array_agg(c.version order by c.accepted_at) v from consents c join accounts a using (user_id) where a.email='seller@example.kz'");
  check('6b new acceptance logged, history kept', JSON.stringify(cons2[0].v) === '["2026-11-16","2027-01-01"]', JSON.stringify(cons2));
  check('6b orders back after accepting', !(await d.locator('#view').innerText()).includes('Примите условия'));

  // 7. expiry → paywall + actions refused (clock moved in the database)
  await sql('update billing_config set grace_days = 0 where id = 1'); // no renewal grace: this step tests the hard expiry
  await sql("update accounts set paid_until = now() - interval '1 minute', trial_ends_at = now() - interval '2 days' where email='seller@example.kz'");
  await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:billingState', payload: { force: true } }));
  await d.evaluate(() => (location.hash = 'orders')); await refresh();
  check('7 expired: paywall instead of orders', (await d.locator('#view').innerText()).includes('закончился'));
  const packExpired = await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:pack', payload: { items: [{ shopId: '1001', orderId: '500000' }] } }));
  check('7 expired: worker refuses pack', packExpired?.error === 'subscriptionRequired', JSON.stringify(packExpired));
  await d.screenshot({ path: `${OUT}/bill-expired.png` });

  // 8. logout
  check('8 blocked window offers "Выйти из аккаунта"', await d.locator('#payDialog button:has-text("Выйти из аккаунта")').isVisible());
  await d.click('#payDialog button:has-text("Выйти из аккаунта")'); await sleep(800);
  await d.evaluate(() => (location.hash = 'account')); await sleep(400);
  check('8 logout → login form', await d.locator('button:has-text("Получить код")').isVisible());
  const sess = await d.evaluate(async () => (await chrome.storage.local.get('ksh.session'))['ksh.session'] || null);
  check('8 session removed', sess === null);

  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  await ctx.close();
})().catch(async (e) => { console.error('CRASH', e.message.split('\n')[0]); process.exit(1); });
