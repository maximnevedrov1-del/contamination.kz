// Signed licence (billing/README.md, step 7): ES256 verification and DevTools tampering.
//   node tests/unit/license-signature.test.mjs
// Copies background/billing.js next to a generated billing-config.js (test key pair),
// so the real verification code runs against tokens signed here.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const URL_ = 'https://test-project.supabase.co';
const ISS = `${URL_}/auth/v1`;

const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pub = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1', alg: 'ES256' };
const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);

const dir = mkdtempSync(path.join(tmpdir(), 'ksh-lic-'));
mkdirSync(path.join(dir, 'background'));
mkdirSync(path.join(dir, 'shared'));
writeFileSync(path.join(dir, 'background/billing.js'), readFileSync(path.join(ROOT, 'background/billing.js')));
const cfg = readFileSync(path.join(ROOT, 'shared/billing-config.js'), 'utf8')
  .replace(/supabaseUrl: '[^']*'/, `supabaseUrl: '${URL_}'`)
  .replace(/supabaseAnonKey: '[^']*'/, "supabaseAnonKey: 'anon'")
  .replace('licenseKeys: []', `licenseKeys: [${JSON.stringify(pub)}]`);
writeFileSync(path.join(dir, 'shared/billing-config.js'), cfg);

const store = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(k) {
        const keys = Array.isArray(k) ? k : [k];
        return Object.fromEntries(keys.filter((x) => x in store).map((x) => [x, structuredClone(store[x])]));
      },
      async set(o) { Object.assign(store, structuredClone(o)); },
      async remove(k) { (Array.isArray(k) ? k : [k]).forEach((x) => delete store[x]); },
    },
  },
  runtime: { getURL: (p) => p },
};
globalThis.fetch = async () => { throw new Error('network must not be used in this test'); };

const B = await import(pathToFileURL(path.join(dir, 'background/billing.js')).href);
const { BILLING } = await import(pathToFileURL(path.join(dir, 'shared/billing-config.js')).href);

const enc = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
async function jwt(claims, { key = privateKey, header = { alg: 'ES256', kid: 'k1', typ: 'JWT' } } = {}) {
  const head = `${enc(header)}.${enc(claims)}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(head));
  return `${head}.${Buffer.from(sig).toString('base64url')}`;
}
const now = Math.floor(Date.now() / 1000);
const DAY = 86400;
const base = { iss: ISS, sub: 'u1', aud: 'authenticated', iat: now, exp: now + 3600, ksh: { pu: now - DAY, te: null, sl: 1, tsl: 1 } };

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };

await t('valid ES256 token is accepted', async () => assert.equal((await B.verifiedClaims(await jwt(base), 'u1'))?.sub, 'u1'));
await t('edited payload (paid_until moved) is rejected', async () => {
  const [h, , s] = (await jwt(base)).split('.');
  const forged = { ...base, ksh: { ...base.ksh, pu: now + 365 * DAY } };
  assert.equal(await B.verifiedClaims(`${h}.${enc(forged)}.${s}`, 'u1'), null);
});
await t('token signed by another key is rejected', async () => assert.equal(await B.verifiedClaims(await jwt(base, { key: other.privateKey }), 'u1'), null));
await t('alg "none" is rejected', async () => assert.equal(await B.verifiedClaims(`${enc({ alg: 'none' })}.${enc(base)}.`, 'u1'), null));
await t('HS256 is rejected', async () => {
  const [, p, s] = (await jwt(base)).split('.');
  assert.equal(await B.verifiedClaims(`${enc({ alg: 'HS256' })}.${p}.${s}`, 'u1'), null);
});
await t('wrong issuer / user / audience rejected', async () => {
  assert.equal(await B.verifiedClaims(await jwt({ ...base, iss: 'https://evil.supabase.co/auth/v1' }), 'u1'), null);
  assert.equal(await B.verifiedClaims(await jwt(base), 'u2'), null);
  assert.equal(await B.verifiedClaims(await jwt({ ...base, aud: 'anon' }), 'u1'), null);
  const { exp, ...noExp } = base;
  assert.equal(await B.verifiedClaims(await jwt(noExp), 'u1'), null);
});
await t('DER/oversized signature rejected', async () => {
  const [h, p] = (await jwt(base)).split('.');
  assert.equal(await B.verifiedClaims(`${h}.${p}.${Buffer.alloc(72).toString('base64url')}`, 'u1'), null);
});
await t('licenseKeys cannot be extended at runtime', async () => {
  assert.throws(() => BILLING.licenseKeys.push({ kty: 'EC' }));
  assert.throws(() => { BILLING.licenseKeys[0].x = 'x'; });
});

await t('DevTools: editing cached licence does not extend an expired subscription', async () => {
  store['ksh.session'] = { access_token: await jwt(base), user_id: 'u1', email: 'a@b.c', expires_at: now + 3600 };
  const far = new Date(Date.now() + 365 * DAY * 1000).toISOString();
  store['ksh.license'] = { data: { paid_until: far, trial_ends_at: far, paid_store_limit: 99, store_limit: 99 }, fetchedAt: Date.now() - 60000, skew: 0 };
  const v = await B.licenseView();
  assert.equal(v.status, 'expired');
  assert.equal(v.canUse, false);
});
await t('DevTools: forged token in storage → invalid', async () => {
  const [h, , s] = (await jwt(base)).split('.');
  store['ksh.session'].access_token = `${h}.${enc({ ...base, ksh: { pu: now + 365 * DAY, sl: 99 } })}.${s}`;
  const v = await B.licenseView();
  assert.equal(v.status, 'invalid');
  assert.equal(v.canUse, false);
});
await t('genuine paid token → active', async () => {
  store['ksh.session'].access_token = await jwt({ ...base, ksh: { pu: now + 30 * DAY, sl: 3, tsl: 1 } });
  const v = await B.licenseView();
  assert.equal(v.status, 'active');
  assert.equal(v.storeLimit, 3);
});

console.log(`\n${n} passed`);
