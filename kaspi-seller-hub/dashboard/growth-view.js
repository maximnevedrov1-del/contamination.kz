/**
 * SaudaPulse — plans and retention in the dashboard:
 *   storeMeter      «Магазин: Все (1/1)  + Добавить магазин» in the top bar
 *   openUpsell      soft paywall on «Старт»: +8 000 ₸/мес for 3 stores, 24 hours free, upgrade now
 *   openCancelFlow  «Отменить подписку»: reason → offer (30 % / «Старт» / freeze / feedback) → cancel
 *   planNotice      grace days / frozen / cancelled — what it means and the one button that helps
 *   telegramCard    «Telegram-уведомления»: link by a one-time button, switches, unlink
 * Everything is decided on the server; the page only shows it and sends the seller's choice.
 */
import { h, clear } from '../shared/utils.js';
import { t, formatDate, formatMoney } from '../shared/i18n.js';

const send = (type, payload) => chrome.runtime.sendMessage({ type, payload });

/** A simple dialog built on <dialog>, closed by its buttons or Escape. */
function dialog(id, build) {
  let dlg = document.getElementById(id);
  if (!dlg) {
    dlg = h('dialog', { id, class: 'dialog dialog--growth', 'aria-labelledby': `${id}Title` });
    document.body.append(dlg);
  }
  const close = () => dlg.close();
  const render = () => clear(dlg).append(build({ close, render }));
  render();
  if (!dlg.open) dlg.showModal();
  return { dlg, close, render };
}

/** «Магазин: Все магазины (1/3)  + Добавить магазин» */
export function storeMeter({ lic, used, current, onAdd }) {
  if (!lic || ['unconfigured', 'loggedOut'].includes(lic.status)) return null;
  const limit = lic.storeLimit || 0;
  const full = limit > 0 && used >= limit;
  return h('div', { class: ['store-meter', full && 'store-meter--full'], dataset: { block: 'store-meter' } },
    h('span', { class: 'store-meter__text' }, t('plan.meter', { store: current, used, limit: limit || '—' })),
    lic.boostUntil ? h('span', { class: 'badge badge--info', title: t('plan.boostUntil', { date: formatDate(lic.boostUntil, 'datetime') }) }, t('plan.boostBadge')) : null,
    h('button', { type: 'button', class: 'btn btn--sm', dataset: { action: 'add-store' }, onclick: onAdd }, t('plan.addStore')));
}

/** Does adding a store need the upsell window first? («Старт», limit reached) */
export const needsUpsell = (lic, used) => !!lic && !lic.freeAccess && ['active', 'grace'].includes(lic.status) && lic.plan === 'start' && used >= (lic.storeLimit || 1);

/**
 * Soft paywall: never a dead end — 24 hours free, or upgrade with the proration shown.
 * @param {{ lic: object, used: number, toast: Function, errorText: Function, onConnect: Function, onPay: Function, onLicense: Function }} ctx
 */
