// «Оркестр»: every background job at the same moment, an expired session, the worker stopped
// and woken, alarms lost, a Kaspi outage, another account on the same computer, the warehouse
// lock — everything must keep working together: no logout, no lost data, no errors.
// Uses ../billcopy (mock Supabase :8098 with the real SQL — refresh tokens are single-use there,
// like Supabase — and mock Kaspi :8099).
const { chromium } = require('playwright');
const path = require('path');
const { Client } = require('pg');
const EXT = path.join(__dirname, '../billcopy');
let fails = 0;
const check = (n, ok, i = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, ok ? '' : i); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const supaLog = () => fetch('http://localhost:8098/__log').then((r) => r.json());
const ALL = ['ksh-sync', 'ksh-health', 'ksh-chat-poll', 'ksh-card-imports'];

(async () => {
  const db = new Client({ host: '/tmp', port: 5499, user: 'postgres', database: 'billing' });
  await db.connect();
  const q = async (sql, a) => (await db.query(sql, a)).rows;
  await fetch('http://localhost:8099/__down?on=0');
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'orchprof' + Date.now()), { headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 }, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const errs = [];
  const d = await ctx.newPage(); d.on('pageerror', (e) => errs.push(e.message));
  const url = (r) => `chrome-extension://${id}/dashboard/dashboard.html#${r}`;
  const msg = (type, payload) => d.evaluate(([t, p]) => chrome.runtime.sendMessage({ type: t, payload: p }), [type, payload]);
  const store = (k) => d.evaluate(async (k) => (await chrome.storage.local.get(k))[k], k);
  const worker = async () => { const w = ctx.serviceWorkers().find((x) => x.url().includes(id)); return w || ctx.waitForEvent('serviceworker'); };
  const fireAll = async () => { const w = await worker(); await w.evaluate((names) => names.forEach((n) => chrome.alarms.create(n + '-now', { when: Date.now() + 50 }) && chrome.alarms.create(n, { when: Date.now() + 50 })), ALL); };
  const cdp = await ctx.newCDPSession(d);
  const stopWorker = async () => { await cdp.send('ServiceWorker.enable').catch(() => {}); await cdp.send('ServiceWorker.stopAllWorkers').catch(() => {}); await sleep(800); };

  // owner: sign in, 2 stores, a support question
  await d.goto(url('account'));
  await d.evaluate(() => { ['home', 'orders', 'settings', 'account', 'help'].forEach((r) => localStorage.setItem(`ksh.guide.${r}`, '1')); localStorage.setItem('ksh.tourDone', '1'); });
  await d.reload(); await d.waitForSelector('input[type=email]');
  await d.fill('input[type=email]', 'owner1@example.kz'); await d.check('label.consent input'); await d.click('button:has-text("Получить код")');
  await d.waitForSelector('input[autocomplete=one-time-code]'); await d.fill('input[autocomplete=one-time-code]', '123456'); await d.click('button:has-text("Войти")');
  await d.waitForSelector('.badge:has-text("Пробный период")', { timeout: 15000 });
  await msg('ui:connectApi', { shopId: null, name: 'Магазин А', token: 'GOOD-TOKEN-1234' }); await sleep(2500);
  await msg('ui:connectApi', { shopId: null, name: 'Магазин Б', token: 'GOOD-TOKEN-B' }); await sleep(4000);
  await msg('ui:ticketSend', { topic: 'orders', message: 'Проверка оркестра' });
  await msg('ui:clearErrors');

  // 1. three rounds: session expired + every job and every page request at the same moment
  for (let round = 1; round <= 3; round++) {
    await d.evaluate(async () => { const s = (await chrome.storage.local.get('ksh.session'))['ksh.session']; s.expires_at = Date.now() - 1000; await chrome.storage.local.set({ 'ksh.session': s }); });
    const before = (await supaLog()).filter((x) => x.refresh).length;
    await fireAll();
    const res = await Promise.all([msg('ui:billingState', { force: true }), msg('ui:tickets'), msg('ui:feedbackDue'), msg('ui:serviceStatus', { force: true }), msg('ui:billingState', { force: false }), msg('ui:sync')]);
    await sleep(3500);
    const refreshes = (await supaLog()).filter((x) => x.refresh).length - before;
    const lic = await msg('ui:billingState', { force: false });
    check(`1.${round} everything at once: still signed in`, !!(await store('ksh.session')) && ['trial', 'active'].includes(lic?.status), JSON.stringify(lic?.status));
    check(`1.${round} one token refresh served all of them`, refreshes === 1, String(refreshes));
    check(`1.${round} every answer arrived`, res.every((r) => r && r.ok !== false || r?.status), JSON.stringify(res.map((r) => r?.ok ?? r?.status)));
  }
  const st = await msg('ui:getState');
  const snaps = async () => Object.values((await d.evaluate(async () => (await (async () => { const g = chrome.storage.local; const ids = (await g.get('ksh.snapIndex'))['ksh.snapIndex']; if (!ids) return (await g.get('ksh.snapshots'))['ksh.snapshots']; const r = await g.get(ids.map((i) => 'ksh.snap.' + i)); return Object.fromEntries(ids.filter((i) => r['ksh.snap.' + i]).map((i) => [i, r['ksh.snap.' + i]])); })()))) || {});
  check('1 both stores and their orders intact', Object.keys(st.settings.stores).length === 2 && (await snaps()).filter((s) => s?.sections?.orders?.items?.length).length === 2, String((await snaps()).length));

  // 2. the worker is stopped (Chrome does this after 30 s idle) → woken by a page; nothing lost
  const hBefore = await d.evaluate(async () => (await chrome.storage.session.get('ksh.health'))['ksh.health']);
  await msg('ui:sync'); await sleep(1500);
  await stopWorker();
  const st2 = await msg('ui:getState');
  check('2 woken worker answers with the same data', Object.keys(st2?.settings?.stores || {}).length === 2);
  const hAfter = await d.evaluate(async () => (await chrome.storage.session.get('ksh.health'))['ksh.health']);
  check('2 unsent API counts survived the stop', (hAfter?.kaspi?.ok || 0) >= (hBefore?.kaspi?.ok || 0), JSON.stringify({ hBefore, hAfter }));

  // 3. Chrome lost the alarms → recreated when the worker wakes, without resetting existing ones
  await (await worker()).evaluate(() => chrome.alarms.clearAll());
  await stopWorker();
  await msg('ui:getState'); await sleep(800);
  const names = (await (await worker()).evaluate(() => chrome.alarms.getAll())).map((a) => a.name);
  check('3 lost alarms recreated on wake (sync, health)', names.includes('ksh-sync') && names.includes('ksh-health'), names.join(','));

  // 4. Kaspi outage during a sync, then recovery: no logout, store marked, then back
  await fetch('http://localhost:8099/__down?on=1');
  await msg('ui:sync'); await sleep(9000);
  const down = await snaps();
  await fetch('http://localhost:8099/__down?on=0');
  check('4 outage: stores marked, orders kept', down.some((s) => s?.status && s.status !== 'ok') && down.every((s) => s?.sections?.orders?.items?.length), JSON.stringify(down.map((s) => [s?.status, s?.sections?.orders?.items?.length])));
  await msg('ui:sync'); await sleep(4000);
  const up = await snaps();
  check('4 recovered by the next sync', up.every((s) => s?.status === 'ok'), JSON.stringify(up.map((s) => s?.status)));
  check('4 still signed in after the outage', !!(await store('ksh.session')));
  await (await worker()).evaluate(() => chrome.alarms.create('ksh-health', { when: Date.now() + 50 })); await sleep(2500);
  const h = (await q("select kinds from api_health h join auth.users u on u.id = h.user_id where u.email='owner1@example.kz'"))[0];
  check('4 outage reached the owner\'s health counts', h?.kinds?.server > 0, JSON.stringify(h));

  // 5. no unexpected errors in the seller's error journal
  const diag = await msg('ui:diagnostics');
  const lines = diag.text.split('\n').filter((l) => /^\s*\d{4}-\d\d-\d\d/.test(l) && !/apiHttp|apiNetwork|502|sync/.test(l));
  check('5 error journal: only the simulated outage', lines.length === 0, lines.join(' | '));

  // 7. warehouse lock: the locked page keeps quiet, owner-only requests refused, no page errors
  await d.goto(url('settings')); await d.reload(); await sleep(1500);
  await d.locator('[data-card=warehouse] [data-field=warehousePin]').fill('2468');
  await d.locator('[data-card=warehouse] button[data-action=warehouse-on]').click(); await sleep(1200);
  await d.reload(); await sleep(1500);
  check('7 lock screen shown', (await d.locator('.lock').count()) === 1);
  const refused = await Promise.all(['ui:tickets', 'ui:feedbackDue', 'ui:diagnostics', 'ui:teamList'].map((t) => msg(t)));
  check('7 owner-only requests refused while locked', refused.every((r) => r?.error === 'warehouseLocked'), JSON.stringify(refused.map((r) => r?.error)));
  await fireAll(); await sleep(3000);
  check('7 background jobs keep running while locked (still signed in)', !!(await store('ksh.session')));
  const un = await msg('ui:ownerUnlock', { pin: '2468' });
  const off = await msg('ui:warehouseSet', { enabled: false, pin: '2468' });
  check('7 owner unlocks with the PIN and switches the lock off', un?.ok !== false && off?.ok !== false, JSON.stringify([un, off]));
  // 6. another account on the same computer: no questions or counts of the previous one
  check('6 owner 1 has a cached question', ((await store('ksh.tickets'))?.list || []).length === 1);
  await msg('ui:billingLogout');
  await d.goto(url('account')); await d.reload(); await d.waitForSelector('input[type=email]');
  await d.fill('input[type=email]', 'owner2@example.kz'); await d.check('label.consent input').catch(() => {}); await d.click('button:has-text("Получить код")');
  await d.waitForSelector('input[autocomplete=one-time-code]'); await d.fill('input[autocomplete=one-time-code]', '123456'); await d.click('button:has-text("Войти")');
  // these two stores already had their free month with owner 1 → owner 2 gets no new trial (anti-abuse)
  await d.waitForFunction(() => document.querySelector('#view')?.innerText.includes('owner2@example.kz'), null, { timeout: 15000 });
  await sleep(1000);
  check('6 no «почему не продлеваете» for someone who never had a period', (await d.locator('[data-card=exit], [data-block=pay-exit]').count()) === 0);
  check('6 the new account does not see owner 1\'s questions', !(await store('ksh.tickets')));
  const t2 = await msg('ui:tickets');
  check('6 server agrees: no questions for owner 2', t2?.ok && t2.list.length === 0, JSON.stringify(t2));

  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  await db.end();
  await ctx.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('CRASH', e.message); process.exit(1); });
