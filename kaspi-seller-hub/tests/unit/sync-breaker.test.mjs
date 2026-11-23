// API circuit breaker: rapid errors count once, spaced errors open it, an expired pause resets.
//   node tests/unit/sync-breaker.test.mjs
import assert from 'node:assert/strict';
import { nextApiHealth, breakerOpen, BREAKER_FAILS, BREAKER_PAUSE, BREAKER_MIN_GAP } from '../../shared/api-breaker.js';

let failed = 0;
function t(name, fn) {
  try { fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '-', e.message); }
}
const T0 = 1_000_000_000_000;

t('errors within the gap count once', () => {
  let api = {};
  for (let i = 0; i < 10; i++) api = nextApiHealth(api, 'apiNetwork', T0 + i * 1000);
  assert.equal(api.fails, 1);
  assert.equal(api.errorAt, T0);
  assert.equal(breakerOpen(api, T0 + 10_000), false);
});
t('spaced errors open the breaker', () => {
  let api = {};
  for (let i = 0; i < BREAKER_FAILS; i++) api = nextApiHealth(api, 'apiHttp', T0 + i * BREAKER_MIN_GAP);
  assert.equal(api.fails, BREAKER_FAILS);
  assert.equal(breakerOpen(api, T0 + 2 * BREAKER_MIN_GAP + 1000), true);
  assert.equal(breakerOpen(api, T0 + 2 * BREAKER_MIN_GAP + BREAKER_PAUSE + 1), false);
});
t('expired pause resets the counter, then counts 1', () => {
  const open = { fails: 3, errorAt: T0, error: 'apiHttp' };
  const api = nextApiHealth(open, 'apiHttp', T0 + BREAKER_PAUSE + 5);
  assert.equal(api.fails, 1);
  assert.equal(breakerOpen(api, T0 + BREAKER_PAUSE + 6), false);
});
t('non-outage error (bad token) resets fails; success clears', () => {
  assert.equal(nextApiHealth({ fails: 2, errorAt: T0 }, 'apiUnauthorized', T0 + 99).fails, 0);
  const ok = nextApiHealth({ fails: 2, error: 'apiHttp' }, null, T0 + 5);
  assert.deepEqual([ok.fails, ok.error, ok.lastOkAt], [0, null, T0 + 5]);
});
t('does not mutate its input', () => {
  const prev = Object.freeze({ fails: 1, errorAt: T0 });
  nextApiHealth(prev, 'apiNetwork', T0 + BREAKER_MIN_GAP);
});
process.exit(failed ? 1 : 0);
