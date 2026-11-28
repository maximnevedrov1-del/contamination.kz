// Advertising (Stage 05), client side: shared/ads.js normalizeAds is an independent second validation of what the server
// sends; background/billing.js ads()/adEvent() never throw, never fetch for ad-free users' benefit, and send nothing but ids.
//   node tests/unit/advertising.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { normalizeAds } = await import(pathToFileURL(path.join(ROOT, 'shared/ads.js')).href);
let n = 0, store = {}, routes = {}, calls = [];
const t = async (name, fn) => { store = {}; routes = {}; calls = []; await fn(); n++; console.log('ok', name); };

const AD = (o = {}) => ({ id: 1, kind: 'sponsor', sponsor_name: 'Fin Co', headline: 'Fast loans', body: 'b', creative_url: 'https://cdn.example.kz/a.png', creative_alt: 'a', destination_url: 'https://a.example.kz/promo?x=1', ...o });
const RAW = (ads, o = {}) => ({ show_ads: true, ads, fallback: false, ...o });

await t('valid server answer → normalized ads (max 3), only display fields', () => {
  const v = normalizeAds(RAW([AD({ id: 1 }), AD({ id: 2 }), AD({ id: 3 }), AD({ id: 4 })]));
  assert.equal(v.ads.length, 3); assert.equal(v.showAds, true);
  assert.deepEqual(Object.keys(v.ads[0]).sort(), ['alt', 'body', 'headline', 'id', 'image', 'kind', 'sponsor', 'url']);
});
await t('ad-free (show_ads false) → nothing, whatever ads the payload contains', () => {
  const v = normalizeAds(RAW([AD()], { show_ads: false }));
  assert.equal(v.showAds, false); assert.deepEqual(v.ads, []);
});
await t('garbage / null / wrong shapes → empty list, never throws', () => {
  for (const r of [null, undefined, 3, 'x', [], {}, { ads: 'x' }, { show_ads: true, ads: [null, 5, 'x', []] }]) assert.deepEqual(normalizeAds(r).ads, [], JSON.stringify(r));
});
await t('hostile destinations are dropped (second validation)', () => {
  for (const u of ['http://a.example.kz/', 'javascript:alert(1)', 'data:text/html,x', 'https://127.0.0.1/x', 'https://localhost/', 'https://good.kz@evil.kz/', 'https://a.example.kz:8443/', 'https://a.example.kz/#x', 'https://a.example.kz/a b', '//a.example.kz/', '', null, 5, 'https://a.example.kz/' + 'x'.repeat(500)])
    assert.deepEqual(normalizeAds(RAW([AD({ destination_url: u })])).ads, [], String(u));
});
await t('uppercase scheme / mixed case is rejected for destination and image', () => {
  assert.deepEqual(normalizeAds(RAW([AD({ destination_url: 'HTTPS://a.example.kz/x' })])).ads, []);
  assert.equal(normalizeAds(RAW([AD({ creative_url: 'HTTPS://tracker.evil.com/p.png' })])).ads[0].image, null);
});
await t('hostile images: ad kept, image dropped (svg, query, http, data:)', () => {
  for (const u of ['https://cdn.example.kz/a.svg', 'https://cdn.example.kz/a.png?u=1', 'http://cdn.example.kz/a.png', 'data:image/png;base64,AAAA', 'https://cdn.example.kz/a.html', null]) {
    const v = normalizeAds(RAW([AD({ creative_url: u })]));
    assert.equal(v.ads.length, 1); assert.equal(v.ads[0].image, null, String(u));
  }
  assert.equal(normalizeAds(RAW([AD()])).ads[0].image, 'https://cdn.example.kz/a.png');
});
await t('text is stripped of markup/control characters and bounded; bad ids/kinds dropped', () => {
  const v = normalizeAds(RAW([AD({ headline: '<img src=x onerror=1>Hi\n', body: 'y'.repeat(999) }), AD({ id: -1 }), AD({ id: 'a' }), AD({ kind: 'evil' }), AD({ headline: '   ' })]));
  assert.equal(v.ads.length, 1); assert.ok(!/[<>\n]/.test(v.ads[0].headline)); assert.ok(v.ads[0].body.length <= 200);
});
await t('fallback flag only with ads present', () => {
  assert.equal(normalizeAds(RAW([AD({ kind: 'internal' })], { fallback: true })).fallback, true);
  assert.equal(normalizeAds(RAW([], { fallback: true })).fallback, false);
});

