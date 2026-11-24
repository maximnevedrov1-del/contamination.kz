// Licence flow: session refresh, server errors, offline cache, statuses from the signed token.
//   node tests/unit/license-flow.test.mjs
// Copies background/billing.js next to a generated billing-config.js (test key pair) and
// answers fetch() from a scripted queue, so the real code runs without a server.
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

const dir = mkdtempSync(path.join(tmpdir(), 'ksh-flow-'));
mkdirSync(path.join(dir, 'background'));
mkdirSync(path.join(dir, 'shared'));
writeFileSync(path.join(dir, 'background/billing.js'), readFileSync(path.join(ROOT, 'background/billing.js')));
writeFileSync(path.join(dir, 'shared/license-signature.js'), readFileSync(path.join(ROOT, 'shared/license-signature.js')));
const cfg = readFileSync(path.join(ROOT, 'shared/billing-config.js'), 'utf8')
  .replace(/supabaseUrl: '[^']*'/, `supabaseUrl: '${URL_}'`)
  .replace(/supabaseAnonKey: '[^']*'/, "supabaseAnonKey: 'anon'")
  .replace(/^  licenseKeys: \[[^\]]*\]/m, `licenseKeys: [${JSON.stringify(pub)}]`);
writeFileSync(path.join(dir, 'shared/billing-config.js'), cfg);

let store = {};
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
    session: { async remove() {} },
  },
  runtime: { getURL: (p) => p },
};

// Scripted server: each route answers from its queue (status, body) or throws (no network).
let routes = {};
let calls = [];
let sent = [];
globalThis.fetch = async (url, opts) => {
  const route = Object.keys(routes).find((r) => String(url).includes(r));
  calls.push(route || String(url));
  sent.push(opts?.body ? JSON.parse(opts.body) : null);
  const next = route && routes[route].shift();
  if (!next) throw new Error(`unexpected request ${url}`);
  if (next === 'offline') throw new TypeError('Failed to fetch');
  const [status, body] = next;
  return { ok: status >= 200 && status < 300, status, text: async () => (body == null ? '' : JSON.stringify(body)) };
};
const TOKEN = '/auth/v1/token';
const LIC = '/rest/v1/rpc/get_license';

const B = await import(pathToFileURL(path.join(dir, 'background/billing.js')).href);

