/**
 * SaudaPulse — subscription client (service worker only).
 *
 * Login: email + one-time code (Supabase Auth, /auth/v1/otp + /auth/v1/verify).
 * Licence: RPC get_license() → status trial | active | expired, store limit,
 * pricing, payment details, open invoice. Invoices: RPC create_invoice().
 * The session (tokens) never leaves the worker; pages get a plain licence view.
 */
import { BILLING } from '../shared/billing-config.js';
import { createLicenseVerifier } from '../shared/license-signature.js';

const SESSION_KEY = 'ksh.session';
const LAST_USER_KEY = 'ksh.lastUser';
/** Per-account data on this computer (support questions, «ответ помог?» marks, unsent usage counts). */
const ACCOUNT_KEYS = ['ksh.tickets', 'ksh.csat', 'ksh.usage', 'ksh.tg'];
const LICENSE_KEY = 'ksh.license';
const DAY = 86400000;

export const isConfigured = () => !!(BILLING.supabaseUrl && BILLING.supabaseAnonKey);

/** Error with a code the UI can translate (errors.<code>). */
export class BillingError extends Error {
  constructor(code, detail = '', status = 0) {
    super(code);
    this.code = code;
    this.detail = detail;
    this.status = status; // HTTP status of the server answer (0 = no answer)
  }
}

const get = async (k) => (await chrome.storage.local.get(k))[k] ?? null;
const set = (k, v) => chrome.storage.local.set({ [k]: v }).catch((e) => console.warn('[ksh.billing] storage write failed', k, e?.message || e));

