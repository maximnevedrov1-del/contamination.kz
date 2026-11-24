// Stable API store id / server key: same token → same identity on any computer.
//   node tests/unit/store-key.test.mjs
import assert from 'node:assert/strict';
import { apiTokenHash, apiStoreId, apiStoreIdFromHash, findApiStore, storeKeySeed, storeKey } from '../../shared/store-key.js';

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '-', e.message); }
}

await t('same token gives the same id, whitespace ignored', async () => {
  const a = await apiStoreId('TOKEN-abc');
  assert.equal(a, await apiStoreId('  TOKEN-abc\n'));
  assert.match(a, /^api-[0-9a-f]{16}$/);
});
await t('different tokens give different ids', async () => {
  assert.notEqual(await apiStoreId('TOKEN-abc'), await apiStoreId('TOKEN-abd'));
});
await t('server key is the same for the same token, whatever the (legacy random) id', async () => {
  const h = await apiTokenHash('TOKEN-abc');
  const k1 = await storeKey({ id: 'api-11111111', api: { tokenHash: h } });
  const k2 = await storeKey({ id: 'api-22222222', api: { tokenHash: h } });
  assert.equal(k1, k2);
  assert.match(k1, /^[0-9a-f]{64}$/);
});
await t('tab stores keep the id-based seed; case/space normalised', async () => {
  assert.equal(storeKeySeed({ id: ' ShopA ' }), 'shopa');
  assert.equal(await storeKey({ id: 'ShopA' }), await storeKey({ id: ' shopa ' }));
  assert.equal(await storeKey({ id: '' }), '');
});
await t('API seed differs from the plain-id seed', async () => {
  const h = await apiTokenHash('x');
  assert.notEqual(await storeKey({ id: apiStoreIdFromHash(h), api: { tokenHash: h } }), await storeKey({ id: apiStoreIdFromHash(h) }));
});
await t('dedupe: a known token resolves to the existing store (by tokenHash or derived id)', async () => {
  const h = await apiTokenHash('TOKEN-abc');
  const byHash = { s1: { id: 's1', api: { tokenHash: h } }, s2: { id: 's2' } };
  assert.equal(findApiStore(byHash, h).id, 's1');
  const byId = { [apiStoreIdFromHash(h)]: { id: apiStoreIdFromHash(h), api: {} } };
  assert.equal(findApiStore(byId, h).id, apiStoreIdFromHash(h));
  assert.equal(findApiStore({ s2: { id: 's2' } }, h), null);
});
process.exit(failed ? 1 : 0);