const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
async function jwt(claims) {
  const head = `${enc({ alg: 'ES256', kid: 'k1', typ: 'JWT' })}.${enc(claims)}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(head));
  return `${head}.${Buffer.from(sig).toString('base64url')}`;
}
const now = Math.floor(Date.now() / 1000);
const DAY = 86400;
const MS_DAY = DAY * 1000;
const claims = (ksh, extra = {}) => ({ iss: ISS, sub: 'u1', aud: 'authenticated', iat: now, exp: now + 3600, ksh, ...extra });

/** Signed-in seller; `expiresIn` ms until the access token expires. */
async function signIn({ expiresIn = 3600000, ksh = { pu: now + 30 * DAY, sl: 3, tsl: 1 }, extra } = {}) {
  store['ksh.session'] = { access_token: await jwt(claims(ksh, extra)), refresh_token: 'r1', user_id: 'u1', email: 'a@b.c', expires_at: Date.now() + expiresIn };
}
const cacheLicence = (data, ageMs) => { store['ksh.license'] = { data, fetchedAt: Date.now() - ageMs, skew: 0 }; };
const LICENCE = { status: 'active', paid_store_limit: 3, store_limit: 3 };
const fresh = async (ksh = { pu: now + 30 * DAY, sl: 3, tsl: 1 }) => ({ access_token: await jwt(claims(ksh)), refresh_token: 'r2', expires_in: 3600, user: { id: 'u1', email: 'a@b.c' } });

let n = 0;
const t = async (name, fn) => {
  store = {}; routes = {}; calls = []; sent = [];
  await fn();
  n++;
  console.log('ok', name);
};

// ---------- session refresh: only a refused refresh token logs out ----------
await t('refresh answers 503, token still valid → licence fetched, still signed in', async () => {
  await signIn({ expiresIn: 30000 }); // < 60 s left → refresh is attempted
  routes = { [TOKEN]: [[503, { message: 'upstream' }]], [LIC]: [[200, LICENCE]] };
  assert.deepEqual(await B.getLicense({ force: true }), LICENCE);
  assert.ok(store['ksh.session'], 'session kept');
});
for (const [label, answer] of [['503', [503, { message: 'down' }]], ['429', [429, { message: 'slow down' }]], ['no network', 'offline']]) {
  await t(`refresh ${label}, token expired → cached licence (1 day old), still signed in`, async () => {
    await signIn({ expiresIn: -1000 });
    cacheLicence(LICENCE, MS_DAY);
    routes = { [TOKEN]: [answer] };
    assert.deepEqual(await B.getLicense({ force: true }), LICENCE);
    assert.ok(store['ksh.session'], 'session kept');
    assert.ok(!calls.includes(LIC), 'no licence call with an expired token');
  });
}
await t('refresh down and cache older than offlineGraceDays → error, still signed in', async () => {
  await signIn({ expiresIn: -1000 });
  cacheLicence(LICENCE, 4 * MS_DAY);
  routes = { [TOKEN]: [[502, null]] };
  await assert.rejects(B.getLicense({ force: true }), (e) => e.code === 'billingNetwork');
  assert.ok(store['ksh.session'], 'session kept');
});
for (const status of [400, 401, 403]) {
  await t(`refresh refused (${status}) → logged out`, async () => {
    await signIn({ expiresIn: -1000 });
    cacheLicence(LICENCE, MS_DAY);
    routes = { [TOKEN]: [[status, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' }]] };
    assert.equal(await B.getLicense({ force: true }), null);
    assert.equal(store['ksh.session'], undefined);
    assert.equal(store['ksh.license'], undefined);
  });
}

// ---------- 401 on the licence call ----------
await t('get_license 401 → token refreshed once → retry succeeds', async () => {
  await signIn();
  const s = await fresh();
  routes = { [LIC]: [[401, { message: 'JWT expired' }], [200, LICENCE]], [TOKEN]: [[200, s]] };
  assert.deepEqual(await B.getLicense({ force: true }), LICENCE);
  assert.equal(store['ksh.session'].access_token, s.access_token);
});
await t('get_license 401 again after a fresh token → logged out', async () => {
  await signIn();
  routes = { [LIC]: [[401, {}], [401, {}]], [TOKEN]: [[200, await fresh()]] };
  assert.equal(await B.getLicense({ force: true }), null);
  assert.equal(store['ksh.session'], undefined);
});
await t('get_license 401 while Auth is down → cached licence, still signed in', async () => {
  await signIn();
  cacheLicence(LICENCE, MS_DAY);
  routes = { [LIC]: [[401, {}]], [TOKEN]: [[503, null]] };
  assert.deepEqual(await B.getLicense({ force: true }), LICENCE);
  assert.ok(store['ksh.session'], 'session kept');
});

// ---------- cache ----------
await t('get_license 500 → cached licence within offlineGraceDays', async () => {
  await signIn();
  cacheLicence(LICENCE, 2 * MS_DAY);
  routes = { [LIC]: [[500, { message: 'boom' }]] };
  assert.deepEqual(await B.getLicense({ force: true }), LICENCE);
});
await t('get_license 500 and no usable cache → error', async () => {
  await signIn();
  cacheLicence(LICENCE, 4 * MS_DAY);
  routes = { [LIC]: [[500, { message: 'boom' }]] };
  await assert.rejects(B.getLicense({ force: true }), (e) => e.code === 'billingHttp' && e.status === 500);
});
await t('recent cache → no request at all', async () => {
  await signIn();
  cacheLicence(LICENCE, 60000);
  assert.deepEqual(await B.getLicense(), LICENCE);
  assert.equal(calls.length, 0);
});
await t('cache «from the future» (edited by hand) is not trusted', async () => {
  await signIn();
  cacheLicence({ ...LICENCE, paid_store_limit: 99 }, -10 * 60000);
  routes = { [LIC]: [[200, LICENCE]] };
  assert.deepEqual(await B.getLicense(), LICENCE);
  assert.deepEqual(calls, [LIC]);
});
await t('store keys are sent with the licence call', async () => {
  await signIn();
  let body;
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => { body = JSON.parse(init.body); return { ok: true, status: 200, text: async () => JSON.stringify(LICENCE) }; };
  try {
    await B.getLicense({ force: true, storeCount: 2, storeKeys: ['a'.repeat(64)] });
  } finally {
    globalThis.fetch = orig;
  }
  assert.deepEqual(body, { p_store_count: 2, p_store_keys: ['a'.repeat(64)] });
});

// ---------- statuses from the signed token (cache 1 min old: no network) ----------
async function view(ksh, { lic = {}, extra } = {}) {
  await signIn({ ksh, extra });
  cacheLicence({ pricing: { base_stores: 3 }, ...lic }, 60000);
  return B.licenseView();
}
await t('trial → canUse, trial store limit', async () => {
  const v = await view({ te: now + 10 * DAY, sl: 1, tsl: 3 });
  assert.equal(v.status, 'trial');
  assert.equal(v.canUse, true);
  assert.equal(v.storeLimit, 3);
});
await t('paid period over, grace until in the future → grace, full access', async () => {
  const v = await view({ pu: now - DAY, gu: now + 3 * DAY, sl: 3, tsl: 1 });
  assert.equal(v.status, 'grace');
  assert.equal(v.canUse, true);
  assert.equal(v.storeLimit, 3);
  assert.equal(v.renewalDue, true);
});
await t('frozen → no access, limit 0, paid days kept', async () => {
  const v = await view({ pu: now + 20 * DAY, fu: now + 5 * DAY, sl: 3, tsl: 1 });
  assert.equal(v.status, 'frozen');
  assert.equal(v.canUse, false);
  assert.equal(v.storeLimit, 0);
});
await t('nothing left → expired', async () => {
  const v = await view({ pu: now - 10 * DAY, te: now - 40 * DAY, sl: 3, tsl: 1 });
  assert.equal(v.status, 'expired');
  assert.equal(v.canUse, false);
});
await t('new offer version not accepted → needsConsent, no access', async () => {
  const v = await view({ pu: now + 30 * DAY, sl: 3, tsl: 1, tv: '2026-11-16', tr: '2026-11-21' });
  assert.equal(v.needsConsent, true);
  assert.equal(v.canUse, false);
});
await t('clock turned back far behind the token → clock', async () => {
  const v = await view({ pu: now + 30 * DAY, sl: 3 }, { extra: { iat: now + 3600, exp: now + 7200 } });
  assert.equal(v.status, 'clock');
  assert.equal(v.canUse, false);
});
await t('token expired more than offlineGraceDays ago → offline', async () => {
  const v = await view({ pu: now + 30 * DAY, sl: 3 }, { extra: { iat: now - 5 * DAY, exp: now - 4 * DAY } });
  assert.equal(v.status, 'offline');
  assert.equal(v.canUse, false);
});
await t('token expired 1 day ago (offline) → still works', async () => {
  const v = await view({ pu: now + 30 * DAY, sl: 3 }, { extra: { iat: now - 2 * DAY, exp: now - DAY } });
  assert.equal(v.status, 'active');
  assert.equal(v.canUse, true);
});
await t('stores in use on another computer reduce the limit', async () => {
  const v = await view({ pu: now + 30 * DAY, sl: 3, tsl: 1 }, { lic: { shared_stores: 1 } });
  assert.equal(v.storeLimit, 2);
  assert.equal(v.sharedStores, 1);
});
await t('server down and no cache → offline view, still signed in', async () => {
  await signIn();
  routes = { [LIC]: ['offline'] };
  const v = await B.licenseView({ force: true });
  assert.equal(v.status, 'offline');
  assert.ok(store['ksh.session'], 'session kept');
});

// ---------- captcha on the e-mail code request ----------
const OTP = '/auth/v1/otp';
await t('code request with a captcha token → sent as gotrue_meta_security.captcha_token', async () => {
  routes = { [OTP]: [[200, {}]] };
  await B.requestCode(' A@B.kz ', 'tok_1234567890', 'kk');
  assert.deepEqual(sent[0], { email: 'a@b.kz', create_user: true, data: { lang: 'kk' }, gotrue_meta_security: { captcha_token: 'tok_1234567890' } });
});
await t('code request without a token (captcha off / page down) → plain body', async () => {
  routes = { [OTP]: [[200, {}]] };
  await B.requestCode('a@b.kz', null);
  assert.deepEqual(sent[0], { email: 'a@b.kz', create_user: true, data: { lang: 'ru' } }, 'no language → Russian');
});
await t('Supabase refuses the captcha → billingCaptcha', async () => {
  routes = { [OTP]: [[400, { code: 400, error_code: 'captcha_failed', msg: 'captcha protection: request disallowed (no captcha response)' }]] };
  await assert.rejects(B.requestCode('a@b.kz'), (e) => e.code === 'billingCaptcha');
});
await t('oversized or non-string token is not sent', async () => {
  assert.deepEqual(B.otpBody('a@b.kz', 'x'.repeat(5000), 'ru'), { email: 'a@b.kz', create_user: true, data: { lang: 'ru' } });
  assert.deepEqual(B.otpBody('a@b.kz', { evil: 1 }, 'en'), { email: 'a@b.kz', create_user: true, data: { lang: 'ru' } }, 'unknown language → Russian');
});

// ---------- UX telemetry: one request per batch ----------
const UXB = '/rest/v1/rpc/track_ux_events';
await t('UX batch → one track_ux_events request, invalid events dropped, n capped at 5', async () => {
  await signIn();
  routes = { [UXB]: [[200, 2]] };
  B.trackUxEvents([
    { t: 'rage_click', k: 'btn_sync', s: 'orders', n: 99 },
    { t: 'evil', k: 'a1', s: 'home', n: 1 },
    { t: 'action_click', k: 'https://x', s: 'home', n: 1 },
    { t: 'screen_view', k: 'orders', s: 'orders' },
  ]);
  for (let i = 0; i < 20 && !calls.length; i++) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls, [UXB]);
  assert.deepEqual(sent[0], { p_events: [{ t: 'rage_click', k: 'btn_sync', s: 'orders', n: 5 }, { t: 'screen_view', k: 'orders', s: 'orders', n: 1 }] });
});
await t('UX batch: more than 50 events → first 50 in one request', async () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ t: 'action_click', k: `btn_${i}`, s: 'home', n: 1 }));
  assert.equal(B.uxBatch(many).length, 50);
  assert.deepEqual(B.uxBatch(null), []);
});
await t('UX batch: server without track_ux_events (404) → dropped silently, no per-event fallback', async () => {
  await signIn();
  routes = { [UXB]: [[404, { code: 'PGRST202', message: 'Could not find the function' }]] };
  B.trackUxEvents([{ t: 'screen_view', k: 'home', s: 'home', n: 3 }]);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(calls, [UXB]);
});

// ---------- interface language → server (bot, e-mails) ----------
const LANG = '/rest/v1/rpc/set_my_lang';
const META = '/auth/v1/user';
await t('language sent once per user and value: set_my_lang + user metadata', async () => {
  await signIn();
  routes = { [LANG]: [[200, { lang: 'kk' }]], [META]: [[200, {}]] };
  assert.equal(await B.syncLang('kk'), true);
  assert.deepEqual(calls, [LANG, META]);
  assert.deepEqual(sent[0], { p_lang: 'kk' });
  assert.deepEqual(sent[1], { data: { lang: 'kk' } });
  assert.equal(await B.syncLang('kk'), false, 'same language again: nothing sent');
  assert.equal(calls.length, 2);
  routes = { [LANG]: [[200, { lang: 'ru' }]], [META]: [[200, {}]] };
  assert.equal(await B.syncLang('ru'), true, 'changed back: sent');
});
await t('language: signed out → nothing sent; server error → retried next time', async () => {
  assert.equal(await B.syncLang('kk'), false);
  assert.equal(calls.length, 0);
  await signIn();
  routes = { [LANG]: [[404, { message: 'Could not find the function' }]] };
  assert.equal(await B.syncLang('kk'), false);
  routes = { [LANG]: [[200, { lang: 'kk' }]], [META]: [[500, {}]] };
  assert.equal(await B.syncLang('kk'), true, 'retried; a metadata failure does not block it');
});

console.log(`\n${n} passed`);
