// Stateless Kaspi relay (billing/supabase/functions/kaspi-relay) + the phone app's transport
// (shared/kaspi-relay-client.js): URL allowlist, signed-in users only, rate limit, no redirects,
// nothing logged or stored, and background/kaspi-api.js working unchanged through it.
//   node tests/unit/kaspi-relay.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRelay, allowedTarget, createLimiter } from '../../billing/supabase/functions/kaspi-relay/handler.js';
import { installRelayFetch } from '../../shared/kaspi-relay-client.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const DIR = new URL('../../billing/supabase/functions/kaspi-relay/', import.meta.url);
const SB = 'https://proj.supabase.co';
const ORIGIN = 'https://saudapulse.kz';
const KTOKEN = 'KaspiToken_abcdef123456';

// ---- an ES256 key pair standing in for the Supabase project's signing key ----
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pub = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'ES256' };
const b64u = (b) => Buffer.from(b).toString('base64url');
async function jwt(claims, key = pair.privateKey, kid = 'k1') {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid }));
  const body = b64u(JSON.stringify({ iss: `${SB}/auth/v1`, aud: 'authenticated', role: 'authenticated', sub: 'user-1', iat: now, exp: now + 3600, ...claims }));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64u(sig)}`;
}

// ---- a fake Kaspi upstream that records what reached it ----
function upstream(answer = () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/vnd.api+json', 'Set-Cookie': 'sid=1', 'X-Internal': 'x' } })) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url, opts });
    return answer(url, opts);
  };
  return { f, calls };
}
const relay = (up, env = {}) => createRelay({ env: { SUPABASE_URL: SB, ...env }, fetchImpl: up.f, jwks: [pub] });
const call = async (handle, envelope, { auth, origin = ORIGIN, method = 'POST' } = {}) =>
  handle(new Request(`${SB}/functions/v1/kaspi-relay`, {
    method,
    headers: { ...(auth !== null ? { Authorization: `Bearer ${auth ?? (await jwt({}))}` } : {}), ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/json' },
    body: method === 'POST' ? (typeof envelope === 'string' ? envelope : JSON.stringify(envelope)) : undefined,
  }));
const ok = { url: 'https://kaspi.kz/shop/api/v2/orders?page[number]=0', method: 'GET', token: KTOKEN };

// ---- nothing may be logged: every console method throws while the relay runs ----
const consoleBackup = { ...console };
const trapConsole = () => { for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table']) console[m] = () => { throw new Error(`relay called console.${m}`); }; };
const restoreConsole = () => Object.assign(console, consoleBackup);

await t('URL allowlist: only https://kaspi.kz/shop/api/v2|products/…', async () => {
  const yes = ['https://kaspi.kz/shop/api/v2/orders', 'https://kaspi.kz/shop/api/v2/orders/123/entries', 'https://kaspi.kz/shop/api/products/classification/categories', 'https://KASPI.kz/shop/api/v2/orders?x=1'];
  const no = [
    'https://evil.com/shop/api/v2/orders', 'http://kaspi.kz/shop/api/v2/orders', 'https://kaspi.kz.evil.com/shop/api/v2/orders',
    'https://evil.com@kaspi.kz/shop/api/v2/orders', 'https://kaspi.kz@evil.com/shop/api/v2/orders', 'https://user:pw@kaspi.kz/shop/api/v2/orders',
    'https://mc.shop.kaspi.kz/shop/api/v2/orders', 'https://kaspi.kz:8443/shop/api/v2/orders', 'https://kaspi.kz/mc/', 'https://kaspi.kz/',
    'https://kaspi.kz/shop/api/v2/../../../login', 'https://kaspi.kz/shop/api/v2/%2e%2e/%2e%2e/%2e%2e/x', 'https://kaspi.kz/shop/api/v2%2f..%2fx',
    'https://kaspi.kz/shop/api/v2\\..\\..\\x', 'javascript:alert(1)', 'file:///etc/passwd', 'https://127.0.0.1/shop/api/v2/', 'https://kaspi.kz/shop/api/v3/orders',
    'https://kaspi.kz/shop/api/v2/orders#frag', '', null, 42,
  ];
  for (const u of yes) assert.ok(allowedTarget(u), u);
  for (const u of no) assert.equal(allowedTarget(u), null, String(u));
});

await t('any other target → 403, and nothing is fetched', async () => {
  const up = upstream();
  const h = relay(up);
  for (const url of ['https://evil.com/x', 'https://kaspi.kz/shop/api/v2/../../x', 'http://kaspi.kz/shop/api/v2/orders', 'https://idmc.shop.kaspi.kz/api']) {
    const r = await call(h, { ...ok, url });
    assert.equal(r.status, 403, url);
    assert.equal(r.headers.get('X-Relay-Error'), 'target');
  }
  for (const method of ['DELETE', 'PUT', 'PATCH']) assert.equal((await call(h, { ...ok, method })).status, 403);
  assert.equal(up.calls.length, 0);
});

await t('signed-in users only: no token, anon key, wrong signature, expired, other issuer → 401', async () => {
  const up = upstream();
  const h = relay(up);
  const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const anonHs = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.x';
  const cases = [null, '', anonHs, await jwt({ role: 'anon', aud: 'anon' }), await jwt({}, other.privateKey), await jwt({ exp: Math.floor(Date.now() / 1000) - 10 }), await jwt({ iss: 'https://other.supabase.co/auth/v1' }), await jwt({ role: 'service_role' }), await jwt({ is_anonymous: true })];
  for (const a of cases) {
    const r = await call(h, ok, { auth: a });
    assert.equal(r.status, 401, String(a).slice(0, 30));
    assert.equal(r.headers.get('X-Relay-Error'), 'auth');
  }
  assert.equal(up.calls.length, 0);
});

await t('forwarded once with only X-Auth-Token / Accept / Content-Type; no redirect following', async () => {
  const up = upstream();
  const h = relay(up);
  const r = await call(h, ok);
  assert.equal(r.status, 200);
  assert.equal(up.calls.length, 1);
  const { url, opts } = up.calls[0];
  assert.equal(url, 'https://kaspi.kz/shop/api/v2/orders?page[number]=0');
  assert.deepEqual(Object.keys(opts.headers).sort(), ['Accept', 'Content-Type', 'User-Agent', 'X-Auth-Token']);
  assert.equal(opts.headers['X-Auth-Token'], KTOKEN);
  assert.equal(opts.redirect, 'manual');
  assert.equal(opts.credentials, 'omit');
  assert.equal(opts.body, undefined);
});

await t('answer passed back: status, body, Content-Type, Retry-After; Set-Cookie and others dropped; no-store; CORS for our site only', async () => {
  const up = upstream(() => new Response('{"errors":[1]}', { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '3', 'Set-Cookie': 'a=b', 'X-Internal': 'x' } }));
  const r = await call(relay(up), ok);
  assert.equal(r.status, 429);
  assert.equal(await r.text(), '{"errors":[1]}');
  assert.equal(r.headers.get('Retry-After'), '3');
  assert.equal(r.headers.get('Set-Cookie'), null);
  assert.equal(r.headers.get('X-Internal'), null);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(r.headers.get('X-Relay-Error'), null);
});

await t('redirect from upstream → 502 (token never follows a 3xx)', async () => {
  const up = upstream(() => new Response(null, { status: 302, headers: { Location: 'https://evil.com/steal' } }));
  const r = await call(relay(up), ok);
  assert.equal(r.status, 502);
  assert.equal(r.headers.get('X-Relay-Error'), 'redirect');
  assert.equal(up.calls.length, 1);
});

await t('foreign page origin → 403; preflight answers our origin only', async () => {
  const h = relay(upstream());
  assert.equal((await call(h, ok, { origin: 'https://evil.com' })).status, 403);
  const pre = await h(new Request(`${SB}/functions/v1/kaspi-relay`, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } }));
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match(pre.headers.get('Access-Control-Allow-Headers'), /authorization/);
  const h2 = relay(upstream(), { RELAY_ALLOWED_ORIGINS: 'https://saudapulse.kz,http://localhost:8787' });
  assert.equal((await call(h2, ok, { origin: 'http://localhost:8787' })).status, 200);
});

await t('bad envelopes: not JSON, bad token, GET with body, body not a string, too big', async () => {
  const h = relay(upstream());
  assert.equal((await call(h, '{oops')).status, 400);
  assert.equal((await call(h, { ...ok, token: 'has spaces in it' })).status, 400);
  assert.equal((await call(h, { ...ok, token: '' })).status, 400);
  assert.equal((await call(h, { ...ok, body: '{}' })).status, 400);
  assert.equal((await call(h, { ...ok, method: 'POST', body: { a: 1 } })).status, 400);
  assert.equal((await call(h, { ...ok, method: 'POST', body: 'x'.repeat(7 * 1024 * 1024) })).status, 413);
  assert.equal((await call(h, ok, { method: 'GET' })).status, 405);
});

await t('rate limit per user → 429 with Retry-After; other users unaffected', async () => {
  let now = 1_000_000;
  const lim = createLimiter({ perMinute: 3, now: () => now });
  assert.equal(lim('a'), null); assert.equal(lim('a'), null); assert.equal(lim('a'), null);
  assert.ok(lim('a') > 0);
  assert.equal(lim('b'), null);
  now += 60000;
  assert.equal(lim('a'), null);
  const full = createLimiter({ perMinute: 5, maxUsers: 2, now: () => now });
  full('x'); full('y');
  assert.ok(full('z') > 0); // full: newcomer refused, nobody evicted
  assert.equal(full('x'), null);
  const h = relay(upstream(), { RELAY_RATE_PER_MINUTE: '2' });
  assert.equal((await call(h, ok)).status, 200);
  assert.equal((await call(h, ok)).status, 200);
  const r = await call(h, ok);
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('Retry-After')) > 0);
  assert.equal((await call(h, ok, { auth: await jwt({ sub: 'user-2' }) })).status, 200);
});

await t('zero logging at run time: no console call on any path (success, refusal, upstream failure)', async () => {
  trapConsole();
  try {
    const h = relay(upstream());
    await call(h, ok);
    await call(h, { ...ok, url: 'https://evil.com' });
    await call(h, ok, { auth: 'bad' });
    await call(h, '{bad');
    const h2 = relay({ f: async () => { throw new TypeError('network down: ' + KTOKEN); } });
    const r = await call(h2, ok);
    assert.equal(r.status, 502);
    assert.ok(!(await r.text()).includes(KTOKEN)); // the error text (which could hold data) is never echoed
  } finally {
    restoreConsole();
  }
});

await t('zero persistence by construction: no console, database, storage or cache APIs in the relay source', async () => {
  for (const f of ['handler.js', 'index.js', 'worker.js']) {
    const src = fs.readFileSync(new URL(f, DIR), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const bad of [/console\./, /supabase-js|createClient/, /\/rest\/v1/, /Deno\.(openKv|writeFile|writeTextFile|open)\b/, /caches\.|\bKV\b|\.put\(/, /localStorage|indexedDB/, /fetch\([^)]*rest/]) assert.ok(!bad.test(src), `${f}: ${bad}`);
  }
  // relay's licence check = the extension's own verifier, byte for byte
  assert.equal(fs.readFileSync(new URL('license-signature.js', DIR), 'utf8'), fs.readFileSync(new URL('../../shared/license-signature.js', import.meta.url), 'utf8'));
});

await t('JWKS read from the project when not configured (public keys only), refused while unavailable', async () => {
  let jwksCalls = 0;
  const f = async (url) => {
    if (url.endsWith('/.well-known/jwks.json')) return jwksCalls++ === 0 ? new Response('down', { status: 503 }) : new Response(JSON.stringify({ keys: [pub] }), { status: 200 });
    return new Response('{}', { status: 200 });
  };
  const h = createRelay({ env: { SUPABASE_URL: SB }, fetchImpl: f });
  assert.equal((await call(h, ok)).status, 503);
  assert.equal((await call(h, ok)).status, 200);
});

/* ---- the phone app's transport + the extension's own Kaspi client, unchanged ---- */
await t('kaspi-api.js through the relay: token only inside the POST body, never in URL or headers', async () => {
  const seen = [];
  const up = upstream((url) => new Response(JSON.stringify({ data: [{ id: 'o1', attributes: { code: '555', status: 'APPROVED_BY_BANK', state: 'NEW', totalPrice: 9990, creationDate: Date.now() } }], meta: { pageCount: 1 } }), { status: 200, headers: { 'Content-Type': 'application/vnd.api+json' } }));
  const handle = relay(up, { RELAY_ALLOWED_ORIGINS: ORIGIN });
  const userJwt = await jwt({});
  const realFetch = async (input, init) => {
    seen.push({ url: String(input), headers: init.headers, body: init.body });
    const req = new Request(String(input), { method: init.method, headers: { ...init.headers, Origin: ORIGIN }, body: init.body });
    return handle(req);
  };
  const off = installRelayFetch({ relayUrl: `${SB}/functions/v1/kaspi-relay`, anonKey: 'anon', accessToken: async () => userJwt, realFetch });
  try {
    const K = await import('../../background/kaspi-api.js');
    const order = await K.getOrderByCode(KTOKEN, '555');
    assert.equal(order.attributes.code, '555');
    assert.equal(K.toOrderItem(order).status, 'new');
  } finally {
    off();
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `${SB}/functions/v1/kaspi-relay`);
  assert.ok(!seen[0].url.includes(KTOKEN));
  assert.ok(!JSON.stringify(seen[0].headers).includes(KTOKEN));
  const env = JSON.parse(seen[0].body);
  assert.equal(env.token, KTOKEN);
  assert.match(env.url, /^https:\/\/kaspi\.kz\/shop\/api\/v2\/orders\?filter%5Borders%5D%5Bcode%5D=555$/);
  assert.equal(up.calls[0].opts.headers['X-Auth-Token'], KTOKEN);
});

await t('transport: non-Kaspi requests untouched; logged out → no request at all', async () => {
  const seen = [];
  const off = installRelayFetch({ relayUrl: `${SB}/functions/v1/kaspi-relay`, anonKey: 'anon', accessToken: async () => null, realFetch: async (u) => (seen.push(String(u)), new Response('x')) });
  try {
    await fetch(`${SB}/auth/v1/user`);
    assert.deepEqual(seen, [`${SB}/auth/v1/user`]);
    await assert.rejects(fetch('https://kaspi.kz/shop/api/v2/orders', { headers: { 'X-Auth-Token': KTOKEN } }), { code: 'billingLoggedOut' });
    assert.equal(seen.length, 1);
  } finally {
    off();
  }
  assert.throws(() => installRelayFetch({ relayUrl: 'http://evil.com/r', anonKey: 'a', accessToken: async () => 'x' }));
});

console.log(`\n${n} checks passed`);
