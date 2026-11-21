// Mass onboarding safety (mock Kaspi :8099, no billing — developer copy):
//   1. quick start: the first sync reads orders in progress + the archive of the last 7 days only,
//      shows them at once; older archive fills in one window per sync up to 90 days
//   2. a store whose API hangs: the sync finishes (request timeout + per-store cap), the other store
//      is updated, the next sync is not blocked
//   3. 429 with Retry-After: waited for and retried, the data arrives
//   4. connect: double click → one check, the same token twice → refused, a bad token retried at once → «wait»
// Own copy of the extension (tests/loadcopy) with short timeouts: requestTimeoutMs 1500, storeSyncMs 6000.
//   node syncload.js   (exit code 1 on any failure)
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const SRC = process.env.SYNCLOAD_SRC || path.join(__dirname, '../..'); // another tree to compare (e.g. the code before a fix)
const EXT = path.join(__dirname, '../loadcopy');
let fails = 0;
const check = (n, ok, i = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, ok ? '' : i); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mock = (p) => fetch(`http://localhost:8099${p}`).then((r) => r.json());

(async () => {
  // copy without tests/ and dist/, API base → mock, short timeouts
  fs.rmSync(EXT, { recursive: true, force: true });
  fs.mkdirSync(EXT, { recursive: true });
  for (const f of fs.readdirSync(SRC)) if (!['tests', 'dist', 'node_modules'].includes(f)) fs.cpSync(path.join(SRC, f), path.join(EXT, f), { recursive: true });
  const selp = path.join(EXT, 'shared/selectors.js');
  let sel = fs.readFileSync(selp, 'utf8');
  for (const [a, b] of [["base: 'https://kaspi.kz/shop/api/v2'", "base: 'http://localhost:8099/shop/api/v2'"], ['requestTimeoutMs: 25000', 'requestTimeoutMs: 1500'], ['storeSyncMs: 180000', 'storeSyncMs: 6000']]) {
    if (!sel.includes(a)) { if (a.startsWith('base:')) throw new Error('selectors.js: ' + a + ' not found'); console.log('NOTE', a, 'not in this code'); continue; }
    sel = sel.replace(a, b);
  }
  fs.writeFileSync(selp, sel);
  await mock('/__down?on=0');
  for (const t of ['GOOD-TOKEN-1234', 'GOOD-TOKEN-B']) { await mock(`/__fail?token=${t}&status=0`); await mock(`/__hang?token=${t}&on=0`); }

  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'loadprof' + Date.now()), { headless: true, channel: 'chromium', args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  const real = [];
  await ctx.route(/^https:\/\/([a-z0-9-]+\.)*kaspi\.kz\//, (r) => { real.push(r.request().url()); return r.abort(); });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const d = await ctx.newPage();
  const errs = [];
  d.on('pageerror', (e) => errs.push(e.message));
  await d.goto(`chrome-extension://${id}/dashboard/dashboard.html#home`);
  const msg = (type, payload) => d.evaluate(([t, p]) => chrome.runtime.sendMessage({ type: t, payload: p }), [type, payload]);
  const snaps = () => d.evaluate(async () => (await chrome.storage.local.get('ksh.snapshots'))['ksh.snapshots'] || {});
  const backfill = () => d.evaluate(async () => (await chrome.storage.local.get('ksh.apiBackfill'))['ksh.apiBackfill'] || {});
  const lists = async (from) => (await mock('/__log')).slice(from).filter((x) => x.list);
  const archiveIn = (items) => items.filter((i) => i.api?.state === 'ARCHIVE');
  const DAY = 86400000;

  // 1. quick start
  const before = (await mock('/__log')).length;
  const t0 = Date.now();
  const c = await msg('ui:connectApi', { shopId: null, name: 'Магазин А', token: 'GOOD-TOKEN-1234' });
  for (let i = 0; i < 150 && !(await snaps())[c.shopId]?.sections?.orders?.items?.length; i++) await sleep(200);
  const shownAfter = Date.now() - t0;
  const A = c.shopId;
  const first = await lists(before);
  const archReq = first.filter((x) => x.list === 'ARCHIVE');
  check('1 first sync: archive read only for the last 7 days', archReq.length > 0 && archReq.every((x) => x.fromDaysAgo <= 7), JSON.stringify(archReq.map((x) => x.fromDaysAgo)));
  check('1 first sync: orders in progress read over the whole 90 days', first.some((x) => x.list === 'NEW' && x.fromDaysAgo >= 80));
  const s1 = (await snaps())[A].sections.orders.items;
  check('1 orders shown after the first (light) sync', s1.some((i) => i.id === '800002001') && archiveIn(s1).every((i) => Date.now() - new Date(i.date).getTime() <= 8 * DAY), `${s1.length} orders, shown after ${shownAfter} ms`);
  check('1 backfill progress saved', (await backfill())[A] > 0);
  let rounds = 0;
  while ((await backfill())[A] != null && rounds < 10) { await msg('ui:sync'); rounds++; }
  const s2 = (await snaps())[A].sections.orders.items;
  const oldest = Math.max(...archiveIn(s2).map((i) => (Date.now() - new Date(i.date).getTime()) / DAY));
  check('1 history filled in over a few syncs (≤ 7), not in one cycle', rounds >= 2 && rounds <= 7 && (await backfill())[A] == null, `${rounds} syncs`);
  check('1 the full 90-day archive is there in the end', archiveIn(s2).length > archiveIn(s1).length && oldest > 60, `${archiveIn(s1).length} → ${archiveIn(s2).length}, oldest ${Math.round(oldest)} d`);
  check('1 no duplicates after repeated syncs', new Set(s2.map((i) => i.id)).size === s2.length);

  // 2. store B hangs
  await msg('ui:connectApi', { shopId: null, name: 'Магазин Б', token: 'GOOD-TOKEN-B' }); await msg('ui:sync');
  const B = Object.values((await msg('ui:getState')).settings.stores).find((s) => s.name === 'Магазин Б').id;
  await mock('/__hang?token=GOOD-TOKEN-B&on=1');
  const t1 = Date.now();
  const res = await Promise.race([msg('ui:sync').then(() => 'done'), sleep(30000).then(() => 'stuck')]);
  const took = Date.now() - t1;
  const s3 = await snaps();
  check('2 sync finishes although store B never answers', res === 'done' && took < 20000, `${res} in ${took} ms`);
  check('2 store A updated, store B marked «timeout», its orders kept', s3[A]?.status === 'ok' && s3[A].ts >= t1 && s3[B]?.status === 'error' && s3[B].error === 'apiTimeout' && s3[B].sections?.orders?.items?.length > 0, JSON.stringify({ a: s3[A]?.status, b: s3[B]?.status, e: s3[B]?.error }));
  const res2 = await Promise.race([msg('ui:sync').then(() => 'done'), sleep(30000).then(() => 'stuck')]);
  check('2 the next sync is not blocked', res2 === 'done');
  await mock('/__hang?token=GOOD-TOKEN-B&on=0');

  // 3. 429 with Retry-After: 1 s → waited and retried
  await mock('/__fail?token=GOOD-TOKEN-1234&status=429&retryAfter=1&times=1');
  const l0 = (await mock('/__log')).length;
  const t2 = Date.now();
  await msg('ui:sync');
  const s4 = await snaps();
  check('3 429 answered once → waited ≥ 1 s, retried, data fresh', Date.now() - t2 >= 1000 && s4[A]?.status === 'ok' && s4[A].ts >= t2, `${Date.now() - t2} ms, ${s4[A]?.status}`);
  check('3 the retry reached the mock after the 429', (await mock('/__log')).slice(l0).filter((x) => x.req && x.token === 'GOOD-TOKEN-1234').length >= 2);
  await mock('/__fail?token=GOOD-TOKEN-1234&status=0');

  // 4. connect guards
  const dbl = await Promise.all([msg('ui:connectApi', { shopId: null, name: 'Магазин В', token: 'GOOD-TOKEN-C' }), msg('ui:connectApi', { shopId: null, name: 'Магазин В', token: 'GOOD-TOKEN-C' })]);
  check('4 double click: one connect, the other «checking»/«already connected»', dbl.filter((r) => r.ok).length === 1 && dbl.some((r) => ['connectBusy', 'tokenAlreadyConnected'].includes(r.error)), JSON.stringify(dbl));
  const dup = await msg('ui:connectApi', { shopId: null, name: 'Копия А', token: 'GOOD-TOKEN-1234' });
  check('4 the same token as a new store → refused', dup.error === 'tokenAlreadyConnected', JSON.stringify(dup));
  const bad1 = await msg('ui:connectApi', { shopId: null, name: 'Плохой', token: 'BAD-TOKEN-1' });
  const n0 = (await mock('/__log')).length;
  const bad2 = await msg('ui:connectApi', { shopId: null, name: 'Плохой', token: 'BAD-TOKEN-1' });
  check('4 a refused token retried at once → «wait 10 s», no request to Kaspi', bad1.error === 'apiUnauthorized' && bad2.error === 'connectWait' && (await mock('/__log')).slice(n0).filter((x) => x.token === 'BAD-TOKEN-1').length === 0, JSON.stringify([bad1.error, bad2.error]));
  const stores = Object.values((await msg('ui:getState')).settings.stores).map((s) => s.name).sort();
  check('4 exactly three stores connected', JSON.stringify(stores) === JSON.stringify(['Магазин А', 'Магазин Б', 'Магазин В']), stores.join());

  check('no request to the real kaspi.kz', real.length === 0, real.slice(0, 2).join(' '));
  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  await ctx.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('CRASH', e.message.split('\n')[0]); process.exit(1); });
