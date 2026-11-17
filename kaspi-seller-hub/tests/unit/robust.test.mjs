// Unit tests (plain Node ≥ 18, no browser): Kazakhstan time, Kaspi API retries,
// price-list drop guard, data migrations, error journal.
//   node tests/unit/robust.test.mjs
import assert from 'node:assert/strict';

/* ---- minimal chrome.* for modules that touch it at import time ---- */
function memoryArea(init = {}) {
  const data = structuredClone(init);
  return {
    data,
    async get(k) {
      if (k == null) return structuredClone(data);
      const keys = Array.isArray(k) ? k : typeof k === 'string' ? [k] : Object.keys(k);
      return Object.fromEntries(keys.filter((x) => x in data).map((x) => [x, structuredClone(data[x])]));
    },
    async set(o) {
      Object.assign(data, structuredClone(o));
    },
    async remove(k) {
      (Array.isArray(k) ? k : [k]).forEach((x) => delete data[x]);
    },
  };
}
globalThis.chrome = {
  runtime: { id: 'test', getURL: (p) => `chrome-extension://test/${p}`, getManifest: () => ({ version: '0.0.0' }) },
  storage: { local: memoryArea(), session: memoryArea(), onChanged: { addListener() {} } },
};

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('PASS', name);
  } catch (e) {
    failures.push(name);
    console.log('FAIL', name, '—', e.message.split('\n')[0]);
  }
}

const U = await import('../../shared/utils.js');
const K = await import('../../background/kaspi-api.js');
const M = await import('../../shared/migrations.js');
const L = await import('../../shared/errorlog.js');
const C = await import('../../background/catalog-service.js');
const I = await import('../../shared/i18n.js');
const P = await import('../../shared/photos.js');

/* ---------------- Kazakhstan time (UTC+5) ---------------- */
await test('dayKey: 19:30 UTC is already the next day in Kazakhstan', () => {
  assert.equal(U.dayKey(Date.UTC(2026, 10, 16, 19, 30)), '2026-11-17');
  assert.equal(U.dayKey(Date.UTC(2026, 10, 16, 18, 59)), '2026-11-16');
});
await test('startOfDay/endOfDay are Kazakhstan midnight', () => {
  assert.equal(U.startOfDay(Date.UTC(2026, 10, 16, 19, 30)).toISOString(), '2026-11-16T19:00:00.000Z');
  assert.equal(U.endOfDay(Date.UTC(2026, 10, 16, 19, 30)).toISOString(), '2026-11-17T18:59:59.999Z');
});
await test('startOfDay of a "YYYY-MM-DD" filter value', () => {
  assert.equal(U.startOfDay('2026-11-17').toISOString(), '2026-11-16T19:00:00.000Z');
  assert.equal(U.endOfDay('2026-11-17').toISOString(), '2026-11-17T18:59:59.999Z');
});
await test('presetRange(7) spans 7 Kazakhstan days', () => {
  const r = U.presetRange(7);
  assert.equal(U.eachDay(r.from, r.to).length, 7);
});
await test('formatDate shows Kazakhstan time whatever the computer zone', () => {
  assert.match(I.formatDate(Date.UTC(2026, 10, 16, 19, 30), 'time'), /00:30/);
  assert.match(I.formatDate(Date.UTC(2026, 10, 16, 19, 30), 'date'), /17\.11\.2026/);
});

/* ---------------- Kaspi API retries ---------------- */
function fakeFetch(answers) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, method: opts.method });
    const a = answers.shift();
    if (a === 'net') throw new TypeError('Failed to fetch');
    return new Response(a.body ?? '{}', { status: a.status, headers: a.headers || {} });
  };
  return calls;
}
const waits = [];
K._setSleep(async (ms) => waits.push(ms));

