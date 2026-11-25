/**
 * SaudaPulse — Settings card «Перенести на телефон» (phone app at saudapulse.kz/app).
 * Makes / opens encrypted .spbackup files through the worker (background/spbackup-service.js):
 * the page never sees a plain Kaspi token, only the finished ciphertext.
 */
import { h } from '../shared/utils.js';
import { MIN_PASSPHRASE } from '../shared/spbackup.js';

/** Passphrase dialog (twice when making a file). Resolves the passphrase or null. */
function askPassphrase(t, { confirm }) {
  return new Promise((resolve) => {
    const p1 = h('input', { type: 'password', class: 'input', autocomplete: confirm ? 'new-password' : 'current-password', minlength: MIN_PASSPHRASE, dataset: { field: 'sp-pass' } });
    const p2 = confirm ? h('input', { type: 'password', class: 'input', autocomplete: 'new-password', dataset: { field: 'sp-pass2' } }) : null;
    const msg = h('p', { class: 'muted small', role: 'alert' });
    const dlg = h('dialog', { class: 'dialog', 'aria-label': t('phone.passTitle') });
    const close = (v) => (dlg.close(), dlg.remove(), resolve(v));
    dlg.append(
      h('h2', { class: 'dialog__title' }, t('phone.passTitle')),
      h('p', { class: 'dialog__text' }, t('phone.passText', { min: MIN_PASSPHRASE })),
      h('label', { class: 'field' }, h('span', null, t('phone.pass')), p1),
      p2 ? h('label', { class: 'field' }, h('span', null, t('phone.passAgain')), p2) : null,
      msg,
      h('div', { class: 'dialog__actions' },
        h('button', { type: 'button', class: 'btn btn--ghost', onclick: () => close(null) }, t('common.cancel')),
        h('button', { type: 'button', class: 'btn btn--primary', dataset: { action: 'sp-pass-ok' }, onclick: () => {
          if (confirm && p1.value.normalize('NFC').length < MIN_PASSPHRASE) return (msg.textContent = t('errors.backupWeakPassphrase'));
          if (confirm && p1.value !== p2.value) return (msg.textContent = t('phone.passMismatch'));
          close(p1.value);
        } }, t('phone.passOk')),
      ),
    );
    dlg.addEventListener('cancel', (e) => (e.preventDefault(), close(null)));
    document.body.append(dlg);
    dlg.showModal();
    p1.focus();
  });
}

/**
 * @param {{ t: Function, send: Function, toast: Function, errorText: Function, reload: Function }} ctx
 */
export function phoneTransferCard({ t, send, toast, errorText, reload }) {
  const make = (scope) => async (e) => {
    const b = e.currentTarget; // read before any await: currentTarget is null after the event
    const pass = await askPassphrase(t, { confirm: true });
    if (!pass) return;
    b.disabled = true;
    try {
      const res = await send('ui:spbackupExport', { scope, passphrase: pass });
      if (!res?.ok) return toast(errorText(res?.error), 'error');
      const a = h('a', { href: URL.createObjectURL(new Blob([res.file], { type: 'application/json' })), download: res.name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast(t('phone.saved'), 'ok', 9000);
    } finally {
      b.disabled = false;
    }
  };
  const file = h('input', { type: 'file', accept: '.spbackup,application/json', hidden: true, dataset: { action: 'sp-file' }, onchange: async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) return toast(errorText('backupTooBig'), 'error');
    const pass = await askPassphrase(t, { confirm: false });
    if (!pass) return;
    const res = await send('ui:spbackupImport', { text: await f.text(), passphrase: pass });
    if (!res?.ok) return toast(errorText(res?.error), 'error');
    toast(t('phone.restored', { stores: res.stores, costs: res.costs }), res.failed ? 'info' : 'ok', 9000);
    if (res.failed) toast(errorText(res.failedReason), 'error', 9000);
    reload();
  } });
  return h(
    'section',
    { class: 'card', dataset: { card: 'phone' } },
    h('div', { class: 'card__header' }, h('div', null, h('h2', { class: 'card__title' }, t('phone.title')), h('div', { class: 'card__sub' }, t('phone.text')))),
    h('div', { class: 'card__body' },
    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
      h('button', { type: 'button', class: 'btn btn--primary', dataset: { action: 'sp-export-owner' }, onclick: make('owner') }, t('phone.exportOwner')),
      h('button', { type: 'button', class: 'btn', dataset: { action: 'sp-export-staff' }, onclick: make('staff') }, t('phone.exportStaff')),
      h('button', { type: 'button', class: 'btn', onclick: () => file.click() }, t('phone.import')),
      file,
    ),
    h('p', { class: 'muted small' }, t('phone.note')),
    ),
  );
}
