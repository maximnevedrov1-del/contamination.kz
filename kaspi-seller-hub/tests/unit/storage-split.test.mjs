// Per-store snapshots (ksh.snap.<shopId>) with legacy ksh.snapshots migration, and invoice limits.
//   node tests/unit/storage-split.test.mjs
import assert from 'node:assert/strict';

const data = {};
const listeners = [];
const writes = [];
const fire = (changes) => listeners.forEach((l) => l(changes, 'local'));
globalThis.chrome = {
  storage: {
    onChanged: { addListener: (l) => listeners.push(l), removeListener() {} },
    local: {
      async get(k) {
        const keys = k == null ? Object.keys(data) : Array.isArray(k) ? k : [k];
        return Object.fromEntries(keys.filter((x) => x in data).map((x) => [x, structuredClone(data[x])]));
      },
      async set(o) {
        writes.push(Object.keys(o).sort());
        const ch = {};
        for (const [k, v] of Object.entries(o)) (ch[k] = { oldValue: data[k], newValue: structuredClone(v) }), (data[k] = structuredClone(v));
        fire(ch);
      },
      async remove(k) {
        const ch = {};
        for (const x of Array.isArray(k) ? k : [k]) if (x in data) (ch[x] = { oldValue: data[x] }), delete data[x];
        fire(ch);
      },
    },
  },
};
const S = await import('../../shared/storage.js');

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const snap = (id, orders = []) => ({ shopId: id, shopName: id, ts: 1, status: 'ok', sections: { orders: { status: 'ok', items: orders } }, missingSelectors: [] });

await t('legacy ksh.snapshots is read before migration', async () => {
  data['ksh.snapshots'] = { A: snap('A'), B: snap('B') };
  assert.deepEqual(Object.keys(await S.getSnapshots()), ['A', 'B']);
  assert.equal((await S.getSnapshot('B')).shopId, 'B');
});
await t('first write migrates to per-store keys and drops the legacy key', async () => {
  const all = await S.getSnapshots();
  await S.setSnapshots(all);
  assert.equal('ksh.snapshots' in data, false);
  assert.deepEqual(data[S.SNAP_INDEX], ['A', 'B']);
  assert.ok(data['ksh.snap.A'] && data['ksh.snap.B']);
});
await t('changing one store writes only that store', async () => {
  writes.length = 0;
  const all = await S.getSnapshots();
  all.B.sections.orders.items.push({ id: '1' });
  await S.setSnapshots(all);
  assert.deepEqual(writes, [['ksh.snap.B']]);
});
await t('unchanged write writes nothing', async () => {
  writes.length = 0;
  await S.setSnapshots(await S.getSnapshots());
  assert.deepEqual(writes, []);
});
await t('updateSnapshot touches one key; new store extends the index', async () => {
  writes.length = 0;
  await S.updateSnapshot('A', (cur) => { cur.status = 'noTab'; });
  assert.deepEqual(writes, [['ksh.snap.A']]);
  await S.updateSnapshot('C', () => snap('C'));
  assert.deepEqual(data[S.SNAP_INDEX], ['A', 'B', 'C']);
  assert.equal((await S.getSnapshots()).A.status, 'noTab');
});
await t('removing a store drops its key and index entry', async () => {
  await S.updateSnapshot('C', () => null);
  assert.equal('ksh.snap.C' in data, false);
  const all = await S.getSnapshots();
  delete all.B;
  await S.setSnapshots(all);
  assert.deepEqual(data[S.SNAP_INDEX], ['A']);
  assert.equal('ksh.snap.B' in data, false);
});
await t('a store changed elsewhere is not skipped by a stale cache', async () => {
  await chrome.storage.local.set({ 'ksh.snap.A': snap('A', [{ id: 'other' }]) }); // another context
  const all = await S.getSnapshots();
  all.A = snap('A'); // worker writes the value it cached earlier → must still be written
  writes.length = 0;
  await S.setSnapshots(all);
  assert.deepEqual(writes, [['ksh.snap.A']]);
  assert.equal(data['ksh.snap.A'].sections.orders.items.length, 0);
});
await t('clearCache removes index, per-store and legacy keys', async () => {
  data['ksh.snapshots'] = {};
  await S.clearCache();
  assert.equal(Object.keys(data).some((k) => k.startsWith('ksh.snap')), false);
  assert.deepEqual(await S.getSnapshots(), {});
});

const DAY = 86400000;
const now = Date.now();
const inv = (id, ts, size = 10, shopId = 'A') => ({ orderId: id, shopId, kind: 'pdf', data: 'x'.repeat(size), ts });
await t('invoices: old ones expire, legacy without ts kept by age', async () => {
  const out = S.pruneInvoiceList([inv('old', now - 40 * DAY), inv('new', now), inv('legacy', undefined)], now);
  assert.deepEqual(out.map((i) => i.orderId), ['new', 'legacy']);
});
await t('invoices: count and byte limits drop the oldest, newest always kept', async () => {
  const lim = { maxAgeDays: 30, maxCount: 2, maxBytes: 10_000 };
  assert.deepEqual(S.pruneInvoiceList([inv('1', now - 3), inv('2', now - 2), inv('3', now - 1)], now, lim).map((i) => i.orderId), ['3', '2']);
  assert.deepEqual(S.pruneInvoiceList([inv('big', now, 50_000), inv('b', now - 1)], now, lim).map((i) => i.orderId), ['big']);
});
await t('addInvoices dedupes, stamps ts and applies limits; pruneInvoices drops a store', async () => {
  data['ksh.invoices'] = [inv('x', now - 40 * DAY), inv('y', now - DAY)];
  await S.addInvoices([{ orderId: 'y', shopId: 'A', kind: 'pdf', data: 'new' }, inv('z', now, 10, 'B')]);
  const list = await S.getInvoices();
  assert.deepEqual(list.map((i) => i.orderId).sort(), ['y', 'z']);
  assert.ok(list.find((i) => i.orderId === 'y').ts >= now);
  assert.equal(await S.pruneInvoices({ dropShops: ['B'] }), 1);
  assert.deepEqual((await S.getInvoices()).map((i) => i.orderId), ['y']);
});

console.log(`\n${n} passed`);
