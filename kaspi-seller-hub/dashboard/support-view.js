/**
 * Kaspi Seller Hub — support inside the extension: the owner's service notice (banner on every
 * page), «Написать в поддержку» with the technical report attached, «Мои вопросы» with answers.
 * The seller never has to explain the version, browser or what failed — it is in the report.
 */
import { h } from '../shared/utils.js';
import { t, formatDate } from '../shared/i18n.js';
import { svgIcon } from '../shared/icons.js';
import { csatRow } from './feedback-view.js';

const CSAT_KEY = 'ksh.csat'; // {ticketId: 0|1} — answered «Ответ помог?» on this computer

const send = (type, payload) => chrome.runtime.sendMessage({ type, payload });
export const TOPICS = ['connect', 'orders', 'print', 'payment', 'warehouse', 'idea', 'other'];

/** Owner's notice («Kaspi не отвечает, чиним») — null when everything is fine. */
export function statusBanner(status) {
  if (!status || status.level === 'ok' || !status.message) return null;
  const tone = status.level === 'down' ? 'danger' : status.level === 'warn' ? 'warn' : 'info';
  return h('div', { class: `banner banner--${tone}`, role: tone === 'info' ? 'status' : 'alert', dataset: { banner: 'service' } },
    h('span', { class: 'banner__icon' }, svgIcon(tone === 'info' ? 'chat' : 'warn')),
    h('span', { class: 'banner__text' }, h('b', null, t(`support.status.${status.level}`)), ' — ', status.message,
      status.updated_at ? h('span', { class: 'muted small' }, ' · ', formatDate(status.updated_at, 'datetime')) : null));
}

/** Answers the seller has not opened yet (from ksh.tickets, no request). */
export const unreadAnswers = (tickets) => (tickets?.list || []).filter((x) => x.unread).length;

/**
 * «Написать в поддержку» + «Мои вопросы».
 * @param {{ signedIn: boolean, tickets: {list:any[]}|null, ui: object, toast: Function, errorText: Function, rerender: Function, onTickets: Function }} ctx
 */
export function supportCard(ctx) {
  const ui = ctx.ui;
  const list = ctx.tickets?.list || [];
  if (!ctx.signedIn)
    return h('section', { class: 'card', dataset: { card: 'support' } },
      h('div', { class: 'card__header' }, h('div', null, h('h2', { class: 'card__title' }, t('support.title')), h('div', { class: 'card__sub' }, t('support.needLogin')))),
      h('div', { class: 'card__body' }, h('a', { class: 'btn btn--primary', href: '#account' }, t('support.login'))));

  const topic = h('select', { class: 'select', dataset: { field: 'ticketTopic' }, 'aria-label': t('support.topic') },
    TOPICS.map((k) => h('option', { value: k, selected: ui.topic === k }, t(`support.topics.${k}`))));
  const text = h('textarea', { class: 'support__text', dataset: { field: 'ticketText' }, rows: 4, maxlength: 2000, placeholder: t('support.placeholder'), 'aria-label': t('support.placeholder') });
  text.value = ui.draft || '';
  text.addEventListener('input', () => (ui.draft = text.value));
  const withReport = h('input', { type: 'checkbox', checked: ui.withReport !== false, onchange: (e) => (ui.withReport = e.target.checked) });
  const sendBtn = h('button', { type: 'button', class: 'btn btn--primary', dataset: { action: 'ticket-send' }, disabled: ui.sending, onclick: async () => {
    ui.topic = topic.value;
    ui.sending = true;
    sendBtn.disabled = true;
    const res = await send('ui:ticketSend', { topic: topic.value, message: text.value, withReport: withReport.checked });
    ui.sending = false;
    if (!res?.ok) {
      sendBtn.disabled = false;
      return ctx.toast(ctx.errorText(res?.error), 'error');
    }
    ui.draft = '';
    ctx.toast(t('support.sent'), 'ok', 6000);
    await ctx.onTickets();
  } }, t('support.send'));

  ui.open ||= new Set(); // stays open after «read» re-renders the list
  const items = list.map((x) => h('details', { class: ['faq__item', 'ticket', x.unread && 'ticket--unread'], dataset: { ticket: x.id }, open: x.unread || ui.open.has(x.id) || null,
    ontoggle: (e) => {
      if (e.target.open) ui.open.add(x.id);
      else ui.open.delete(x.id);
      if (e.target.open && x.unread) send('ui:ticketSeen', { id: x.id }).then(ctx.onTickets);
    } },
    h('summary', null,
      h('span', { class: ['pill', `ticket__status--${x.status}`] }, t(`support.st.${x.unread ? 'new' : x.status}`)), ' ',
      t(`support.topics.${x.topic}`), ' · ', formatDate(x.created_at, 'short'), ' — ', String(x.message).slice(0, 80)),
    h('p', { class: 'ticket__q' }, x.message),
    x.reply ? h('div', { class: 'ticket__a' }, h('b', null, t('support.answer')), ' ', x.reply) : h('p', { class: 'muted small' }, t('support.waiting')),
    x.reply && csatRow(x, ctx.csat?.[x.id], async (score) => {
      const { [CSAT_KEY]: m = {} } = await chrome.storage.local.get(CSAT_KEY);
      await chrome.storage.local.set({ [CSAT_KEY]: { ...m, [x.id]: score } });
      ctx.onCsat?.(x.id, score);
      await ctx.onTickets();
    }),
    x.status !== 'closed' && x.reply && h('button', { type: 'button', class: 'btn btn--sm', dataset: { action: 'ticket-close' }, onclick: async () => {
      const res = await send('ui:ticketClose', { id: x.id });
      if (!res?.ok) return ctx.toast(ctx.errorText(res?.error), 'error');
      await ctx.onTickets();
    } }, t('support.solved'))));

  return h('section', { class: 'card', dataset: { card: 'support' } },
    h('div', { class: 'card__header' }, h('div', null, h('h2', { class: 'card__title' }, t('support.title')), h('div', { class: 'card__sub' }, t('support.text')))),
    h('div', { class: 'card__body support' },
      h('label', { class: 'support__row' }, h('span', null, t('support.topic')), topic),
      text,
      h('label', { class: 'check' }, withReport, t('support.withReport')),
      h('div', null, sendBtn)),
    list.length ? h('div', { class: 'card__body faq', dataset: { block: 'tickets' } }, h('h3', { class: 'card__title small' }, t('support.mine')), items) : null);
}

export const getCsat = async () => (await chrome.storage.local.get(CSAT_KEY))[CSAT_KEY] || {};
