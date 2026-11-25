// Phone app storage: AES-GCM encrypted StorageArea (shared/storage-adapter.js), the chrome.storage
// facade that lets shared/storage.js + background/billing.js run unchanged, and .spbackup files.
//   node tests/unit/secure-storage.test.mjs
import assert from 'node:assert/strict';
import { createMemoryBackend, createSecureArea, createMemoryArea, installChromeFacade } from '../../shared/storage-adapter.js';
import { encryptBackup, decryptBackup, readHeader, sanitizePayload, passphraseOk, KDF_ITERATIONS } from '../../shared/spbackup.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const TOKEN = 'KaspiSecretToken_9f8e7d6c5b4a';
const rawText = (backend) => JSON.stringify([...backend._raw].map(([k, v]) => [k, { iv: [...v.iv], ct: Buffer.from(v.ct).toString('latin1') }]));

await t('roundtrip: values come back equal, every record is AES-GCM ciphertext', async () => {
  const backend = createMemoryBackend();
  const area = createSecureArea({ backend });
  const value = { token: TOKEN, orders: [{ id: '123', amount: 45990, buyer: 'Асель' }], n: 1.5, ok: true };
  await area.set({ secret: value, plain: 'hello' });
  assert.deepEqual(await area.get('secret'), { secret: value });
  assert.deepEqual(await area.get(['secret', 'plain', 'missing']), { secret: value, plain: 'hello' });
  assert.deepEqual(await area.get({ missing: 7 }), { missing: 7 });
  const all = await area.get(null);
  assert.deepEqual(Object.keys(all).sort(), ['plain', 'secret']);
  const raw = rawText(backend);
  for (const s of [TOKEN, '45990', 'Асель', 'hello', 'amount']) assert.ok(!raw.includes(s), `plain "${s}" stored`);
  for (const rec of backend._raw.values()) {
    assert.equal(rec.v, 1);
    assert.equal(rec.iv.length, 12);
    assert.ok(rec.ct.length >= 16); // GCM tag
  }
});

await t('the key is a non-extractable AES-GCM 256 CryptoKey', async () => {
  const backend = createMemoryBackend();
  const area = createSecureArea({ backend });
  await area.set({ a: 1 });
  const key = await backend.getKey('kv-v1');
  assert.equal(key.algorithm.name, 'AES-GCM');
  assert.equal(key.algorithm.length, 256);
  assert.equal(key.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('raw', key));
});

await t('fresh IV on every write of the same value', async () => {
  const backend = createMemoryBackend();
  const area = createSecureArea({ backend });
  await area.set({ a: TOKEN });
  const first = backend._raw.get('a');
  await area.set({ a: TOKEN });
  const second = backend._raw.get('a');
  assert.notDeepEqual([...first.iv], [...second.iv]);
  assert.notDeepEqual([...first.ct], [...second.ct]);
});

await t('a record copied under another key name does not decrypt (bound by additional data)', async () => {
  const backend = createMemoryBackend();
  const bad = [];
  const area = createSecureArea({ backend, onUndecryptable: (k) => bad.push(k) });
  await area.set({ 'ksh.apiTokens': { A: TOKEN }, 'ksh.settings': { lang: 'ru' } });
  backend._raw.set('ksh.settings', backend._raw.get('ksh.apiTokens'));
  assert.deepEqual(await area.get('ksh.settings'), {});
  assert.deepEqual(bad, ['ksh.settings']);
});

await t('tampered ciphertext / another phone key → treated as absent, never garbage', async () => {
  const backend = createMemoryBackend();
  const area = createSecureArea({ backend });
  await area.set({ a: { x: 1 } });
  const rec = backend._raw.get('a');
  rec.ct[0] ^= 1;
  assert.deepEqual(await area.get('a'), {});
  const other = createMemoryBackend();
  const area2 = createSecureArea({ backend: other });
  await area2.set({ b: 1 });
  other._raw.set('b', structuredClone((await (async () => { const b2 = createMemoryBackend(); const a3 = createSecureArea({ backend: b2 }); await a3.set({ b: 1 }); return b2._raw.get('b'); })())));
  assert.deepEqual(await area2.get('b'), {});
});

