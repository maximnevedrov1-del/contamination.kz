/**
 * SaudaPulse — Settings card «Перенести на телефон» (phone app at saudapulse.kz/app).
 * Makes / opens encrypted .spbackup files through the worker (background/spbackup-service.js):
 * the page never sees a plain Kaspi token, only the finished ciphertext.
 */
import { h } from '../shared/utils.js';
import { MIN_PASSPHRASE } from '../shared/spbackup.js';
import { qrMatrix } from '../shared/qr-transfer.js';
import qrcode from '../vendor/qrcode/qrcode.mjs';

const APP_URL = 'https://saudapulse.kz/app/';

/** Draw a QR matrix on a canvas (dark modules on white, 4-module quiet zone). */
function qrCanvas(matrix, px, label) {
  const n = matrix.length;
  const scale = Math.max(2, Math.floor(px / (n + 8)));
  const size = (n + 8) * scale;
  const c = h('canvas', { width: size, height: size, role: 'img', 'aria-label': label, style: { width: `${size}px`, height: `${size}px`, maxWidth: '100%', imageRendering: 'pixelated', background: '#fff', borderRadius: '8px' } });
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, size, size);
  g.fillStyle = '#000';
  matrix.forEach((row, r) => row.forEach((dark, col) => dark && g.fillRect((col + 4) * scale, (r + 4) * scale, scale, scale)));
  return c;
}

/** «Показать QR-код»: steps + the transfer QR; hidden after its 2 minutes. */
async function showQr({ t, send, toast, errorText }) {
  const res = await send('ui:qrTransfer');
  if (!res?.ok) return toast(errorText(res?.error), 'error');
  const dlg = h('dialog', { class: 'dialog', 'aria-label': t('phone.qrTitle'), dataset: { dialog: 'qr' }, style: { padding: '24px', maxWidth: '640px', width: 'calc(100% - 32px)' } });
  const close = () => (clearInterval(timer), dlg.close(), dlg.remove());
  const left = h('p', { class: 'muted small', role: 'status' });
  const code = h('div', { style: { display: 'flex', justifyContent: 'center' } }, qrCanvas(res.matrix, 300, t('phone.qrTitle')));
  const tick = () => {
    const s = Math.max(0, Math.round((res.exp - Date.now()) / 1000));
    left.textContent = t('phone.qrLeft', { sec: s });
    if (!s) {
      code.replaceChildren(h('p', { class: 'muted' }, t('phone.qrGone')));
      clearInterval(timer);
    }
  };
  const timer = setInterval(tick, 1000);
  const appQr = qrCanvas(qrMatrix(qrcode, APP_URL), 110, APP_URL);
  dlg.append(...[
    h('h2', { class: 'dialog__title' }, t('phone.qrTitle')),
    h('div', { style: { display: 'flex', gap: '16px', alignItems: 'flex-start', flexWrap: 'wrap' } },
      h('ol', { style: { flex: '1 1 220px', margin: 0, paddingLeft: '20px', display: 'grid', gap: '8px' } },
        h('li', null, t('phone.qrStep1'), ' ', h('strong', null, 'saudapulse.kz/app'), h('div', { style: { marginTop: '6px' } }, appQr), h('div', { class: 'muted small' }, t('phone.qrStep1hint'))),
        h('li', null, t('phone.qrStep2')),
        h('li', null, t('phone.qrStep3'))),
      h('div', { style: { flex: '0 0 auto', textAlign: 'center' } }, code, left)),
    res.withCosts ? null : h('p', { class: 'muted small' }, t('phone.qrNoCosts')),
    h('p', { class: 'muted small' }, t('phone.qrSafety')),
    h('div', { class: 'dialog__actions' }, h('button', { type: 'button', class: 'btn btn--primary', onclick: close }, t('phone.qrDone'))),
  ].filter(Boolean)); // Element.append(null) would print «null»
  dlg.addEventListener('cancel', (e) => (e.preventDefault(), close()));
  dlg.addEventListener('close', () => clearInterval(timer));
  document.body.append(dlg);
  tick();
  dlg.showModal();
}

/** Passphrase dialog (twice when making a file). Resolves the passphrase or null. */
function askPassphrase(t, { confirm }) {
  return new Promise((resolve) => {
    const p1 = h('input', { type: 'password', class: 'input', autocomplete: confirm ? 'new-password' : 'current-password', minlength: MIN_PASSPHRASE, dataset: { field: 'sp-pass' } });
    const p2 = confirm ? h('input', { type: 'password', class: 'input', autocomplete: 'new-password', dataset: { field: 'sp-pass2' } }) : null;
    const msg = h('p', { class: 'muted small', role: 'alert' });
    const dlg = h('dialog', { class: 'dialog', 'aria-label': t('phone.passTitle'), dataset: { padded: '' } });
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
      h('button', { type: 'button', class: 'btn btn--primary', style: { alignSelf: 'flex-start', justifySelf: 'start', width: 'auto' }, dataset: { action: 'sp-qr' }, onclick: () => showQr({ t, send, toast, errorText }) }, t('phone.qrButton')),
      h('details', { style: { marginTop: '12px' } },
        h('summary', { class: 'muted small', style: { cursor: 'pointer' } }, t('phone.other')),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' } },
          h('button', { type: 'button', class: 'btn', dataset: { action: 'sp-export-owner' }, onclick: make('owner') }, t('phone.exportOwner')),
          h('button', { type: 'button', class: 'btn', dataset: { action: 'sp-export-staff' }, onclick: make('staff') }, t('phone.exportStaff')),
          h('button', { type: 'button', class: 'btn', onclick: () => file.click() }, t('phone.import')),
          file,
        ),
        h('p', { class: 'muted small' }, t('phone.note')),
      ),
    ),
  );
}
