/**
 * SaudaPulse — the ONE advertising placement (Stage 06): a thin banner right under the top bar.
 *
 * Rules this file keeps (docs/transformation/06-advertising-banner.md):
 *  - the server decides who sees ads (Stage 04/05); an ad-free supporter, a signed-out user, a disabled system, an empty
 *    list or ANY error all end the same way: the slot stays hidden and takes no room;
 *  - nothing here is awaited by a business flow: start()/refresh() never throw and never block rendering;
 *  - no markup from the server is ever interpreted: text goes through text nodes, links must be https;
 *  - the only thing sent back is {campaign id, 'impression'|'click'} (background/billing.js adEvent → aggregate counter).
 *
 * Three parts, so the logic is testable without a browser:
 *   createRotation()  — which ad is shown and when it changes (30 s timer, pause reasons, manual navigation)
 *   resolveAds()      — one round trip to the service worker → { state, ads }
 *   mountAdBanner()   — the DOM, built with the dashboard's own h() helper and existing .badge / .btn classes
 */
import { h, clear } from '../shared/utils.js';

export const ROTATE_MS = 30000;
export const MAX_AD_SLOTS = 3;
export const REQUEST_TIMEOUT_MS = 8000;
export const STALE_MS = 15 * 60000; // same as the worker's cache: a long-open tab asks again when it becomes visible
export const REVALIDATE_MS = 10 * 60000;
const HINT_KEY = 'ksh.adHint';

/**
 * Rotation controller. Any "pause reason" (hidden tab, pointer over the banner, keyboard focus inside, the user's own
 * pause button, reduced-motion preference) stops the timer. Whenever the timer (re)starts — resume or manual
 * navigation — the shown ad gets a full interval again, so nobody loses an ad because of a pause.
 */
export function createRotation({ interval = ROTATE_MS, count = 0, onChange = () => {}, timers = { setTimeout, clearTimeout } } = {}) {
  let n = Math.max(0, Math.min(MAX_AD_SLOTS, count | 0));
  let index = 0;
  let timer = null;
  let dead = false;
  const reasons = new Set();
  const stop = () => { if (timer != null) { timers.clearTimeout(timer); timer = null; } };
  const arm = () => {
    stop();
    if (dead || n < 2 || reasons.size) return;
    timer = timers.setTimeout(() => { timer = null; go((index + 1) % n, 'auto'); }, interval);
  };
  function go(i, why) {
    if (dead || n < 1) return false;
    const next = ((i % n) + n) % n;
    const changed = next !== index;
    index = next;
    arm();
    if (changed || why === 'manual') onChange(index, why);
    return changed;
  }
  arm();   // starts at once when there is more than one ad and nothing pauses it
  return {
    get index() { return index; },
    get count() { return n; },
    get running() { return timer != null; },
    get paused() { return reasons.size > 0; },
    has: (r) => reasons.has(r),
    reasons: () => [...reasons],
    next: () => go(index + 1, 'manual'),
    prev: () => go(index - 1, 'manual'),
    goTo: (i) => go(i, 'manual'),
    /** @param {string} reason 'hidden' | 'hover' | 'focus' | 'user' | 'motion' | … */
    setPause(reason, on) {
      const was = reasons.size;
      if (on) reasons.add(reason); else reasons.delete(reason);
      if (reasons.size !== was) arm();   // resuming restarts the full interval
    },
    setCount(c) { n = Math.max(0, Math.min(MAX_AD_SLOTS, c | 0)); index = 0; arm(); },
    destroy() { dead = true; stop(); },
  };
}

const withTimeout = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout')), ms);
  Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});
const httpsOnly = (u) => typeof u === 'string' && u.startsWith('https://');

/**
 * One round trip: the supporter entitlement (cached in the worker) and the campaign list, in parallel.
 * @returns {Promise<{state: 'ready'|'empty'|'adfree'|'error', ads: object[]}>} never rejects
 */