await t('remove / clear / destroy (key deleted → nothing readable)', async () => {
  const backend = createMemoryBackend();
  const changes = [];
  const area = createSecureArea({ backend, onChange: (c) => changes.push(c) });
  await area.set({ a: 1, b: 2, c: 3 });
  await area.remove('a');
  assert.deepEqual(await area.get(null), { b: 2, c: 3 });
  await area.remove(['b']);
  assert.deepEqual(changes.at(-1), { b: { oldValue: 2 } });
  await area.clear();
  assert.deepEqual(await area.get(null), {});
  await area.set({ d: 4 });
  await area.destroy();
  assert.equal(backend._raw.size, 0);
  assert.equal(await backend.getKey('kv-v1'), undefined);
});

await t('writes stay in order (read-modify-write like chrome.storage)', async () => {
  const area = createSecureArea({ backend: createMemoryBackend() });
  await Promise.all(Array.from({ length: 20 }, (_, i) => area.set({ k: i })));
  assert.deepEqual(await area.get('k'), { k: 19 });
});

await t('memory session area: JSON values, defaults, change events', async () => {
  const ev = [];
  const s = createMemoryArea({ onChange: (c, a) => ev.push([c, a]) });
  await s.set({ x: { d: new Date(0) } });
  assert.deepEqual(await s.get('x'), { x: { d: '1970-01-01T00:00:00.000Z' } });
  await s.remove('x');
  assert.equal(ev.length, 2);
  assert.equal(ev[0][1], 'session');
});

/* ---- the extension's own modules on top of the facade (PWA) ---- */
const backend = createMemoryBackend();
const facade = installChromeFacade({ backend, version: '9.9.9', baseUrl: 'https://saudapulse.kz/app/' });
const S = await import('../../shared/storage.js');
const SK = await import('../../shared/store-key.js');

await t('installChromeFacade refuses to replace a real chrome.storage', async () => {
  const saved = globalThis.chrome;
  globalThis.chrome = { storage: { local: {} } };
  assert.throws(() => installChromeFacade({ backend: createMemoryBackend() }), /real chrome.storage/);
  globalThis.chrome = saved;
});

await t('shared/storage.js runs unchanged on the encrypted area: settings, tokens, snapshots', async () => {
  await S.saveSettings({ lang: 'kk', stores: { 'api-1': { id: 'api-1', name: 'Магазин', color: '#2a78d6', enabled: true } } });
  assert.equal((await S.getSettings()).lang, 'kk');
  await S.setApiTokens({ 'api-1': TOKEN });
  assert.deepEqual(await S.getApiTokens(), { 'api-1': TOKEN });
  await S.updateSnapshot('api-1', () => ({ shopId: 'api-1', sections: { orders: { status: 'ok', items: [{ id: '777', amount: 12345 }] } } }));
  assert.equal((await S.getSnapshot('api-1')).sections.orders.items[0].amount, 12345);
  const raw = rawText(backend);
  for (const s of [TOKEN, '12345', 'Магазин', 'ksh-api']) assert.ok(!raw.includes(s), `plain "${s}" in IndexedDB`);
  // the token is double-protected: token-crypto (enc1:) inside the encrypted record
  const stored = await facade.storage.local.get('ksh.apiTokens');
  assert.ok(stored['ksh.apiTokens']['api-1'].startsWith('enc1:'));
});

await t('onKeyChange works through the facade', async () => {
  let seen = null;
  const off = S.onKeyChange(S.KEYS.costs, (v) => (seen = v));
  await S.setCosts({ SKU1: 1000 });
  off();
  assert.deepEqual(seen, { SKU1: 1000 });
});

await t('trial store key = same double SHA-256 as the extension', async () => {
  const h = await SK.apiTokenHash(` ${TOKEN} `);
  const expectHash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ksh-api:${TOKEN}`))).toString('hex');
  assert.equal(h, expectHash);
  const key = await SK.storeKey({ api: { tokenHash: h } });
  const expectKey = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ksh:api:${h}`))).toString('hex');
  assert.equal(key, expectKey);
});

await t('background/billing.js loads on the facade (version read from the facade)', async () => {
  const B = await import('../../background/billing.js');
  assert.equal(typeof B.licenseView, 'function');
  assert.equal(await B.signedIn(), false);
});

