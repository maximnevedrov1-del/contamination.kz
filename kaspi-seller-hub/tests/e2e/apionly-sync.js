// Synchronisation in the RELEASE build (API-only: cabinet mode off, no content scripts, no scripting
// permission) — the build from tools/build-release.mjs, prepared by mkrelcopy.sh (only the Kaspi and
// Supabase addresses point at the local mocks). Every request to the real kaspi.kz is blocked and
// counted: the test fails if one is attempted.
//   A. no stores, no tabs → sync is a normal empty state, no error
//   B. one store (made-up token) → orders loaded from the mock API and shown in the dashboard
//   C. two stores, no Kaspi tabs → both updated; no cabinet, no script injection
//   D. one store answers 503, then 401 → its error is shown, the other keeps working, its cache stays
//   E. several syncs at once → at most one extra cycle, cache intact, no deadlock
//   F. service worker stopped → stores kept, alarms back, sync works
//   G. «Только чтение» → reads work, writes never reach the mock API
// A successful sync stamps a store snapshot with `ts` (an error with `checkedAt`).
//   node apionly-sync.js [path to tests/relmock]   (exit code 1 on any failure)
const { chromium } = require('playwright');
const path = require('path');
const EXT = process.argv[2] || path.join(__dirname, '../relmock');
let fails = 0;
const check = (n, ok, i = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, ok ? '' : i); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kaspiLog = () => fetch('http://localhost:8099/__log').then((r) => r.json());
const apiReqs = async (token) => (await kaspiLog()).filter((x) => x.req && (!token || x.token === token));

