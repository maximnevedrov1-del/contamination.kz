// Supporter (Stage 04), client side: shared/ads.js decides only «show ads or not», fail-safe to «show»;
// background/billing.js entitlements() asks the server, caches per user, never trusts local edits beyond the ad flag.
//   node tests/unit/supporter.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { normalizeEntitlements: norm, adsVisible } = await import(pathToFileURL(path.join(ROOT, 'shared/ads.js')).href);
let n = 0;
const t = async (name, fn) => { store = {}; routes = {}; calls = []; await fn(); n++; console.log('ok', name); };
let store = {}, routes = {}, calls = [];

const HOUR = 3600e3;
const ON = (extra = {}) => ({ status: 'supporter', ad_free: true, show_ads: false, ends_at: new Date(Date.now() + 5 * HOUR * 24).toISOString(), price_month: 5000, currency: 'KZT', max_months: 12, payments_enabled: true, ...extra });

await t('server says supporter → no ads', () => {
  const e = norm(ON());
  assert.equal(e.adFree, true); assert.equal(e.showAds, false); assert.equal(adsVisible(e), false); assert.equal(e.status, 'supporter');
});
await t('free / expired / garbage / null → ads are shown (fail-safe)', () => {
  for (const raw of [null, undefined, 5, 'x', [], {}, { status: 'free', ad_free: false, show_ads: true }, { status: 'expired', ad_free: false, show_ads: true }]) {
    const e = norm(raw); assert.equal(e.showAds, true, JSON.stringify(raw)); assert.equal(adsVisible(e), true);
  }
  assert.equal(adsVisible(null), true);
});
await t('inconsistent or forged flags do not hide ads', () => {
  assert.equal(norm(ON({ show_ads: true })).showAds, true, 'show_ads true wins');
  assert.equal(norm(ON({ ad_free: 'true' })).showAds, true, 'string is not boolean true');
  assert.equal(norm(ON({ ends_at: null })).showAds, true, 'no end date → not ad-free');
  assert.equal(norm(ON({ ends_at: 'soon' })).showAds, true);
});
await t('a period that has run out locally stops hiding ads', () => {
  const e = norm(ON({ ends_at: new Date(Date.now() - 1000).toISOString() }));
  assert.equal(e.showAds, true); assert.equal(e.endsAt, null);
});
await t('ending subscription (cancel requested) is still ad-free until the end', () => {
  const e = norm(ON({ status: 'supporter_ending', cancel_at: new Date().toISOString() }));
  assert.equal(e.status, 'supporter_ending'); assert.equal(e.showAds, false); assert.ok(e.cancelAt);
});
await t('price and months come from the server, bounded', () => {
  const e = norm(ON({ price_month: 5000, max_months: 999 }));
  assert.equal(e.priceMonth, 5000); assert.equal(e.currency, 'KZT'); assert.equal(e.maxMonths, 24);
  assert.equal(norm(ON({ price_month: -3 })).priceMonth, 5000);
  assert.equal(norm(ON({ payments_enabled: 'yes' })).paymentsEnabled, false);
});
await t('the entitlement object carries no functional restriction fields', () => {
  const keys = Object.keys(norm(ON())).join(',');
  assert.ok(!/canUse|storeLimit|limit|readOnly/i.test(keys), keys);
});

// ----- billing.js entitlements() against a scripted server -----
const URL_ = 'https://test-project.supabase.co';
const dir = mkdtempSync(path.join(tmpdir(), 'ksh-sup-'));
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
const ENT = '/rest/v1/rpc/get_entitlements';
const signIn = (user = 'u1') => { store['ksh.session'] = { access_token: 'tok', refresh_token: 'r', user_id: user, email: 'a@b.c', expires_at: Date.now() + 3600e3 }; };

await t('signed out → free tier, no request', async () => {
  const e = await B.entitlements(); assert.equal(e.showAds, true); assert.equal(calls.length, 0);
});
await t('server answer → no ads, cached (second call makes no request), force refreshes', async () => {
  signIn(); routes = { [ENT]: [[200, ON()], [200, { status: 'expired', ad_free: false, show_ads: true }]] };
  assert.equal((await B.entitlements()).showAds, false);
  assert.equal((await B.entitlements()).showAds, false); assert.equal(calls.length, 1);
  assert.equal((await B.entitlements({ force: true })).showAds, true, 'the server later says expired');
});
await t('a cache written by another user is ignored', async () => {
  signIn('u2'); store['ksh.entitlements'] = { data: ON(), fetchedAt: Date.now(), user: 'u1' };
  routes = { [ENT]: [[200, { status: 'free', ad_free: false, show_ads: true }]] };
  assert.equal((await B.entitlements()).showAds, true); assert.equal(calls.length, 1);
});
await t('server down: last answer of THIS user is used within 3 days, older → ads', async () => {
  signIn(); store['ksh.entitlements'] = { data: ON(), fetchedAt: Date.now() - 2 * 86400e3, user: 'u1' };
  routes = { [ENT]: ['offline'] };
  assert.equal((await B.entitlements()).showAds, false);
  store['ksh.entitlements'].fetchedAt = Date.now() - 4 * 86400e3; routes = { [ENT]: ['offline'] };
  assert.equal((await B.entitlements()).showAds, true);
});
await t('a cache dated in the future (edited by hand) is not trusted', async () => {
  signIn(); store['ksh.entitlements'] = { data: ON(), fetchedAt: Date.now() + 10 * 86400e3, user: 'u1' };
  routes = { [ENT]: [[200, { status: 'free', ad_free: false, show_ads: true }]] };
  assert.equal((await B.entitlements()).showAds, true);
});
await t('create / cancel / resume call the server RPCs and refresh entitlements; the client sends no plan or date', async () => {
  signIn();
  routes = { '/rpc/create_supporter_invoice': [[200, { id: 7, amount: 5000 }]], [ENT]: [[200, { status: 'free', ad_free: false, show_ads: true }]] };
  await B.createSupporterInvoice({ months: 1, phone: '' });
  assert.deepEqual(calls[0].body, { p_months: 1, p_phone: null });
  routes = { '/rpc/cancel_supporter': [[200, {}]], [ENT]: [[200, ON({ status: 'supporter_ending', cancel_at: new Date().toISOString() })]] };
  await B.cancelSupporter(); assert.deepEqual(calls[2].body, {});
  routes = { '/rpc/resume_supporter': [[200, {}]], [ENT]: [[200, ON()]] };
  await B.resumeSupporter();
  assert.equal((await B.entitlements()).showAds, false);
});
await t('logout removes the entitlement cache', async () => {
  signIn(); routes = { [ENT]: [[200, ON()]], '/auth/v1/logout': [[204, null]] };
  await B.entitlements(); assert.ok(store['ksh.entitlements']);
  await B.logout(); assert.ok(!store['ksh.entitlements']);
});
console.log(`\n${n} passed`);