export async function resolveAds(send, timeoutMs = REQUEST_TIMEOUT_MS) {
  try {
    const [sup, res] = await Promise.all([
      withTimeout(send('ui:supporterGet', {}), timeoutMs).catch(() => null),   // unknown ≠ supporter: the server's answer below still decides
      withTimeout(send('ui:adsGet', {}), timeoutMs),
    ]);
    const e = sup && sup.ok ? sup.entitlements : null;
    if (e && (e.adFree === true || e.showAds === false)) return { state: 'adfree', ads: [] };
    if (!res || res.ok === false) return { state: 'error', ads: [] };
    if (res.showAds === false) return { state: 'adfree', ads: [] };
    const ads = (Array.isArray(res.ads) ? res.ads : [])
      .filter((a) => a && Number.isSafeInteger(a.id) && a.headline && httpsOnly(a.url) && ['sponsor', 'internal'].includes(a.kind))
      .slice(0, MAX_AD_SLOTS)
      .map((a) => ({ ...a, image: httpsOnly(a.image) ? a.image : null }));
    return { state: ads.length ? 'ready' : 'empty', ads };
  } catch {
    return { state: 'error', ads: [] };
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const glyph = (d) => {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', d);
  svg.append(p);
  return svg;
};
const PATHS = { prev: 'M15 18l-6-6 6-6', next: 'M9 18l6-6-6-6', pause: 'M8 5v14M16 5v14', play: 'M7 4l13 8-13 8z' };

/**
 * @param {object} o
 * @param {HTMLElement} o.root        the #adSlot element (already in the page, `hidden`)
 * @param {(type:string, payload?:object)=>Promise<any>} o.send   chrome.runtime.sendMessage wrapper
 * @param {(key:string, vars?:object)=>string} o.t
 * @param {()=>boolean} [o.enabled]   false → nothing is requested or shown (packer / locked warehouse screen)
 * @param {(event:'impression'|'click', ad:object)=>void} [o.onEvent]   analytics hook; default: aggregate counter in the worker
 */
export function mountAdBanner({ root, send, t, enabled = () => true, onEvent, interval = ROTATE_MS }) {
  const track = onEvent || ((event, ad) => { send('ui:adsEvent', { id: ad.id, event }).catch(() => {}); });
  const reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let ads = [];
  let rot = createRotation({ interval });
  let loadedAt = 0;
  let loading = null;
  let retries = 0;
  let retryTimer = null;
  const status = h('span', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });   // persistent: only content changes inside it are announced
  root.append(status);
  const wipe = () => { root.querySelectorAll('.ad-banner').forEach((n) => n.remove()); };
  const seen = new Set();       // impressions: once per campaign per page load

  const hint = {
    get() { try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return false; } },
    set(on) { try { on ? localStorage.setItem(HINT_KEY, '1') : localStorage.removeItem(HINT_KEY); } catch { /* storage may be blocked */ } },
  };

  const setState = (s) => { root.dataset.adState = s; };
  const show = (on) => { root.hidden = !on; };

  function impression() {
    const ad = ads[rot.index];
    if (!ad || document.hidden || root.hidden || !enabled() || seen.has(ad.id)) return;
    seen.add(ad.id);
    try { track('impression', ad); } catch { /* analytics must never break the page */ }
  }

  function slide(ad, i) {
    const sponsored = ad.kind === 'sponsor';
    const label = sponsored ? t('ads.label') : t('ads.internal');
    const link = h('a', {
      class: 'ad-banner__link', href: ad.url, target: '_blank', rel: 'noopener noreferrer sponsored', referrerpolicy: 'no-referrer',
      dataset: { adId: String(ad.id) },
    },
      h('span', { class: 'ad-banner__headline' }, ad.headline),
      ad.body ? h('span', { class: 'ad-banner__body' }, ad.body) : null,
      h('span', { class: 'sr-only' }, ` — ${t('ads.opensNew')}`));
    const onClick = () => { try { track('click', ad); } catch { /* ignore */ } };
    link.addEventListener('click', onClick);
    link.addEventListener('auxclick', (e) => e.button === 1 && onClick());
    let img = null;
    if (ad.image) {
      img = h('img', { class: 'ad-banner__img', src: ad.image, alt: ad.alt || '', width: 40, height: 40, loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => img.remove());   // a broken picture never leaves a hole
    }
    return h('div', { class: 'ad-banner__slide', role: 'group', 'aria-roledescription': 'slide', 'aria-label': t('ads.slide', { n: i + 1, total: ads.length }), dataset: { slide: String(i) } },
      h('span', { class: ['badge', sponsored ? 'badge--warn' : 'badge--info', 'ad-banner__label'] }, label),
      img,
      h('span', { class: 'ad-banner__text' },
        sponsored && ad.sponsor ? h('span', { class: 'ad-banner__sponsor' }, ad.sponsor) : null,
        link));
  }

  function btn(kind, labelKey, onclick) {
    return h('button', { type: 'button', class: 'btn btn--ghost btn--icon ad-banner__btn', dataset: { adAction: kind }, 'aria-label': t(labelKey), title: t(labelKey), onclick }, glyph(PATHS[kind]));
  }

  function paint() {
    const act = document.activeElement;
    const focused = root.contains(act) ? act.dataset?.adAction : null;
    const onLink = root.contains(act) && act.matches?.('.ad-banner__link');   // keyboard users keep their place
    wipe();
    const box = root;
    if (!ads.length) return;
    const multi = ads.length > 1;
    const userPaused = rot.has('user');
    const stage = h('div', { class: 'ad-banner__stage' }, slide(ads[rot.index], rot.index));
    const controls = multi ? h('div', { class: 'ad-banner__controls' },
      btn('prev', 'ads.prev', () => rot.prev()),
      h('span', { class: 'ad-banner__pos', 'aria-hidden': 'true' }, t('ads.position', { n: rot.index + 1, total: ads.length })),
      btn('next', 'ads.next', () => rot.next()),
      reduced?.matches ? null : btn(userPaused ? 'play' : 'pause', userPaused ? 'ads.play' : 'ads.pause', () => { pause('user', !rot.has('user')); paint(); })) : null;
    const bar = h('div', { class: 'ad-banner', role: 'group', 'aria-roledescription': 'carousel', 'aria-label': t('ads.region'), dataset: { count: String(ads.length), paused: String(rot.paused) } }, stage, controls);
    box.append(bar);
    if (focused) bar.querySelector(`[data-ad-action="${focused === 'pause' || focused === 'play' ? (userPaused ? 'play' : 'pause') : focused}"]`)?.focus();
    if (onLink) bar.querySelector('.ad-banner__link')?.focus();
    // a rebuilt DOM fires no focusout for the old node: recompute the keyboard-focus pause from where the focus really is
    const a = document.activeElement;
    rot.setPause('focus', multi && root.contains(a) && !!a.matches?.(':focus-visible'));
    syncLive();
  }

  function announce() { const a = ads[rot.index]; status.textContent = a ? `${t('ads.slide', { n: rot.index + 1, total: ads.length })}: ${a.kind === 'sponsor' ? t('ads.label') : t('ads.internal')}. ${a.headline}` : ''; }

  /** Auto-rotating: the slide is not announced. Paused / user-driven: announce changes politely (W3C carousel pattern). */
  function syncLive() {
    const stage = root.querySelector('.ad-banner__stage');
    const bar = root.querySelector('.ad-banner');
    if (bar) bar.dataset.paused = String(rot.paused);
  }
  const pause = (reason, on) => { rot.setPause(reason, on); syncLive(); };

  // listeners live on the persistent slot, not on the (re)built banner, so a re-render can never strand a pause
  root.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse' && ads.length > 1) pause('hover', true); });
  root.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') pause('hover', false); });
  root.addEventListener('focusin', (e) => { if (ads.length > 1 && e.target.matches?.(':focus-visible')) pause('focus', true); });
  root.addEventListener('focusout', (e) => { if (!root.contains(e.relatedTarget)) pause('focus', false); });

  function applyReady(list) {
    ads = list;
    root.removeAttribute('aria-busy');
    rot.destroy();
    rot = createRotation({ interval, count: ads.length, onChange: (i, why) => { paint(); impression(); if (why === 'manual') announce(); } });
    rot.setPause('hidden', !!document.hidden);
    rot.setPause('motion', !!reduced?.matches);
    setState('ready');
    show(true);
    paint();
    impression();
  }

  function applyNone(state) {
    ads = [];
    rot.destroy();
    wipe();
    status.textContent = '';
    root.removeAttribute('aria-busy');
    setState(state);
    show(false);
  }

  /** Never rejects. */
  function load() {
    if (loading) return loading;
    if (!enabled()) { applyNone('off'); return Promise.resolve(); }
    // reserve the room only when the last visit showed an ad: no jump when it arrives, no empty box for supporters
    if (!ads.length && hint.get()) {
      wipe();
      root.append(h('div', { class: 'ad-banner ad-banner--loading', 'aria-hidden': 'true' }, h('span', { class: 'ad-banner__bar' }), h('span', { class: 'ad-banner__bar ad-banner__bar--short' })));
      root.setAttribute('aria-busy', 'true');
      setState('loading');
      show(true);
    }
    loading = (async () => {
      const r = await resolveAds(send);
      loadedAt = Date.now();
      if (r.state === 'ready') { retries = 0; hint.set(true); applyReady(r.ads); }
      else {
        hint.set(false);
        applyNone(r.state);
        if (r.state === 'error' && retries < 2) { retries++; clearTimeout(retryTimer); retryTimer = setTimeout(load, 60000 * retries); }
      }
    })().catch(() => applyNone('error')).finally(() => { loading = null; });
    return loading;
  }

  document.addEventListener('visibilitychange', () => {
    pause('hidden', !!document.hidden);
    if (!document.hidden) {
      if (loadedAt && Date.now() - loadedAt > STALE_MS) load();
      else impression();
    }
  });
  // a tab that stays open: re-check eligibility (supporter paid elsewhere, campaign paused) while visible
  setInterval(() => { if (!document.hidden && enabled() && !loading) { loadedAt = 0; load(); } }, REVALIDATE_MS);
  reduced?.addEventListener?.('change', () => { rot.setPause('motion', reduced.matches); if (ads.length) paint(); });

  return {
    /** First load. */
    start: () => load(),
    /** After the subscription changed (e.g. the supporter paid): ask again, now. */
    refresh: () => { retries = 0; loadedAt = 0; clearTimeout(retryTimer); return loading ? loading.then(load) : load(); },
    /** Cheap, no network unless the mode changed: packer / locked screen starting or ending after the first load. */
    sync: () => { if (!enabled()) { if (root.dataset.adState !== 'off') applyNone('off'); } else if (root.dataset.adState === 'off') return load(); },
    /** Re-render in the new language. */
    rerender: () => { if (ads.length) paint(); },
    get state() { return root.dataset.adState || 'idle'; },
    rotation: () => rot,
  };
}
