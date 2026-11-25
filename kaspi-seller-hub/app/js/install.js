/**
 * «Установить» bar at the bottom of the phone app.
 *  - Android / Chrome / Edge / Samsung Internet: the browser's own install prompt, one tap.
 *  - iPhone / iPad Safari: Apple allows no install button, so the bar opens a 2-step hint
 *    («Поделиться» → «На экран Домой»).
 *  - Already installed (opened from the home screen) → nothing is shown.
 * «Не сейчас» hides it for 7 days (remembered in the app's encrypted storage).
 * `?install=1` in the address (the site's «Установить» button) opens the install step at once.
 */
import { h } from '../../shared/utils.js';

const KEY = 'pwa.installHidden';
let deferred = null;
let onChange = () => {};

const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const ios = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // we show our own bar instead of the mini-infobar
  deferred = e;
  onChange();
});
addEventListener('appinstalled', () => {
  deferred = null;
  document.querySelector('.install-bar')?.remove();
});

const hiddenUntil = async () => (await chrome.storage.local.get(KEY))[KEY] || 0;

function iosSheet() {
  const dlg = h('dialog', { class: 'sheet', 'aria-label': 'Установить на iPhone' });
  const close = () => (dlg.close(), dlg.remove());
  dlg.append(
    h('h2', { class: 'sheet__title' }, 'Установить на iPhone'),
    h('ol', { class: 'install-steps' },
      h('li', null, 'Нажмите ', h('strong', null, '«Поделиться»'), ' ', h('span', { class: 'install-ico', 'aria-hidden': 'true' }, '⬆'), ' внизу экрана Safari.'),
      h('li', null, 'Выберите ', h('strong', null, '«На экран Домой»'), ' ', h('span', { class: 'install-ico', 'aria-hidden': 'true' }, '⊞'), '.'),
      h('li', null, 'Нажмите ', h('strong', null, '«Добавить»'), '. Иконка SaudaPulse появится рядом с другими приложениями.')),
    h('p', { class: 'muted small' }, 'Открывайте SaudaPulse с главного экрана: так данные надёжно хранятся на телефоне.'),
    h('div', { class: 'sheet__actions' }, h('button', { type: 'button', class: 'btn btn--primary', onclick: close }, 'Понятно')),
  );
  dlg.addEventListener('cancel', (e) => (e.preventDefault(), close()));
  document.body.append(dlg);
  dlg.showModal();
}

async function install() {
  if (deferred) {
    const e = deferred;
    deferred = null;
    await e.prompt();
    const { outcome } = await e.userChoice.catch(() => ({}));
    if (outcome === 'accepted') document.querySelector('.install-bar')?.remove();
    return;
  }
  if (ios()) iosSheet();
}

/** Show the bar when installing is possible and the user did not hide it. Call after each render. */
export async function showInstallBar() {
  if (standalone()) return;
  const can = () => deferred || ios();
  const paint = async () => {
    document.querySelector('.install-bar')?.remove();
    if (!can() || (await hiddenUntil()) > Date.now()) return;
    const bar = h('div', { class: 'install-bar', role: 'region', 'aria-label': 'Установка приложения' },
      h('img', { src: new URL('../icons/icon-192.png', import.meta.url).href, alt: '', width: 40, height: 40 }),
      h('span', { class: 'install-bar__text' }, h('strong', null, 'SaudaPulse на телефон'), h('small', null, 'Открывается с главного экрана, как приложение')),
      h('button', { type: 'button', class: 'btn btn--ghost btn--small', 'aria-label': 'Не сейчас', onclick: async () => {
        await chrome.storage.local.set({ [KEY]: Date.now() + 7 * 86400000 });
        bar.remove();
      } }, '✕'),
      h('button', { type: 'button', class: 'btn btn--primary btn--small', dataset: { action: 'install' }, onclick: install }, 'Установить'),
    );
    document.body.append(bar);
  };
  onChange = paint;
  await paint();
  if (new URLSearchParams(location.search).get('install') === '1') {
    history.replaceState(null, '', location.pathname); // once
    if (ios()) iosSheet();
    else if (deferred) install();
  }
}