await test('GET: 503 then 200 → retried, succeeds', async () => {
  const calls = fakeFetch([{ status: 503 }, { status: 200 }]);
  const res = await K.apiRequest('t', '/orders');
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
});
await test('GET: network failure twice then OK', async () => {
  const calls = fakeFetch(['net', 'net', { status: 200 }]);
  await K.apiRequest('t', '/orders');
  assert.equal(calls.length, 3);
});
await test('GET: gives up after 3 attempts with apiHttp', async () => {
  const calls = fakeFetch([{ status: 502 }, { status: 502 }, { status: 502 }]);
  await assert.rejects(K.apiRequest('t', '/orders'), (e) => e.code === 'apiHttp' && e.status === 502);
  assert.equal(calls.length, 3);
});
await test('429 honours Retry-After (capped at 10 s)', async () => {
  waits.length = 0;
  fakeFetch([{ status: 429, headers: { 'Retry-After': '120' } }, { status: 200 }]);
  await K.apiRequest('t', '/orders');
  assert.deepEqual(waits, [10000]);
});
await test('429 three times → apiRateLimit', async () => {
  fakeFetch([{ status: 429 }, { status: 429 }, { status: 429 }]);
  await assert.rejects(K.apiRequest('t', '/orders'), (e) => e.code === 'apiRateLimit');
});
await test('POST (accept order): 429 is retried — Kaspi did not process it', async () => {
  const calls = fakeFetch([{ status: 429 }, { status: 200 }]);
  await K.apiRequest('t', '/orders', { method: 'POST', body: { a: 1 } });
  assert.equal(calls.length, 2);
});
await test('POST: 503 is NOT retried (may already be applied)', async () => {
  const calls = fakeFetch([{ status: 503 }, { status: 200 }]);
  await assert.rejects(K.apiRequest('t', '/orders', { method: 'POST', body: {} }), (e) => e.status === 503);
  assert.equal(calls.length, 1);
});
await test('POST: network failure is NOT retried', async () => {
  const calls = fakeFetch(['net', { status: 200 }]);
  await assert.rejects(K.apiRequest('t', '/orders', { method: 'POST', body: {} }), (e) => e.code === 'apiNetwork');
  assert.equal(calls.length, 1);
});
await test('401 is never retried', async () => {
  const calls = fakeFetch([{ status: 401 }, { status: 200 }]);
  await assert.rejects(K.apiRequest('t', '/orders'), (e) => e.code === 'apiUnauthorized');
  assert.equal(calls.length, 1);
});
await test('card import sends text/plain JSON array once on 503', async () => {
  let seen;
  globalThis.fetch = async (url, opts) => {
    seen = opts;
    return new Response('', { status: 503 });
  };
  await assert.rejects(K.importProducts('t', [{ sku: 'A1' }]));
  assert.equal(seen.headers['Content-Type'], 'text/plain');
  assert.equal(seen.body, '[{"sku":"A1"}]');
});

/* ---------------- price-list drop guard ---------------- */
await test('drop guard: everything gone → held', () => assert.equal(C.isSuspiciousDrop(5, 0), true));
await test('drop guard: 100 → 40 held, 100 → 60 allowed', () => {
  assert.equal(C.isSuspiciousDrop(100, 40), true);
  assert.equal(C.isSuspiciousDrop(100, 60), false);
});
await test('drop guard: small stores may remove a few products', () => assert.equal(C.isSuspiciousDrop(4, 1), false));
await test('drop guard: first upload is never held', () => {
  assert.equal(C.isSuspiciousDrop(undefined, 0), false);
  assert.equal(C.isSuspiciousDrop(0, 0), false);
});

/* ---------------- data migrations ---------------- */
await test('fresh install: version stamped, nothing else touched', async () => {
  const a = memoryArea({ 'ksh.costs': { A: 1 } });
  const r = await M.migrateStorage(a);
  assert.equal(a.data[M.VERSION_KEY], M.DATA_VERSION);
  assert.deepEqual(a.data['ksh.costs'], { A: 1 });
  assert.equal(r.ran.length, 0);
});
await test('update: steps run in order, backup kept, version saved', async () => {
  const a = memoryArea({ [M.VERSION_KEY]: 1, 'ksh.costs': { A: 100 } });
  const steps = {
    2: (all) => ({ set: { 'ksh.costs': Object.fromEntries(Object.entries(all['ksh.costs']).map(([k, v]) => [k, { cost: v }])) } }),
    3: (all) => ({ set: { 'ksh.costs3': all['ksh.costs'] }, remove: ['ksh.costs'] }),
  };
  const r = await M.migrateStorage(a, { target: 3, steps });
  assert.deepEqual(r.ran, [2, 3]);
  assert.deepEqual(a.data['ksh.costs3'], { A: { cost: 100 } });
  assert.equal(a.data['ksh.costs'], undefined);
  assert.equal(a.data[M.VERSION_KEY], 3);
  assert.deepEqual(a.data[M.BACKUP_KEY].data['ksh.costs'], { A: 100 });
});
await test('failed step: earlier steps kept, version stops before it, data intact', async () => {
  const a = memoryArea({ [M.VERSION_KEY]: 1, 'ksh.costs': { A: 1 } });
  const r = await M.migrateStorage(a, { target: 3, steps: { 2: () => ({ set: { x2: 1 } }), 3: () => { throw new Error('boom'); } } });
  assert.equal(r.error, 'boom');
  assert.equal(a.data[M.VERSION_KEY], 2);
  assert.deepEqual(a.data['ksh.costs'], { A: 1 });
  // next start resumes from step 3 only
  let ran2 = 0;
  const r2 = await M.migrateStorage(a, { target: 3, steps: { 2: () => (ran2++, {}), 3: () => ({}) } });
  assert.deepEqual(r2.ran, [3]);
  assert.equal(ran2, 0);
});
await test('data from a newer build is not touched', async () => {
  const a = memoryArea({ [M.VERSION_KEY]: 99, 'ksh.costs': { A: 1 } });
  const r = await M.migrateStorage(a);
  assert.equal(r.downgraded, true);
  assert.equal(a.data[M.VERSION_KEY], 99);
});

