/**
 * Kaspi Seller Hub — «Первые шаги» on Home.
 *
 * Most sellers who leave never got to the useful part: no store connected, the first waybill
 * printed crooked, no cost prices (so no profit), no backup. The card shows five steps with
 * progress and a button to the right place, until everything is done or the seller hides it.
 *
 * Steps that leave no trace in the data (test print, backup) are marked in ksh.onboarding.
 */
import { h } from '../shared/utils.js';
import { t } from '../shared/i18n.js';

export const ONBOARD_KEY = 'ksh.onboarding';

/** Remember that a step was done (test print, waybill printed, backup saved). */
export async function markStep(step) {
  try {
    const { [ONBOARD_KEY]: o = {} } = await chrome.storage.local.get(ONBOARD_KEY);
    if (o[step]) return;
    await chrome.storage.local.set({ [ONBOARD_KEY]: { ...o, [step]: Date.now() } });
  } catch {
    /* never break printing or backups */
  }
}

export const getOnboarding = async () => (await chrome.storage.local.get(ONBOARD_KEY))[ONBOARD_KEY] || {};

/**
 * @param {{ stores: number, loaded: boolean, costs: number, flags: object }} s
 * @returns {{ key: string, done: boolean }[]}
 */
export function onboardingSteps(s) {
  return [
    { key: 'store', done: s.stores > 0 },
    { key: 'orders', done: s.loaded },
    { key: 'print', done: !!s.flags.print },
    { key: 'costs', done: s.costs > 0 },
    { key: 'backup', done: !!s.flags.backup },
  ];
}

/**
 * @param {{ stores: number, loaded: boolean, costs: number, flags: object, go: Record<string, () => void>, onHide: () => void }} ctx
 * @returns {HTMLElement|null}
 */
export function onboardingCard(ctx) {
  if (ctx.flags.hidden) return null;
  const steps = onboardingSteps(ctx);
  const done = steps.filter((x) => x.done).length;
  const all = done === steps.length;
  const next = steps.find((x) => !x.done);
  return h('section', { class: ['card', 'onboard', all && 'onboard--done'], dataset: { card: 'onboarding' } },
    h('div', { class: 'card__header' },
      h('div', null,
        h('h2', { class: 'card__title' }, all ? t('onboard.doneTitle') : t('onboard.title')),
        h('div', { class: 'card__sub' }, all ? t('onboard.doneText') : t('onboard.progress', { done, total: steps.length }))),
      h('button', { type: 'button', class: 'btn btn--sm btn--ghost', dataset: { action: 'onboard-hide' }, onclick: ctx.onHide }, all ? t('onboard.close') : t('onboard.hide'))),
    h('div', { class: 'onboard__bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': steps.length, 'aria-valuenow': done },
      h('span', { style: { width: `${(done / steps.length) * 100}%` } })),
    all ? null : h('ol', { class: 'onboard__steps' },
      steps.map((x) => h('li', { class: ['onboard__step', x.done && 'is-done', x === next && 'is-next'], dataset: { step: x.key } },
        h('span', { class: 'onboard__mark', 'aria-hidden': 'true' }, x.done ? '✓' : ''),
        h('span', { class: 'onboard__text' },
          h('b', null, t(`onboard.steps.${x.key}.title`)),
          x.done ? null : h('span', { class: 'muted small' }, t(`onboard.steps.${x.key}.why`))),
        x.done ? h('span', { class: 'sr-only' }, t('onboard.doneMark'))
          : h('button', { type: 'button', class: ['btn', 'btn--sm', x === next && 'btn--primary'], dataset: { action: `onboard-${x.key}` }, onclick: ctx.go[x.key] }, t(`onboard.steps.${x.key}.action`))))));
}

/**
 * «Токен создаёт руководитель» — a ready message for the store owner, so a manager who
 * installed the extension is not stuck. Plain text: WhatsApp / Telegram / copy.
 */
export function ownerInstructions(copyText, toast) {
  const text = t('onboard.ownerMessage');
  const enc = encodeURIComponent(text);
  return h('div', { class: 'connect__owner', dataset: { block: 'owner-help' } },
    h('span', { class: 'muted small' }, t('onboard.notOwner')),
    h('a', { class: 'btn btn--sm', href: `https://wa.me/?text=${enc}`, target: '_blank', rel: 'noopener' }, 'WhatsApp'),
    h('a', { class: 'btn btn--sm', href: `https://t.me/share/url?url=${encodeURIComponent('https://kaspi.kz/mc/')}&text=${enc}`, target: '_blank', rel: 'noopener' }, 'Telegram'),
    h('button', { type: 'button', class: 'btn btn--sm', dataset: { action: 'copy-owner-text' }, onclick: async () => {
      await copyText(text);
      toast(t('onboard.copied'), 'ok');
    } }, t('onboard.copy')));
}