// per-worker random factor so many installs do not re-check the licence at the same moment
const REFRESH_JITTER = 0.8 + Math.random() * 0.4;
const BILLING_TIMEOUT_MS = 20000;
async function http(path, { method = 'POST', body, token } = {}) {
  let res;
  try {
    res = await fetch(BILLING.supabaseUrl.replace(/\/$/, '') + path, {
      method,
      headers: {
        apikey: BILLING.supabaseAnonKey,
        Authorization: `Bearer ${token || BILLING.supabaseAnonKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(BILLING_TIMEOUT_MS), // a hung server must not block the sync (licence check)
    });
  } catch (e) {
    throw new BillingError('billingNetwork', e.message);
  }
  let text;
  try {
    text = await res.text();
  } catch (e) {
    throw new BillingError('billingNetwork', e.message);
  }
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = String(data?.message || data?.msg || data?.error_description || data?.error || '');
    // Postgres exceptions raised by our SQL functions carry a stable code in `message`.
    const known = ['invalid_phone', 'invalid_months', 'invalid_stores', 'terms_required', 'rate_limited', 'subscription_required', 'store_limit', 'invalid_shop', 'not_authenticated', 'forbidden',
      'owner_subscription_required', 'not_invited', 'access_disabled', 'invite_self', 'team_limit', 'not_found', 'ticket_limit',
      'boost_used', 'boost_not_needed', 'offer_used', 'invalid_choice', 'bot_not_configured'];
    const hit = known.find((k) => msg.includes(k));
    if (hit) throw new BillingError(`billing_${hit}`, msg, res.status);
    // Supabase Auth: "captcha protection: request disallowed (...)", error_code captcha_failed
    if (/captcha/i.test(msg) || data?.error_code === 'captcha_failed') throw new BillingError('billingCaptcha', msg, res.status);
    if (path.startsWith('/auth/v1/verify')) throw new BillingError('billingBadCode', msg, res.status);
    if (res.status === 429) throw new BillingError('billingRateLimit', msg, res.status);
    if (res.status === 401 || res.status === 403) throw new BillingError('billingAuth', msg, res.status);
    throw new BillingError('billingHttp', `${res.status} ${msg}`.trim(), res.status);
  }
  return data;
}

async function saveSession(s, fallbackUser = {}) {
  await set(SESSION_KEY, {
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_at: Date.now() + (s.expires_in || 3600) * 1000,
    email: s.user?.email || fallbackUser.email || null,
    user_id: s.user?.id || fallbackUser.id || null,
  });
}

/** Body of /auth/v1/otp; the captcha token (shared/captcha.js) goes where Supabase Auth reads it.
 *  data.lang is saved in a NEW user's metadata, so the first login e-mail is in the interface language. */
export function otpBody(email, captchaToken, lang) {
  const body = { email, create_user: true, data: { lang: uiLang(lang) } };
  if (typeof captchaToken === 'string' && captchaToken && captchaToken.length < 4096) body.gotrue_meta_security = { captcha_token: captchaToken };
  return body;
}

/** Step 1: e-mail a one-time code (creates the account on first login → trial starts). */
export async function requestCode(email, captchaToken, lang) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BillingError('billingBadEmail');
  await http('/auth/v1/otp', { body: otpBody(email, captchaToken, lang) });
  return { ok: true };
}

/** Step 2: exchange the code for a session. */
export async function verifyCode(email, code) {
  const token = String(code || '').replace(/\s/g, '');
  if (!/^\d{6,10}$/.test(token)) throw new BillingError('billingBadCode');
  const s = await http('/auth/v1/verify', { body: { type: 'email', email: String(email).trim().toLowerCase(), token } });
  if (!s?.access_token) throw new BillingError('billingBadCode');
  await saveSession(s);
  await set(LICENSE_KEY, null);
  // another account on this computer: its questions, ratings and unsent counts are not ours
  const last = await get(LAST_USER_KEY);
  if (last && s.user?.id && last !== s.user.id) await chrome.storage.local.remove(ACCOUNT_KEYS);
  if (s.user?.id) await set(LAST_USER_KEY, s.user.id);
  await chrome.storage.session.remove('ksh.feedbackDue').catch(() => {});
  return { ok: true };
}

/* ---------- the interface language on the server (029_client_language.sql) ----------
 * The Telegram bot and the login e-mail speak the language the seller chose in the extension.
 * Sent on sign-in and whenever it changes; remembered per user so it is not resent on every wake-up.
 * Fire-and-forget: a failure is retried on the next sign-in, language change or browser start.
 */
const LANG_SYNC_KEY = 'ksh.langSynced';
export const uiLang = (l) => (l === 'kk' ? 'kk' : 'ru');
export async function syncLang(lang) {
  try {
    if (!isConfigured()) return false;
    const l = uiLang(lang);
    const s = await get(SESSION_KEY);
    if (!s?.user_id) return false;
    const mark = `${s.user_id}:${l}`;
    if ((await get(LANG_SYNC_KEY)) === mark) return false;
    await rpc('set_my_lang', { p_lang: l });
    // the login e-mail template reads it from the user's metadata ({{ .Data.lang }})
    const token = await accessToken();
    if (token) await http('/auth/v1/user', { method: 'PUT', body: { data: { lang: l } }, token }).catch(() => {});
    await set(LANG_SYNC_KEY, mark);
    return true;
  } catch {
    return false; // older server without set_my_lang, offline, signed out: try again next time
  }
}

/* ---------- staff (packers): a second, separate session on the owner's computer ----------
 * The packer signs in with their own e-mail code. Their session never replaces the owner's
 * (SESSION_KEY): background/staff.js keeps it apart and checks it every few minutes.
 */

/** Exchange an e-mail code for a session without saving it as the owner's. */
export async function verifyCodeRaw(email, code) {
  const token = String(code || '').replace(/\s/g, '');
  if (!/^\d{6,10}$/.test(token)) throw new BillingError('billingBadCode');
  const s = await http('/auth/v1/verify', { body: { type: 'email', email: String(email).trim().toLowerCase(), token } });
  if (!s?.access_token) throw new BillingError('billingBadCode');
  return { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: Date.now() + (s.expires_in || 3600) * 1000, email: s.user?.email || email, user_id: s.user?.id || null };
}

/** Fresh tokens for a stored (staff) session. */
export async function refreshRaw(session) {
  if (session.expires_at - 60000 > Date.now()) return session;
  const fresh = await http('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: session.refresh_token } });
  return { ...session, access_token: fresh.access_token, refresh_token: fresh.refresh_token, expires_at: Date.now() + (fresh.expires_in || 3600) * 1000 };
}

/** RPC with an explicit token (the staff session). */
export const rpcWith = (token, fn, args = {}) => http(`/rest/v1/rpc/${fn}`, { body: args, token });

/** The owner signed in to the extension on this computer (null when nobody is). */
export const ownerUserId = async () => (await get(SESSION_KEY))?.user_id || null;

/** Owner's team (002_team.sql). */
export const teamList = () => rpc('team_list');
export const teamInvite = ({ email, name, shopIds, canAccept }) => rpc('team_invite', { p_email: email, p_name: name, p_shop_ids: shopIds || [], p_can_accept: !!canAccept });
export const teamUpdate = ({ id, name, shopIds, canAccept }) => rpc('team_update', { p_id: id, p_name: name, p_shop_ids: shopIds || [], p_can_accept: !!canAccept });
export const teamSetEnabled = ({ id, enabled }) => rpc('team_set_enabled', { p_id: id, p_enabled: !!enabled });
export const teamRemove = ({ id }) => rpc('team_remove', { p_id: id });

/** The client ticked «I accept the offer and the privacy policy» → logged on the server. */
export async function acceptTerms() {
  await rpc('accept_terms');
  return licenseView({ force: true });
}

export async function logout() {
  const s = await get(SESSION_KEY);
  if (s?.access_token) await http('/auth/v1/logout', { token: s.access_token }).catch(() => {});
  await chrome.storage.local.remove([SESSION_KEY, LICENSE_KEY]);
  return { ok: true };
}

/**
 * Valid access token, refreshed when about to expire (or now, with force); null when logged out.
 * Single flight: sync, the 15-minute counts, the ticket check and the licence check may all need a
 * fresh token at the same moment — one refresh request serves them all (two parallel refreshes
 * with the same refresh token could make the server revoke the session and log the seller out).
 */
let refreshing = null;
function accessToken(force = false) {
  if (refreshing) return refreshing;
  const p = accessTokenOnce(force).finally(() => {
    if (refreshing === p) refreshing = null;
  });
  // only a real refresh is shared; a still-valid token returns at once
  refreshing = p;
  return p;
}
async function accessTokenOnce(force) {
  const s = await get(SESSION_KEY);
  if (!s) return null;
  if (!force && s.expires_at - 60000 > Date.now()) return s.access_token;
  try {
    const fresh = await http('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: s.refresh_token } });
    await saveSession(fresh, { email: s.email, id: s.user_id });
    return fresh.access_token;
  } catch (e) {
    if (refreshRefused(e)) {
      await chrome.storage.local.remove([SESSION_KEY]); // refresh token revoked/expired → log in again
      return null;
    }
    // No answer, timeout, 5xx or 429: the session is fine, the server is not. Keep it and try
    // again later. A still-valid token can be used; an expired one would only bring a 401 → offline.
    if (s.expires_at > Date.now()) return s.access_token;
    throw new BillingError('billingNetwork', `refresh failed: ${e.code} ${e.status || ''}`.trim());
  }
}
/** Supabase Auth refused the refresh token itself (revoked, expired, unknown): 400/401/403. */
const refreshRefused = (e) => e?.status === 400 || e?.status === 401 || e?.status === 403;

/* ---------- signed licence ----------
 * With BILLING.licenseKeys set, the subscription dates and limits are taken ONLY from
 * the access token, which Supabase Auth signs with the project's private key (the
 * custom_access_token_hook in 001_billing.sql puts the licence into it). Editing
 * chrome.storage, replaying or faking server answers cannot produce a valid signature.
 */
const verifier = createLicenseVerifier({
  keys: () => BILLING.licenseKeys,
  issuer: () => BILLING.supabaseUrl.replace(/\/$/, '') + '/auth/v1',
});
export const signingRequired = () => verifier.required();

/** Claims of a JWT whose ES256/RS256 signature checks out against licenseKeys; otherwise null (see shared/license-signature.js). */
export const verifiedClaims = (jwt, expectedSub = null) => verifier.verifiedClaims(jwt, expectedSub);

const sec = (iso) => (iso ? Math.floor(new Date(iso).getTime() / 1000) : null);
/** Server answer and token disagree (just paid, consent given…) → the token is older. */
const claimsStale = (k, lic) =>
  !k || (k.pu ?? null) !== sec(lic.paid_until) || (k.te ?? null) !== sec(lic.trial_ends_at) || k.sl !== lic.paid_store_limit || (k.tv ?? null) !== (lic.terms_version ?? null) || (k.tr ?? null) !== (lic.terms_required ?? null) ||
  // boost / grace / freeze changed (a 24-hour boost, «Заморозить», «Отменить», payment)
  (k.bu ?? null) !== sec(lic.boost_until) || (k.fu ?? null) !== sec(lic.frozen_until) || (k.gu ?? null) !== sec(lic.grace_until);
// Server state we already refreshed the token for (no refresh loop if the hook is off).
let refreshedFor = null;

/** The licence fields that matter for access, from the signed token. */
async function trustedLicence(lic, fresh) {
  let s = await get(SESSION_KEY);
  let claims = await verifiedClaims(s?.access_token, s?.user_id);
  // Fresh server data newer than the token → get a new token once (throttled).
  const state = JSON.stringify([lic.paid_until, lic.trial_ends_at, lic.paid_store_limit, lic.terms_version, lic.terms_required, lic.boost_until, lic.frozen_until, lic.grace_until]);
  if (fresh && claimsStale(claims?.ksh, lic) && refreshedFor !== state) {
    refreshedFor = state;
    await accessToken(true).catch(() => null); // server down: keep the token we have
    s = await get(SESSION_KEY);
    claims = await verifiedClaims(s?.access_token, s?.user_id);
  }
  return claims?.ksh ? claims : null;
}

async function rpc(fn, args = {}) {
  const token = await accessToken();
  if (!token) throw new BillingError('billingLoggedOut');
  return http(`/rest/v1/rpc/${fn}`, { body: args, token });
}

/**
 * Licence, cached. `force` re-checks online now. On network failure the cached
 * licence is used for up to offlineGraceDays.
 * @param {{ force?: boolean, storeCount?: number }} [opts] storeCount is reported for the owner's admin page
 */
export async function getLicense({ force = false, storeCount, storeKeys } = {}) {
  if (!isConfigured()) return null;
  const cache = await get(LICENSE_KEY);
  // A cache "from the future" was edited by hand → ignore it.
  const age = cache ? Date.now() - cache.fetchedAt : Infinity;
  const usable = cache && age >= -60000;
  const fresh = usable && age < BILLING.refreshMinutes * 60000 * REFRESH_JITTER;
  if (cache && fresh && !force) return cache.data;
  if (!(await get(SESSION_KEY))) return null;
  const args = { p_store_count: storeCount ?? null, p_store_keys: storeKeys?.length ? storeKeys : null };
  try {
    let data;
    try {
      data = await rpc('get_license', args);
    } catch (e) {
      if (e.code !== 'billingAuth') throw e;
      // 401/403 on the licence call: the access token was rejected. Refresh it once and retry;
      // only a refused refresh (accessTokenOnce removes the session) or a second 401 logs out.
      const rejected = (await get(SESSION_KEY))?.access_token;
      const token = await accessToken(true);
      if (!token) throw new BillingError('billingLoggedOut');
      // refresh had no answer and handed back the same token: do not log out over a server hiccup
      if (token === rejected) throw new BillingError('billingNetwork', 'token not refreshed');
      data = await rpc('get_license', args);
    }
    // Server clock offset, so a wrong local clock cannot stretch a licence.
    if (data.features !== undefined && (!data.features || typeof data.features !== 'object' || Array.isArray(data.features))) data.features = {};
    const skew = data.server_time ? new Date(data.server_time).getTime() - Date.now() : 0;
    await set(LICENSE_KEY, { data, fetchedAt: Date.now(), skew });
    return data;
  } catch (e) {
    if (e.code === 'billingLoggedOut' || e.code === 'billingAuth') {
      await chrome.storage.local.remove([SESSION_KEY, LICENSE_KEY]);
      return null;
    }
    if (usable && age < BILLING.offlineGraceDays * DAY) return cache.data;
    reportClientError(`license_${e.code || 'error'}`, 'getLicense');
    throw e;
  }
}

function normalizeBanner(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b) || b.active !== true || typeof b.text !== 'string' || !b.text.trim()) return { active: false };
  return { active: true, text: b.text.trim().slice(0, 300), type: ['info', 'warn', 'danger'].includes(b.type) ? b.type : 'info' };
}

/**
 * What the rest of the extension needs to know — safe to send to pages.
 * status: 'unconfigured' (developer mode) | 'loggedOut' | 'trial' | 'active' | 'expired' | 'offline'
 */
export async function licenseView({ force = false, storeCount, storeKeys } = {}) {
  if (!isConfigured()) return { status: 'unconfigured', canUse: true, storeLimit: null };
  const session = await get(SESSION_KEY);
  if (!session) return { status: 'loggedOut', canUse: false, storeLimit: 0 };
  let lic;
  try {
    lic = await getLicense({ force, storeCount, storeKeys });
  } catch (e) {
    return { status: 'offline', canUse: false, storeLimit: 0, email: session.email, error: e.code };
  }
  if (!lic) return { status: 'loggedOut', canUse: false, storeLimit: 0 };
  const cache = await get(LICENSE_KEY);
  const fresh = !!cache && Math.abs(Date.now() - cache.fetchedAt) < 5000;
  // Server clock offset; a stored value is clamped so editing it cannot rewind time far.
  const skew = Math.max(-DAY, Math.min(DAY, Number(cache?.skew) || 0));
  let now = Date.now() + skew;

  // Access-relevant fields: from the signed token when signing is configured.
  let paidUntil = lic.paid_until;
  let trialEnds = lic.trial_ends_at;
  let paidLimit = lic.paid_store_limit;
  let trialLimit = lic.store_limit;
  let termsOk = !lic.terms_required || lic.terms_version === lic.terms_required;
  let boostUntil = lic.boost_until;
  let graceUntil = lic.grace_until;
  let frozenUntil = lic.frozen_until;
  let baseStores = lic.pricing?.base_stores || 3;
  if (signingRequired()) {
    const claims = await trustedLicence(lic, fresh);
    if (!claims) return { status: 'invalid', canUse: false, storeLimit: 0, email: session.email, error: 'licenseInvalid' };
    const k = claims.ksh;
    const iat = (claims.iat || 0) * 1000;
    if (now < iat - 10 * 60000) return { status: 'clock', canUse: false, storeLimit: 0, email: session.email, error: 'licenseClock' }; // clock turned back
    now = Math.max(now, iat);
    // A token that expired long ago (network blocked to keep an old licence) stops working.
    if ((claims.exp || 0) * 1000 + BILLING.offlineGraceDays * DAY < now) return { status: 'offline', canUse: false, storeLimit: 0, email: session.email, error: 'billingNetwork' };
    paidUntil = k.pu ? new Date(k.pu * 1000).toISOString() : null;
    trialEnds = k.te ? new Date(k.te * 1000).toISOString() : null;
    paidLimit = k.sl;
    trialLimit = Math.max(k.tsl || 0, k.sl || 0);
    termsOk = !k.tr || k.tv === k.tr;
    const iso = (sec) => (sec ? new Date(sec * 1000).toISOString() : null);
    boostUntil = iso(k.bu);
    graceUntil = iso(k.gu);
    frozenUntil = iso(k.fu);
    baseStores = k.bs || baseStores;
  }

  // Dates are re-evaluated locally so a licence ends on time even between checks.
  const after = (iso) => !!iso && new Date(iso).getTime() > now;
  const frozen = after(frozenUntil);
  const paid = !frozen && after(paidUntil);
  const trial = !frozen && !paid && after(trialEnds);
  // paid period over, renewal not paid yet (not cancelled): grace days with full access
  const grace = !frozen && !paid && !trial && after(graceUntil);
  const status = frozen ? 'frozen' : paid ? 'active' : trial ? 'trial' : grace ? 'grace' : 'expired';
  let storeLimit = ['expired', 'frozen'].includes(status) ? 0 : (paid || grace ? paidLimit : trialLimit) || lic.pricing?.base_stores || 3;
  const boosted = (paid || grace) && after(boostUntil);
  if (boosted) storeLimit = Math.max(storeLimit, baseStores);
  // Stores of this login in use on other computers right now count against the same limit.
  const sharedStores = Math.max(0, Math.floor(Number(lic.shared_stores) || 0));
  if (sharedStores && storeLimit != null) storeLimit = Math.max(0, storeLimit - sharedStores);
  const coverageEnd = paid ? paidUntil : trial ? trialEnds : grace ? graceUntil : paidUntil || trialEnds;
  const msLeft = coverageEnd ? new Date(coverageEnd).getTime() - now : 0;
  const remindDays = lic.remind_days ?? 5;
  // Offer/policy not accepted (or a new version published) → nothing works until the box is ticked.
  const needsConsent = !termsOk;
  return {
    status,
    canUse: !['expired', 'frozen'].includes(status) && !needsConsent,
    plan: (paidLimit || 0) <= 1 && lic.pricing?.start_price ? 'start' : 'multi',
    boostUntil: boosted ? boostUntil : null,
    canBoost: !!lic.can_boost && paid,
    graceUntil: grace ? graceUntil : null,
    frozenUntil: frozen ? frozenUntil : null,
    cancelAt: lic.cancel_at || null,
    downgradeNext: !!lic.downgrade_next,
    discount: lic.discount || null,
    needsConsent,
    signed: signingRequired(),
    trialBlocked: !!lic.trial_blocked,
    termsVersion: lic.terms_required || null,
    termsAcceptedAt: lic.terms_accepted_at || null,
    features: lic.features && typeof lic.features === 'object' && !Array.isArray(lic.features) ? lic.features : {},
    systemBanner: normalizeBanner(lic.system_banner),
    storeLimit,
    sharedStores,
    coverageEnd,
    daysLeft: Math.max(0, Math.ceil(msLeft / DAY)),
    remindDays,
    renewalDue: status === 'expired' || msLeft <= remindDays * DAY,
    email: lic.email || session.email,
    phone: lic.phone,
    phoneVerified: lic.phone_verified === true,
    trialEndsAt: trialEnds,
    paidUntil,
    pricing: lic.pricing,
    payment: lic.payment,
    pendingInvoice: lic.pending_invoice,
    invoices: lic.invoices || [],
    checkedAt: cache?.fetchedAt || null,
  };
}

const FUNNEL_EVENTS = new Set(['onboarding_completed', 'first_sync_done', 'trial_expired_view', 'invoice_created', 'referral_shared']);
const FUNNEL_KEY = 'ksh.funnelSent';
const errThrottle = new Map();
/**
 * Anonymous error report (short code + context only; the server strips anything personal anyway).
 * Fire-and-forget: never throws, skips when signed out, same code+context at most once per 10 min.
 */
export function reportClientError(code, context = '') {
  try {
    if (!isConfigured()) return;
    const c = String(code ?? '').slice(0, 120);
    const x = String(context ?? '').slice(0, 120);
    if (!c) return;
    const key = `${c}|${x}`;
    const now = Date.now();
    if (now - (errThrottle.get(key) || 0) < 10 * 60000) return;
    if (errThrottle.size >= 50 && !errThrottle.has(key)) errThrottle.delete(errThrottle.keys().next().value);
    errThrottle.set(key, now);
    (async () => {
      try {
        if (!(await accessToken())) return;
        const version = typeof chrome !== 'undefined' ? chrome.runtime?.getManifest?.().version || '' : '';
        await rpc('report_client_error', { p_code: c, p_context: x, p_version: String(version).slice(0, 120) });
      } catch { /* telemetry must never break anything */ }
    })();
  } catch { /* ignore */ }
}

const UX_TYPES = new Set(['screen_view', 'action_click', 'rage_click', 'form_abandoned', 'help_opened']);
const UX_KEY = /^[a-z0-9_:-]{1,64}$/;
const uxOk = (k) => typeof k === 'string' && UX_KEY.test(k) && !/^[0-9]+$/.test(k);
/**
 * Anonymous UX counters from the dashboard (shared/ux-telemetry.js): a batch of {t, k, s, n}.
 * Only whitelisted codes pass (re-validated here and again on the server), at most 50 events,
 * n capped at 5. The whole batch goes in ONE request (track_ux_events, 027_ux_events_batch.sql);
 * before it was one request per event and repeat — up to 250 per batch.
 * Fire-and-forget: never throws, skips when signed out / not configured. If the server has no
 * track_ux_events yet (migration not applied), the batch is dropped: telemetry must not add load.
 */
export function trackUxEvents(events) {
  (async () => {
    try {
      const batch = uxBatch(events);
      if (!batch.length || !isConfigured() || !(await accessToken())) return;
      await rpc('track_ux_events', { p_events: batch });
    } catch { /* telemetry must never break anything */ }
  })();
}

/** Valid events only, as sent to track_ux_events: [{t, k, s, n 1..5}], at most 50. */
export function uxBatch(events) {
  if (!Array.isArray(events)) return [];
  return events
    .filter((e) => e && UX_TYPES.has(e.t) && uxOk(e.k) && uxOk(e.s))
    .slice(0, 50)
    .map((e) => ({ t: e.t, k: e.k, s: e.s, n: Math.min(Math.max(Math.floor(Number(e.n)) || 1, 1), 5) }));
}

const funnelPending = new Set();
/**
 * Product funnel milestone, sent at most once per event (the server also dedups). Fire-and-forget:
 * callers do not await it; never throws, skips silently when signed out or offline (retried next time).
 */
export function trackFunnel(event) {
  (async () => {
    try {
      if (!FUNNEL_EVENTS.has(event) || funnelPending.has(event) || !isConfigured()) return;
      funnelPending.add(event);
      try {
        const sent = (await get(FUNNEL_KEY)) || [];
        if (sent.includes(event)) return;
        if (!(await accessToken())) return;
        await rpc('track_funnel_event', { p_event: event });
        await set(FUNNEL_KEY, [...new Set([...sent, event])]);
      } finally { funnelPending.delete(event); }
    } catch { /* telemetry must never break anything */ }
  })();
}

export async function createInvoice({ stores, months, phone }) {
  await rpc('create_invoice', { p_stores: Number(stores), p_months: Number(months), p_phone: String(phone || '') });
  trackFunnel('invoice_created');
  return licenseView({ force: true });
}

/**
 * Keep the bill in line with reality (idempotent, server decides the amount):
 *  - within remind_days of the end, or expired → one renewal invoice for ALL stores;
 *  - more stores connected than covered → add-on invoice (prorated to the period end).
 * @param {number} storeCount enabled stores in the extension
 * @returns {Promise<boolean>} true when the server was asked (licence then re-read)
 */
export async function reconcileInvoice(storeCount, view) {
  if (!isConfigured() || !view || ['loggedOut', 'offline', 'unconfigured', 'invalid', 'clock'].includes(view.status)) return false;
  if (view.renewalDue) await rpc('ensure_renewal_invoice', { p_stores: storeCount });
  else if (storeCount > view.storeLimit) await rpc('request_store_addon', { p_total_stores: storeCount });
  else return false;
  return true;
}

export async function requestAddon({ total }) {
  await rpc('request_store_addon', { p_total_stores: Number(total) });
  return licenseView({ force: true });
}

export async function setPhone({ phone }) {
  await rpc('set_my_phone', { p_phone: String(phone || '') });
  return licenseView({ force: true });
}

export async function cancelInvoice({ id }) {
  await rpc('cancel_my_invoice', { p_id: Number(id) });
  return licenseView({ force: true });
}

/* ---------------- support: service status, tickets, API health ---------------- */

/** Owner's notice for every client («Kaspi не отвечает, чиним»). Works before login (anon key). */
export async function serviceStatus() {
  if (!isConfigured()) return { level: 'ok' };
  return (await http('/rest/v1/rpc/get_service_status', { body: {} })) || { level: 'ok' };
}

export const signedIn = async () => !!(await get(SESSION_KEY));

export async function ticketCreate({ topic, message, report, version }) {
  return rpc('ticket_create', { p_topic: String(topic || 'other'), p_message: String(message || '').slice(0, 2000), p_report: report ? String(report).slice(0, 8000) : null, p_version: version ? String(version).slice(0, 40) : null });
}
export const myTickets = () => rpc('my_tickets', {});
export const ticketSeen = ({ id }) => rpc('ticket_seen', { p_id: Number(id) });
export const ticketClose = ({ id }) => rpc('ticket_close', { p_id: Number(id) });

/** Counts of marketplace API calls (no data): [{market, ok, fail, kinds}] */
export const healthReport = (list) => rpc('health_report', { p: list });

/* ---------------- control panel: usage counts and surveys ---------------- */
export const usageReport = (steps, days, version) => rpc('usage_report', { p_steps: steps, p_days: days, p_version: version || null });
export const feedbackDue = () => rpc('feedback_due', {});
export const feedbackSubmit = ({ kind, score = null, reason = null, comment = null, ticket = null }) =>
  rpc('feedback_submit', { p_kind: String(kind), p_score: score == null ? null : Number(score), p_reason: reason, p_comment: comment ? String(comment).slice(0, 1000) : null, p_ticket: ticket == null ? null : Number(ticket) });

/* ---------------- growth: plans, cancellation flow, Telegram ---------------- */
/** The signed-in seller's access token (refreshed if needed) — for the bot function. */
export const currentToken = () => accessToken();
export const upgradeQuote = (stores) => rpc('upgrade_quote', { p_stores: stores });
export const trialBoost = () => rpc('start_trial_boost', {});
export const cancelFlow = ({ reason, outcome, comment }) => rpc('cancel_flow', { p_reason: String(reason), p_outcome: String(outcome), p_comment: comment ? String(comment).slice(0, 1000) : null });
export const resumeSubscription = () => rpc('resume_subscription', {});
export const referralInfo = () => rpc('my_referral', {});
export const applyReferral = (code) => rpc('apply_referral_code', { p_code: String(code || '').slice(0, 32) });
export const tgStatus = () => rpc('tg_status', {});
export const tgLinkCreate = () => rpc('tg_link_create', {});
export const tgSettings = ({ digest, alerts }) => rpc('tg_settings', { p_digest: digest, p_alerts: alerts });
export const tgUnlink = () => rpc('tg_unlink', {});
export const digestReport = (day, stats) => rpc('digest_report', { p_day: day, p_stats: stats });
