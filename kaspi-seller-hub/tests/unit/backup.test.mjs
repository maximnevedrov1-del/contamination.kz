// Local backup: export → import round trip (orders, costs, settings), secrets never exported or overwritten.
//   node tests/unit/backup.test.mjs
import assert from 'node:assert/strict';

const data = {};
globalThis.chrome = {
  runtime: { id: 'test', getURL: (p) => `chrome-extension://test/${p}`, getManifest: () => ({ version: '0.0.0' }), onMessage: { addListener() {} } },
  alarms: { create() {}, clear: async () => true, get: async () => null },
  storage: {
    onChanged: { addListener() {}, removeListener() {} },
    session: { async get() { return {}; }, async set() {}, async remove() {} },
    local: {
      async get(k) {
        const keys = k == null ? Object.keys(data) : Array.isArray(k) ? k : typeof k === 'object' ? Object.keys(k) : [k];
        return Object.fromEntries(keys.filter((x) => x in data).map((x) => [x, structuredClone(data[x])]));
      },
      async set(o) { for (const [k, v] of Object.entries(o)) data[k] = structuredClone(v); },
      async remove(k) { for (const x of Array.isArray(k) ? k : [k]) delete data[x]; },
    },
  },
};
const S = await import('../../shared/storage.js');
const { catalogHandlers } = await import('../../background/catalog-service.js');
const H = catalogHandlers({ allowedShopIds: async () => null });

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const snap = (id, codes) => ({ shopId: id, shopName: id, ts: 1, status: 'ok', sections: { orders: { status: 'ok', items: codes.map((code) => ({ code })) } }, missingSelectors: [] });

const settings = await S.getSettings();
await S.saveSettings({ theme: 'dark', stores: { A: { ...(settings.stores?.A || {}), id: 'A', name: 'Shop A', enabled: true, alias: 'Alpha', color: '#112233' } } });
await S.setCosts({ 'SKU-1': 1500 });
await S.setSnapshots({ A: snap('A', ['101', '102']) });
data['ksh.apiTokens'] = { A: 'enc1:secret' };
data['ksh.session'] = { access_token: 'sess' };
data['ksh.license'] = { token: 'lic' };

let backup;
await t('export contains orders, costs, settings and no secrets', async () => {
  const r = await H['ui:backupExport']();
  assert.equal(r.ok, true);
  backup = JSON.parse(JSON.stringify(r.backup));
  assert.equal(backup.version, 1);
  assert.equal(backup.snapshots.A.sections.orders.items.length, 2);
  assert.equal(backup.costs['SKU-1'], 1500);
  assert.equal(backup.settings.theme, 'dark');
  const text = JSON.stringify(backup);
  for (const s of ['enc1:secret', 'sess', '"lic"', 'apiTokens', 'access_token']) assert.ok(!text.includes(s), `leaked ${s}`);
});

await t('import into an empty profile restores orders and costs, keeps secrets', async () => {
  await S.setSnapshots({});
  await S.setCosts({});
  data['ksh.apiTokens'] = { A: 'enc1:new' };
  const r = await H['ui:backupImport']({ backup });
  assert.equal(r.ok, true);
  assert.equal((await S.getSnapshots()).A.sections.orders.items.length, 2);
  assert.equal((await S.getCosts())['SKU-1'], 1500);
  assert.deepEqual(data['ksh.apiTokens'], { A: 'enc1:new' });
  assert.deepEqual(data['ksh.license'], { token: 'lic' });
});

await t('existing orders are not overwritten', async () => {
  await S.setSnapshots({ A: snap('A', ['999']) });
  await H['ui:backupImport']({ backup });
  assert.deepEqual((await S.getSnapshots()).A.sections.orders.items.map((o) => o.code), ['999']);
});

await t('invalid files are rejected', async () => {
  for (const bad of [null, {}, { app: 'other', version: 1 }, { app: 'kaspi-seller-hub', version: 2 }]) {
    assert.equal((await H['ui:backupImport']({ backup: bad })).ok, false);
  }
});

await t('malformed snapshots are skipped', async () => {
  await S.setSnapshots({});
  await H['ui:backupImport']({ backup: { ...backup, snapshots: { A: { sections: 'x' } } } });
  assert.equal((await S.getSnapshots()).A, undefined);
});

await t('reserved keys (__proto__, constructor) are not imported as skus', async () => {
  const evil = JSON.parse('{"app":"kaspi-seller-hub","version":1,"catalog":{"x":{"sku":"__proto__","title":"t","brand":"b","price":100,"stock":1},"y":{"sku":"constructor","title":"t","brand":"b","price":100,"stock":1}}}');
  const r = await H['ui:backupImport']({ backup: evil });
  assert.equal(r.ok, true);
  assert.equal(r.products, 0);
  assert.equal(({}).title, undefined);
  assert.equal(Object.keys(await S.getCatalog()).includes('__proto__'), false);
});

await t('quota failure on a write is reported, not ok:true', async () => {
  const realSet = chrome.storage.local.set;
  chrome.storage.local.set = async () => { const e = new Error('QUOTA_BYTES quota exceeded'); e.name = 'QuotaExceededError'; throw e; };
  try {
    const r = await H['ui:backupImport']({ backup });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'quota');
  } finally { chrome.storage.local.set = realSet; }
});

console.log(`${n} passed`);
