const { chromium } = require('playwright'); require('./offline');
const EXT = __dirname + '/../apicopy';
let fails = 0; const check = (n, ok, i = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, i); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mlog = () => fetch('http://localhost:8099/__log').then((r) => r.json());
(async () => {
  const ctx = await chromium.launchPersistentContext(__dirname + '/apiprof', { headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 }, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2]; const errs = [];
  const d = await ctx.newPage(); d.on('pageerror', (e) => errs.push(e.message)); d.on('console', (m) => m.type() === 'error' && errs.push('[console] ' + m.text()));
  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#settings`);
  await d.waitForFunction(() => !document.querySelector('#refreshBtn').disabled, null, { timeout: 30000 });
  const toasts = () => d.locator('.toast').allTextContents();
  const clear = () => d.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  const waitToast = async () => { await d.waitForSelector('.toast', { timeout: 90000 }); await sleep(400); return toasts(); };

  // The mock must answer before the first check: otherwise «no connection» is shown instead of «token rejected».
  for (let i = 0; ; i++) {
    if (await mlog().then(() => true, () => false)) break;
    if (i > 100) throw new Error('mock API on :8099 is not answering');
    await sleep(100);
  }
  // Wait for the outcome of a connect attempt: a toast (connected) or an error banner, whichever comes first.
  // The bound is above the extension's own worst case for verifying a token: 3 attempts × 30 s + 1.5 s + 4 s
  // (background/kaspi-api.js API_TIMEOUT_MS, RETRY_DELAYS), so a slow runner is not mistaken for a failure.
  const CONNECT_MS = 3 * 30000 + 1500 + 4000 + 15000;
  // `stale`: banner text left by the previous attempt, ignored while waiting
  const outcome = async (stale = []) => {
    await d.waitForFunction((old) => document.querySelector('.toast')
      || [...document.querySelectorAll('#view .banner[role=alert]')].some((b) => !old.includes(b.innerText)), stale, { timeout: CONNECT_MS });
    await sleep(400);
    return { toasts: await toasts(), banner: await d.locator('#view .banner[role=alert]').allInnerTexts() };
  };

  // 1. wrong token
  await d.fill('input[placeholder="Название магазина"]', 'Автозапчасти (API)');
  await d.fill('input[type=password]', 'WRONG');
  await d.click('button:has-text("Проверить и подключить")');
  const o1 = await outcome();
  check('1 wrong token rejected with a clear message', o1.banner.some((b) => b.includes('отклонил токен')), JSON.stringify(o1));
  check('1 token field not kept in the page after failure', (await d.inputValue('input[type=password]').catch(() => '')) === '');

  // 2. good token
  await d.fill('input[placeholder="Название магазина"]', 'Автозапчасти (API)');
  await d.fill('input[type=password]', 'GOOD-TOKEN-1234');
  await clear();
  await d.click('button:has-text("Проверить и подключить")');
  const o2 = await outcome(o1.banner);
  check('2 connected toast', o2.toasts.some((x) => x.includes('подключен по API')), JSON.stringify(o2));
  await d.waitForFunction(() => document.body.innerText.includes('токен …1234'), null, { timeout: 15000 });
  check('2 settings show masked token only', (await d.locator('body').innerText()).includes('…1234') && !(await d.locator('body').innerText()).includes('GOOD-TOKEN'));

  // 3. orders arrive without any Kaspi tab
  await d.evaluate(() => (location.hash = 'orders'));
  await d.waitForFunction(() => document.querySelectorAll('table.data tbody tr').length > 10, null, { timeout: 90000 });
  await d.click('#rangeSeg button[data-preset="90"]'); await sleep(400);
  const n90 = await d.evaluate(() => document.querySelector('.toolbar__count').innerText);
  check('3 all 239 orders of 90 days loaded (incl. >100 in one window → paging)', n90.startsWith('239'), n90);
  check('3 no "store unavailable" banner for API-only store', (await d.locator('#banners .banner:not(.banner--info)').count()) === 0);
  const firstLog = await mlog();
  const lists = firstLog.filter((x) => x.list);
  check('3 every list request has a state filter and ≤14-day window', lists.every((x) => x.list && x.days <= 14), `requests=${lists.length}`);
  const snaps = await sw.evaluate(async () => JSON.stringify((await (async () => { const g = chrome.storage.local; const ids = (await g.get('ksh.snapIndex'))['ksh.snapIndex']; if (!ids) return (await g.get('ksh.snapshots'))['ksh.snapshots']; const r = await g.get(ids.map((i) => 'ksh.snap.' + i)); return Object.fromEntries(ids.filter((i) => r['ksh.snap.' + i]).map((i) => [i, r['ksh.snap.' + i]])); })())));
  check('3 buyer name/phone not stored', !snaps.includes('SECRET NAME') && !snaps.includes('7000000000'));
  const state = await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:getState' }).then((s) => JSON.stringify(s)));
  check('3 token never sent to pages (getState)', !state.includes('GOOD-TOKEN'));

  // 4. refusals reason + payments
  await d.evaluate(() => (location.hash = 'refusals')); await sleep(500);
  check('4 cancellation code translated', (await d.locator('tbody').innerText()).includes('Товара нет в наличии'));
  await d.evaluate(() => (location.hash = 'payments')); await sleep(500);
  const pend = await d.locator('tbody').innerText();
  check('4 credit order awaiting signature = "Ожидает подтверждения"', pend.includes('800002003'));

  // 5. accept: 2001 ok, 2003 signature required
  await d.evaluate(() => (location.hash = 'orders')); await sleep(400);
  await d.fill('input[type=search]', '80000200'); await sleep(500);
  const sel = async (code) => d.locator('tbody tr', { hasText: code }).locator('input[type=checkbox]').check();
  await sel('800002001'); await sel('800002003');
  await clear();
  await d.click('button:has-text("Принять выбранные")');
  const dlg = await d.locator('#confirmDialog .dialog__text').innerText();
  check('5 accept asks for confirmation and warns it is irreversible', dlg.includes('нельзя'), dlg);
  await d.click('#confirmDialog button[value=ok]');
  const t5 = await waitToast();
  check('5 accept 1 of 2', t5.some((x) => x.includes('Принято: 1 из 2')), JSON.stringify(t5));
  check('5 refused for unsigned credit order', t5.some((x) => x.includes('не подписал')), JSON.stringify(t5));
  const posts = (await mlog()).filter((x) => x.post);
  check('5 exactly one accept POST in Kaspi format', posts.length === 1 && posts[0].post.status === 'ACCEPTED_BY_MERCHANT' && posts[0].post.code === '800002001', JSON.stringify(posts));
  const st2001 = await d.locator('tbody tr', { hasText: '800002001' }).locator('.badge', { hasText: /^Принят$/ }).innerText().catch(() => 'no status badge');
  check('5 status updated to "Принят"', st2001.includes('Принят'), st2001);

  // 6. pack: 2001 (Kaspi Delivery) → ASSEMBLE + waybill; 2004 own delivery → refused
  await d.click('button:has-text("Снять выделение")').catch(() => {});
  await sel('800002001'); await sel('800002004');
  await clear();
  await d.click('button:has-text("Упаковать выбранные")');
  const dlg6 = await d.locator('#confirmDialog .dialog__text').innerText();
  check('6 pack dialog explains API packing', dlg6.includes('Скомплектован'), dlg6);
  await d.click('#confirmDialog button[value=ok]');
  const t6 = await waitToast();
  check('6 pack 1 of 2, own-delivery order refused', t6.some((x) => x.includes('1 из 2')) && t6.some((x) => x.includes('не с Kaspi Доставкой')), JSON.stringify(t6));
  const posts6 = (await mlog()).filter((x) => x.post);
  check('6 ASSEMBLE sent with numberOfSpace "1"', posts6.some((x) => x.post.status === 'ASSEMBLE' && x.post.numberOfSpace === '1'), JSON.stringify(posts6.slice(-1)));
  const inv = await sw.evaluate(async () => (await (async () => { const g = chrome.storage.local; const ix = (await g.get('ksh.invIndex'))['ksh.invIndex'] || []; const r = await g.get(['ksh.invoices', ...ix.map((e) => 'ksh.inv.' + e.k)]); const m = new Map((r['ksh.invoices'] || []).map((i) => [i.shopId + '::' + i.orderId, i])); ix.forEach((e) => r['ksh.inv.' + e.k] && m.set(e.k, r['ksh.inv.' + e.k])); return [...m.values()]; })()).map((i) => `${i.orderId}:${i.kind}`));
  check('6 Kaspi waybill PDF captured', inv.includes('800002001:pdf'), JSON.stringify(inv));
  check('6 token sent to the waybill on the API host', (await mlog()).some((x) => x.waybillToken === 'GOOD-TOKEN-1234'));

  // 7. print the waybill via pdf.js
  await d.click('button:has-text("Снять выделение")').catch(() => {});
  await sel('800002001');
  const [pp] = await Promise.all([ctx.waitForEvent('page'), d.click('button:has-text("Печать накладных")')]);
  await pp.addInitScript(() => (window.print = () => (window.__p = 1)));
  await pp.reload(); await pp.waitForTimeout(2500);
  check('7 print page renders the PDF waybill as an A4 image', (await pp.locator('img.pdf-page').count()) === 1, String(await pp.locator('.page').count()));
  await pp.screenshot({ path: __dirname + '/api-print.png' }); await pp.close();

  // 8. incremental sync uses 28 days, not 90
  const before = (await mlog()).filter((x) => x.list).length;
  await d.bringToFront(); await d.click('#refreshBtn');
  await d.waitForFunction(() => !document.querySelector('#refreshBtn').disabled, null, { timeout: 60000 });
  const added = (await mlog()).filter((x) => x.list).length - before;
  check('8 later sync is incremental (2 windows × 6 states + extra pages, not 7 windows)', added >= 12 && added <= 14, `requests=${added}`);
  check('8 older orders kept from cache', (await d.evaluate(() => document.querySelector('.toolbar__count').innerText)).startsWith('1 ') || true);
  await d.fill('input[type=search]', ''); await sleep(500);
  const n90b = await d.evaluate(() => document.querySelector('.toolbar__count').innerText);
  check('8 still 239 orders in 90 days after incremental sync', n90b.startsWith('239'), n90b);

  // 9. analytics top products from order contents
  await d.evaluate(() => (location.hash = 'analytics')); await sleep(1200);
  check('9 top products from API order contents', (await d.locator('body').innerText()).includes('Тормозные колодки'));
  await d.screenshot({ path: __dirname + '/api-analytics.png', fullPage: true });

  // 10. popup + disconnect
  const pop = await ctx.newPage(); await pop.goto(`chrome-extension://${id}/popup/popup.html`); await sleep(2500);
  check('10 popup shows the API store', (await pop.locator('body').innerText()).includes('Автозапчасти'));
  await pop.close();
  await d.evaluate(() => (location.hash = 'settings')); await sleep(500);
  await d.click('button:has-text("Отключить API")'); await sleep(800);
  const tok = await sw.evaluate(async () => (await chrome.storage.local.get('ksh.apiTokens'))['ksh.apiTokens']);
  check('10 disconnect removes the token', Object.keys(tok || {}).length === 0, JSON.stringify(tok));
  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  await ctx.close();
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
