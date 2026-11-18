/**
 * Kaspi Seller Hub — support inside the extension (service worker).
 *
 *  - ui:serviceStatus  — the owner's notice for everyone («Kaspi не отвечает, чиним»), cached 5 min;
 *  - ui:ticketSend     — a question from «Помощь», with the technical report attached
 *                        (version, counts, last errors — the same text as «Скопировать отчёт»);
 *  - ui:tickets        — the seller's questions and the answers;
 *  - pollTickets()     — every 15 min while a question waits: a new answer → Chrome notification.
 * Tickets are kept in ksh.tickets so the dashboard can show «есть ответ» without a request.
 */
import { serviceStatus, ticketCreate, myTickets, ticketSeen, ticketClose, isConfigured, signedIn } from './billing.js';

const STATUS_KEY = 'ksh.serviceStatus';
export const TICKETS_KEY = 'ksh.tickets';
const STATUS_TTL = 5 * 60000;
const TOPICS = ['connect', 'orders', 'print', 'payment', 'warehouse', 'idea', 'other'];

const err = (e) => ({ ok: false, error: e?.code || 'unknown' });

async function getStatus(force = false) {
  if (!isConfigured()) return { level: 'ok' };
  const { [STATUS_KEY]: c } = await chrome.storage.session.get(STATUS_KEY).catch(() => ({}));
  if (!force && c && Date.now() - c.at < STATUS_TTL) return c.status;
  try {
    const status = await serviceStatus();
    await chrome.storage.session.set({ [STATUS_KEY]: { at: Date.now(), status } }).catch(() => {});
    return status;
  } catch {
    return c?.status || { level: 'ok' }; // offline: last known
  }
}

async function saveTickets(list) {
  await chrome.storage.local.set({ [TICKETS_KEY]: { at: Date.now(), list } });
  return list;
}

/** Fetch the seller's questions; notify about answers that arrived since the last look. */
export async function pollTickets({ notify = true } = {}) {
  if (!isConfigured() || !(await signedIn())) return null;
  const { [TICKETS_KEY]: old } = await chrome.storage.local.get(TICKETS_KEY);
  // nothing waiting for an answer → no request (most sellers never write)
  if (notify && !(old?.list || []).some((t) => t.status === 'open')) return null;
  const list = await myTickets();
  const known = new Map((old?.list || []).map((t) => [t.id, t]));
  const fresh = list.filter((t) => t.unread && known.get(t.id)?.replied_at !== t.replied_at);
  await saveTickets(list);
  if (notify && fresh.length && chrome.notifications) {
    chrome.notifications.create(`ksh:help:${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: chrome.i18n?.getMessage?.('supportReplyTitle') || 'Поддержка ответила',
      message: String(fresh[0].reply || '').slice(0, 180),
      priority: 1,
    });
  }
  return list;
}

/** @param {{ diagnostics: () => Promise<{text:string}> }} deps */
export function supportHandlers({ diagnostics }) {
  return {
    'ui:serviceStatus': async (p) => ({ ok: true, status: await getStatus(!!p?.force) }),

    'ui:ticketSend': async (p) => {
      const message = String(p?.message || '').trim();
      if (message.length < 5) return { ok: false, error: 'ticketTooShort' };
      if (!(await signedIn())) return { ok: false, error: 'billingLoggedOut' };
      try {
        const report = p?.withReport === false ? null : (await diagnostics())?.text;
        const t = await ticketCreate({ topic: TOPICS.includes(p?.topic) ? p.topic : 'other', message, report, version: chrome.runtime.getManifest().version });
        const { [TICKETS_KEY]: old } = await chrome.storage.local.get(TICKETS_KEY);
        await saveTickets([t, ...(old?.list || [])].slice(0, 20));
        return { ok: true, ticket: t };
      } catch (e) {
        return err(e);
      }
    },

    'ui:tickets': async () => {
      try {
        return { ok: true, list: (await pollTickets({ notify: false })) || [] };
      } catch (e) {
        const { [TICKETS_KEY]: old } = await chrome.storage.local.get(TICKETS_KEY);
        return { ok: false, error: e?.code || 'unknown', list: old?.list || [] };
      }
    },

    'ui:ticketSeen': async (p) => {
      try {
        await ticketSeen({ id: p?.id });
        const { [TICKETS_KEY]: old } = await chrome.storage.local.get(TICKETS_KEY);
        await saveTickets((old?.list || []).map((t) => (t.id === p?.id ? { ...t, unread: false } : t)));
        return { ok: true };
      } catch (e) {
        return err(e);
      }
    },

    'ui:ticketClose': async (p) => {
      try {
        await ticketClose({ id: p?.id });
        const { [TICKETS_KEY]: old } = await chrome.storage.local.get(TICKETS_KEY);
        await saveTickets((old?.list || []).map((t) => (t.id === p?.id ? { ...t, status: 'closed', unread: false } : t)));
        return { ok: true };
      } catch (e) {
        return err(e);
      }
    },
  };
}
