// Kaspi API tokens encrypted at rest + migration of plain tokens from older versions.
//   node tests/unit/token-crypto.test.mjs
import assert from 'node:assert/strict';

const data = {};
globalThis.chrome = {
  storage: {
    onChanged: { addListener() {}, removeListener() {} },
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
const S = await import('../../shared/storage.js');
const C = await import('../../shared/token-crypto.js');

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const TOK = 'kaspi-secret-token-123';

await t('tokens are stored encrypted, read back plain', async () => {
  await S.setApiTokens({ A: TOK });
  assert.ok(C.isEncrypted(data['ksh.apiTokens'].A));
  assert.ok(!JSON.stringify(data).includes(TOK));
  assert.deepEqual(await S.getApiTokens(), { A: TOK });
});
await t('each write uses a fresh IV', async () => {
  const a = await C.encryptToken('A', TOK);
  assert.notEqual(a, await C.encryptToken('A', TOK));
});
await t('ciphertext moved to another store does not decrypt', async () => {
  data['ksh.apiTokens'] = { B: data['ksh.apiTokens'].A };
  assert.deepEqual(await S.getApiTokens(), {});
});
await t('damaged value → store skipped, others still work', async () => {
  data['ksh.apiTokens'] = { A: await C.encryptToken('A', TOK), X: 'enc1:AAAA:BBBB' };
  assert.deepEqual(await S.getApiTokens(), { A: TOK });
});
await t('plain tokens from an older version keep working and get encrypted', async () => {
  data['ksh.apiTokens'] = { A: TOK, B: 'other' };
  assert.deepEqual(await S.getApiTokens(), { A: TOK, B: 'other' });
  assert.ok(C.isEncrypted(data['ksh.apiTokens'].A) && C.isEncrypted(data['ksh.apiTokens'].B));
  assert.deepEqual(await S.getApiTokens(), { A: TOK, B: 'other' });
});
await t('migration does not overwrite a token written at the same time', async () => {
  data['ksh.apiTokens'] = { A: TOK };
  const read = S.getApiTokens(); // starts the migration
  await S.setApiTokens({ A: TOK, C: 'new' }); // a store connected meanwhile
  await read;
  assert.deepEqual(await S.getApiTokens(), { A: TOK, C: 'new' });
});
await t('removing a store removes its token', async () => {
  const tok = await S.getApiTokens();
  delete tok.C;
  await S.setApiTokens(tok);
  assert.deepEqual(Object.keys(data['ksh.apiTokens']), ['A']);
});

console.log(`\n${n} passed`);