export async function openUpsell(ctx) {
  const pr = ctx.lic.pricing || {};
  const diff = (pr.base_price || 20000) - (pr.start_price || 12000);
  const more = (pr.base_stores || 3) - 1;
  let quote = null;
  const ui = { busy: false };
  const box = dialog('upsellDialog', ({ close, render }) => {
    const act = (fn) => async () => {
      if (ui.busy) return;
      ui.busy = true;
      render();
      try {
        await fn(close);
      } finally {
        ui.busy = false;
        if (box.dlg.open) render();
      }
    };
    return h('div', { class: 'upsell' },
      h('h2', { class: 'dialog__title', id: 'upsellDialogTitle' }, t('plan.upsell.title')),
      h('p', { class: 'upsell__offer' }, t('plan.upsell.offer', { count: more, diff: formatMoney(diff), stores: pr.base_stores || 3 })),
      quote && quote.upgrade_cost > 0
        ? h('p', { class: 'muted', dataset: { block: 'proration' } }, t('plan.upsell.now', { amount: formatMoney(quote.upgrade_cost), days: quote.remaining_days }))
        : null,
      h('div', { class: 'upsell__actions' },
        ctx.lic.canBoost && h('button', { type: 'button', class: 'btn btn--primary', dataset: { action: 'boost' }, disabled: ui.busy, onclick: act(async (closeDlg) => {
          const res = await send('ui:trialBoost');
          if (!res?.ok) return ctx.toast(ctx.errorText(res?.error), 'error');
          ctx.onLicense(res.license);
          closeDlg();
          ctx.toast(t('plan.upsell.boosted', { hours: pr.boost_hours || 24 }), 'ok', 8000);
          ctx.onConnect();
        }) }, t('plan.upsell.boost', { stores: pr.base_stores || 3, hours: pr.boost_hours || 24 })),
        h('button', { type: 'button', class: ['btn', !ctx.lic.canBoost && 'btn--primary'], dataset: { action: 'upgrade' }, disabled: ui.busy, onclick: act(async (closeDlg) => {
          closeDlg();
          await ctx.onPay(ctx.used + 1);
        }) }, t('plan.upsell.upgrade')),
        h('button', { type: 'button', class: 'btn btn--ghost', onclick: close }, t('plan.upsell.later'))),
      h('p', { class: 'muted small' }, t('plan.upsell.note')));
  });
  const res = await send('ui:upgradeQuote', { stores: ctx.used + 1 });
  if (res?.ok) {
    quote = res.quote;
    box.render();
  }
}

/**
 * Cancellation flow. Offers follow the reason; «Всё равно отменить» is always one click away.
 * @param {{ lic: object, toast: Function, errorText: Function, onLicense: Function }} ctx
 */