/* ---------------- error journal ---------------- */
await test('scrub removes tokens, e-mails, phones, query values', () => {
  const s = L.scrub('token FAKE+TokenAbCdEf0123456789xyzQRSTuv= user a.b@mail.kz phone +7 701 123 45 67 url /x?name=Иван&page=2 order 1234567890');
  for (const bad of ['FAKE+Token', 'a.b@mail.kz', '701 123', 'Иван', '1234567890']) assert.ok(!s.includes(bad), `${bad} leaked: ${s}`);
});
await test('journal keeps 50 entries and folds repeats', async () => {
  const a = memoryArea();
  for (let i = 0; i < 3; i++) await L.logError('worker:sync', new Error('same'), a);
  for (let i = 0; i < 60; i++) await L.logError('worker:sync', new Error(`e${i}`), a);
  const list = await L.getErrorLog(a);
  assert.equal(list.length, 50);
  assert.equal(list.at(-1).msg, 'e59');
  const b = memoryArea();
  for (let i = 0; i < 3; i++) await L.logError('w', new Error('same'), b);
  assert.equal((await L.getErrorLog(b))[0].n, 3);
});
await test('report is plain text with version and errors', () => {
  const txt = L.formatReport({ version: '1.2.3', browser: 'Chrome/130', dataVersion: 1, stores: 3, apiStores: 2, licence: 'active', errors: [{ at: Date.UTC(2026, 0, 1, 19), where: 'worker:sync', code: 'apiHttp', status: 502, msg: '', n: 2 }] });
  assert.match(txt, /Версия: 1\.2\.3/);
  assert.match(txt, /2026-01-02 00:00 worker:sync \[apiHttp 502\] ×2/);
});

/* ---------------- product photos ---------------- */
await test('photo: Kaspi CDN links and small images allowed', () => {
  assert.ok(P.isAllowedPhoto('https://resources.cdn-kaspi.kz/img/m/p/h44/h88/63854412398622.jpg'));
  assert.ok(P.isAllowedPhoto('https://kaspi.kz/img/x.png'));
  assert.ok(P.isAllowedPhoto('data:image/jpeg;base64,/9j/4AAQSkZJRg=='));
});
await test('photo: other hosts, http, look-alike hosts, scripts refused', () => {
  for (const bad of ['http://resources.cdn-kaspi.kz/a.jpg', 'https://evil.com/a.jpg', 'https://kaspi.kz.evil.com/a.jpg', 'https://evilkaspi.kz/a.jpg', 'https://user:pw@kaspi.kz/a.jpg', 'javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/svg+xml;base64,PHN2Zz4=', '', null]) assert.equal(P.isAllowedPhoto(bad), false, String(bad));
  assert.equal(P.isAllowedPhoto('data:image/jpeg;base64,' + 'A'.repeat(P.MAX_PHOTO_DATA)), false);
});
await test('photo: seller photo wins, then catalog, else none', () => {
  const cat = { A1: { images: ['https://other.com/x.jpg', 'https://resources.cdn-kaspi.kz/a.jpg'] } };
  assert.equal(P.photoFor('A1', {}, cat), 'https://resources.cdn-kaspi.kz/a.jpg');
  assert.equal(P.photoFor('A1', { A1: 'https://resources.cdn-kaspi.kz/own.jpg' }, cat), 'https://resources.cdn-kaspi.kz/own.jpg');
  assert.equal(P.photoFor('B2', {}, cat), null);
});

console.log(failures.length ? `${failures.length} FAILED (${passed} passed)` : `ALL ${passed} PASSED`);
process.exit(failures.length ? 1 : 0);
