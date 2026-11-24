/**
 * SaudaPulse — staff (packers) on the owner's warehouse computer.
 *
 *  - The owner invites a packer by e-mail (billing/supabase/002_team.sql) and turns this
 *    computer into a «Компьютер склада»: the owner's dashboard is locked with the owner's PIN.
 *  - The packer signs in once with the code from a letter and chooses a PIN; later they sign in
 *    with e-mail + PIN. Their session is separate from the owner's.
 *  - Every 2 minutes (alarm) the server is asked whether the packer is still allowed. Switched off
 *    by the owner → logged out at once, their saved session is deleted.
 *  - While a packer works, the worker only answers what packing needs (STAFF_ALLOWED), and
 *    only for the stores the owner gave them.
 *
 * Honest limit of stage 1: on a shared computer the extension's local data stays readable to
 * someone who opens the browser's developer tools. Separate devices come with the web version.
 */
import * as B from './billing.js';
import { getSettings, saveSettings } from '../shared/storage.js';

export const ALARM_STAFF = 'ksh-staff-check';
const ROSTER_KEY = 'ksh.staffRoster'; // local: { [email]: { member, session, pin, fails, lockedUntil, lastOkAt } }
const ACTIVE_KEY = 'ksh.staffActive'; // session (cleared when the browser closes): { email, member, lastOkAt }
const OWNER_PIN_KEY = 'ksh.ownerPin'; // local: { hash, salt }
const OWNER_UNLOCK_KEY = 'ksh.ownerUnlocked'; // session: { until }
const CHECK_MINUTES = 2;
const OFFLINE_GRACE_MS = 15 * 60000; // no answer from the server for longer → the packer is logged out
const OWNER_UNLOCK_MS = 8 * 3600000;
const MAX_PIN_FAILS = 5;
const LOCK_MS = 15 * 60000;

const local = chrome.storage.local;
const session = chrome.storage.session;
const get = async (area, k, def) => (await area.get(k))[k] ?? def;

