/**
 * Kaspi Seller Hub — subscription client (service worker only).
 *
 * Login: email + one-time code (Supabase Auth, /auth/v1/otp + /auth/v1/verify).
 * Licence: RPC get_license() → status trial | active | expired, store limit,
 * pricing, payment details, open invoice. Invoices: RPC create_invoice().
 * The session (tokens) never leaves the worker; pages get a plain licence view.
 */
import { BILLING } from '../shared/billing-config.js';

const SESSION_KEY = 'ksh.session';
const LICENSE_KEY = 'ksh.license';
const DAY = 86400000;

export const isConfigured = () => !!(BILLING.supabaseUrl && BILLING.supabaseAnonKey);

/** Error with a code the UI can translate (errors.<code>). */
class BillingError extends Error {
  constructor(code, detail = '') {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

const get = async (k) => (await chrome.storage.local.get(k))[k] ?? null;
const set = (k, v) => chrome.storage.local.set({ [k]: v });

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
    });
  } catch (e) {
    throw new BillingError('billingNetwork', e.message);
  }
  const text = await res.text();
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
      'owner_subscription_required', 'not_invited', 'access_disabled', 'invite_self', 'team_limit', 'not_found'];
    const hit = known.find((k) => msg.includes(k));
    if (hit) throw new BillingError(`billing_${hit}`);
    if (path.startsWith('/auth/v1/verify')) throw new BillingError('billingBadCode', msg);
    if (res.status === 429) throw new BillingError('billingRateLimit', msg);
    if (res.status === 401 || res.status === 403) throw new BillingError('billingAuth', msg);
    throw new BillingError('billingHttp', `${res.status} ${msg}`.trim());
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

/** Step 1: e-mail a one-time code (creates the account on first login → trial starts). */
export async function requestCode(email) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BillingError('billingBadEmail');
  await http('/auth/v1/otp', { body: { email, create_user: true } });
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
  return { ok: true };
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

/** Valid access token, refreshed when about to expire (or now, with force); null when logged out. */
async function accessToken(force = false) {
  const s = await get(SESSION_KEY);
  if (!s) return null;
  if (!force && s.expires_at - 60000 > Date.now()) return s.access_token;
  try {
    const fresh = await http('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: s.refresh_token } });
    await saveSession(fresh, { email: s.email, id: s.user_id });
    return fresh.access_token;
  } catch (e) {
    if (e.code === 'billingNetwork') return s.access_token; // try again later
    await chrome.storage.local.remove([SESSION_KEY]); // refresh token revoked/expired → log in again
    return null;
  }
}

/* ---------- signed licence ----------
 * With BILLING.licenseKeys set, the subscription dates and limits are taken ONLY from
 * the access token, which Supabase Auth signs with the project's private key (the
 * custom_access_token_hook in 001_billing.sql puts the licence into it). Editing
 * chrome.storage, replaying or faking server answers cannot produce a valid signature.
 */
export const signingRequired = () => Array.isArray(BILLING.licenseKeys) && BILLING.licenseKeys.length > 0;

const b64url = (str) => {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
const ALGS = {
  ES256: { kty: 'EC', import: { name: 'ECDSA', namedCurve: 'P-256' }, verify: { name: 'ECDSA', hash: 'SHA-256' } },
  RS256: { kty: 'RSA', import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verify: { name: 'RSASSA-PKCS1-v1_5' } },
};
let keysPromise = null;
function verifyingKeys() {
  keysPromise ??= Promise.all(
    BILLING.licenseKeys.map(async (jwk) => {
      const alg = Object.keys(ALGS).find((a) => ALGS[a].kty === jwk.kty);
      if (!alg) return null;
      const { kty, crv, x, y, n, e } = jwk; // public parts only
      const key = await crypto.subtle.importKey('jwk', { kty, crv, x, y, n, e }, ALGS[alg].import, false, ['verify']).catch(() => null);
      return key && { kid: jwk.kid || null, alg, key };
    }),
  ).then((list) => list.filter(Boolean));
  return keysPromise;
}

/** Claims of a JWT whose signature checks out against licenseKeys; otherwise null. */
export async function verifiedClaims(jwt, expectedSub = null) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64url(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64url(parts[1])));
  } catch {
    return null;
  }
  if (!ALGS[header?.alg]) return null; // never "none" or HS256 (symmetric: the secret would have to ship in the extension)
  const iss = BILLING.supabaseUrl.replace(/\/$/, '') + '/auth/v1';
  if (payload.iss !== iss || (expectedSub && payload.sub !== expectedSub)) return null;
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const sig = b64url(parts[2]);
  for (const k of await verifyingKeys()) {
    if (k.alg !== header.alg || (header.kid && k.kid && k.kid !== header.kid)) continue;
    if (await crypto.subtle.verify(ALGS[k.alg].verify, k.key, sig, data).catch(() => false)) return payload;
  }
  return null;
}

const sec = (iso) => (iso ? Math.floor(new Date(iso).getTime() / 1000) : null);
/** Server answer and token disagree (just paid, consent given…) → the token is older. */
const claimsStale = (k, lic) =>
  !k || (k.pu ?? null) !== sec(lic.paid_until) || (k.te ?? null) !== sec(lic.trial_ends_at) || k.sl !== lic.paid_store_limit || (k.tv ?? null) !== (lic.terms_version ?? null) || (k.tr ?? null) !== (lic.terms_required ?? null);
