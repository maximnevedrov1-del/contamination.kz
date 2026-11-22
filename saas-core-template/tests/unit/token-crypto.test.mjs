// Secrets encrypted at rest (AES-GCM, scopeId as additional data) + plain-value migration.
//   node tests/unit/token-crypto.test.mjs
import assert from 'node:assert/strict';

const data = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(k) {
        const keys = Array.isArray(k) ? k : [k];
        return Object.fromEntries(keys.filter((x) => x in data).map((x) => [x, structuredClone(data[x])]));
      },
      async set(o) { Object.assign(data, structuredClone(o)); },
      async remove(k) { (Array.isArray(k) ? k : [k]).forEach((x) => delete data[x]); },
    },
  },
};
const { createSecretStore } = await import('../../extension-core/storage-split.js');
const C = await import('../../extension-core/token-crypto.js');
const KEY = 'app.apiTokens';
const S = createSecretStore({ area: () => chrome.storage.local, key: KEY });
const getApiTokens = () => S.getAll();
const setApiTokens = (v) => S.set(v);

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const TOK = 'secret-token-123';

await t('tokens are stored encrypted, read back plain', async () => {
  await setApiTokens({ A: TOK });
  assert.ok(C.isEncrypted(data[KEY].A));
  assert.ok(!JSON.stringify(data).includes(TOK));
  assert.deepEqual(await getApiTokens(), { A: TOK });
});
await t('each write uses a fresh IV', async () => {
  const a = await C.encryptToken('A', TOK);
  assert.notEqual(a, await C.encryptToken('A', TOK));
});
await t('ciphertext moved to another scope does not decrypt', async () => {
  data[KEY] = { B: data[KEY].A };
  assert.deepEqual(await getApiTokens(), {});
});
await t('damaged value → scope skipped, others still work', async () => {
  data[KEY] = { A: await C.encryptToken('A', TOK), X: 'enc1:AAAA:BBBB' };
  assert.deepEqual(await getApiTokens(), { A: TOK });
});
await t('plain tokens from an older version keep working and get encrypted', async () => {
  data[KEY] = { A: TOK, B: 'other' };
  assert.deepEqual(await getApiTokens(), { A: TOK, B: 'other' });
  assert.ok(C.isEncrypted(data[KEY].A) && C.isEncrypted(data[KEY].B));
  assert.deepEqual(await getApiTokens(), { A: TOK, B: 'other' });
});
await t('migration does not overwrite a token written at the same time', async () => {
  data[KEY] = { A: TOK };
  const read = getApiTokens(); // starts the migration
  await setApiTokens({ A: TOK, C: 'new' });
  await read;
  assert.deepEqual(await getApiTokens(), { A: TOK, C: 'new' });
});
await t('removing a scope removes its token', async () => {
  const tok = await getApiTokens();
  delete tok.C;
  await setApiTokens(tok);
  assert.deepEqual(Object.keys(data[KEY]), ['A']);
});
await t('encryptSecret / decryptSecret are the same primitives', async () => {
  assert.equal(await C.decryptSecret('s', await C.encryptSecret('s', 'v')), 'v');
});

console.log(`\n${n} passed`);