/* ---- .spbackup ---- */
const PASS = 'correct horse battery';
const ownerPayload = {
  stores: { 'api-1': { name: 'Магазин 1', color: '#eb6834' }, 'api-2': { name: 'Магазин 2' } },
  tokens: { 'api-1': TOKEN, 'api-2': 'SecondToken_12345678' },
  costs: { SKU1: 1500, BAD: -1 },
  profit: { defaultCommission: 12, byCategory: { Телефоны: 8 } },
  deadlines: { acceptHours: 3, warnHours: 1 },
  ownerId: '7f0c3a1e-1111-4a2b-9c3d-1234567890ab',
};

await t('.spbackup owner: roundtrip, nothing readable in the file', async () => {
  const file = await encryptBackup(ownerPayload, PASS, { scope: 'owner' });
  const text = JSON.stringify(file);
  for (const s of [TOKEN, 'Магазин', '1500', 'SKU1', 'Телефоны']) assert.ok(!text.includes(s));
  assert.equal(file.kdf.iterations, KDF_ITERATIONS);
  const { scope, payload } = await decryptBackup(text, PASS);
  assert.equal(scope, 'owner');
  assert.equal(payload.tokens['api-1'], TOKEN);
  assert.deepEqual(payload.costs, { SKU1: 1500 });
  assert.equal(payload.profit.defaultCommission, 12);
});

await t('.spbackup staff: no cost prices, no profit, owner id required', async () => {
  const file = await encryptBackup(ownerPayload, PASS, { scope: 'staff' });
  const { payload } = await decryptBackup(file, PASS, { expectScope: 'staff' });
  assert.equal(payload.costs, undefined);
  assert.equal(payload.profit, undefined);
  assert.equal(payload.ownerId, ownerPayload.ownerId);
  assert.deepEqual(Object.keys(payload).sort(), ['app', 'ownerId', 'scope', 'stores', 'tokens']);
  await assert.rejects(encryptBackup({ ...ownerPayload, ownerId: null }, PASS, { scope: 'staff' }), { code: 'backupNoOwner' });
  await assert.rejects(decryptBackup(file, PASS, { expectScope: 'owner' }), { code: 'backupIsStaff' });
});

await t('.spbackup: wrong passphrase, edited header (staff→owner, fewer iterations), edited data all fail', async () => {
  const file = await encryptBackup(ownerPayload, PASS, { scope: 'staff' });
  await assert.rejects(decryptBackup(file, 'wrong passphrase!!'), { code: 'backupWrongPassphrase' });
  await assert.rejects(decryptBackup({ ...file, scope: 'owner' }, PASS), { code: 'backupWrongPassphrase' });
  await assert.rejects(decryptBackup({ ...file, kdf: { ...file.kdf, iterations: 1000 } }, PASS), { code: 'backupInvalid' });
  await assert.rejects(decryptBackup({ ...file, createdAt: '2020-01-01T00:00:00.000Z' }, PASS), { code: 'backupWrongPassphrase' });
  const d = file.data;
  await assert.rejects(decryptBackup({ ...file, data: (d[0] === 'A' ? 'B' : 'A') + d.slice(1) }, PASS), { code: 'backupWrongPassphrase' });
  await assert.rejects(decryptBackup('{not json', PASS), { code: 'backupInvalid' });
  await assert.rejects(decryptBackup({ format: 'x' }, PASS), { code: 'backupInvalid' });
});

await t('.spbackup: weak passphrase refused; header readable without passphrase', async () => {
  assert.equal(passphraseOk('short'), false);
  await assert.rejects(encryptBackup(ownerPayload, 'short', { scope: 'owner' }), { code: 'backupWeakPassphrase' });
  const f = await encryptBackup(ownerPayload, PASS, { scope: 'owner' });
  assert.equal(readHeader(f).scope, 'owner');
});

await t('sanitizePayload drops junk ids, bad tokens and prototype tricks', async () => {
  const p = sanitizePayload({ stores: { '../x': { name: 'x' }, ok: { name: 'Ok', color: 'red' } }, tokens: { ok: 'bad token with spaces' }, costs: { a: 'x' } }, 'owner');
  assert.deepEqual(Object.keys(p.stores), ['ok']);
  assert.equal(p.stores.ok.color, '#2a78d6');
  assert.deepEqual(p.tokens, {});
  assert.deepEqual(p.costs, {});
});

console.log(`\n${n} checks passed`);
