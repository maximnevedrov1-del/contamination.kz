/**
 * Anonymous UX behaviour tracker (pure, dependency-injected; no DOM, no chrome.*).
 *
 * Counts only short whitelisted codes: event type + control key + screen key. Never text, values, URLs or
 * page content. Events are aggregated in memory and handed to send(events) at most once per flush window
 * (60 s) — plus one final flush when the page is hidden. Everything is silent-fail and never blocks the UI.
 *   events: [{ t: type, k: target key, s: screen key, n: count }]
 * Server side: track_ux_event() in billing/supabase/024_ux_behavior_telemetry.sql.
 */
export const UX_EVENT_TYPES = ['screen_view', 'action_click', 'rage_click', 'form_abandoned', 'help_opened'];
const KEY_RE = /^[a-z0-9_:-]{1,64}$/;

/** A key is a short code: [a-z0-9_:-], 1..64 chars, not digits only (so ids, URLs and free text never pass). */
export const isValidKey = (k) => typeof k === 'string' && KEY_RE.test(k) && !/^[0-9]+$/.test(k);
/** Turns an element id into a key ("connectDialog" → "connectdialog"); null if nothing valid is left. */
export function normalizeKey(raw) {
  const k = String(raw ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 64);
  return isValidKey(k) ? k : null;
}

export function createUxTracker({
  send,                                   // (events) => any | Promise — delivers one batch
  now = Date.now,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  flushMs = 60000,
  maxKeys = 50,                           // distinct (type,key,screen) per batch; the rest is dropped
  maxCount = 50,                          // per event per batch
  rageClicks = 4,
  rageMs = 2000,
  abandonMs = 15000,
} = {}) {
  const pending = new Map();
  const clicks = new Map();               // key → recent click times (rage detection)
  const forms = new Map();                // form key → opened at
  let screen = 'home';
  let timer = null;

  function flush() {
    if (timer != null) { try { clearTimer(timer); } catch { /* ignore */ } timer = null; }
    if (!pending.size) return false;
    const events = [...pending.values()];
    pending.clear();
    try {
      const r = send(events);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* telemetry must never break the UI */ }
    return true;
  }

  function track(type, key, scr = screen, n = 1) {
    try {
      if (!UX_EVENT_TYPES.includes(type) || !isValidKey(key) || !isValidKey(scr)) return false;
      const id = `${type}|${key}|${scr}`;
      const cur = pending.get(id);
      if (cur) cur.n = Math.min(cur.n + n, maxCount);
      else if (pending.size < maxKeys) pending.set(id, { t: type, k: key, s: scr, n: Math.min(n, maxCount) });
      else return false;
      if (timer == null) timer = setTimer(flush, flushMs);
      return true;
    } catch { return false; }
  }

  return {
    track,
    flush,
    pendingCount: () => pending.size,
    /** Section opened (route id). Becomes the current screen. */
    screenView(route) {
      if (!isValidKey(route)) return false;
      screen = route;
      return track('screen_view', route, route);
    },
    /** Click on a control that carries data-ux-key; 4+ clicks within 2 s on the same key = rage click. */
    click(key) {
      if (!isValidKey(key)) return false;
      track('action_click', key);
      const t = now();
      const list = (clicks.get(key) || []).filter((x) => t - x <= rageMs);
      list.push(t);
      if (list.length >= rageClicks) { clicks.delete(key); track('rage_click', key); }
      else { if (clicks.size >= 100 && !clicks.has(key)) clicks.clear(); clicks.set(key, list); }
      return true;
    },
    help: (key) => track('help_opened', key),
    /** A form / dialog / settings page was opened. */
    formOpened(key) { if (isValidKey(key)) forms.set(key, now()); },
    /** It was closed; counted as abandoned when it stayed open > 15 s and nothing was saved. */
    formClosed(key, saved = false) {
      const at = forms.get(key);
      forms.delete(key);
      if (at == null || saved || now() - at <= abandonMs) return false;
      return track('form_abandoned', key);
    },
    setScreen(route) { if (isValidKey(route)) screen = route; },
  };
}
