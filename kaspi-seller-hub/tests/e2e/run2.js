const { chromium } = require('playwright');
const path = require('path');
const fixture = require('./fixture');
const EXT = require('path').join(__dirname, '../..');
const OUT = __dirname;
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', name, info); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(OUT, 'profile2'), {
    headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const errors = [];
  const handler = (route) => {
    const u = new URL(route.request().url());
    const sub = u.hostname.split('.')[0];
    const shop = { a: 'A', b: 'B', c: 'C' }[sub] || 'A';
    if (u.pathname.startsWith('/mc/invoice/')) return route.fulfill({ contentType: 'text/html', body: `<h1>Накладная ${u.pathname}</h1>` });
    const q = u.searchParams;
    const body = fixture(shop, { login: q.has('login'), public: u.pathname.startsWith('/shop'), packfail: q.has('packfail'), noconvid: q.has('noconvid') });
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
  };
  await ctx.route('https://kaspi.kz/**', handler);
  await ctx.route('https://*.kaspi.kz/**', handler);
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  let id = sw.url().split('/')[2];
  const tabs = {};
  const open = async (key, url) => { const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(`[${key}] ${e.message}`)); await p.goto(url); tabs[key] = p; return p; };
  await open('A', 'https://a.kaspi.kz/mc/#/orders');
  await open('B', 'https://b.kaspi.kz/mc/#/orders');
  await open('C', 'https://c.kaspi.kz/mc/?packfail=1#/orders');
  await open('login', 'https://kaspi.kz/mc/?login=1#/login');
  await open('public', 'https://kaspi.kz/shop/c/phones/');
  await sleep(1200);

  // T1 popup → "Open dashboard"
  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${id}/popup/popup.html`);
  await pop.waitForTimeout(1500);
  const [dash] = await Promise.all([ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null), pop.click('#openDashboard')]);
  check('T1 popup opens dashboard tab', !!dash && dash.url().includes('/dashboard/dashboard.html'), dash?.url());
  const d = dash || (await ctx.newPage());
  d.on('pageerror', (e) => errors.push('[dash] ' + e.message));
  d.on('console', (m) => m.type() === 'error' && errors.push('[dash console] ' + m.text()));
  if (!dash) await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#orders`);
  await d.waitForSelector('table.data tbody tr', { timeout: 20000 });
  await d.waitForFunction(() => !document.querySelector('#refreshBtn').disabled, null, { timeout: 30000 });

  // T2 stores + unauth banner (login tab counted, public page not)
  const stores = await d.locator('#sidebarStores li').count();
  check('T2 three stores detected', stores === 3, `stores=${stores}`);
  const banner = await d.locator('.banner--info').allTextContents();
  check('T2 only cabinet login tab counted as "not logged in"', banner.length === 1 && /^1 /.test(banner[0].trim()), JSON.stringify(banner));

  const rowsData = () => d.$$eval('table.data tbody tr', (trs) => trs.map((tr) => ({ id: tr.cells[1].innerText.trim(), store: tr.cells[2].innerText.trim(), date: tr.cells[3].innerText.trim(), cust: tr.cells[4].innerText.trim(), amount: Number(tr.cells[7].innerText.replace(/[^\d]/g, '')) })));
  const clearToasts = () => d.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  const waitToasts = async (n = 1, timeout = 60000) => { await d.waitForFunction((n) => document.querySelectorAll('.toast').length >= n, n, { timeout }); await sleep(300); return d.locator('.toast').allTextContents(); };

  // T3 sort by amount ascending
  await d.click('th button:has-text("Сумма")'); await sleep(150);
  let dir = await d.getAttribute('th:has(button:has-text("Сумма"))', 'aria-sort');
  if (dir !== 'ascending') { await d.click('th button:has-text("Сумма")'); await sleep(150); dir = await d.getAttribute('th:has(button:has-text("Сумма"))', 'aria-sort'); }
  let rows = await rowsData();
  check('T3 sort by amount ascending', dir === 'ascending' && rows.every((r, i) => i === 0 || rows[i - 1].amount <= r.amount), `dir=${dir} n=${rows.length}`);

  // T4 7 days < 30 days
  const n30 = rows.length;
  await d.click('#rangeSeg button[data-preset="7"]'); await sleep(200);
  const n7 = (await rowsData()).length;
  check('T4 7-day range shows fewer orders than 30-day', n7 > 0 && n7 < n30, `7d=${n7} 30d=${n30}`);

  // T5 custom range: single day
  await d.click('#rangeSeg button[data-preset="custom"]'); await sleep(150);
  const today = await d.evaluate(() => { const x = new Date(); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; });
  await d.fill('#dateFrom', today); await d.fill('#dateTo', today); await d.dispatchEvent('#dateTo', 'change'); await sleep(200);
  rows = await rowsData();
  const todayRu = await d.evaluate(() => new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date()));
  check('T5 custom range = today only', rows.length > 0 && rows.every((r) => r.date.startsWith(todayRu)), `n=${rows.length}`);
  await d.click('#rangeSeg button[data-preset="30"]'); await sleep(150);

  // T6 search
  await d.fill('input[type=search]', 'Айгерим'); await sleep(400);
  rows = await rowsData();
  check('T6 search filters by customer', rows.length > 0 && rows.every((r) => r.cust.includes('Айгерим')), `n=${rows.length}`);
  check('T6 search input keeps focus after re-render', await d.evaluate(() => document.activeElement?.type === 'search'));
  await d.fill('input[type=search]', ''); await sleep(400);

  // T7 keyboard navigation
  await d.focus('table.data tbody tr[tabindex="0"]');
  await d.keyboard.press('ArrowDown'); await d.keyboard.press('Space'); await sleep(150);
  const sel1 = await d.$$eval('tbody tr', (trs) => trs.map((t) => t.getAttribute('aria-selected')).indexOf('true'));
  const bulk = await d.locator('.bulkbar__count').textContent().catch(() => '');
  check('T7 ArrowDown+Space selects 2nd row', sel1 === 1 && bulk.includes('1'), `idx=${sel1} bulk=${bulk}`);
  check('T7 focus stays on the row after re-render', await d.evaluate(() => document.activeElement?.tagName === 'TR' && document.activeElement.dataset.idx === '1'));
  await d.keyboard.press('Escape'); await sleep(150);
  check('T7 Escape clears selection', (await d.locator('.bulkbar').count()) === 0);

  // T8 pack failure is reported (store C never confirms)
  await d.click('.tabs .tab:has-text("Новые")'); await sleep(150);
  const invBefore = await sw.evaluate(async () => ((await chrome.storage.local.get('ksh.invoices'))['ksh.invoices'] || []).length);
  const cRow = d.locator('tbody tr', { hasText: 'Детский мир' }).first();
  const cId = (await cRow.locator('td').nth(1).innerText()).trim();
  await cRow.locator('input[type=checkbox]').check();
  await clearToasts();
  await d.click('button:has-text("Упаковать выбранные")'); await d.click('#confirmDialog button[value=ok]');
  let toasts = await waitToasts(2);
  const invAfter = await sw.evaluate(async () => ((await chrome.storage.local.get('ksh.invoices'))['ksh.invoices'] || []).length);
  check('T8 failed pack reported as failure, not success', toasts.some((t) => t.includes('0 из 1')) && toasts.some((t) => t.includes('не подтвердил')), JSON.stringify(toasts));
  check('T8 no invoice stored for failed pack', invAfter === invBefore, `${invBefore}→${invAfter}`);
  check('T8 order still "new" in the store tab', await tabs.C.evaluate((id) => [...document.querySelectorAll('[data-testid=order-row]')].find((r) => r.innerText.includes(id))?.querySelector('[data-testid=order-status]').textContent, cId) === 'Новый');

  // T9 pack success (store A)
  await d.waitForFunction(() => !document.querySelector('.progress:not([hidden])'));
  check('T8 failed order stays selected for retry', (await d.locator('tbody tr[aria-selected="true"]').count()) === 1);
  await d.click('button:has-text("Снять выделение")');
  const aRow = d.locator('tbody tr', { hasText: 'Электроника' }).first();
  await aRow.locator('input[type=checkbox]').check();
  await clearToasts();
  await d.click('button:has-text("Упаковать выбранные")'); await d.click('#confirmDialog button[value=ok]');
  toasts = await waitToasts(1);
  check('T9 pack success', toasts.some((t) => t.includes('1 из 1')), JSON.stringify(toasts));
  check('T9 packed order deselected', (await d.locator('tbody tr[aria-selected="true"]').count()) === 0);
  await d.click('.tabs .tab:has-text("Все")');

  // T10 returns: process 2 → store tab navigated + 1 new tab
  await d.evaluate(() => (location.hash = 'returns')); await sleep(600);
  const pagesBefore = ctx.pages().length;
  const bRet = d.locator('tbody tr', { hasText: 'HomeStyle' });
  await bRet.nth(0).locator('input[type=checkbox]').check(); await bRet.nth(1).locator('input[type=checkbox]').check();
  await d.click('button:has-text("Обработать выбранные")'); await d.click('#confirmDialog button[value=ok]'); await sleep(1500);
  check('T10 process 2 returns → 1 store tab reused + 1 new tab', ctx.pages().length === pagesBefore + 1 && tabs.B.url().includes('#/returns/'), `pages ${pagesBefore}→${ctx.pages().length} B=${tabs.B.url()}`);
  await d.bringToFront();

  // T11 payments refresh (store B tab is now on returns page → must navigate to orders list)
  await d.evaluate(() => (location.hash = 'payments')); await sleep(600);
  const pend = await d.locator('.group-card[aria-pressed="true"]').innerText();
  const payRows = d.locator('tbody tr');
  await payRows.nth(0).locator('input[type=checkbox]').check(); await payRows.nth(1).locator('input[type=checkbox]').check();
  await clearToasts();
  await d.click('button:has-text("Обновить статус оплаты")');
  toasts = await waitToasts(1);
  check('T11 refresh payment status 2/2', toasts.some((t) => t.includes('2 из 2')), `${pend.split('\n')[0]} ${JSON.stringify(toasts)}`);

  // T12 settings: alias, colour, disable/enable
  await d.evaluate(() => (location.hash = 'settings')); await sleep(600);
  const aliasInput = d.locator('tr', { hasText: 'Электроника Плюс' }).locator('input.input');
  await aliasInput.fill('Электроника (осн.)'); await aliasInput.dispatchEvent('change'); await sleep(600);
  await d.locator('tr', { hasText: 'HomeStyle KZ' }).locator('.color-pick > summary').click(); await d.locator('tr', { hasText: 'HomeStyle KZ' }).locator('.color-pick__menu .swatch').nth(6).click(); await sleep(600);
  await d.evaluate(() => (location.hash = 'orders')); await sleep(600);
  const storesInTable = new Set((await rowsData()).map((r) => r.store));
  check('T12 alias shown in orders table', storesInTable.has('Электроника (осн.)'), [...storesInTable].join(', '));
  const bColor = await d.locator('tbody .store-chip', { hasText: 'HomeStyle' }).first().evaluate((el) => el.style.getPropertyValue('--store-color'));
  check('T12 colour change applied', bColor === '#6250d6', bColor);
  await d.evaluate(() => (location.hash = 'settings')); await sleep(500);
  await d.locator('tr', { hasText: 'HomeStyle KZ' }).locator('input[type=checkbox]').uncheck(); await sleep(700);
  await d.evaluate(() => (location.hash = 'orders')); await sleep(500);
  const afterDisable = new Set((await rowsData()).map((r) => r.store));
  check('T12 disabled store hidden', !afterDisable.has('HomeStyle KZ') && (await d.locator('#sidebarStores li').count()) === 2, [...afterDisable].join(', '));
  const persisted = await sw.evaluate(async () => Object.values((await chrome.storage.local.get('ksh.settings'))['ksh.settings'].stores).map((s) => `${s.name}|${s.alias}|${s.enabled}`));
  check('T12 settings persisted by the worker', persisted.some((x) => x.startsWith('HomeStyle KZ||false')) && persisted.some((x) => x.includes('Электроника (осн.)')), JSON.stringify(persisted));
  await d.evaluate(() => (location.hash = 'settings')); await sleep(500);
  await d.locator('tr', { hasText: 'HomeStyle KZ' }).locator('input[type=checkbox]').check(); await sleep(700);

  // T13 chat: duplicate text verified, unstable ids refused
  await d.evaluate(() => (location.hash = 'chat')); await sleep(1800);
  const convA = d.locator('.conv', { hasText: 'Электроника' }).first();
  await convA.click(); await sleep(1500);
  for (let i = 0; i < 2; i++) {
    await clearToasts();
    await d.fill('.composer textarea', 'Ваш заказ упакован');
    await d.keyboard.press('Control+Enter');
    toasts = await waitToasts(1, 20000);
    check(`T13 chat send #${i + 1} verified (same text twice)`, toasts[0].trim() === 'Отправлено', JSON.stringify(toasts));
  }
  await tabs.B.goto('https://b.kaspi.kz/mc/?noconvid=1#/chat'); await sleep(1500);
  await d.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:chatList' })); await sleep(800);
  await d.evaluate(() => (location.hash = 'orders')); await sleep(200); await d.evaluate(() => (location.hash = 'chat')); await sleep(1500);
  await d.locator('.conv', { hasText: 'HomeStyle' }).first().click(); await sleep(1500);
  await clearToasts();
  await d.fill('.composer textarea', 'не должно уйти');
  await d.keyboard.press('Control+Enter');
  toasts = await waitToasts(1, 20000);
  const leaked = await tabs.B.evaluate(() => document.querySelectorAll('.chat-thread__message--outgoing').length);
  check('T13 reply refused when conversation id is unstable', toasts.some((t) => t.includes('Не отправлено')) && leaked === 0, `${JSON.stringify(toasts)} outgoing=${leaked}`);
  check('T13 draft kept after failed send', (await d.inputValue('.composer textarea')) === 'не должно уйти');

  // T14 closed tab → only that store unavailable, its cached rows kept
  await tabs.C.close();
  await d.evaluate(() => (location.hash = 'orders')); await sleep(300);
  await d.click('#refreshBtn');
  await d.waitForFunction(() => !document.querySelector('#refreshBtn').disabled, null, { timeout: 30000 });
  const warn = await d.locator('#banners .banner:not(.banner--info)').allTextContents();
  const storesNow = new Set((await rowsData()).map((r) => r.store));
  check('T14 closed tab → banner for that store only', warn.length === 1 && warn[0].includes('Детский мир') && warn[0].includes('Вкладка закрыта'), JSON.stringify(warn));
  check('T14 other stores and cached rows still shown', storesNow.has('HomeStyle KZ') && storesNow.has('Детский мир Алматы'), [...storesNow].join(', '));

  // T15 badge
  const badge = await sw.evaluate(() => chrome.action.getBadgeText({}));
  check('T15 toolbar badge shows a count', /^\d+$/.test(badge), badge);

  // T16 remove store
  await d.evaluate(() => (location.hash = 'settings')); await sleep(500);
  await d.locator('tr', { hasText: 'Детский мир' }).locator('button:has-text("Удалить")').click(); await d.click('#confirmDialog button[value=ok]'); await sleep(1000);
  const left = await sw.evaluate(async () => ({ s: Object.keys((await chrome.storage.local.get('ksh.settings'))['ksh.settings'].stores).length, snap: Object.keys((await chrome.storage.local.get('ksh.snapshots'))['ksh.snapshots']).length }));
  check('T16 remove store deletes settings + cache', left.s === 2 && left.snap === 2, JSON.stringify(left));

  // T17 orphaned content script (simulated: old instance reports its context as dead)
  const tabIdA = await sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url.startsWith('https://a.kaspi.kz'))?.id);
  const r17 = await sw.evaluate(async (tabId) => {
    const run = (func) => chrome.scripting.executeScript({ target: { tabId }, func }).then((r) => r[0].result);
    await run(() => { globalThis.__KSH_TEST_OLD__ = globalThis.__KSH_CONTENT_ALIVE__; globalThis.__KSH_CONTENT_ALIVE__ = () => false; });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['shared/selectors.js', 'content/content.js'] });
    const replaced = await run(() => globalThis.__KSH_CONTENT_ALIVE__ !== globalThis.__KSH_TEST_OLD__ && globalThis.__KSH_CONTENT_ALIVE__());
    // a live instance must NOT be duplicated by another injection
    const before = await run(() => globalThis.__KSH_CONTENT_ALIVE__);
    await chrome.scripting.executeScript({ target: { tabId }, files: ['shared/selectors.js', 'content/content.js'] });
    const kept = await run(() => globalThis.__KSH_CONTENT_ALIVE__);
    const ping = await chrome.tabs.sendMessage(tabId, { type: 'ksh:ping' });
    return { replaced, notDuplicated: typeof before === 'function' && typeof kept === 'function', ping: ping?.ok && ping.authenticated };
  }, tabIdA);
  check('T17 dead instance is replaced by a fresh injection', r17.replaced === true, JSON.stringify(r17));
  check('T17 fresh instance answers pings', r17.ping === true);

  // T18 sync after everything: store statuses
  await d.click('#refreshBtn');
  await d.waitForFunction(() => !document.querySelector('#refreshBtn').disabled, null, { timeout: 30000 });
  const online = await d.$$eval('#sidebarStores li', (lis) => lis.map((l) => l.innerText.replace(/\s+/g, ' ')));
  check('T18 remaining stores online after re-sync', online.length === 2 && online.every((x) => x.includes('Подключен')), JSON.stringify(online));
  const d2 = d;
  check('no page errors overall', errors.length === 0, errors.join('\n'));
  await d2.screenshot({ path: `${OUT}/run2-final.png` });
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  await ctx.close();
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
