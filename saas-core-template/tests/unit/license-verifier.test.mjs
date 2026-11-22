// license-signature.js on its own: ES256 verification rules.
//   node tests/unit/license-verifier.test.mjs
import assert from 'node:assert/strict';
import { createLicenseVerifier } from '../../extension-core/license-signature.js';

const ISS = 'https://x.supabase.co/auth/v1';
const gen = () => crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const A = await gen();
const B = await gen();
const jwkA = { ...(await crypto.subtle.exportKey('jwk', A.publicKey)), kid: 'k1', alg: 'ES256' };
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const claims = { iss: ISS, sub: 'u1', aud: 'authenticated', iat: now, exp: now + 3600, app: { sl: 1 } };
async function jwt(c = claims, { key = A.privateKey, header = { alg: 'ES256', kid: 'k1' } } = {}) {
  const head = `${enc(header)}.${enc(c)}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(head));
  return `${head}.${Buffer.from(sig).toString('base64url')}`;
}
const v = createLicenseVerifier({ keys: [jwkA], issuer: ISS });

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };

await t('valid token → claims; required() true', async () => {
  assert.equal(v.required(), true);
  assert.deepEqual((await v.verifiedClaims(await jwt(), 'u1')).app, { sl: 1 });
});
await t('foreign signature, tampered payload, wrong sub/iss/aud → null', async () => {
  assert.equal(await v.verifiedClaims(await jwt(claims, { key: B.privateKey })), null);
  const good = (await jwt()).split('.');
  assert.equal(await v.verifiedClaims(`${good[0]}.${enc({ ...claims, app: { sl: 99 } })}.${good[2]}`), null);
  assert.equal(await v.verifiedClaims(await jwt(), 'someone-else'), null);
  assert.equal(await v.verifiedClaims(await jwt({ ...claims, iss: 'https://evil/auth/v1' })), null);
  assert.equal(await v.verifiedClaims(await jwt({ ...claims, aud: 'anon' })), null);
  assert.equal(await v.verifiedClaims(await jwt({ ...claims, exp: undefined })), null);
});
await t('alg none / HS256 / garbage → null', async () => {
  assert.equal(await v.verifiedClaims(`${enc({ alg: 'none' })}.${enc(claims)}.`), null);
  assert.equal(await v.verifiedClaims(await jwt(claims, { header: { alg: 'HS256' } })), null);
  assert.equal(await v.verifiedClaims('nope'), null);
  assert.equal(await v.verifiedClaims(null), null);
});
await t('private JWK is never used; no keys → required() false', async () => {
  const priv = { ...(await crypto.subtle.exportKey('jwk', A.privateKey)), kid: 'k1', alg: 'ES256' };
  assert.equal(await createLicenseVerifier({ keys: [priv], issuer: ISS }).verifiedClaims(await jwt()), null);
  assert.equal(createLicenseVerifier({ keys: [], issuer: ISS }).required(), false);
});
await t('keys / issuer may be lazy functions', async () => {
  const lazy = createLicenseVerifier({ keys: () => [jwkA], issuer: () => ISS });
  assert.ok(await lazy.verifiedClaims(await jwt()));
});

console.log(`\n${n} passed`);
