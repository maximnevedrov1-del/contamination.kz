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
    const known = ['invalid_phone', 'invalid_months', 'invalid_stores', 'not_authenticated', 'forbidden'];
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

export async function logout() {
  const s = await get(SESSION_KEY);
  if (s?.access_token) await http('/auth/v1/logout', { token: s.access_token }).catch(() => {});
  await chrome.storage.local.remove([SESSION_KEY, LICENSE_KEY]);
  return { ok: true };
}

/** Valid access token, refreshed when about to expire; null when logged out. */
async function accessToken() {
  const s = await get(SESSION_KEY);
  if (!s) return null;
  if (s.expires_at - 60000 > Date.now()) return s.access_token;
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
export async function getLicense({ force = false, storeCount } = {}) {
  if (!isConfigured()) return null;
  const cache = await get(LICENSE_KEY);
  const fresh = cache && Date.now() - cache.fetchedAt < BILLING.refreshMinutes * 60000;
  if (cache && fresh && !force) return cache.data;
  if (!(await get(SESSION_KEY))) return null;
  try {
    const data = await rpc('get_license', { p_store_count: storeCount ?? null });
    // Server clock offset, so a wrong local clock cannot stretch a licence.
    const skew = data.server_time ? new Date(data.server_time).getTime() - Date.now() : 0;
    await set(LICENSE_KEY, { data, fetchedAt: Date.now(), skew });
    return data;
  } catch (e) {
    if (e.code === 'billingLoggedOut' || e.code === 'billingAuth') {
      await chrome.storage.local.remove([SESSION_KEY, LICENSE_KEY]);
      return null;
    }
    if (cache && Date.now() - cache.fetchedAt < BILLING.offlineGraceDays * DAY) return cache.data;
    throw e;
  }
}

/**
 * What the rest of the extension needs to know — safe to send to pages.
 * status: 'unconfigured' (developer mode) | 'loggedOut' | 'trial' | 'active' | 'expired' | 'offline'
 */
export async function licenseView({ force = false, storeCount } = {}) {
  if (!isConfigured()) return { status: 'unconfigured', canUse: true, storeLimit: null };
  const session = await get(SESSION_KEY);
  if (!session) return { status: 'loggedOut', canUse: false, storeLimit: 0 };
  let lic;
  try {
    lic = await getLicense({ force, storeCount });
  } catch (e) {
    return { status: 'offline', canUse: false, storeLimit: 0, email: session.email, error: e.code };
  }
  if (!lic) return { status: 'loggedOut', canUse: false, storeLimit: 0 };
  const cache = await get(LICENSE_KEY);
  const now = Date.now() + (cache?.skew || 0);
  // Dates are re-evaluated locally so a licence ends on time even between checks.
  const paid = lic.paid_until && new Date(lic.paid_until).getTime() > now;
  const trial = !paid && lic.trial_ends_at && new Date(lic.trial_ends_at).getTime() > now;
  const status = paid ? 'active' : trial ? 'trial' : 'expired';
  const storeLimit = status === 'expired' ? 0 : lic.store_limit || lic.paid_store_limit || lic.pricing?.base_stores || 3;
  const coverageEnd = lic.coverage_end || (paid ? lic.paid_until : lic.trial_ends_at);
  const msLeft = coverageEnd ? new Date(coverageEnd).getTime() - now : 0;
  const remindDays = lic.remind_days ?? 5;
  return {
    status,
    canUse: status !== 'expired',
    storeLimit,
    coverageEnd,
    daysLeft: Math.max(0, Math.ceil(msLeft / DAY)),
    remindDays,
    renewalDue: status === 'expired' || msLeft <= remindDays * DAY,
    email: lic.email || session.email,
    phone: lic.phone,
    trialEndsAt: lic.trial_ends_at,
    paidUntil: lic.paid_until,
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
  if (!isConfigured() || !view || ['loggedOut', 'offline', 'unconfigured'].includes(view.status)) return false;
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
