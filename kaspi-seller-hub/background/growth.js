/**
 * Kaspi Seller Hub — growth features in the worker:
 *   - Telegram: «Подключить Telegram» (one-time link), status, switches; the numbers for the 09:00
 *     digest (yesterday and today: orders, sum, shipped, orders at risk); instant «order at risk»
 *     alerts through the bot function, once per order;
 *   - plans: 24-hour boost, upgrade quote, cancellation flow (offer / freeze / cancel), resume.
 * The server never gets buyers' data: only counts, sums, order numbers and store names.
 */
import { BILLING } from '../shared/billing-config.js';
import { getSnapshots } from '../shared/storage.js';
import { dayKey, deadlineOf, urgencyOf } from '../shared/utils.js';
import * as B from './billing.js';

const TG_KEY = 'ksh.tg'; // {linked, alerts, digest, name, at} — cached status (the worker checks it before an alert)
const REVENUE_EXCLUDED = new Set(['cancelled', 'refused', 'returned']);
const SHIPPED = new Set(['delivering', 'delivered']);

const err = (e) => ({ ok: false, error: e?.code || 'unknown' });

async function tgStatus(force = false) {
  const { [TG_KEY]: c } = await chrome.storage.local.get(TG_KEY);
  if (!force && c && Date.now() - c.at < 30 * 60000) return c;
  if (!B.isConfigured() || !(await B.signedIn())) return { linked: false };
  const s = await B.tgStatus();
  const v = { ...s, at: Date.now() };
  await chrome.storage.local.set({ [TG_KEY]: v });
  return v;
}

/** Numbers of one day (Kazakhstan time) across the stores. */
export function dayStats(snapshots, settings, day, now = Date.now()) {
  let orders = 0, sum = 0, shipped = 0;
  const atRisk = [];
  const shops = [];
  for (const [shopId, snap] of Object.entries(snapshots || {})) {
    const store = settings.stores?.[shopId];
    if (!store?.enabled) continue;
    const name = store.alias || store.name || shopId;
    shops.push(name);
    for (const it of snap?.sections?.orders?.items || []) {
      if (it.date && dayKey(it.date) === day && !REVENUE_EXCLUDED.has(it.status)) {
        orders++;
        sum += Number(it.amount) || 0;
        if (SHIPPED.has(it.status)) shipped++;
      }
      const dl = deadlineOf(it, settings);
      const u = urgencyOf(dl, settings, now);
      if (u === 'soon' || u === 'overdue') atRisk.push({ code: String(it.api?.code || it.id).replace(/[^0-9A-Za-z-]/g, '').slice(0, 20), shop: name, minutes: Math.round((dl.at - now) / 60000) });
    }
  }
  atRisk.sort((a, b) => a.minutes - b.minutes);
  return { orders, sum: Math.round(sum), shipped, at_risk: atRisk.slice(0, 20), shops: shops.slice(0, 50) };
}

/** Every 15 minutes: yesterday's and today's numbers for the 09:00 digest. */
export async function reportDigest() {
  if (!B.isConfigured() || !(await B.signedIn())) return false;
  const tg = await tgStatus().catch(() => null);
  if (!tg?.linked || tg.digest === false) return false;           // nobody to send it to
  const got = await chrome.storage.local.get(['ksh.settings']);
  got['ksh.snapshots'] = await getSnapshots();
  const settings = got['ksh.settings'] || {};
  const today = dayKey(Date.now());
  const yesterday = dayKey(Date.now() - 86400000);
  for (const day of [yesterday, today]) await B.digestReport(day, dayStats(got['ksh.snapshots'], settings, day));
  return true;
}

/**
 * After a sync: orders whose handover deadline is near → one Telegram alert each (the database
 * refuses repeats too). Only when the seller linked Telegram and kept alerts on.
 */
export async function alertDeadlines(fresh) {
  if (!fresh?.length || !B.isConfigured() || !(await B.signedIn())) return 0;
  const tg = await tgStatus().catch(() => null);
  if (!tg?.linked || tg.alerts === false) return 0;
  const token = await B.currentToken();
  if (!token) return 0;
  let n = 0;
  for (const f of fresh.slice(0, 10)) {
    const code = String(f.it.api?.code || f.it.id).replace(/[^0-9A-Za-z-]/g, '').slice(0, 20);
    try {
      const res = await fetch(`${BILLING.supabaseUrl.replace(/\/$/, '')}/functions/v1/telegram-bot/alert`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, apikey: BILLING.supabaseAnonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, shop: f.store, minutes: Math.round((f.dl.at - Date.now()) / 60000), kind: 'deadline' }),
      });
      if ((await res.json().catch(() => ({}))).sent) n++;
    } catch {
      /* no network: the Chrome notification is still shown */
    }
  }
  return n;
}

export function growthHandlers({ license }) {
  return {
    'ui:tgStatus': async (p) => {
      try {
        return { ok: true, tg: await tgStatus(!!p?.force) };
      } catch (e) {
        return err(e);
      }
    },
    'ui:tgLink': async () => {
      try {
        await chrome.storage.local.remove(TG_KEY); // re-checked after the seller presses Start
        return { ok: true, ...(await B.tgLinkCreate()) };
      } catch (e) {
        return err(e);
      }
    },
    'ui:tgSettings': async (p) => {
      try {
        const s = await B.tgSettings({ digest: p?.digest ?? null, alerts: p?.alerts ?? null });
        await chrome.storage.local.set({ [TG_KEY]: { ...s, at: Date.now() } });
        return { ok: true, tg: s };
      } catch (e) {
        return err(e);
      }
    },
    'ui:tgUnlink': async () => {
      try {
        const s = await B.tgUnlink();
        await chrome.storage.local.set({ [TG_KEY]: { ...s, at: Date.now() } });
        return { ok: true, tg: s };
      } catch (e) {
        return err(e);
      }
    },
    'ui:upgradeQuote': async (p) => {
      try {
        return { ok: true, quote: await B.upgradeQuote(Number(p?.stores) || 2) };
      } catch (e) {
        return err(e);
      }
    },
    'ui:trialBoost': async () => {
      try {
        await B.trialBoost();
        return { ok: true, license: await license(true) };
      } catch (e) {
        return err(e);
      }
    },
    'ui:cancelFlow': async (p) => {
      try {
        await B.cancelFlow({ reason: p?.reason, outcome: p?.outcome, comment: p?.comment });
        return { ok: true, license: await license(true) };
      } catch (e) {
        return err(e);
      }
    },
    'ui:resumeSubscription': async () => {
      try {
        await B.resumeSubscription();
        return { ok: true, license: await license(true) };
      } catch (e) {
        return err(e);
      }
    },
  };
}
