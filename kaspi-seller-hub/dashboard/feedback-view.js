/**
 * SaudaPulse — short surveys for the owner's control panel.
 *  - NPS: «Насколько вероятно, что вы порекомендуете …» 0–10 + one open question. A card on Home,
 *    never a blocking window; the server decides when (after 14 days, then every 90 days).
 *  - «Почему не продлеваете?»: when the trial or subscription has ended.
 *  - «Ответ помог?»: under an answer from support (dashboard/support-view.js).
 */
import { h } from '../shared/utils.js';
import { t } from '../shared/i18n.js';

const send = (type, payload) => chrome.runtime.sendMessage({ type, payload });
export const EXIT_REASONS = ['price', 'notUsing', 'missing', 'bugs', 'closed', 'competitor', 'other'];

/**
 * @param {{ ui: {score:number|null, comment:string, done:boolean}, toast: Function, errorText: Function, rerender: Function, onDone: Function }} ctx
 */
export function npsCard(ctx) {
  const ui = ctx.ui;
  if (ui.done)
    return h('section', { class: 'card nps nps--thanks', dataset: { card: 'nps' } }, h('p', { class: 'nps__thanks' }, t('feedback.thanks')));
  const submit = async (score, comment) => {
    const res = await send('ui:feedback', { kind: 'nps', score, comment: comment || null });
    if (!res?.ok) return ctx.toast(ctx.errorText(res?.error), 'error');
    ui.done = score != null;
    ctx.onDone(score == null);
  };
  const scale = h('div', { class: 'nps__scale', role: 'group', 'aria-label': t('feedback.nps.question') },
    Array.from({ length: 11 }, (_, n) => h('button', { type: 'button', class: ['nps__n', ui.score === n && 'is-on', n <= 6 ? 'nps__n--low' : n <= 8 ? 'nps__n--mid' : 'nps__n--high'], dataset: { score: n }, 'aria-pressed': String(ui.score === n), onclick: () => {
      ui.score = n;
      ctx.rerender();
    } }, String(n))));
  const comment = ui.score == null ? null : h('textarea', { class: 'support__text', dataset: { field: 'npsComment' }, rows: 2, maxlength: 1000, placeholder: t(ui.score >= 9 ? 'feedback.nps.likePlaceholder' : 'feedback.nps.improvePlaceholder') });
  if (comment) {
    comment.value = ui.comment || '';
    comment.addEventListener('input', () => (ui.comment = comment.value));
  }
  return h('section', { class: 'card nps', dataset: { card: 'nps' } },
    h('div', { class: 'card__header' },
      h('div', null, h('h2', { class: 'card__title' }, t('feedback.nps.question')), h('div', { class: 'card__sub' }, t('feedback.nps.sub'))),
      h('button', { type: 'button', class: 'btn btn--sm btn--ghost', dataset: { action: 'nps-later' }, onclick: () => submit(null) }, t('feedback.later'))),
    h('div', { class: 'card__body' },
      scale,
      h('div', { class: 'nps__ends muted small' }, h('span', null, t('feedback.nps.low')), h('span', null, t('feedback.nps.high'))),
      comment && h('label', { class: 'nps__q' }, h('b', null, t(ui.score >= 9 ? 'feedback.nps.like' : 'feedback.nps.improve')), comment),
      ui.score != null && h('div', null, h('button', { type: 'button', class: 'btn btn--primary', dataset: { action: 'nps-send' }, onclick: () => submit(ui.score, ui.comment) }, t('feedback.send')))));
}

/**
 * «Почему не продлеваете?» — one click; the comment is optional.
 * @param {{ ui: {reason:string|null, comment:string, done:boolean}, toast: Function, errorText: Function, rerender: Function }} ctx
 */
export function exitCard(ctx) {
  const ui = ctx.ui;
  if (ui.done) return h('section', { class: 'card', dataset: { card: 'exit' } }, h('p', { class: 'nps__thanks' }, t('feedback.exit.thanks')));
  const comment = h('textarea', { class: 'support__text', dataset: { field: 'exitComment' }, rows: 2, maxlength: 1000, placeholder: t('feedback.exit.placeholder') });
  comment.value = ui.comment || '';
  comment.addEventListener('input', () => (ui.comment = comment.value));
  return h('section', { class: 'card', dataset: { card: 'exit' } },
    h('div', { class: 'card__header' }, h('div', null, h('h2', { class: 'card__title' }, t('feedback.exit.title')), h('div', { class: 'card__sub' }, t('feedback.exit.sub')))),
    h('div', { class: 'card__body support' },
      h('div', { class: 'exit__reasons', role: 'radiogroup' },
        EXIT_REASONS.map((r) => h('label', { class: 'check' }, h('input', { type: 'radio', name: 'exitReason', value: r, checked: ui.reason === r, onchange: () => (ui.reason = r) }), t(`feedback.exit.reasons.${r}`)))),
      comment,
      h('div', null, h('button', { type: 'button', class: 'btn btn--primary', dataset: { action: 'exit-send' }, onclick: async () => {
        if (!ui.reason) return ctx.toast(t('feedback.exit.pick'), 'error');
        const res = await send('ui:feedback', { kind: 'exit', reason: ui.reason, comment: ui.comment || null });
        if (!res?.ok) return ctx.toast(ctx.errorText(res?.error), 'error');
        ui.done = true;
        ctx.rerender();
      } }, t('feedback.send')))));
}

/** «Ответ помог?» under a support answer. */
export function csatRow(ticket, answered, onAnswer) {
  if (answered != null) return h('p', { class: 'muted small', dataset: { block: 'csat' } }, t(answered ? 'feedback.csat.thanksGood' : 'feedback.csat.thanksBad'));
  const vote = (score) => async () => {
    const res = await send('ui:feedback', { kind: 'csat', score, ticket: ticket.id });
    if (res?.ok) onAnswer(score);
  };
  return h('div', { class: 'csat', dataset: { block: 'csat' } },
    h('span', null, t('feedback.csat.question')),
    h('button', { type: 'button', class: 'btn btn--sm', dataset: { action: 'csat-yes' }, onclick: vote(1) }, '👍 ', t('feedback.csat.yes')),
    h('button', { type: 'button', class: 'btn btn--sm', dataset: { action: 'csat-no' }, onclick: vote(0) }, '👎 ', t('feedback.csat.no')));
}