// ----- billing.js against a scripted server -----
const URL_ = 'https://test-project.supabase.co';
const dir = mkdtempSync(path.join(tmpdir(), 'ksh-ads-'));
mkdirSync(path.join(dir, 'background')); mkdirSync(path.join(dir, 'shared'));
for (const f of ['background/billing.js', 'shared/license-signature.js', 'shared/ads.js']) writeFileSync(path.join(dir, f), readFileSync(path.join(ROOT, f)));
writeFileSync(path.join(dir, 'shared/billing-config.js'), readFileSync(path.join(ROOT, 'shared/billing-config.js'), 'utf8')
  .replace(/supabaseUrl: '[^']*'/, `supabaseUrl: '${URL_}'`).replace(/supabaseAnonKey: '[^']*'/, "supabaseAnonKey: 'anon'"));
globalThis.chrome = { storage: { local: {
  async get(k) { const keys = Array.isArray(k) ? k : [k]; return Object.fromEntries(keys.filter((x) => x in store).map((x) => [x, structuredClone(store[x])])); },
  async set(o) { Object.assign(store, structuredClone(o)); },
  async remove(k) { (Array.isArray(k) ? k : [k]).forEach((x) => delete store[x]); } }, session: { async remove() {} } }, runtime: { getURL: (p) => p } };
globalThis.fetch = async (url, opts) => {
  const route = Object.keys(routes).find((r) => String(url).includes(r));
  calls.push({ route, body: opts?.body ? JSON.parse(opts.body) : null });
  const next = route && routes[route].shift();
  if (!next) throw new Error(`unexpected request ${url}`);
  if (next === 'offline') throw new TypeError('Failed to fetch');
  const [status, body] = next;
  return { ok: status >= 200 && status < 300, status, text: async () => (body == null ? '' : JSON.stringify(body)) };
};
const B = await import(pathToFileURL(path.join(dir, 'background/billing.js')).href);
const ADS = '/rest/v1/rpc/get_ads', REC = '/rest/v1/rpc/ad_record';
const signIn = (user = 'u1') => { store['ksh.session'] = { access_token: 'tok', refresh_token: 'r', user_id: user, email: 'a@b.c', expires_at: Date.now() + 3600e3 }; };

await t('signed out → no ads, no request', async () => { const v = await B.ads(); assert.deepEqual(v.ads, []); assert.equal(calls.length, 0); });
await t('free user: ads fetched with NO arguments, cached for the next call, force refetches', async () => {
  signIn(); routes = { [ADS]: [[200, RAW([AD()])], [200, RAW([AD(), AD({ id: 2 })])]] };
  assert.equal((await B.ads()).ads.length, 1); assert.deepEqual(calls[0].body, {});
  assert.equal((await B.ads()).ads.length, 1); assert.equal(calls.length, 1);
  assert.equal((await B.ads({ force: true })).ads.length, 2);
});
await t('server error / offline / garbage → empty list, no exception', async () => {
  signIn();
  for (const answer of ['offline', [500, { message: 'boom' }], [200, 'junk'], [401, {}]]) { routes = { [ADS]: [answer] }; store = { 'ksh.session': store['ksh.session'] }; const v = await B.ads({ force: true }); assert.deepEqual(v.ads, [], JSON.stringify(answer)); }
});
await t('a cached ad-free entitlement suppresses ads even if the ads cache has some', async () => {
  signIn(); store['ksh.entitlements'] = { user: 'u1', fetchedAt: Date.now(), data: { status: 'supporter', ad_free: true, show_ads: false, ends_at: new Date(Date.now() + 864e5).toISOString() } };
  routes = { [ADS]: [[200, RAW([AD()])]] };
  const v = await B.ads({ force: true }); assert.equal(v.showAds, false); assert.deepEqual(v.ads, []);
});
await t('another user\'s cache is ignored; logout clears it', async () => {
  signIn('u2'); store['ksh.ads'] = { user: 'u1', fetchedAt: Date.now(), data: RAW([AD()]) };
  routes = { [ADS]: [[200, RAW([])]] };
  assert.deepEqual((await B.ads()).ads, []); assert.equal(calls.length, 1);
  routes = { '/auth/v1/logout': [[204, null]] }; await B.logout(); assert.ok(!store['ksh.ads']);
});
await t('adEvent sends only campaign id + event; failures and bad input → false, no exception', async () => {
  signIn(); routes = { [REC]: [[200, true]] };
  assert.equal(await B.adEvent({ id: 7, event: 'click' }), true); assert.deepEqual(calls[0].body, { p_campaign: 7, p_event: 'click' });
  assert.equal(await B.adEvent({ id: 7, event: 'hover' }), false); assert.equal(await B.adEvent({ id: 'x', event: 'click' }), false);
  routes = { [REC]: ['offline'] }; assert.equal(await B.adEvent({ id: 7, event: 'impression' }), false);
  routes = { [REC]: [[200, false]] }; assert.equal(await B.adEvent({ id: 7, event: 'impression' }), false);
});
console.log(`\n${n} passed`);