// Server state we already refreshed the token for (no refresh loop if the hook is off).
let refreshedFor = null;

/** The licence fields that matter for access, from the signed token. */
async function trustedLicence(lic, fresh) {
  let s = await get(SESSION_KEY);
  let claims = await verifiedClaims(s?.access_token, s?.user_id);
  // Fresh server data newer than the token → get a new token once (throttled).
  const state = JSON.stringify([lic.paid_until, lic.trial_ends_at, lic.paid_store_limit, lic.terms_version, lic.terms_required]);
  if (fresh && claimsStale(claims?.ksh, lic) && refreshedFor !== state) {
    refreshedFor = state;
    await accessToken(true);
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
  const fresh = usable && age < BILLING.refreshMinutes * 60000;
  if (cache && fresh && !force) return cache.data;
  if (!(await get(SESSION_KEY))) return null;
  try {
    const data = await rpc('get_license', { p_store_count: storeCount ?? null, p_store_keys: storeKeys?.length ? storeKeys : null });
    // Server clock offset, so a wrong local clock cannot stretch a licence.
    const skew = data.server_time ? new Date(data.server_time).getTime() - Date.now() : 0;
    await set(LICENSE_KEY, { data, fetchedAt: Date.now(), skew });
    return data;
  } catch (e) {
    if (e.code === 'billingLoggedOut' || e.code === 'billingAuth') {
      await chrome.storage.local.remove([SESSION_KEY, LICENSE_KEY]);
      return null;
    }
    if (usable && age < BILLING.offlineGraceDays * DAY) return cache.data;
    throw e;
  }
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
  }

  // Dates are re-evaluated locally so a licence ends on time even between checks.
  const paid = !!paidUntil && new Date(paidUntil).getTime() > now;
  const trial = !paid && !!trialEnds && new Date(trialEnds).getTime() > now;
  const status = paid ? 'active' : trial ? 'trial' : 'expired';
  const storeLimit = status === 'expired' ? 0 : (paid ? paidLimit : trialLimit) || lic.pricing?.base_stores || 3;
  const coverageEnd = paid ? paidUntil : trialEnds;
  const msLeft = coverageEnd ? new Date(coverageEnd).getTime() - now : 0;
  const remindDays = lic.remind_days ?? 5;
  // Offer/policy not accepted (or a new version published) → nothing works until the box is ticked.
  const needsConsent = !termsOk;
  return {
    status,
    canUse: status !== 'expired' && !needsConsent,
    needsConsent,
    signed: signingRequired(),
    trialBlocked: !!lic.trial_blocked,
    termsVersion: lic.terms_required || null,
    termsAcceptedAt: lic.terms_accepted_at || null,
    storeLimit,
    coverageEnd,
    daysLeft: Math.max(0, Math.ceil(msLeft / DAY)),
    remindDays,
    renewalDue: status === 'expired' || msLeft <= remindDays * DAY,
    email: lic.email || session.email,
    phone: lic.phone,
    trialEndsAt: trialEnds,
    paidUntil,
    pricing: lic.pricing,
    payment: lic.payment,
    pendingInvoice: lic.pending_invoice,
    invoices: lic.invoices || [],
    checkedAt: cache?.fetchedAt || null,
  };
}

export async function createInvoice({ stores, months, phone }) {
  await rpc('create_invoice', { p_stores: Number(stores), p_months: Number(months), p_phone: String(phone || '') });
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

/* ---------------- price-list feeds (Supabase Storage) ---------------- */

/** Secret feed of one store (created on first use). */
export async function ensureFeed(shopKey) {
  return rpc('ensure_price_feed', { p_shop_key: shopKey });
}

/** Public URL Kaspi fetches the price list from. */
export const feedUrl = (feedId, shopKey) => `${BILLING.supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/pricelists/${feedId}/${shopKey}.xml`;

/** Upload (overwrite) the store's XML price list. */
export async function uploadFeed(feedId, shopKey, xml) {
  const token = await accessToken();
  if (!token) throw new BillingError('billingLoggedOut');
  let res;
  try {
    res = await fetch(`${BILLING.supabaseUrl.replace(/\/$/, '')}/storage/v1/object/pricelists/${feedId}/${shopKey}.xml`, {
      method: 'POST',
      headers: { apikey: BILLING.supabaseAnonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/xml', 'x-upsert': 'true', 'cache-control': 'max-age=60' },
      body: new Blob([xml], { type: 'application/xml' }),
    });
  } catch (e) {
    throw new BillingError('billingNetwork', e.message);
  }
  if (res.status === 413) throw new BillingError('feedTooLarge');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Storage answers 400 {"statusCode":"403","message":"new row violates row-level security policy"}
    if (res.status === 401 || res.status === 403 || /row-level security|"403"|Unauthorized/i.test(text)) throw new BillingError('feedForbidden', text.slice(0, 200));
    throw new BillingError('billingHttp', `${res.status} ${text.slice(0, 200)}`);
  }
  return feedUrl(feedId, shopKey);
}
