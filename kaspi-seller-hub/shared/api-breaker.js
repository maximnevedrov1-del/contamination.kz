/**
 * Circuit breaker for the Kaspi API: after BREAKER_FAILS outage errors in a row (server error,
 * network, rate limit, unexpected answer — not a wrong token) a store rests for BREAKER_PAUSE.
 * Two fixes over the first version:
 *  - errors closer than BREAKER_MIN_GAP to the last COUNTED error (several syncs fired within
 *    seconds, e.g. connecting stores in a row) count once, so a short blip cannot open the breaker;
 *  - when the previous pause has already expired the counter starts again from 0.
 */
export const OUTAGE_CODES = new Set(['apiNetwork', 'apiHttp', 'apiRateLimit', 'apiFormat', 'apiTimeout']);
export const BREAKER_FAILS = 3;
export const BREAKER_PAUSE = 10 * 60000;
export const BREAKER_MIN_GAP = 60_000;

export const breakerOpen = (api, now = Date.now()) => !!api && (api.fails || 0) >= BREAKER_FAILS && now - (api.errorAt || 0) < BREAKER_PAUSE;

/** New `store.api` object after a sync of that store (err = error code or falsy on success). Pure. */
export function nextApiHealth(prev, err, now = Date.now()) {
  prev = prev || {};
  if (!err) return { ...prev, error: null, lastOkAt: now, fails: 0 };
  if (!OUTAGE_CODES.has(err)) return { ...prev, error: err, errorAt: now, fails: 0 };
  const fails = prev.fails || 0;
  const pauseExpired = fails >= BREAKER_FAILS && now - (prev.errorAt || 0) >= BREAKER_PAUSE;
  const base = pauseExpired ? 0 : fails;
  if (base > 0 && now - (prev.errorAt || 0) < BREAKER_MIN_GAP) return { ...prev, error: err }; // same blip: not counted again
  return { ...prev, error: err, errorAt: now, fails: base + 1 };
}