/* ---------- PIN: PBKDF2-SHA-256, never stored in clear ---------- */
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function pinHash(pin, saltHex) {
  const salt = saltHex ? Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16))) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 150000 }, key, 256);
  return { hash: hex(bits), salt: hex(salt) };
}
const validPin = (pin) => /^\d{4,8}$/.test(String(pin || ''));
const sameHash = (a, b) => a.length === b.length && [...a].reduce((d, c, i) => d | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;

/* ---------- state ---------- */
export const warehouseOn = async () => !!(await getSettings()).warehouse?.enabled;
export const activeStaff = () => get(session, ACTIVE_KEY, null);
const ownerUnlocked = async () => (await get(session, OWNER_UNLOCK_KEY, null))?.until > Date.now();
const roster = () => get(local, ROSTER_KEY, {});
const saveRoster = (r) => local.set({ [ROSTER_KEY]: r });

async function signOutStaff(email, { forget = false } = {}) {
  await session.remove(ACTIVE_KEY);
  if (forget && email) {
    const r = await roster();
    delete r[email];
    await saveRoster(r);
  }
  chrome.runtime.sendMessage({ type: 'bg:staffChanged' }).catch(() => {});
}

/** The packer's rights, as the server sent them. Empty shop list = every store. */
const view = (m) => m && { id: m.id, name: m.name, email: m.email, shopIds: m.shop_ids || [], canAccept: !!m.can_accept };
export const staffMayUseShop = (member, shopId) => !member.shopIds?.length || member.shopIds.includes(shopId);

/** Server check for the active packer; switched off → logged out and forgotten. */
export async function checkStaff() {
  const act = await activeStaff();
  if (!act) return { ok: true, active: null };
  const r = await roster();
  const entry = r[act.email];
  const owner = await B.ownerUserId();
  if (!entry || !owner) {
    await signOutStaff(act.email);
    return { ok: false, error: 'staffSignedOut' };
  }
  try {
    entry.session = await B.refreshRaw(entry.session);
    const m = await B.rpcWith(entry.session.access_token, 'team_check', { p_owner: owner });
    entry.member = view(m);
    entry.lastOkAt = Date.now();
    r[act.email] = entry;
    await saveRoster(r);
    await session.set({ [ACTIVE_KEY]: { email: act.email, member: entry.member, lastOkAt: entry.lastOkAt } });
    return { ok: true, active: entry.member };
  } catch (e) {
    if (e.code === 'billingNetwork' && Date.now() - (entry.lastOkAt || 0) < OFFLINE_GRACE_MS) return { ok: true, active: act.member, offline: true };
    // switched off, owner unpaid, session revoked or offline for too long → out
    const forget = ['billing_access_disabled', 'billing_not_invited', 'billingAuth'].includes(e.code);
    await signOutStaff(act.email, { forget });
    return { ok: false, error: e.code || 'staffSignedOut' };
  }
}

export async function scheduleStaffCheck() {
  if (await activeStaff()) await chrome.alarms.create(ALARM_STAFF, { periodInMinutes: CHECK_MINUTES });
  else await chrome.alarms.clear(ALARM_STAFF);
}

/* ---------- what the worker answers on a warehouse computer ---------- */

/** Allowed without anybody signed in (the sign-in screen). */
const PUBLIC = new Set(['ui:getState', 'ui:serviceStatus', 'ui:usage', 'ui:staffState', 'ui:staffRequestCode', 'ui:staffVerify', 'ui:staffPinLogin', 'ui:ownerUnlock', 'ui:logError', 'ui:trackFunnel']);
/** Allowed to a signed-in packer (packing only). */
const STAFF_ALLOWED = new Set([...PUBLIC, 'ui:sync', 'ui:staffLogout', 'ui:staffCheck', 'ui:pack', 'ui:accept', 'ui:print', 'ui:fetchInvoices', 'ui:packLogAdd', 'ui:packProblem', 'ui:setBarcode']);

/**
 * null = allowed; otherwise the refusal sent to the page. Only on a «Компьютер склада»
 * that the owner has not unlocked with their PIN.
 */
export async function staffGate(type, payload) {
  if (!(await warehouseOn()) || (await ownerUnlocked())) return null;
  const act = await activeStaff();
  if (!act) return PUBLIC.has(type) ? null : { ok: false, error: 'warehouseLocked' };
  if (!STAFF_ALLOWED.has(type)) return { ok: false, error: 'staffNotAllowed' };
  if (type === 'ui:accept' && !act.member.canAccept) return { ok: false, error: 'staffNotAllowed' };
  const items = payload?.items || [];
  if (items.some((i) => !staffMayUseShop(act.member, i.shopId))) return { ok: false, error: 'staffNotAllowed' };
  return null;
}

/* ---------- handlers ---------- */
export function staffHandlers() {
  return {
    'ui:staffState': async () => {
      const [act, r, wh, unlocked, ownerPin] = await Promise.all([activeStaff(), roster(), warehouseOn(), ownerUnlocked(), get(local, OWNER_PIN_KEY, null)]);
      return {
        ok: true,
        warehouse: wh,
        ownerUnlocked: unlocked,
        ownerPinSet: !!ownerPin,
        active: act ? act.member : null,
        // for the quick «choose your name» list on the sign-in screen
        known: Object.entries(r).map(([email, e]) => ({ email, name: e.member?.name || email })),
      };
    },

    /** Step 1 of the first sign-in: a code to the packer's e-mail. */
    'ui:staffRequestCode': async ({ email, captchaToken }) => {
      if (!B.isConfigured()) return { ok: false, error: 'billingNotConfigured' };
      await B.requestCode(email, captchaToken);
      return { ok: true };
    },

    /** Step 2: code + new PIN → joins the owner's team on this computer. */
    'ui:staffVerify': async ({ email, code, pin }) => {
      if (!validPin(pin)) return { ok: false, error: 'staffBadPin' };
      const owner = await B.ownerUserId();
      if (!owner) return { ok: false, error: 'staffNoOwner' };
      const s = await B.verifyCodeRaw(email, code);
      const m = view(await B.rpcWith(s.access_token, 'team_join', { p_owner: owner }));
      const key = s.email.toLowerCase();
      const r = await roster();
      r[key] = { member: m, session: s, pin: await pinHash(pin), fails: 0, lockedUntil: 0, lastOkAt: Date.now() };
      await saveRoster(r);
      await session.set({ [ACTIVE_KEY]: { email: key, member: m, lastOkAt: Date.now() } });
      await scheduleStaffCheck();
      return { ok: true, active: m };
    },

    /** Every next sign-in: e-mail + PIN, then the server is asked at once. */
    'ui:staffPinLogin': async ({ email, pin }) => {
      const key = String(email || '').trim().toLowerCase();
      const r = await roster();
      const e = r[key];
      if (!e) return { ok: false, error: 'staffUnknown' };
      if (e.lockedUntil > Date.now()) return { ok: false, error: 'staffLocked' };
      const { hash } = await pinHash(pin, e.pin.salt);
      if (!sameHash(hash, e.pin.hash)) {
        e.fails = (e.fails || 0) + 1;
        if (e.fails >= MAX_PIN_FAILS) Object.assign(e, { fails: 0, lockedUntil: Date.now() + LOCK_MS });
        r[key] = e;
        await saveRoster(r);
        return { ok: false, error: e.lockedUntil > Date.now() ? 'staffLocked' : 'staffBadPin' };
      }
      e.fails = 0;
      r[key] = e;
      await saveRoster(r);
      await session.set({ [ACTIVE_KEY]: { email: key, member: e.member, lastOkAt: e.lastOkAt } });
      const res = await checkStaff(); // switched off since the last shift → refused right here
      if (!res.ok) return { ok: false, error: res.error };
      await scheduleStaffCheck();
      return { ok: true, active: res.active };
    },

    'ui:staffLogout': async () => {
      const act = await activeStaff();
      await signOutStaff(act?.email);
      await scheduleStaffCheck();
      return { ok: true };
    },

    'ui:staffCheck': () => checkStaff(),

    /* ----- owner: the team (needs the owner unlocked, see staffGate) ----- */
    'ui:teamList': async () => ({ ok: true, list: await B.teamList() }),
    'ui:teamInvite': async (p) => ({ ok: true, member: await B.teamInvite(p) }),
    'ui:teamUpdate': async (p) => ({ ok: true, member: await B.teamUpdate(p) }),
    'ui:teamSetEnabled': async (p) => ({ ok: true, member: await B.teamSetEnabled(p) }),
    'ui:teamRemove': async (p) => ({ ok: true, removed: await B.teamRemove(p) }),

    /* ----- owner: «Компьютер склада» ----- */
    /** Turn on with a new owner PIN, or off. Turning on locks the owner view right away. */
    'ui:warehouseSet': async ({ enabled, pin }) => {
      if (enabled) {
        if (!validPin(pin)) return { ok: false, error: 'staffBadPin' };
        await local.set({ [OWNER_PIN_KEY]: await pinHash(pin) });
        await saveSettings({ warehouse: { enabled: true } });
        await session.remove(OWNER_UNLOCK_KEY);
      } else {
        await saveSettings({ warehouse: { enabled: false } });
        await local.remove(OWNER_PIN_KEY);
      }
      return { ok: true };
    },
    'ui:ownerUnlock': async ({ pin }) => {
      const stored = await get(local, OWNER_PIN_KEY, null);
      if (!stored) return { ok: false, error: 'staffBadPin' };
      const { hash } = await pinHash(pin, stored.salt);
      if (!sameHash(hash, stored.hash)) return { ok: false, error: 'staffBadPin' };
      await session.set({ [OWNER_UNLOCK_KEY]: { until: Date.now() + OWNER_UNLOCK_MS } });
      const act = await activeStaff();
      if (act) await signOutStaff(act.email); // the owner takes over the computer
      return { ok: true };
    },
    'ui:ownerLock': async () => {
      await session.remove(OWNER_UNLOCK_KEY);
      return { ok: true };
    },
  };
}
