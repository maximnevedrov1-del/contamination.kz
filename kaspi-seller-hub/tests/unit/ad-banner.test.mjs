// Advertising banner (Stage 06): rotation timing, pause reasons, manual navigation, eligibility and failure handling.
//   node tests/unit/ad-banner.test.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { createRotation, resolveAds, ROTATE_MS, MAX_AD_SLOTS } = await import(pathToFileURL(path.join(ROOT, 'dashboard/ad-banner.js')).href);

// manual clock: timers fire only when advance() is called
const clock = () => {
  let now = 0, seq = 0; const q = new Map();
  return {
    timers: { setTimeout: (fn, ms) => { q.set(++seq, { at: now + ms, fn }); return seq; }, clearTimeout: (id) => q.delete(id) },
    pending: () => q.size,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...q.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        q.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = end;
    },
  };
};
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const mk = (count, extra = {}) => { const c = clock(); const log = []; const r = createRotation({ count, timers: c.timers, onChange: (i, why) => log.push([i, why]), ...extra }); return { c, r, log }; };

await t('constants: 30 s, at most 3 campaigns', () => { assert.equal(ROTATE_MS, 30000); assert.equal(MAX_AD_SLOTS, 3); });

await t('rotates every 30 s and wraps around', () => {
  const { c, r, log } = mk(3);
  c.advance(29999); assert.equal(r.index, 0);
  c.advance(1); assert.equal(r.index, 1);
  c.advance(30000); c.advance(30000); assert.equal(r.index, 0);
  assert.deepEqual(log.map((x) => x[1]), ['auto', 'auto', 'auto']);
});
await t('count is capped at 3; a single ad or none never rotates and arms no timer', () => {
  assert.equal(mk(9).r.count, 3);
  for (const k of [0, 1]) { const { c, r } = mk(k); assert.equal(c.pending(), 0); c.advance(300000); assert.equal(r.index, 0); assert.equal(r.running, false); }
});
await t('hidden tab pauses; visible again gives the ad a full interval', () => {
  const { c, r } = mk(2);
  c.advance(20000); r.setPause('hidden', true);
  assert.equal(c.pending(), 0); c.advance(600000); assert.equal(r.index, 0);
  r.setPause('hidden', false);
  c.advance(29999); assert.equal(r.index, 0); c.advance(1); assert.equal(r.index, 1);
});
await t('hover / focus / user pause / reduced motion: each blocks until ALL are cleared', () => {
  const { c, r } = mk(3);
  r.setPause('hover', true); r.setPause('focus', true); r.setPause('user', true); r.setPause('motion', true);
  c.advance(120000); assert.equal(r.index, 0);
  r.setPause('hover', false); r.setPause('focus', false); r.setPause('user', false);
  c.advance(120000); assert.equal(r.index, 0, 'motion preference still pauses');
  r.setPause('motion', false); c.advance(30000); assert.equal(r.index, 1);
});
await t('pausing twice for the same reason is one pause; no stacked timers', () => {
  const { c, r } = mk(2);
  r.setPause('hover', true); r.setPause('hover', true); r.setPause('hover', false);
  assert.equal(c.pending(), 1); c.advance(30000); assert.equal(r.index, 1);
});
await t('manual next/prev wrap, report "manual", and restart the interval', () => {
  const { c, r, log } = mk(3);
  c.advance(25000); r.next(); assert.equal(r.index, 1);
  c.advance(29999); assert.equal(r.index, 1, 'a manual move restarts the 30 s');
  c.advance(1); assert.equal(r.index, 2);
  r.prev(); r.prev(); r.prev(); assert.equal(r.index, 2);
  assert.ok(log.some((x) => x[1] === 'manual'));
});
await t('manual navigation works while paused and keeps it paused', () => {
  const { c, r } = mk(3);
  r.setPause('user', true); r.next(); assert.equal(r.index, 1); assert.equal(r.running, false);
  c.advance(600000); assert.equal(r.index, 1);
});
await t('goTo / out-of-range indices are normalized; destroy stops everything', () => {
  const { c, r } = mk(3);
  r.goTo(7); assert.equal(r.index, 1); r.goTo(-1); assert.equal(r.index, 2);
  r.destroy(); assert.equal(c.pending(), 0); r.next(); c.advance(100000); assert.equal(r.index, 2);
});
await t('setCount re-arms and resets to the first ad', () => {
  const { c, r } = mk(1); r.setCount(2); assert.equal(c.pending(), 1); c.advance(30000); assert.equal(r.index, 1);
  r.setCount(0); assert.equal(c.pending(), 0);
});

