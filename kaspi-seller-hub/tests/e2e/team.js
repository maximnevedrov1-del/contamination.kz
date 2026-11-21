// Staff (packers): owner invites → «Компьютер склада» → packer signs in with the e-mail code and
// a PIN → scan-to-verify packing → journal → owner switches the packer off → packer is out.
// Uses ../billcopy (mock Supabase on :8098 with the REAL 001+002 SQL, mock Kaspi on :8099).
const { chromium } = require('playwright');
const path = require('path');
const { Client } = require('pg');
const EXT = path.join(__dirname, '../billcopy');
let fails = 0;
const check = (n, ok, i = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, ok ? '' : i); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kaspiLog = () => fetch('http://localhost:8099/__log').then((r) => r.json());

(async () => {
  const db = new Client({ host: '/tmp', port: 5499, user: 'postgres', database: 'billing' });
  await db.connect();
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'teamprof' + Date.now()), { headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 }, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const errs = [];
  const d = await ctx.newPage();
  d.on('pageerror', (e) => errs.push(e.message));
  const url = (r) => `chrome-extension://${id}/dashboard/dashboard.html#${r}`;
  const msg = (type, payload) => d.evaluate(([t, p]) => chrome.runtime.sendMessage({ type: t, payload: p }), [type, payload]);
  const toasts = () => d.$$eval('.toast', (t) => t.map((x) => x.innerText).join(' | '));

  // owner signs in, accepts the offer, connects two stores
  await d.goto(url('account'));
  await d.evaluate(() => { ['home', 'orders', 'settings', 'account'].forEach((r) => localStorage.setItem(`ksh.guide.${r}`, '1')); localStorage.setItem('ksh.tourDone', '1'); });
  await d.waitForSelector('input[type=email]');
  await d.fill('input[type=email]', 'shopowner@example.kz'); await d.check('label.consent input'); await d.click('button:has-text("Получить код")');
  await d.waitForSelector('input[autocomplete=one-time-code]'); await d.fill('input[autocomplete=one-time-code]', '123456'); await d.click('button:has-text("Войти")');
  await d.waitForSelector('.badge:has-text("Пробный период")', { timeout: 15000 });
  await msg('ui:connectApi', { shopId: null, name: 'Магазин А', token: 'GOOD-TOKEN-1234' }); await sleep(2500);
  await msg('ui:connectApi', { shopId: null, name: 'Магазин Б', token: 'GOOD-TOKEN-B' }); await sleep(5000);
  const stores = Object.values((await msg('ui:getState')).settings.stores);
  const A = stores.find((s) => s.name === 'Магазин А').id, B = stores.find((s) => s.name === 'Магазин Б').id;

  // 1. invite a packer: only store A, may accept new orders
  await d.goto(url('settings')); await d.reload(); await sleep(1500);
  const card = d.locator('[data-card=team]');
  await card.locator('[data-field=teamName]').fill('Ерлан');
  await card.locator('[data-field=teamEmail]').fill('packer@example.kz');
  await card.locator('.team__shops label', { hasText: 'Магазин Б' }).locator('input').uncheck();
  await card.locator('label.check', { hasText: 'Может принимать' }).locator('input').check();
  await card.locator('button[data-action=team-invite]').click(); await sleep(1200);
  check('1 invitation text ready to send (WhatsApp / Telegram / e-mail)', (await card.locator('[data-block=invite-text]').innerText()).includes('packer@example.kz') && (await card.locator('[data-block=invite-text] a', { hasText: 'WhatsApp' }).count()) === 1);
  check('1 packer listed as «приглашён», store A only', (await card.locator('tr[data-member="packer@example.kz"]').innerText()).includes('приглашён'));
  const row = (await db.query("select shop_ids, can_accept, status from team_members where email='packer@example.kz'")).rows[0];
  check('1 server: store A only, may accept', row?.shop_ids?.length === 1 && row.shop_ids[0] === A && row.can_accept === true, JSON.stringify(row));

  // 2. «Компьютер склада» on → the owner's dashboard is locked
  await d.locator('[data-card=warehouse] [data-field=warehousePin]').fill('2468');
  await d.locator('[data-card=warehouse] button[data-action=warehouse-on]').click(); await sleep(1200);
  check('2 warehouse on: sign-in screen instead of the dashboard', (await d.locator('.lock').count()) === 1 && !(await d.locator('.app').isVisible()));
  const blocked = await msg('ui:teamList');
  check('2 nothing answered before sign-in', blocked?.error === 'warehouseLocked', JSON.stringify(blocked));

  // 3. packer: first sign-in with the e-mail code + a PIN
  await d.fill('.lock [data-field=email]', 'packer@example.kz');
  await d.click('.lock button:has-text("Получить код")'); await sleep(800);
  await d.fill('.lock [data-field=code]', '123456');
  await d.fill('.lock [data-field=newPin]', '1357'); await d.fill('.lock [data-field=newPin2]', '1357');
  await d.click('.lock button:has-text("Войти")'); await sleep(1500);
  check('3 packer panel open with the packer\'s name', (await d.locator('.pack__who').innerText()).includes('Ерлан'));
  check('3 the owner\'s session is untouched', (await sw.evaluate(async () => (await chrome.storage.local.get('ksh.session'))['ksh.session']?.email)) === 'shopowner@example.kz');
  const queueText = await d.locator('.pack__queue').innerText();
  check('3 queue: only store A', queueText.includes('Магазин А') && !queueText.includes('Магазин Б'), queueText.slice(0, 200));
  const deny1 = await msg('ui:teamList');
  const deny2 = await msg('ui:pack', { items: [{ shopId: B, orderId: '800002001' }] });
  const deny3 = await msg('ui:saveCost', { sku: 'X', cost: 1 });
  check('3 worker refuses the packer: team, other store, cost prices', [deny1, deny2, deny3].every((r) => r?.error === 'staffNotAllowed'), JSON.stringify([deny1, deny2, deny3]));
  const st = await msg('ui:getState');
  check('3 no money in the packer screen', !(await d.locator('.pack').innerText()).includes('₸'));

  // 4. scan-to-verify: order barcode → products → wrong item → bind barcode → pack & print
  await d.fill('#packScan', '123'); await d.press('#packScan', 'Enter'); await sleep(300);
  check('4 unknown order number → visible «не найден»', (await d.locator('.pack__flash--bad').innerText().catch(() => '')).includes('не найден'));
  await sleep(1700);
  await d.fill('#packScan', '800002001'); await d.press('#packScan', 'Enter'); await sleep(500);
  check('4 order opened by its barcode', (await d.locator('.pack__ohead h2').innerText()).includes('800002001'));
  check('4 product with photo placeholder and «0 / 2»', (await d.locator('.pack__line').first().innerText()).includes('0') && (await d.locator('.pack__line').first().innerText()).includes('/ 2'));
  check('4 «Упаковать» locked until everything is checked', await d.locator('button[data-action=pack-finish]').isDisabled());
  await d.fill('#packScan', '4870000000017'); await d.press('#packScan', 'Enter'); await sleep(300);
  check('4 unknown barcode → «which product is it?»', (await d.locator('.pack__bind').count()) === 1);
  await d.locator('.pack__bind .btn', { hasText: 'Свечи' }).click(); await sleep(300);
  await d.fill('#packScan', '9999999999999'); await d.press('#packScan', 'Enter'); await sleep(200);
  check('4 a foreign product → red «чужой товар»', (await d.locator('.pack__flash--bad').innerText().catch(() => '')).includes('Чужой'));
  await sleep(1700);
  await d.fill('#packScan', '4870000000017'); await d.press('#packScan', 'Enter'); await sleep(400);
  check('4 second unit scanned → «2 / 2», ready', (await d.locator('.pack__line').first().innerText()).includes('2') && !(await d.locator('button[data-action=pack-finish]').isDisabled()));
  const before = (await kaspiLog()).filter((x) => x.post).length;
  const [printPage] = await Promise.all([ctx.waitForEvent('page', { timeout: 20000 }).catch(() => null), d.click('button[data-action=pack-finish]')]);
  await sleep(2500);
  const posts = (await kaspiLog()).filter((x) => x.post).slice(before);
  check('4 accepted and packed in Kaspi (2 requests)', posts.length === 2 && posts[0].post.status === 'ACCEPTED_BY_MERCHANT' && posts[1].post.status === 'ASSEMBLE', JSON.stringify(posts));
  check('4 waybill print opened', !!printPage);
  await printPage?.close();
  const bc = await sw.evaluate(async () => (await chrome.storage.local.get('ksh.barcodes'))['ksh.barcodes']);
  check('4 barcode remembered for the product', bc?.['SKU-2']?.includes('4870000000017'), JSON.stringify(bc));

  // 5. owner unlocks with the PIN → the journal shows who packed it and how
  await d.click('button[data-action=staff-logout]'); await sleep(600);
  await d.click('.lock .tab:has-text("Владелец")'); await d.fill('.lock [data-field=ownerPin]', '0000'); await d.press('.lock [data-field=ownerPin]', 'Enter'); await sleep(500);
  check('5 wrong owner PIN refused', (await d.locator('.lock__err').innerText()).includes('неверный'));
  await d.fill('.lock [data-field=ownerPin]', '2468'); await d.press('.lock [data-field=ownerPin]', 'Enter'); await sleep(1200);
  await d.goto(url('settings')); await d.reload(); await sleep(1800);
  const journal = await d.locator('[data-card=journal]').innerText();
  check('5 journal: Ерлан packed 800002001 by scanner, 1 wrong scan', /Ерлан[\s\S]*упаковал[\s\S]*800002001[\s\S]*сканером[\s\S]*1 ошибка/.test(journal), journal.slice(0, 400));

  // 6. the owner switches the packer off → PIN sign-in refused
  await d.locator('tr[data-member="packer@example.kz"] button[data-action=team-disable]').click();
  await d.click('#confirmDialog button[value=ok]'); await sleep(1000);
  check('6 owner sees «отключён»', (await d.locator('tr[data-member="packer@example.kz"]').innerText()).includes('отключён'));
  await d.locator('[data-card=warehouse] button[data-action=owner-lock]').click(); await sleep(800);
  await d.selectOption('.lock [data-field=who]', 'packer@example.kz').catch(() => {});
  await d.fill('.lock [data-field=pin]', '1357'); await d.press('.lock [data-field=pin]', 'Enter'); await sleep(1200);
  check('6 switched-off packer cannot sign in', (await d.locator('.lock__err').innerText()).includes('отключил') && (await d.locator('.pack').count()) === 0, await d.locator('.lock__err').innerText());

  // 7. switched off WHILE working → out at the next check
  await db.query("update team_members set status='active', disabled_at=null where email='packer@example.kz'");
  await d.reload(); await sleep(1000);
  await d.click('.lock button:has-text("Первый вход")').catch(() => {});
  await d.fill('.lock [data-field=email]', 'packer@example.kz'); await d.click('.lock button:has-text("Получить код")'); await sleep(600);
  await d.fill('.lock [data-field=code]', '123456'); await d.fill('.lock [data-field=newPin]', '1357'); await d.fill('.lock [data-field=newPin2]', '1357');
  await d.click('.lock button:has-text("Войти")'); await sleep(1500);
  check('7 packer working again', (await d.locator('.pack').count()) === 1);
  await db.query("update team_members set status='disabled', disabled_at=now() where email='packer@example.kz'");
  await msg('ui:staffCheck'); await sleep(1000); // the 2-minute alarm, run now
  check('7 switched off while working → back to the sign-in screen', (await d.locator('.lock').count()) === 1 && (await d.locator('.pack').count()) === 0);

  // 8. PIN guessing: 5 wrong tries → locked
  await db.query("update team_members set status='active', disabled_at=null where email='packer@example.kz'");
  await d.reload(); await sleep(800);
  // switched off → this computer forgot the packer: a first sign-in again, then sign out
  await d.click('.lock button:has-text("Первый вход")').catch(() => {});
  await d.fill('.lock [data-field=email]', 'packer@example.kz'); await d.click('.lock button:has-text("Получить код")'); await sleep(600);
  await d.fill('.lock [data-field=code]', '123456'); await d.fill('.lock [data-field=newPin]', '1357'); await d.fill('.lock [data-field=newPin2]', '1357');
  await d.click('.lock button:has-text("Войти")'); await sleep(1500);
  await d.click('button[data-action=staff-logout]'); await sleep(800);
  for (let i = 0; i < 5; i++) { await d.fill('.lock [data-field=pin]', '0000').catch(() => {}); await d.press('.lock [data-field=pin]', 'Enter').catch(() => {}); await sleep(400); }
  await d.fill('.lock [data-field=pin]', '1357').catch(() => {}); await d.press('.lock [data-field=pin]', 'Enter').catch(() => {}); await sleep(800);
  check('8 five wrong PINs → locked even for the right PIN', (await d.locator('.lock__err').innerText().catch(() => '')).includes('15 минут'));

  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  await db.end();
  await ctx.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CRASH', e.message.split('\n')[0]); process.exit(1); });
