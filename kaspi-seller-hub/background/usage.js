/**
 * Kaspi Seller Hub — usage counts for the owner's control panel (service worker).
 *
 * Counted per day (Kazakhstan time), numbers only:
 *   sections — how many times each dashboard section was opened;
 *   actions  — how many times «Принять», «Упаковать», печать, выгрузка… were used.
 * Plus the 5 first steps done / not done. Every 15 minutes (with the API health counts) the
 * numbers go to usage_report() — only for signed-in sellers. No orders, products, amounts,
 * store names or tokens. Surveys (NPS, «почему не продлеваете», «ответ помог?») live here too.
 */
import { getSnapshots } from '../shared/storage.js';
import { dayKey } from '../shared/utils.js';
import { isConfigured, signedIn, usageReport, feedbackDue, feedbackSubmit } from './billing.js';

const KEY = 'ksh.usage';
const DUE_KEY = 'ksh.feedbackDue';
const SECTIONS = ['home', 'orders', 'returns', 'refusals', 'payments', 'analytics', 'products', 'catalog', 'chat', 'settings', 'account', 'help'];
const ACTIONS = ['accept', 'pack', 'print', 'pickList', 'export', 'publish', 'connect', 'sync', 'ticket', 'invite', 'cost'];
/** Worker messages that count as a use of a feature (when they succeed). */
export const ACTION_OF = {
  'ui:accept': 'accept',
  'ui:pack': 'pack',
  'ui:print': 'print',
  'ui:catalogPublish': 'publish',
  'ui:connectApi': 'connect',
  'ui:sync': 'sync',
  'ui:ticketSend': 'ticket',
  'ui:teamInvite': 'invite',
  'ui:saveCost': 'cost',
};

// one write at a time (the worker may get several messages at once)
let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn, fn));

function bump(kind, name) {
  return serial(async () => {
    const { [KEY]: u = { days: {} } } = await chrome.storage.local.get(KEY);
    const d = (u.days[dayKey(Date.now())] ||= { sections: {}, actions: {} });
    d[kind][name] = (d[kind][name] || 0) + 1;
    // keep at most a week of unsent days (offline, logged out)
    const keys = Object.keys(u.days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 7))) delete u.days[k];
    try { await chrome.storage.local.set({ [KEY]: u }); } catch (e) { console.warn('[ksh.usage] storage write failed', e?.message || e); }
  }).catch(() => {});
}

export const noteSection = (s) => (SECTIONS.includes(s) ? bump('sections', s) : Promise.resolve());
export const noteAction = (a) => (ACTIONS.includes(a) ? bump('actions', a) : Promise.resolve());

/** First steps from what is on this computer (same rules as «Первые шаги» on Home). */
async function steps() {
  const got = await chrome.storage.local.get(['ksh.settings', 'ksh.costs', 'ksh.onboarding']);
  got['ksh.snapshots'] = await getSnapshots();
  const stores = Object.values(got['ksh.settings']?.stores || {}).filter((s) => s.enabled !== false);
  return {
    store: stores.length > 0,
    orders: Object.values(got['ksh.snapshots'] || {}).some((sn) => sn?.sections?.orders),
    print: !!got['ksh.onboarding']?.print,
    costs: Object.keys(got['ksh.costs'] || {}).length > 0,
    backup: !!got['ksh.onboarding']?.backup,
  };
}

/** Send the counts (the last 3 days at most) and remove what was sent. */
export async function flushUsage() {
  if (!isConfigured() || !(await signedIn())) return false;
  const { [KEY]: u = { days: {} } } = await chrome.storage.local.get(KEY);
  const days = Object.keys(u.days).sort().slice(-3).map((day) => ({ day, ...u.days[day] }));
  await usageReport(await steps(), days, chrome.runtime.getManifest().version);
  await serial(async () => {
    const { [KEY]: now = { days: {} } } = await chrome.storage.local.get(KEY);
    for (const sent of days) {
      const d = now.days[sent.day];
      if (!d) continue;
      for (const kind of ['sections', 'actions'])
        for (const [k, n] of Object.entries(sent[kind] || {})) {
          d[kind][k] = (d[kind][k] || 0) - n;
          if (d[kind][k] <= 0) delete d[kind][k];
        }
      if (!Object.keys(d.sections).length && !Object.keys(d.actions).length) delete now.days[sent.day];
    }
    try { await chrome.storage.local.set({ [KEY]: now }); } catch (e) { console.warn('[ksh.usage] storage write failed', e?.message || e); }
  });
  return true;
}

export function usageHandlers() {
  return {
    /** From the dashboard: a section opened, or an action that happens in the page (Excel, pick list). */
    'ui:usage': async (p) => {
      if (p?.section) await noteSection(p.section);
      if (p?.action) await noteAction(p.action);
      return { ok: true };
    },
    /** Which survey to show now: 'nps' | 'exit' | null. Asked at most every 6 hours. */
    'ui:feedbackDue': async () => {
      if (!isConfigured() || !(await signedIn())) return { ok: true, due: null };
      const { [DUE_KEY]: c } = await chrome.storage.session.get(DUE_KEY).catch(() => ({}));
      if (c && Date.now() - c.at < 6 * 3600000) return { ok: true, due: c.due };
      try {
        const due = await feedbackDue();
        await chrome.storage.session.set({ [DUE_KEY]: { at: Date.now(), due } }).catch(() => {});
        return { ok: true, due };
      } catch {
        return { ok: true, due: null };
      }
    },
    'ui:feedback': async (p) => {
      try {
        await feedbackSubmit(p || {});
        await chrome.storage.session.set({ [DUE_KEY]: { at: Date.now(), due: null } }).catch(() => {});
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e?.code || 'unknown' };
      }
    },
  };
}