// ---- eligibility and failures ----
const AD = (o = {}) => ({ id: 1, kind: 'sponsor', sponsor: 'Fin Co', headline: 'Fast loans', body: '', image: null, alt: '', url: 'https://a.example.kz/p', ...o });
const bus = (routes) => async (type) => { const r = routes[type]; if (r instanceof Error) throw r; return typeof r === 'function' ? r() : r; };
const FREE = { ok: true, entitlements: { adFree: false, showAds: true } };

await t('free user with campaigns → ready, at most 3', async () => {
  const r = await resolveAds(bus({ 'ui:supporterGet': FREE, 'ui:adsGet': { ok: true, showAds: true, ads: [1, 2, 3, 4].map((id) => AD({ id })) } }));
  assert.equal(r.state, 'ready'); assert.equal(r.ads.length, 3);
});
await t('ACTIVE SUPPORTER: nothing, even if the ads answer contains campaigns', async () => {
  const ads = { ok: true, showAds: true, ads: [AD()] };
  assert.equal((await resolveAds(bus({ 'ui:supporterGet': { ok: true, entitlements: { adFree: true, showAds: false } }, 'ui:adsGet': ads }))).state, 'adfree');
  assert.equal((await resolveAds(bus({ 'ui:supporterGet': { ok: true, entitlements: { adFree: false, showAds: false } }, 'ui:adsGet': ads }))).state, 'adfree');
  const r = await resolveAds(bus({ 'ui:supporterGet': FREE, 'ui:adsGet': { ok: true, showAds: false, ads: [AD()] } }));
  assert.deepEqual(r, { state: 'adfree', ads: [] });
});
await t('entitlement unknown (error / timeout) → the server answer decides, still ads for a free user', async () => {
  const r = await resolveAds(bus({ 'ui:supporterGet': new Error('sw asleep'), 'ui:adsGet': { ok: true, showAds: true, ads: [AD()] } }));
  assert.equal(r.state, 'ready');
  const r2 = await resolveAds(bus({ 'ui:supporterGet': { ok: false, error: 'rpc' }, 'ui:adsGet': { ok: true, showAds: false, ads: [] } }));
  assert.equal(r2.state, 'adfree');
});
await t('empty list → empty (slot stays hidden); internal fallback ads are accepted', async () => {
  assert.equal((await resolveAds(bus({ 'ui:supporterGet': FREE, 'ui:adsGet': { ok: true, showAds: true, ads: [] } }))).state, 'empty');
  const r = await resolveAds(bus({ 'ui:supporterGet': FREE, 'ui:adsGet': { ok: true, showAds: true, fallback: true, ads: [AD({ kind: 'internal', sponsor: '' })] } }));
  assert.equal(r.state, 'ready'); assert.equal(r.ads[0].kind, 'internal');
});
await t('API failures never throw: rejection, ok:false, garbage, hang → error', async () => {
  for (const a of [new Error('boom'), { ok: false, error: 'x' }, null, undefined, 5, 'x', { ok: true, ads: 'x' }]) {
    const r = await resolveAds(bus({ 'ui:supporterGet': FREE, 'ui:adsGet': a }));
    assert.ok(['error', 'empty'].includes(r.state), String(a)); assert.deepEqual(r.ads, []);
  }
  const t0 = Date.now();
  const r = await resolveAds(() => new Promise(() => {}), 50);
  assert.equal(r.state, 'error'); assert.ok(Date.now() - t0 < 1000);
});
await t('second validation: non-https links dropped, non-https image dropped, unknown kind dropped', async () => {
  const r = await resolveAds(bus({ 'ui:supporterGet': FREE, 'ui:adsGet': { ok: true, showAds: true, ads: [AD({ id: 1, url: 'http://a.kz/' }), AD({ id: 2, url: 'javascript:alert(1)' }), AD({ id: 3, kind: 'evil' }), AD({ id: 4, image: 'http://x.kz/a.png' }), AD({ id: 5, id2: 0, headline: '' }), AD({ id: 'x' })] } }));
  assert.deepEqual(r.ads.map((a) => a.id), [4]); assert.equal(r.ads[0].image, null);
});
console.log(`\n${n} tests passed`);