export function openCancelFlow(ctx) {
  const ui = { step: 'reason', reason: null, comment: '', busy: false, used: {} };
  const pr = ctx.lic.pricing || {};
  const box = dialog('cancelDialog', ({ close, render }) => {
    const decide = (outcome) => async () => {
      if (ui.busy) return;
      ui.busy = true;
      render();
      const res = await send('ui:cancelFlow', { reason: ui.reason, outcome, comment: ui.comment || null });
      ui.busy = false;
      if (!res?.ok) {
        if (res?.error === 'billing_offer_used') ui.used[outcome] = true;
        render();
        return ctx.toast(ctx.errorText(res?.error), 'error');
      }
      ctx.onLicense(res.license);
      ui.step = `done-${outcome}`;
      render();
    };
    const comment = () => {
      const ta = h('textarea', { class: 'support__text', rows: 3, maxlength: 1000, dataset: { field: 'cancelComment' }, placeholder: t(`plan.cancel.placeholder.${ui.reason}`) });
      ta.value = ui.comment;
      ta.addEventListener('input', () => (ui.comment = ta.value));
      return ta;
    };
    const cancelAnyway = () => h('button', { type: 'button', class: 'btn btn--ghost', dataset: { action: 'cancel-anyway' }, disabled: ui.busy, onclick: decide('cancelled') }, t('plan.cancel.anyway'));
    let body;
    if (ui.step === 'reason') {
      body = [
        h('p', { class: 'muted' }, t('plan.cancel.why')),
        h('div', { class: 'exit__reasons', role: 'radiogroup' }, ['price', 'closed', 'missing', 'other'].map((r) =>
          h('label', { class: 'check' }, h('input', { type: 'radio', name: 'cancelReason', value: r, checked: ui.reason === r, onchange: () => ((ui.reason = r), render()) }), t(`plan.cancel.reasons.${r}`)))),
        h('div', { class: 'upsell__actions' },
          h('button', { type: 'button', class: 'btn btn--primary', dataset: { action: 'cancel-next' }, disabled: !ui.reason, onclick: () => ((ui.step = 'offer'), render()) }, t('plan.cancel.next')),
          h('button', { type: 'button', class: 'btn btn--ghost', onclick: close }, t('plan.cancel.stay'))),
      ];
    } else if (ui.step === 'offer') {
      const offers = {
        price: [
          !ui.used.discount && h('div', { class: 'offer', dataset: { offer: 'discount' } }, h('b', null, t('plan.cancel.discountTitle')), h('p', null, t('plan.cancel.discountText')),
            h('button', { type: 'button', class: 'btn btn--primary', dataset: { action: 'offer-discount' }, disabled: ui.busy, onclick: decide('discount') }, t('plan.cancel.discountBtn'))),
          ctx.lic.plan !== 'start' && !ctx.lic.downgradeNext && h('div', { class: 'offer', dataset: { offer: 'downgrade' } }, h('b', null, t('plan.cancel.downgradeTitle', { price: formatMoney(pr.start_price || 12000) })), h('p', null, t('plan.cancel.downgradeText')),
            h('button', { type: 'button', class: 'btn', dataset: { action: 'offer-downgrade' }, disabled: ui.busy, onclick: decide('downgrade') }, t('plan.cancel.downgradeBtn'))),
        ],
        closed: [
          !ui.used.freeze && h('div', { class: 'offer', dataset: { offer: 'freeze' } }, h('b', null, t('plan.cancel.freezeTitle', { days: pr.freeze_days || 30 })), h('p', null, t('plan.cancel.freezeText')),
            h('button', { type: 'button', class: 'btn btn--primary', dataset: { action: 'offer-freeze' }, disabled: ui.busy, onclick: decide('freeze') }, t('plan.cancel.freezeBtn', { days: pr.freeze_days || 30 }))),
        ],
        missing: [
          h('div', { class: 'offer', dataset: { offer: 'feedback' } }, h('b', null, t('plan.cancel.missingTitle')), h('p', null, t('plan.cancel.missingText')), comment(),
            h('button', { type: 'button', class: 'btn btn--primary', dataset: { action: 'offer-feedback' }, disabled: ui.busy, onclick: async () => {
              if ((ui.comment || '').trim().length < 5) return ctx.toast(t('plan.cancel.missingEmpty'), 'error');
              const res = await send('ui:ticketSend', { topic: 'idea', message: ui.comment, withReport: false });
              if (!res?.ok) return ctx.toast(ctx.errorText(res?.error), 'error');
              ui.step = 'done-feedback';
              render();
            } }, t('plan.cancel.missingBtn'))),
        ],
        other: [h('div', { class: 'offer' }, comment())],
      }[ui.reason].filter(Boolean);
      body = [
        h('p', { class: 'muted' }, t(`plan.cancel.offerIntro.${ui.reason}`)),
        ...offers,
        h('div', { class: 'upsell__actions' }, cancelAnyway(), h('button', { type: 'button', class: 'btn btn--ghost', onclick: () => ((ui.step = 'reason'), render()) }, t('common.back'))),
        h('p', { class: 'muted small' }, t('plan.cancel.anywayNote', { date: ctx.lic.paidUntil ? formatDate(ctx.lic.paidUntil) : '—' })),
      ];
    } else {
      const key = ui.step.replace('done-', '');
      body = [h('p', { class: 'cancel__done', dataset: { done: key } }, t(`plan.cancel.done.${key}`, { date: ctx.lic.paidUntil ? formatDate(ctx.lic.paidUntil) : '—', days: pr.freeze_days || 30 })),
        h('div', { class: 'upsell__actions' }, h('button', { type: 'button', class: 'btn btn--primary', onclick: close }, t('common.close')))];
    }
    return h('div', { class: 'cancel-flow', dataset: { step: ui.step } }, h('h2', { class: 'dialog__title', id: 'cancelDialogTitle' }, t('plan.cancel.title')), ...body);
  });
  return box;
}

