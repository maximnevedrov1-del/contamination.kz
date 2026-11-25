// Extension side of «Перенести на телефон» (background/spbackup-service.js): the worker reads
// the tokens and encrypts; the file opens with the same shared/spbackup.js the phone app uses.
//   node tests/unit/spbackup-ext.test.mjs
import assert from 'node:assert/strict';

const data = {};
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: 'test' }) },
  storage: {
    onChanged: { addListener() {}, removeListener() {} },
    local: {
      async get(k) {
        const keys = k == null ? Object.keys(data) : Array.isArray(k) ? k : [k];
        return Object.fromEntries(keys.filter((x) => x in data).map((x) => [x, structuredClone(data[x])]));
      },
      async set(o) { Object.assign(data, structuredClone(o)); },
      async remove(k) { (Array.isArray(k) ? k : [k]).forEach((x) => delete data[x]); },
    },
    session: { async get() { return {}; }, async set() {}, async remove() {} },
  },
};
const S = await import('../../shared/storage.js');
const { spbackupHandlers } = await import('../../background/spbackup-service.js');
const { decryptBackup, encryptBackup } = await import('../../shared/spbackup.js');

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const TOK = 'KaspiToken_desktop_123456';
const PASS = 'passphrase-for-phone';
const OWNER = '7f0c3a1e-1111-4a2b-9c3d-1234567890ab';
const connected = [];
const H = spbackupHandlers({ connectApi: async (p) => (connected.push(p), p.token === 'BadToken_zzzzzzzz' ? { ok: false, error: 'apiUnauthorized' } : { ok: true, shopId: 'x' }), lock: (fn) => fn() });

await S.saveSettings({ stores: { 'api-1': { id: 'api-1', name: 'Магазин', color: '#eb6834', api: { connected: true } }, 'tab-1': { id: 'tab-1', name: 'Кабинет' } }, profit: { defaultCommission: 12, byCategory: { A: 5 } } });
await S.setApiTokens({ 'api-1': TOK });
await S.setCosts({ SKU: 1000 });

await t('owner file from the worker opens with the phone app code: stores, tokens, costs, profit', async () => {
  const res = await H['ui:spbackupExport']({ scope: 'owner', passphrase: PASS });
  assert.ok(res.ok);
  assert.match(res.name, /^saudapulse-owner-.*\.spbackup$/);
  assert.ok(!res.file.includes(TOK) && !res.file.includes('Магазин'));
  const { payload } = await decryptBackup(res.file, PASS, { expectScope: 'owner' });
  assert.deepEqual(Object.keys(payload.stores), ['api-1']); // cabinet-tab stores have no token: not exported
  assert.equal(payload.tokens['api-1'], TOK);
  assert.deepEqual(payload.costs, { SKU: 1000 });
  assert.equal(payload.profit.defaultCommission, 12);
});

await t('staff file needs the signed-in owner and carries no cost prices', async () => {
  assert.equal((await H['ui:spbackupExport']({ scope: 'staff', passphrase: PASS })).error, 'backupNoOwner');
  data['ksh.session'] = { access_token: 'x', refresh_token: 'y', expires_at: Date.now() + 1e6, user_id: OWNER };
  const res = await H['ui:spbackupExport']({ scope: 'staff', passphrase: PASS });
  const { payload } = await decryptBackup(res.file, PASS, { expectScope: 'staff' });
  assert.equal(payload.ownerId, OWNER);
  assert.equal(payload.costs, undefined);
  assert.equal(payload.profit, undefined);
});

await t('weak passphrase refused; no stores → clear error', async () => {
  assert.equal((await H['ui:spbackupExport']({ scope: 'owner', passphrase: 'short' })).error, 'backupWeakPassphrase');
  const saved = data['ksh.apiTokens'];
  delete data['ksh.apiTokens'];
  assert.equal((await H['ui:spbackupExport']({ scope: 'owner', passphrase: PASS })).error, 'backupNoStores');
  data['ksh.apiTokens'] = saved;
});

await t('phone → computer: owner file connects stores through the normal connect, merges costs, keeps a set commission', async () => {
  const file = await encryptBackup({ stores: { p1: { name: 'С телефона' }, p2: { name: 'Плохой' } }, tokens: { p1: 'PhoneToken_abcdefgh', p2: 'BadToken_zzzzzzzz' }, costs: { NEW: 50 }, profit: { defaultCommission: null, byCategory: { B: 7 } } }, PASS, { scope: 'owner' });
  const res = await H['ui:spbackupImport']({ text: JSON.stringify(file), passphrase: PASS });
  assert.equal(res.ok, true);
  assert.equal(res.stores, 1);
  assert.equal(res.failed, 1);
  assert.equal(res.failedReason, 'apiUnauthorized');
  assert.deepEqual(connected.map((c) => c.token), ['PhoneToken_abcdefgh', 'BadToken_zzzzzzzz']);
  assert.deepEqual(await S.getCosts(), { SKU: 1000, NEW: 50 });
  const p = (await S.getSettings()).profit;
  assert.equal(p.defaultCommission, 12);
  assert.deepEqual(p.byCategory, { A: 5, B: 7 });
});

await t('import refuses a packer file and a wrong passphrase', async () => {
  const staff = await encryptBackup({ stores: {}, tokens: {}, ownerId: OWNER }, PASS, { scope: 'staff' });
  assert.equal((await H['ui:spbackupImport']({ text: JSON.stringify(staff), passphrase: PASS })).error, 'backupIsStaff');
  const own = await encryptBackup({ stores: {}, tokens: {} }, PASS, { scope: 'owner' });
  assert.equal((await H['ui:spbackupImport']({ text: JSON.stringify(own), passphrase: 'wrong passphrase' })).error, 'backupWrongPassphrase');
  assert.equal((await H['ui:spbackupImport']({ text: 'garbage', passphrase: PASS })).error, 'backupInvalid');
});

console.log(`\n${n} checks passed`);
