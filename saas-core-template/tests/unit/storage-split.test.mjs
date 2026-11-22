// Generic storage split: one key per record + index, only changed records written, quota safety.
//   node tests/unit/storage-split.test.mjs
import assert from 'node:assert/strict';
import { createSplitCollection, createSecretStore, safeSet, getStorageHealth, fingerprint } from '../../extension-core/storage-split.js';

const data = {};
const writes = [];
let failNext = null;
globalThis.chrome = {
  storage: {
    local: {
      async get(k) {
        const keys = k == null ? Object.keys(data) : Array.isArray(k) ? k : [k];
        return Object.fromEntries(keys.filter((x) => x in data).map((x) => [x, structuredClone(data[x])]));
      },
      async set(o) {
        if (failNext) throw failNext;
        writes.push(Object.keys(o).sort());
        for (const [k, v] of Object.entries(o)) data[k] = structuredClone(v);
      },
      async remove(k) { for (const x of Array.isArray(k) ? k : [k]) delete data[x]; },
    },
  },
};
const area = () => chrome.storage.local;
const col = createSplitCollection({ area, indexKey: 'app.itemIndex', prefix: 'app.item.' });

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const rec = (id, v = 0) => ({ id, v });

await t('setAll writes one key per record plus the index', async () => {
  await col.setAll({ A: rec('A'), B: rec('B') });
  assert.deepEqual(data['app.itemIndex'], ['A', 'B']);
  assert.ok(data['app.item.A'] && data['app.item.B']);
  assert.deepEqual(Object.keys(await col.getAll()), ['A', 'B']);
});
await t('changing one record writes only that record', async () => {
  writes.length = 0;
  const all = await col.getAll();
  all.B.v = 1;
  await col.setAll(all);
  assert.deepEqual(writes, [['app.item.B']]);
});
await t('unchanged write writes nothing', async () => {
  writes.length = 0;
  await col.setAll(await col.getAll());
  assert.deepEqual(writes, []);
});
await t('update touches one key; a new id extends the index', async () => {
  writes.length = 0;
  await col.update('A', (cur) => { cur.v = 5; });
  assert.deepEqual(writes, [['app.item.A']]);
  await col.update('C', () => rec('C'));
  assert.deepEqual(data['app.itemIndex'], ['A', 'B', 'C']);
  assert.equal((await col.get('A')).v, 5);
});
await t('removing drops the key and the index entry', async () => {
  await col.update('C', () => null);
  assert.equal('app.item.C' in data, false);
  const all = await col.getAll();
  delete all.B;
  await col.setAll(all);
  assert.deepEqual(data['app.itemIndex'], ['A']);
  assert.equal('app.item.B' in data, false);
});
await t('a record changed elsewhere is not skipped by a stale fingerprint cache', async () => {
  await chrome.storage.local.set({ 'app.item.A': rec('A', 99) });
  const all = await col.getAll();
  all.A = rec('A', 5); // cached earlier → must still be written
  writes.length = 0;
  await col.setAll(all);
  assert.deepEqual(writes, [['app.item.A']]);
  assert.equal(data['app.item.A'].v, 5);
});
await t('clear removes index and records', async () => {
  await col.clear();
  assert.equal(Object.keys(data).some((k) => k.startsWith('app.item')), false);
  assert.deepEqual(await col.getAll(), {});
});
await t('fingerprint is stable and sensitive', () => {
  assert.equal(fingerprint({ a: 1 }), fingerprint({ a: 1 }));
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
});

const quota = () => Object.assign(new Error('QUOTA_BYTES quota exceeded'), { name: 'QuotaExceededError' });
await t('quota failure: {ok:false, kind:quota}, old data stays, health reports it', async () => {
  await col.setAll({ A: rec('A', 1) });
  assert.deepEqual(getStorageHealth(), { ok: true });
  const warn = console.warn; console.warn = () => {};
  try {
    failNext = quota();
    const before = structuredClone(data);
    const r = await col.setAll({ A: rec('A', 2), Z: rec('Z') });
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'quota');
    assert.equal(getStorageHealth().ok, false);
    assert.deepEqual(data, before);
    assert.equal((await safeSet(area, { x: 1 }, 'x')).ok, false);
  } finally { failNext = null; console.warn = warn; }
  assert.deepEqual(await safeSet(area, { x: 1 }, 'x'), { ok: true });
});

const secrets = createSecretStore({ area, key: 'app.secrets' });
await t('secret store: encrypted at rest, plain on read', async () => {
  await secrets.set({ W1: 'tok-1' });
  assert.ok(data['app.secrets'].W1.startsWith('enc1:'));
  assert.ok(!JSON.stringify(data).includes('tok-1'));
  assert.deepEqual(await secrets.getAll(), { W1: 'tok-1' });
});
await t('secret store: plain legacy values are read and re-encrypted', async () => {
  data['app.secrets'] = { W1: 'plain', W2: 'plain2' };
  assert.deepEqual(await secrets.getAll(), { W1: 'plain', W2: 'plain2' });
  assert.ok(data['app.secrets'].W1.startsWith('enc1:') && data['app.secrets'].W2.startsWith('enc1:'));
});

console.log(`\n${n} passed`);
