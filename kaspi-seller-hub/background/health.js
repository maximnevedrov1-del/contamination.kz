/**
 * SaudaPulse — API health counts (service worker).
 *
 * Every Kaspi API request ends as «worked» or «failed because …». The worker adds these up and
 * every 15 minutes sends ONLY the numbers to the subscription server:
 *   [{ market: 'kaspi', ok: 120, fail: 3, kinds: { server: 2, network: 1 } }]
 * No orders, URLs, store names or tokens. When many sellers fail at the same time, Kaspi is down
 * or changed its API; the owner gets a Telegram message (billing/supabase/003_support.sql,
 * tools/ops-alert.mjs) before the sellers start writing.
 */
import { setApiObserver } from './kaspi-api.js';
import { isConfigured, signedIn, healthReport } from './billing.js';

export const ALARM_HEALTH = 'ksh-health';
const KEY = 'ksh.health';

/** ApiError → kind the server understands. */
export function kindOf(err) {
  const code = err?.code;
  if (code === 'apiUnauthorized') return 'auth';
  if (code === 'apiRateLimit') return 'rate';
  if (code === 'apiNetwork') return 'network';
  if (code === 'apiTimeout') return 'timeout';
  if (code === 'apiFormat') return 'format';
  if (code === 'apiHttp' && err.status >= 500) return 'server';
  return 'other';
}

// Counts live in memory and are copied to storage.session (the worker may sleep between requests).
let counts = null;
let saveTimer = null;
async function load() {
  if (counts) return counts;
  counts = (await chrome.storage.session.get(KEY).catch(() => ({})))[KEY] || {};
  return counts;
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.session.set({ [KEY]: counts }).catch(() => {}), 500);
}

export async function noteApi(market, err) {
  if (err?.code === 'readOnly') return; // our own guard, not the marketplace
  const c = await load();
  const m = (c[market] ||= { ok: 0, fail: 0, kinds: {} });
  if (!err) m.ok++;
  else {
    m.fail++;
    const k = kindOf(err);
    m.kinds[k] = (m.kinds[k] || 0) + 1;
  }
  save();
}

/** Send the counts (signed-in sellers only) and start again from zero. */
export async function flushHealth() {
  if (!isConfigured() || !(await signedIn())) return false;
  const c = await load();
  const list = Object.entries(c)
    .filter(([, v]) => v.ok + v.fail > 0)
    .map(([market, v]) => ({ market, ok: v.ok, fail: v.fail, kinds: v.kinds }));
  if (!list.length) return false;
  await healthReport(list);
  // only what was sent is subtracted: requests counted meanwhile stay for the next time
  for (const { market, ok, fail, kinds } of list) {
    const m = counts[market];
    m.ok -= ok;
    m.fail -= fail;
    for (const [k, n] of Object.entries(kinds)) m.kinds[k] = Math.max(0, (m.kinds[k] || 0) - n);
  }
  save();
  return true;
}

export function startHealth() {
  setApiObserver((err) => noteApi('kaspi', err));
}

export const scheduleHealth = () => chrome.alarms.create(ALARM_HEALTH, { periodInMinutes: 15 });