/** Grace / frozen / cancelled: one line and the button that helps. */
export function planNotice(lic, { onPay, onResume }) {
  if (!lic || lic.freeAccess) return null; // free access: grace/freeze/cancel are history, nothing to warn about
  if (lic.status === 'grace')
    return h('div', { class: 'banner banner--warn', role: 'alert', dataset: { banner: 'grace' } },
      h('span', { class: 'banner__text' }, t('plan.grace', { date: formatDate(lic.graceUntil, 'datetime') })),
      h('button', { type: 'button', class: 'btn btn--sm btn--primary', onclick: onPay }, t('plan.payNow')));
  if (lic.status === 'frozen')
    return h('div', { class: 'banner banner--info', role: 'status', dataset: { banner: 'frozen' } },
      h('span', { class: 'banner__text' }, t('plan.frozen', { date: formatDate(lic.frozenUntil) })),
      h('button', { type: 'button', class: 'btn btn--sm', dataset: { action: 'unfreeze' }, onclick: onResume }, t('plan.unfreeze')));
  if (lic.cancelAt && lic.status === 'active')
    return h('div', { class: 'banner banner--info', role: 'status', dataset: { banner: 'cancelled' } },
      h('span', { class: 'banner__text' }, t('plan.cancelled', { date: formatDate(lic.paidUntil) })),
      h('button', { type: 'button', class: 'btn btn--sm', dataset: { action: 'resume' }, onclick: onResume }, t('plan.resume')));
  return null;
}

/**
 * «Telegram-уведомления» in Settings.
 * @param {{ tg: object|null, ui: object, toast: Function, errorText: Function, rerender: Function, onTg: Function }} ctx
 */
export function telegramCard(ctx) {
  const tg = ctx.tg;
  const ui = ctx.ui;
  const head = h('div', { class: 'card__header' }, h('div', null, h('h2', { class: 'card__title' }, t('tg.title')), h('div', { class: 'card__sub' }, t('tg.text'))));
  let body;
  if (!tg) body = h('p', { class: 'muted' }, t('common.loading'));
  else if (tg.linked) {
    const sw = (key, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', dataset: { setting: `tg-${key}` }, checked: tg[key] !== false, onchange: async (e) => {
      const res = await send('ui:tgSettings', { [key]: e.target.checked });
      if (!res?.ok) return ctx.toast(ctx.errorText(res?.error), 'error');
      ctx.onTg(res.tg);
    } }), label);
    body = [
      h('p', { dataset: { block: 'tg-linked' } }, '✅ ', t('tg.linked', { name: tg.name || 'Telegram' })),
      sw('digest', t('tg.digest')),
      sw('alerts', t('tg.alerts')),
      h('div', null, h('button', { type: 'button', class: 'btn btn--ghost', dataset: { action: 'tg-unlink' }, onclick: async () => {
        const res = await send('ui:tgUnlink');
        if (!res?.ok) return ctx.toast(ctx.errorText(res?.error), 'error');
        ctx.onTg(res.tg);
      } }, t('tg.unlink'))),
    ];
  } else {
    body = [
      tg.blocked ? h('p', { class: 'muted' }, t('tg.blocked')) : null,
      h('ul', { class: 'tg__list' }, ['digest', 'alerts', 'care'].map((k) => h('li', null, t(`tg.points.${k}`)))),
      h('button', { type: 'button', class: 'btn btn--primary', dataset: { action: 'tg-link' }, disabled: ui.waiting, onclick: async () => {
        const res = await send('ui:tgLink');
        if (!res?.ok) return ctx.toast(ctx.errorText(res?.error), 'error');
        window.open(res.url, '_blank', 'noopener');
        // wait for /start in Telegram (up to 3 minutes)
        ui.waiting = true;
        ctx.rerender();
        const until = Date.now() + 180000;
        while (Date.now() < until) {
          await new Promise((r) => setTimeout(r, 3000));
          const st = await send('ui:tgStatus', { force: true });
          if (st?.tg?.linked) {
            ui.waiting = false;
            ctx.onTg(st.tg);
            return ctx.toast(t('tg.done'), 'ok', 6000);
          }
        }
        ui.waiting = false;
        ctx.rerender();
      } }, ui.waiting ? t('tg.waiting') : t('tg.link')),
    ];
  }
  return h('section', { class: 'card', dataset: { card: 'telegram' } }, head, h('div', { class: 'card__body support' }, body));
}