(async () => {
  await fetch('http://localhost:8099/__down?on=0');
  for (const t of ['GOOD-TOKEN-1234', 'GOOD-TOKEN-B']) await fetch(`http://localhost:8099/__fail?token=${t}&status=0`);
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'relsyncprof' + Date.now()), { headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 }, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  // guard: nothing may reach the real Kaspi
  const real = [];
  await ctx.route(/^https:\/\/([a-z0-9-]+\.)*kaspi\.kz\//, (r) => { real.push(r.request().url()); return r.abort(); });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const worker = async () => ctx.serviceWorkers().find((w) => w.url().includes(id)) || ctx.waitForEvent('serviceworker');
  const errs = [];
  const d = await ctx.newPage();
  d.on('pageerror', (e) => errs.push(e.message));
  const url = (r) => `chrome-extension://${id}/dashboard/dashboard.html#${r}`;
  const msg = (type, payload) => d.evaluate(([t, p]) => chrome.runtime.sendMessage({ type: t, payload: p }), [type, payload]);
  const snaps = () => d.evaluate(async () => (await chrome.storage.local.get('ksh.snapshots'))['ksh.snapshots'] || {});
  const settings = () => d.evaluate(async () => (await chrome.storage.local.get('ksh.settings'))['ksh.settings']);
  const workerErrors = async () => (await d.evaluate(async () => (await chrome.storage.local.get('ksh.errorLog'))['ksh.errorLog'] || [])).filter((e) => /TypeError|undefined|map/.test(`${e.msg} ${e.code}`));

  await d.goto(url('account'));
  const manifest = await d.evaluate(() => chrome.runtime.getManifest());
  check('0 this is the API-only build: no content scripts, no scripting permission', !manifest.content_scripts && !manifest.permissions.includes('scripting'), JSON.stringify(manifest.permissions));
  check('0 worker has no chrome.scripting', await (await worker()).evaluate(() => typeof chrome.scripting === 'undefined'));
  await d.evaluate(() => { ['home', 'orders', 'settings', 'account', 'help'].forEach((r) => localStorage.setItem(`ksh.guide.${r}`, '1')); localStorage.setItem('ksh.tourDone', '1'); });
  await d.reload(); await d.waitForSelector('input[type=email]');
  await d.fill('input[type=email]', 'apionly@example.kz'); await d.check('label.consent input'); await d.click('button:has-text("Получить код")');
  await d.waitForSelector('input[autocomplete=one-time-code]'); await d.fill('input[autocomplete=one-time-code]', '123456'); await d.click('button:has-text("Войти")');
  await d.waitForSelector('.badge:has-text("Пробный период")', { timeout: 20000 });

  // A. no stores, no tabs
  const a = await msg('ui:sync');
  check('A sync with no stores: normal state, no error', !!a?.settings && a.ok !== false && !a.error, JSON.stringify(a)?.slice(0, 200));
  check('A no TypeError in the worker journal', (await workerErrors()).length === 0, JSON.stringify(await workerErrors()));
  await d.goto(url('home')); await d.reload(); await sleep(1200);
  check('A dashboard shows the empty state', (await d.locator('#view').innerText()).length > 0 && (await d.locator('#view .empty, #view [data-card=onboarding]').count()) > 0);

  // B. one store through the «Подключить магазин» form
  await d.click('#connectStoreBtn'); await d.waitForSelector('#connectDialog[open]');
  await d.fill('#connectName', 'Магазин А'); await d.fill('#connectToken', 'GOOD-TOKEN-1234'); await d.click('#connectSubmit');
  await d.waitForFunction(() => !document.getElementById('connectDialog').open, null, { timeout: 20000 });
  await msg('ui:sync'); await sleep(1500);
  const st1 = await settings();
  const A = Object.values(st1.stores).find((s) => s.name === 'Магазин А')?.id;
  const sA = (await snaps())[A];
  check('B orders loaded from the mock API', sA?.status === 'ok' && (sA.sections?.orders?.items?.length || 0) > 100, JSON.stringify({ status: sA?.status, n: sA?.sections?.orders?.items?.length }));
  check('B requests went to the mock with the store token', (await apiReqs('GOOD-TOKEN-1234')).length > 0);
  await d.goto(url('orders')); await d.reload(); await sleep(1500);
  await d.click('.tabs .tab:has-text("Все")').catch(() => {}); await sleep(300);
  check('B orders appear in the dashboard', (await d.locator('#view tbody tr').count()) > 0 && (await d.locator('#view tbody tr', { hasText: '800002001' }).count()) === 1);

  // C. a second store, still no Kaspi tabs
  await msg('ui:connectApi', { shopId: null, name: 'Магазин Б', token: 'GOOD-TOKEN-B' }); await sleep(1000);
  const t0 = Date.now();
  await msg('ui:sync'); await sleep(1000);
  const st2 = await settings();
  const B = Object.values(st2.stores).find((s) => s.name === 'Магазин Б')?.id;
  const s2 = await snaps();
  check('C both stores updated by this sync', [A, B].every((x) => s2[x]?.status === 'ok' && s2[x].ts >= t0 && s2[x].sections?.orders?.items?.length > 100), JSON.stringify([A, B].map((x) => [s2[x]?.status, s2[x]?.ts >= t0])));
  check('C both tokens used', (await apiReqs('GOOD-TOKEN-B')).length > 0 && (await apiReqs('GOOD-TOKEN-1234')).length > 0);
  const reg = await d.evaluate(async () => (await chrome.storage.session.get('ksh.registry'))['ksh.registry'] || {});
  check('C no cabinet tabs registered', Object.keys(reg).length === 0, JSON.stringify(reg));

  // D. store B fails (503, then 401); A keeps working; B's orders are not wiped
  const keptB = s2[B].sections.orders.items.length;
  await fetch('http://localhost:8099/__fail?token=GOOD-TOKEN-B&status=503');
  const t1 = Date.now();
  await msg('ui:sync'); await sleep(800);
  let s3 = await snaps();
  check('D 503: B marked with an error, its orders kept', s3[B]?.status === 'error' && s3[B].sections?.orders?.items?.length === keptB, JSON.stringify({ st: s3[B]?.status, err: s3[B]?.error, n: s3[B]?.sections?.orders?.items?.length, keptB }));
  check('D 503: A updated and fine', s3[A]?.status === 'ok' && s3[A].ts >= t1);
  await d.goto(url('orders')); await d.reload(); await sleep(1500);
  check('D the error is shown for B', (await d.locator('#banners').innerText()).includes('Магазин Б'));
  await fetch('http://localhost:8099/__fail?token=GOOD-TOKEN-B&status=401');
  await msg('ui:sync'); await sleep(800);
  s3 = await snaps();
  check('D 401: B shows «token» error, orders kept, A fine', s3[B]?.status === 'error' && /Unauthorized|401/i.test(s3[B].error || '') && s3[B].sections?.orders?.items?.length === keptB && s3[A]?.status === 'ok', JSON.stringify({ err: s3[B]?.error, a: s3[A]?.status }));
  await fetch('http://localhost:8099/__fail?token=GOOD-TOKEN-B&status=0');
  await msg('ui:sync'); await sleep(500);
  check('D B recovers when the API answers again', (await snaps())[B]?.status === 'ok');

  // E. six syncs at the same moment
  const one0 = (await apiReqs()).length;
  await msg('ui:sync');
  const perCycle = (await apiReqs()).length - one0;
  const before = (await apiReqs()).length;
  const results = await Promise.all(Array.from({ length: 6 }, () => msg('ui:sync')));
  const used = (await apiReqs()).length - before;
  check('E all six calls answered', results.every((r) => !!r?.settings), JSON.stringify(results.map((r) => !!r?.settings)));
  check('E at most two full cycles for six calls (one running + one queued)', used <= 2 * perCycle, `${used} requests, one cycle = ${perCycle}`);
  const s4 = await snaps();
  check('E cache intact', [A, B].every((x) => s4[x]?.status === 'ok' && s4[x].sections?.orders?.items?.length > 100));
  const late = await Promise.race([msg('ui:sync').then(() => 'done'), sleep(30000).then(() => 'timeout')]);
  check('E no deadlock: another sync finishes', late === 'done');

  // F. the worker is stopped (Chrome does this after ~30 s idle) and woken again
  const cdp = await ctx.newCDPSession(d);
  await cdp.send('ServiceWorker.enable').catch(() => {});
  await cdp.send('ServiceWorker.stopAllWorkers'); await sleep(800);
  const st5 = await msg('ui:getState');
  check('F stores kept after the restart', Object.keys(st5?.settings?.stores || {}).length === 2);
  const alarms = (await (await worker()).evaluate(() => chrome.alarms.getAll())).map((x) => x.name);
  check('F sync and health alarms present', alarms.includes('ksh-sync') && alarms.includes('ksh-health'), alarms.join());
  await (await worker()).evaluate(() => chrome.alarms.clearAll());
  await cdp.send('ServiceWorker.stopAllWorkers'); await sleep(800);
  await msg('ui:getState'); await sleep(800);
  const alarms2 = (await (await worker()).evaluate(() => chrome.alarms.getAll())).map((x) => x.name);
  check('F lost alarms recreated when the worker wakes', alarms2.includes('ksh-sync') && alarms2.includes('ksh-health'), alarms2.join());
  const t2 = Date.now();
  await msg('ui:sync');
  check('F sync works after the restart', Object.values(await snaps()).every((x) => x.ts >= t2 && x.status === 'ok'));

  // G. «Только чтение»
  await d.goto(url('settings')); await d.reload(); await sleep(1200);
  await d.check('input[data-setting=readOnly]'); await sleep(800);
  const t3 = Date.now();
  await msg('ui:sync');
  check('G reads still work', Object.values(await snaps()).every((x) => x.ts >= t3 && x.status === 'ok'));
  const item = [{ shopId: A, orderId: '800002001' }];
  const w = await Promise.all([msg('ui:accept', { items: item }), msg('ui:pack', { items: item })]);
  check('G accept / pack refused', w.every((r) => r?.error === 'readOnly'), JSON.stringify(w));
  const writes = (await apiReqs()).filter((x) => x.req !== 'GET');
  check('G no write request ever reached the mock API', writes.length === 0, JSON.stringify(writes.slice(0, 3)));

  check('no request to the real kaspi.kz', real.length === 0, real.slice(0, 3).join(' '));
  check('no TypeError in the worker journal', (await workerErrors()).length === 0, JSON.stringify(await workerErrors()));
  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  await ctx.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('CRASH', e.message.split('\n')[0]); process.exit(1); });
