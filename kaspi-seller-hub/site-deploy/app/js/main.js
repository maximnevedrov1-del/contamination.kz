/**
 * SaudaPulse phone app — screens. Two roles, two separate apps in one page:
 *   Owner  (Владелец):  Главная · Заказы · Магазины · Ещё
 *   Packer (Упаковщик): Очередь · Поиск · Профиль   — no revenue, cost prices, profit or billing
 *                       is ever loaded, stored or rendered in this mode.
 * Everything is built with h() (no innerHTML): text from Kaspi can never inject markup.
 */
import * as B from '../core/background/billing.js';
import * as S from '../core/shared/storage.js';
import { h, clear, deadlineOf, urgencyOf, orderProfit } from '../core/shared/utils.js';
import { encryptBackup, decryptBackup, readHeader, passphraseOk, backupFileName, MIN_PASSPHRASE } from '../core/shared/spbackup.js';
import * as D from './data.js';
import { getTurnstileToken } from './turnstile.js';
import { scanQr } from './scan.js';
import { decodeTransfer, QR_PREFIX } from '../core/shared/qr-transfer.js';
import { showInstallBar } from './install.js';
import { STAFF_CHECK_MS, STAFF_OFFLINE_GRACE_MS, AUTO_SYNC_MS } from './config.js';

const root = () => document.getElementById('app');
const state = { role: null, tab: null, license: null, staff: null, busy: false, filter: 'new', query: '' };

/* ---------------- texts ---------------- */
const ERR = {
  billingBadEmail: 'Проверьте адрес почты.',
  billingBadCode: 'Код не подошёл. Проверьте последнее письмо.',
  billingNetwork: 'Нет связи с сервером. Проверьте интернет.',
  billingCaptcha: 'Пройдите проверку «Я не робот» ещё раз.',
  billingRateLimit: 'Слишком много попыток. Подождите минуту.',
  apiUnauthorized: 'Kaspi не принял токен. Проверьте его в кабинете Kaspi (Настройки → Токен API).',
  apiNetwork: 'Kaspi не отвечает. Попробуйте позже.',
  apiTimeout: 'Kaspi долго не отвечает. Попробуйте позже.',
  apiRateLimit: 'Kaspi просит подождать. Повторите через минуту.',
  apiHttp: 'Kaspi вернул ошибку. Попробуйте позже.',
  tokenEmpty: 'Вставьте токен API из кабинета Kaspi.',
  backupInvalid: 'Это не файл SaudaPulse (.spbackup) или он повреждён.',
  backupWrongPassphrase: 'Пароль файла не подошёл.',
  backupWeakPassphrase: `Пароль файла — не короче ${MIN_PASSPHRASE} символов.`,
  backupIsStaff: 'Это файл для упаковщика. Владельцу нужен файл «для владельца».',
  backupIsOwner: 'Это файл владельца. Упаковщику нужен файл «для упаковщика».',
  backupNoOwner: 'Войдите как владелец, чтобы сделать файл для упаковщика.',
  backupTooBig: 'Файл слишком большой.',
  qrNotOurs: 'Это не QR-код SaudaPulse. Откройте на компьютере: расширение → Настройки → «Показать QR-код для телефона».',
  qrExpired: 'Код устарел. Нажмите на компьютере «Показать QR-код» ещё раз.',
  backupNoStores: 'В расширении нет магазинов, подключённых по токену API.',
  not_invited: 'Владелец не приглашал этот адрес почты. Попросите добавить вас в команду.',
  access_disabled: 'Владелец отключил ваш доступ.',
  owner_subscription_required: 'У владельца закончилась подписка.',
  storeNotAllowed: 'Этот магазин вам не доступен.',
  subscriptionRequired: 'Подписка не активна. Продлите её в расширении SaudaPulse на компьютере.',
};
const errText = (e) => ERR[e?.code] || ERR[e?.message] || (String(e?.detail || e?.message || '').match(/not_invited|access_disabled|owner_subscription_required/) ? ERR[String(e.detail || e.message).match(/not_invited|access_disabled|owner_subscription_required/)[0]] : 'Что-то пошло не так. Попробуйте ещё раз.');
const STATUS = { new: 'Новый', accepted: 'Принят', packed: 'Собран', delivering: 'У курьера', delivered: 'Выдан', cancelled: 'Отменён', returned: 'Возврат', unknown: '—' };
const money = (n) => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0))} ₸`;
const time = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Almaty' }) : '');
const ago = (ts) => (!ts ? 'ещё не обновлялось' : `обновлено ${new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Almaty' })}`);

/* ---------------- small UI kit ---------------- */
function toast(text, kind = 'info') {
  document.querySelectorAll('.toast').forEach((t) => t.remove()); // one message at a time
  const el = h('div', { class: `toast toast--${kind}`, role: kind === 'error' ? 'alert' : 'status' }, text);
  document.body.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3500);
}
const btn = (label, onclick, cls = '', extra = {}) => h('button', { type: 'button', class: `btn ${cls}`, onclick, ...extra }, label);
const field = (label, input) => h('label', { class: 'field' }, h('span', { class: 'field__label' }, label), input);
const card = (title, ...body) => h('section', { class: 'card' }, title ? h('h2', { class: 'card__title' }, title) : null, ...body);
async function busy(el, fn) {
  if (state.busy) return;
  state.busy = true;
  el?.setAttribute('aria-busy', 'true');
  if (el) el.disabled = true;
  try {
    return await fn();
  } catch (e) {
    toast(errText(e), 'error');
  } finally {
    state.busy = false;
    el?.removeAttribute('aria-busy');
    if (el) el.disabled = false;
  }
}
function confirmSheet(title, text, yes = 'Да') {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'sheet', 'aria-label': title });
    const close = (v) => (dlg.close(), dlg.remove(), resolve(v));
    dlg.append(h('h2', { class: 'sheet__title' }, title), h('p', null, text), h('div', { class: 'sheet__actions' }, btn('Отмена', () => close(false), 'btn--ghost'), btn(yes, () => close(true), 'btn--primary')));
    dlg.addEventListener('cancel', (e) => (e.preventDefault(), close(false)));
    document.body.append(dlg);
    dlg.showModal();
  });
}
function pickFile(accept = '.spbackup,application/json') {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, hidden: true, onchange: () => (resolve(input.files[0] || null), input.remove()) });
    document.body.append(input);
    input.click();
  });
}
function download(name, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 4000);
}

function shell(tabs, active, content, title) {
  const r = clear(root());
  r.append(
    h('header', { class: 'topbar' }, h('img', { src: './icons/icon-192.png', alt: '', class: 'topbar__logo', width: 28, height: 28 }), h('h1', { class: 'topbar__title' }, title), h('span', { class: `role-chip role-chip--${state.role}` }, state.role === 'staff' ? 'Упаковщик' : 'Владелец')),
    h('main', { class: 'content', id: 'content' }, content),
    h(
      'nav',
      { class: 'bottomnav', 'aria-label': 'Разделы' },
      tabs.map(([id, label, icon]) =>
        h('button', { type: 'button', class: ['bottomnav__btn', id === active && 'is-active'], 'aria-current': id === active ? 'page' : null, dataset: { tab: id }, onclick: () => go(id) }, h('span', { class: 'bottomnav__icon', 'aria-hidden': 'true' }, icon), h('span', null, label)),
      ),
    ),
  );
  showInstallBar();
}

/* ---------------- start / login ---------------- */
export async function start() {
  state.role = await D.getRole();
  if (!(await B.signedIn())) return renderLogin();
  return state.role === 'staff' ? startStaff() : startOwner();
}

function renderLogin(step = 'email', email = '') {
  const r = clear(root());
  const role = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Кто вы' });
  let chosen = state.role || 'owner';
  const opt = (id, label, hint) =>
    h('button', { type: 'button', role: 'radio', class: ['segmented__opt', chosen === id && 'is-on'], 'aria-checked': String(chosen === id), dataset: { role: id }, onclick: (e) => {
      chosen = id;
      role.querySelectorAll('.segmented__opt').forEach((b) => (b.classList.toggle('is-on', b.dataset.role === id), b.setAttribute('aria-checked', String(b.dataset.role === id))));
      hintEl.textContent = hint;
      e.currentTarget.blur();
    } }, label);
  const hintEl = h('p', { class: 'muted small' }, 'Магазины, выручка, маржа и заказы.');
  role.append(opt('owner', 'Я владелец', 'Магазины, выручка, маржа и заказы.'), opt('staff', 'Я упаковщик', 'Только очередь упаковки: без сумм и цен.'));

  if (step === 'email') {
    const input = h('input', { type: 'email', name: 'email', autocomplete: 'email', inputmode: 'email', required: true, placeholder: 'you@example.kz', value: email });
    const captchaBox = h('div', { class: 'captcha', id: 'captcha' });
    const send = btn('Получить код', async (e) => busy(e.currentTarget, async () => {
      state.role = chosen;
      const captcha = await getTurnstileToken(captchaBox);
      await B.requestCode(input.value, captcha, 'ru');
      renderLogin('code', input.value.trim().toLowerCase());
    }), 'btn--primary btn--block', { dataset: { action: 'send-code' } });
    r.append(
      h('div', { class: 'login' },
        h('img', { src: './icons/icon-192.png', alt: 'SaudaPulse', class: 'login__logo', width: 72, height: 72 }),
        h('h1', { class: 'login__title' }, 'SaudaPulse'),
        h('p', { class: 'muted' }, 'Заказы Kaspi на телефоне. Данные хранятся только на этом телефоне, в зашифрованном виде.'),
        role, hintEl,
        field('Почта', input), captchaBox, send,
      ),
    );
    showInstallBar();
    return;
  }
  const code = h('input', { type: 'text', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]*', maxlength: 10, required: true, placeholder: '123456' });
  r.append(
    h('div', { class: 'login' },
      h('h1', { class: 'login__title' }, 'Код из письма'),
      h('p', { class: 'muted' }, `Мы отправили код на ${email}.`),
      field('Код', code),
      btn('Войти', async (e) => busy(e.currentTarget, async () => {
        const prevUser = await D.getPhoneUser();
        await B.verifyCode(email, code.value);
        const user = await B.ownerUserId();
        // another account on this phone: the previous account's stores, tokens and orders are wiped first
        if (prevUser && user && prevUser !== user) await D.wipeKeepSession();
        await D.setPhoneUser(user);
        await D.setRole(state.role || 'owner');
        // fresh page: Cloudflare's captcha script never stays loaded next to decrypted data
        location.reload();
      }), 'btn--primary btn--block', { dataset: { action: 'verify-code' } }),
      btn('Другая почта', () => renderLogin('email', email), 'btn--ghost btn--block'),
    ),
  );
}

async function signOut({ wipe = false } = {}) {
  clearInterval(state.timer);
  await B.logout().catch(() => {});
  if (wipe) await D.wipePhone();
  location.reload();
}

/* ======================= OWNER ======================= */
const OWNER_TABS = [['home', 'Главная', '⌂'], ['orders', 'Заказы', '☰'], ['stores', 'Магазины', '▦'], ['more', 'Ещё', '⋯']];

async function startOwner() {
  state.role = 'owner';
  state.tab ||= 'home';
  await refreshLicense();
  await go(state.tab);
  clearInterval(state.timer);
  state.timer = setInterval(() => !document.hidden && ownerSync(null, { quiet: true }), AUTO_SYNC_MS);
}

async function refreshLicense(force = false) {
  const keys = await D.ownerStoreKeys();
  state.license = await B.licenseView({ force, storeCount: keys.length, storeKeys: keys }).catch(() => ({ status: 'offline', canUse: false }));
  if (state.license.status === 'loggedOut') return signOut();
  return state.license;
}
/** Stores this licence covers (oldest first, like the extension's store limit). */
async function allowedOwnerIds() {
  const lic = state.license;
  if (!lic?.canUse) return [];
  const ids = (await D.ownerStores()).map((s) => s.id);
  return lic.storeLimit == null ? ids : ids.slice(0, lic.storeLimit);
}

async function ownerSync(el, { quiet = false } = {}) {
  const run = async () => {
    const ids = await allowedOwnerIds();
    if (!ids.length) return;
    const { errors } = await D.syncOwner(ids);
    const bad = Object.values(errors);
    if (bad.length && !quiet) toast(errText({ code: bad[0] }), 'error');
    else if (!quiet) toast('Заказы обновлены', 'ok');
    if (['home', 'orders'].includes(state.tab)) render();
  };
  return quiet ? run().catch(() => {}) : busy(el, run);
}

async function go(tab) {
  state.tab = tab;
  await render();
  document.getElementById('content')?.scrollTo?.(0, 0);
}
async function render() {
  if (state.role === 'staff') return renderStaff();
  if (state.license?.needsConsent) return renderConsent(); // the offer comes before anything else, like in the extension
  const view = { home: ownerHome, orders: ownerOrders, stores: ownerStoresView, more: ownerMore }[state.tab] || ownerHome;
  const title = { home: 'Сводка', orders: 'Заказы', stores: 'Магазины', more: 'Ещё' }[state.tab];
  shell(OWNER_TABS, state.tab, await view(), title);
}

/** «Примите условия сервиса»: same text and server record (accept_terms) as the extension. */
function renderConsent() {
  const updated = !!state.license?.termsAcceptedAt;
  const box = h('input', { type: 'checkbox', id: 'terms-ok', dataset: { field: 'terms' } });
  const accept = btn('Принимаю', async (e) => busy(e.currentTarget, async () => {
    if (!box.checked) return;
    state.license = await B.acceptTerms();
    toast('Согласие сохранено', 'ok');
    await render();
  }), 'btn--primary btn--block', { disabled: true, dataset: { action: 'accept-terms' } });
  box.addEventListener('change', () => (accept.disabled = !box.checked));
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
  const r = clear(root());
  r.append(
    h('div', { class: 'login consent' },
      h('img', { src: './icons/icon-192.png', alt: '', class: 'login__logo', width: 64, height: 64 }),
      h('h1', { class: 'login__title' }, updated ? 'Условия сервиса обновились' : 'Примите условия сервиса'),
      h('p', { class: 'muted' }, updated
        ? 'Мы опубликовали новую редакцию оферты и политики конфиденциальности. Чтобы продолжить работу, подтвердите согласие.'
        : 'Чтобы пользоваться SaudaPulse, ознакомьтесь с офертой и политикой конфиденциальности и подтвердите согласие.'),
      h('label', { class: 'check consent__check', for: 'terms-ok' }, box,
        h('span', null, 'Я принимаю условия ', link('/offer', 'Публичной оферты'), ' и даю согласие на обработку моих персональных данных в соответствии с ', link('/privacy', 'Политикой конфиденциальности'), '.')),
      accept,
      btn('Выйти', () => signOut(), 'btn--ghost btn--block'),
    ),
  );
}

function licenseBanner() {
  const l = state.license;
  if (!l || l.canUse) return null;
  return h('div', { class: 'banner banner--warn', role: 'alert' }, l.status === 'offline' ? 'Нет связи с сервером подписки. Данные на телефоне доступны, обновление заказов — когда появится интернет.' : ERR.subscriptionRequired);
}

async function ownerHome() {
  const ids = await allowedOwnerIds();
  const stores = await D.ownerStores();
  if (!stores.length) {
    return h('div', null, licenseBanner(), card('Перенесите магазины с компьютера',
      h('ol', { class: 'steps' },
        h('li', null, 'На компьютере в расширении SaudaPulse: ', h('strong', null, 'Настройки → «Показать QR-код для телефона»'), '.'),
        h('li', null, 'Нажмите кнопку ниже и наведите камеру на код.')),
      btn('Сканировать QR с компьютера', (e) => importQrFlow(e.currentTarget), 'btn--primary btn--block btn--big', { dataset: { action: 'scan-qr' } }),
      h('p', { class: 'muted small' }, 'Код идёт с экрана прямо в камеру телефона — через интернет и наш сервер он не передаётся.'),
      btn('Другие способы', () => go('stores'), 'btn--ghost btn--block')));
  }
  const { tot, perStore, lastSync } = await D.ownerSummary(ids);
  return h('div', null,
    licenseBanner(),
    h('div', { class: 'kpis' },
      h('div', { class: 'kpi kpi--wide', dataset: { kpi: 'revenue' } }, h('span', { class: 'kpi__label' }, 'Выручка сегодня'), h('strong', { class: 'kpi__value' }, money(tot.todayRevenue)), h('span', { class: 'kpi__sub' }, `${tot.todayOrders} заказ(ов)`)),
      h('div', { class: 'kpi', dataset: { kpi: 'margin' } }, h('span', { class: 'kpi__label' }, 'Маржа сегодня'), h('strong', { class: 'kpi__value' }, tot.todayMargin == null ? '—' : `${Math.round(tot.todayMargin * 100)}%`), h('span', { class: 'kpi__sub' }, tot.todayMargin == null ? 'укажите себестоимость и комиссию' : `${money(tot.todayProfit)}${tot.todayProfitComplete ? '' : ' · часть заказов без себестоимости'}`)),
      h('div', { class: 'kpi', dataset: { kpi: 'week' } }, h('span', { class: 'kpi__label' }, 'За 7 дней'), h('strong', { class: 'kpi__value' }, money(tot.weekRevenue)), h('span', { class: 'kpi__sub' }, `${tot.weekOrders} заказ(ов)`)),
      h('button', { type: 'button', class: 'kpi kpi--action', onclick: () => ((state.filter = 'new'), go('orders')) }, h('span', { class: 'kpi__label' }, 'Новые'), h('strong', { class: 'kpi__value' }, String(tot.newOrders)), h('span', { class: 'kpi__sub' }, 'принять')),
      h('button', { type: 'button', class: 'kpi kpi--action', onclick: () => ((state.filter = 'accepted'), go('orders')) }, h('span', { class: 'kpi__label' }, 'Упаковать'), h('strong', { class: 'kpi__value' }, String(tot.toPack)), h('span', { class: 'kpi__sub' }, 'принятые')),
    ),
    card('По магазинам', h('ul', { class: 'list' }, perStore.map((s) => h('li', { class: 'list__row' }, h('span', { class: 'dot', style: { background: s.color } }), h('span', { class: 'list__main' }, s.name, h('small', { class: 'muted' }, `${s.todayOrders} сегодня · ${s.newOrders} новых`)), h('strong', null, money(s.todayRevenue)))))),
    h('div', { class: 'row-between' }, h('span', { class: 'muted small' }, ago(lastSync)), btn('Обновить', (e) => ownerSync(e.currentTarget), 'btn--primary', { dataset: { action: 'sync' } })),
  );
}

async function ownerOrders() {
  const ids = await allowedOwnerIds();
  const { orders, settings, costs } = await D.ownerSummary(ids);
  const filters = [['new', 'Новые'], ['accepted', 'Упаковать'], ['all', 'Все'], ['return', 'Возвраты']];
  const q = h('input', { type: 'search', inputmode: 'search', placeholder: 'Номер заказа', value: state.query, 'aria-label': 'Поиск по номеру', oninput: (e) => ((state.query = e.target.value), paint()) });
  const listEl = h('ul', { class: 'orders' });
  const paint = () => {
    const query = state.query.trim();
    const shown = orders
      .filter((o) => (state.filter === 'all' ? true : state.filter === 'return' ? o.kind === 'return' : o.status === state.filter))
      .filter((o) => !query || String(o.id).includes(query))
      .slice(0, 200);
    clear(listEl).append(...(shown.length ? shown.map((o) => orderRow(o, settings, costs)) : [h('li', { class: 'empty' }, 'Здесь пока пусто')]));
  };
  paint();
  return h('div', null,
    licenseBanner(),
    h('div', { class: 'chips', role: 'tablist' }, filters.map(([id, label]) => h('button', { type: 'button', role: 'tab', class: ['chip', state.filter === id && 'is-on'], 'aria-selected': String(state.filter === id), onclick: () => ((state.filter = id), render()) }, label))),
    q, listEl,
  );
}

function orderRow(o, settings, costs) {
  const urg = urgencyOf(deadlineOf(o, settings), settings);
  return h('li', null, h('button', { type: 'button', class: ['order', urg && `order--${urg}`], onclick: () => ownerOrderSheet(o, settings, costs) },
    h('span', { class: 'dot', style: { background: o.shopColor } }),
    h('span', { class: 'order__main' }, h('strong', null, `№ ${o.id}`), h('small', { class: 'muted' }, `${o.shopName} · ${time(o.date)}`)),
    h('span', { class: 'order__side' }, h('strong', null, money(o.amount)), h('span', { class: `badge badge--${o.status}` }, STATUS[o.status] || o.status)),
  ));
}

function ownerOrderSheet(o, settings, costs) {
  const dlg = h('dialog', { class: 'sheet', 'aria-label': `Заказ ${o.id}` });
  const close = () => (dlg.close(), dlg.remove());
  const p = orderProfit(o, costs, settings.profit);
  dlg.append(
    h('h2', { class: 'sheet__title' }, `Заказ № ${o.id}`),
    h('p', { class: 'muted' }, `${o.shopName} · ${time(o.date)} · ${STATUS[o.status] || o.status}`),
    h('ul', { class: 'list' }, (o.entries || []).map((e) => h('li', { class: 'list__row' }, h('span', { class: 'list__main' }, e.name || e.sku, h('small', { class: 'muted' }, `${e.sku} × ${e.quantity}`)), h('strong', null, money(e.total ?? e.price * e.quantity))))),
    o.entries ? null : h('p', { class: 'muted small' }, 'Состав заказа загрузится при следующем обновлении.'),
    h('div', { class: 'row-between' }, h('span', null, 'Сумма'), h('strong', null, money(o.amount))),
    p ? h('div', { class: 'row-between' }, h('span', null, 'Прибыль'), h('strong', null, `${money(p.profit)}${p.margin != null ? ` · ${Math.round(p.margin * 100)}%` : ''}${p.complete ? '' : ' *'}`)) : null,
    h('div', { class: 'sheet__actions' },
      btn('Закрыть', close, 'btn--ghost'),
      o.status === 'new' && state.license?.canUse ? btn('Принять', async (e) => busy(e.currentTarget, async () => {
        if (!(await confirmSheet('Принять заказ?', `Заказ № ${o.id} будет принят в Kaspi. Отменить это нельзя.`, 'Принять'))) return;
        const K = await import('../core/background/kaspi-api.js');
        const token = (await S.getApiTokens())[o.shopId];
        await K.acceptOrder(token, { id: o.api.id, code: o.api.code });
        toast('Заказ принят', 'ok');
        close();
        await ownerSync(null, { quiet: true });
      }), 'btn--primary') : null,
    ),
  );
  dlg.addEventListener('cancel', (e) => (e.preventDefault(), close()));
  document.body.append(dlg);
  dlg.showModal();
}

async function ownerStoresView() {
  const stores = await D.ownerStores();
  const name = h('input', { type: 'text', placeholder: 'Например: Мой магазин', autocomplete: 'off' });
  const token = h('input', { type: 'password', placeholder: 'Токен API из кабинета Kaspi', autocomplete: 'off', spellcheck: false });
  return h('div', null,
    licenseBanner(),
    card('Мои магазины',
      stores.length
        ? h('ul', { class: 'list' }, stores.map((s) => h('li', { class: 'list__row' }, h('span', { class: 'dot', style: { background: s.color } }), h('span', { class: 'list__main' }, s.alias || s.name, h('small', { class: 'muted' }, `токен …${s.api?.last4 || ''}`)), btn('Убрать', async (e) => {
            if (!(await confirmSheet('Убрать магазин с телефона?', 'Токен и заказы этого магазина будут удалены с телефона. В Kaspi ничего не изменится.', 'Убрать'))) return;
            await D.removeStore(s.id);
            render();
          }, 'btn--ghost btn--small'))))
        : h('p', { class: 'muted' }, 'Пока нет магазинов.'),
    ),
    stores.length ? card('Ассортимент и остатки',
      h('p', null, 'Заказы приходят по токену. Чтобы видеть весь ассортимент и остатки, загрузите прайс-лист из кабинета Kaspi в расширение на компьютере — 1 минута:'),
      h('ol', { class: 'steps small' },
        h('li', null, 'Кабинет Kaspi: Товары → Прайс-лист → Скачать в Excel.'),
        h('li', null, 'Расширение: «Выгрузка товаров» → «Загрузить ассортимент».')),
      h('p', { class: 'muted small' }, 'После этого при каждой отгрузке остаток уменьшается сам (−1, −2…) — и в SaudaPulse, и в Kaspi.')) : null,
        card('Перенести с компьютера',
      h('p', null, 'На компьютере: расширение SaudaPulse → Настройки → «Показать QR-код для телефона». Затем нажмите:'),
      btn('Сканировать QR с компьютера', (e) => importQrFlow(e.currentTarget), 'btn--primary btn--block btn--big', { dataset: { action: 'scan-qr' } }),
    ),
    h('details', { class: 'card more' },
      h('summary', { class: 'more__sum' }, 'Другие способы'),
      h('h3', null, 'Файл .spbackup'),
      h('p', { class: 'muted small' }, 'Если на компьютере сохранили файл с паролем.'),
      btn('Открыть файл .spbackup', (e) => importBackupFlow(e.currentTarget, 'owner'), 'btn--block', { dataset: { action: 'import-owner' } }),
      h('h3', null, 'Токен API Kaspi'),
      field('Название', name), field('Токен API', token),
      btn('Подключить', async (e) => busy(e.currentTarget, async () => {
        if (!state.license?.canUse) throw { code: 'subscriptionRequired' };
        await D.connectStore({ name: name.value, token: token.value });
        token.value = '';
        toast('Магазин подключён', 'ok');
        await refreshLicense(true);
        render();
        ownerSync(null, { quiet: true });
      }), 'btn--block', { dataset: { action: 'connect' } }),
      h('p', { class: 'muted small' }, 'Токен хранится только на этом телефоне, зашифрованным. На наш сервер он не отправляется и не сохраняется.'),
      h('h3', null, 'Упаковщику'),
      h('p', { class: 'muted small' }, 'Упаковщик увидит только очередь сборки — без сумм, цен и прибыли. Сначала пригласите его в команду в расширении (Настройки → Команда).'),
      btn('Сделать файл для упаковщика', (e) => exportBackupFlow(e.currentTarget, 'staff'), 'btn--block', { dataset: { action: 'export-staff' } }),
      btn('Сделать файл для своего компьютера', (e) => exportBackupFlow(e.currentTarget, 'owner'), 'btn--ghost btn--block'),
    ),
  );
}

/** One tap: scan the computer's QR → stores, tokens (and cost prices when they fit) on this phone. */
async function importQrFlow(el) {
  const text = await scanQr({ title: 'Сканировать QR с компьютера', hint: 'Наведите камеру на код в расширении SaudaPulse на компьютере.', accept: (t) => t.startsWith(QR_PREFIX) });
  if (!text) return;
  await busy(el, async () => {
    const payload = await decodeTransfer(text);
    const res = await D.importOwnerBackup(payload);
    toast(`Готово: магазинов ${res.stores}${res.costs ? `, себестоимостей ${res.costs}` : ''}`, 'ok');
    await refreshLicense(true);
    state.tab = 'home';
    await render();
    ownerSync(null, { quiet: true });
  });
}

async function askPassphrase(title, { confirm = false } = {}) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'sheet', 'aria-label': title });
    const p1 = h('input', { type: 'password', autocomplete: confirm ? 'new-password' : 'current-password', minlength: MIN_PASSPHRASE, placeholder: `не короче ${MIN_PASSPHRASE} символов` });
    const p2 = confirm ? h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'повторите' }) : null;
    const msg = h('p', { class: 'error small', role: 'alert' });
    const close = (v) => (dlg.close(), dlg.remove(), resolve(v));
    dlg.append(
      h('h2', { class: 'sheet__title' }, title),
      field('Пароль файла', p1), p2 ? field('Ещё раз', p2) : null, msg,
      h('p', { class: 'muted small' }, 'Пароль не хранится нигде. Передайте его отдельно от файла (например, голосом).'),
      h('div', { class: 'sheet__actions' }, btn('Отмена', () => close(null), 'btn--ghost'), btn('Готово', () => {
        if (confirm && !passphraseOk(p1.value)) return (msg.textContent = ERR.backupWeakPassphrase);
        if (confirm && p1.value !== p2.value) return (msg.textContent = 'Пароли не совпадают.');
        close(p1.value);
      }, 'btn--primary', { dataset: { action: 'passphrase-ok' } })),
    );
    dlg.addEventListener('cancel', (e) => (e.preventDefault(), close(null)));
    document.body.append(dlg);
    dlg.showModal();
  });
}

async function exportBackupFlow(el, scope) {
  const pass = await askPassphrase(scope === 'staff' ? 'Файл для упаковщика' : 'Файл для компьютера', { confirm: true });
  if (!pass) return;
  await busy(el, async () => {
    const ownerId = scope === 'staff' ? await B.ownerUserId() : null;
    const file = await encryptBackup(await D.backupPayload(scope, { ownerId }), pass, { scope });
    download(backupFileName(scope), JSON.stringify(file));
    toast('Файл сохранён. Он зашифрован.', 'ok');
  });
}

async function importBackupFlow(el, expectScope) {
  const f = await pickFile();
  if (!f) return;
  if (f.size > 20 * 1024 * 1024) return toast(ERR.backupTooBig, 'error');
  const text = await f.text();
  try {
    readHeader(JSON.parse(text));
  } catch {
    return toast(ERR.backupInvalid, 'error');
  }
  const pass = await askPassphrase('Пароль файла');
  if (!pass) return;
  await busy(el, async () => {
    const { payload } = await decryptBackup(text, pass, { expectScope });
    if (expectScope === 'owner') {
      const res = await D.importOwnerBackup(payload);
      toast(`Перенесено магазинов: ${res.stores}, себестоимостей: ${res.costs}`, 'ok');
      await refreshLicense(true);
      await render();
      ownerSync(null, { quiet: true });
    } else {
      await D.importStaffBackup(payload);
      await staffCheck({ join: true });
    }
  });
}

async function ownerMore() {
  const l = state.license || {};
  const st = { active: 'Оплачена', trial: 'Пробный период', grace: 'Льготные дни', expired: 'Закончилась', frozen: 'Заморожена', offline: 'Нет связи', invalid: 'Ошибка лицензии' }[l.status] || l.status || '—';
  return h('div', null,
    card('Аккаунт', h('p', null, l.email || ''), h('div', { class: 'row-between' }, h('span', null, 'Подписка'), h('strong', null, st)), l.daysLeft != null && l.canUse ? h('div', { class: 'row-between' }, h('span', null, 'Осталось дней'), h('strong', null, String(l.daysLeft))) : null, l.storeLimit != null ? h('div', { class: 'row-between' }, h('span', null, 'Магазинов по тарифу'), h('strong', null, String(l.storeLimit))) : null, h('p', { class: 'muted small' }, 'Оплата и счета — в расширении SaudaPulse на компьютере.')),
    card('Безопасность', h('p', null, 'Токены, заказы и себестоимость хранятся только на этом телефоне, зашифрованы (AES-256). Наш сервер их не получает и не хранит. Запросы к Kaspi идут через проходной узел без журнала.')),
    card('Установить на главный экран', h('p', null, 'iPhone: Safari → «Поделиться» → «На экран Домой». Android: Chrome → меню ⋮ → «Установить приложение».')),
    btn('Выйти', () => signOut(), 'btn--block', { dataset: { action: 'logout' } }),
    btn('Выйти и стереть всё с телефона', async () => (await confirmSheet('Стереть всё?', 'Токены, заказы и настройки будут удалены с этого телефона без возможности восстановления.', 'Стереть')) && signOut({ wipe: true }), 'btn--danger btn--block'),
  );
}

/* ======================= PACKER ======================= */
const STAFF_TABS = [['queue', 'Очередь', '☰'], ['search', 'Поиск', '⌕'], ['profile', 'Профиль', '☺']];

async function startStaff() {
  state.role = 'staff';
  state.tab = ['queue', 'search', 'profile'].includes(state.tab) ? state.tab : 'queue';
  state.staff = await D.getStaff();
  if (!state.staff?.ownerId) return renderStaffSetup();
  await staffCheck({ join: !state.staff.member });
  clearInterval(state.timer);
  state.timer = setInterval(() => !document.hidden && staffCheck({ quiet: true }), STAFF_CHECK_MS);
}

function renderStaffSetup() {
  shell([['setup', 'Начало', '☰']], 'setup', h('div', null,
    card('Файл от владельца',
      h('p', null, 'Попросите владельца сделать «Файл для упаковщика» и сказать пароль. Откройте файл здесь.'),
      btn('Открыть файл .spbackup', (e) => importBackupFlow(e.currentTarget, 'staff'), 'btn--primary btn--block', { dataset: { action: 'import-staff' } }),
    ),
    btn('Выйти', () => signOut({ wipe: true }), 'btn--ghost btn--block'),
  ), 'Упаковка');
}

/** Is this packer still allowed? (server: team_join / team_check). Switched off → phone wiped. */
async function staffCheck({ join = false, quiet = false } = {}) {
  const staff = (state.staff = await D.getStaff());
  if (!staff?.ownerId) return renderStaffSetup();
  try {
    const token = await B.currentToken();
    if (!token) return signOut({ wipe: true }); // session revoked / user deleted: nothing stays on a packer phone
    const member = await B.rpcWith(token, join ? 'team_join' : 'team_check', { p_owner: staff.ownerId });
    state.staff = { ...staff, member, lastOkAt: Date.now() };
    await D.setStaff(state.staff);
    await D.pruneStaffStores(member?.shop_ids); // tokens of stores not given to this packer leave the phone
    state.staff = await D.getStaff();
  } catch (e) {
    const reason = String(e?.detail || e?.message || '').match(/not_invited|access_disabled|owner_subscription_required/)?.[0];
    if (reason) {
      await B.logout().catch(() => {});
      await D.wipePhone();
      clearInterval(state.timer);
      shell([['setup', 'Доступ', '☰']], 'setup', card('Доступ закрыт', h('p', { role: 'alert' }, ERR[reason]), h('p', { class: 'muted small' }, 'Данные магазина удалены с этого телефона.'), btn('Войти снова', () => location.reload(), 'btn--primary btn--block')), 'Упаковка');
      return;
    }
    // no answer: keep working for a few minutes, then lock until the server answers again
    if (Date.now() - (staff.lastOkAt || 0) > STAFF_OFFLINE_GRACE_MS) {
      shell([['setup', 'Связь', '☰']], 'setup', card('Нет связи', h('p', null, 'Не удаётся проверить доступ. Проверьте интернет.'), btn('Повторить', (ev) => busy(ev.currentTarget, () => staffCheck()), 'btn--primary btn--block')), 'Упаковка');
      return;
    }
  }
  if (!quiet) {
    await staffSync(null, { quiet: true });
    await render();
  } else staffSync(null, { quiet: true }).then(() => state.tab === 'queue' && render());
}

const staffAllowed = () => {
  const m = state.staff?.member;
  const own = Object.keys(state.staff?.stores || {});
  return m?.shop_ids?.length ? own.filter((id) => m.shop_ids.includes(id)) : own;
};
async function staffSync(el, { quiet = false } = {}) {
  const run = async () => {
    const { errors } = await D.syncStaff(staffAllowed());
    const bad = Object.values(errors);
    if (bad.length && !quiet) toast(errText({ code: bad[0] }), 'error');
    if (!quiet) render();
  };
  return quiet ? run().catch(() => {}) : busy(el, run);
}

async function renderStaff() {
  const view = { queue: staffQueueView, search: staffSearchView, profile: staffProfile }[state.tab] || staffQueueView;
  shell(STAFF_TABS, state.tab, await view(), { queue: 'Очередь упаковки', search: 'Поиск заказа', profile: 'Профиль' }[state.tab]);
}

async function staffQueueView() {
  const settings = await S.getSettings();
  const list = await D.staffQueue(staffAllowed(), settings);
  const canAccept = !!state.staff?.member?.can_accept;
  const toPack = list.filter((o) => (o.status === 'accepted' && !o.localPacked) || (o.status === 'new' && canAccept));
  const lastSync = (await chrome.storage.local.get(D.APP_KEYS.lastSync))[D.APP_KEYS.lastSync];
  return h('div', null,
    h('div', { class: 'row-between' }, h('span', { class: 'muted small' }, `${toPack.length} в очереди · ${ago(lastSync)}`), btn('Обновить', (e) => staffSync(e.currentTarget), 'btn--primary', { dataset: { action: 'sync' } })),
    h('ul', { class: 'orders' }, toPack.length ? toPack.map((o) => h('li', null, h('button', { type: 'button', class: ['order', o.urgency && `order--${o.urgency}`], dataset: { order: o.id }, onclick: () => staffOrderSheet(o) },
      h('span', { class: 'dot', style: { background: o.shopColor } }),
      h('span', { class: 'order__main' }, h('strong', null, `№ ${o.id}`), h('small', { class: 'muted' }, `${o.shopName} · ${(o.entries || []).reduce((n, e) => n + e.quantity, 0) || '?'} шт.`)),
      h('span', { class: 'order__side' }, h('span', { class: `badge badge--${o.status}` }, STATUS[o.status]), o.deadline ? h('small', { class: 'muted' }, `до ${time(new Date(o.deadline.at).toISOString())}`) : null),
    ))) : [h('li', { class: 'empty' }, 'Очередь пуста 🎉')]),
  );
}

function staffOrderSheet(o) {
  const started = Date.now();
  const dlg = h('dialog', { class: 'sheet', 'aria-label': `Заказ ${o.id}` });
  const close = () => (dlg.close(), dlg.remove());
  const lines = (o.entries || []).map((e) => ({ ...e, done: false }));
  const listEl = h('ul', { class: 'list' });
  const scan = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'Сканируйте или введите артикул', 'aria-label': 'Штрихкод или артикул', onkeydown: (ev) => {
    if (ev.key !== 'Enter') return;
    const code = scan.value.trim();
    scan.value = '';
    const line = lines.find((l) => !l.done && l.sku && l.sku === code);
    if (line) (line.done = true), paint();
    else toast('Такого товара нет в этом заказе', 'error');
  } });
  const paint = () => clear(listEl).append(...lines.map((l) => h('li', null, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: l.done, onchange: (ev) => ((l.done = ev.target.checked), paint()) }), h('span', { class: 'list__main' }, l.name || l.sku, h('small', { class: 'muted' }, `${l.sku} × ${l.quantity}`))))));
  paint();
  const canAccept = !!state.staff?.member?.can_accept;
  const act = async (action, el) => busy(el, async () => {
    if (action === 'pack' && lines.length && lines.some((l) => !l.done) && !(await confirmSheet('Не все товары отмечены', 'Всё равно отметить заказ собранным?', 'Да, собран'))) return;
    await D.staffAction(action, o, { seconds: (Date.now() - started) / 1000, checked: lines.every((l) => l.done) ? 'scan' : 'manual' });
    toast(action === 'accept' ? 'Заказ принят' : 'Заказ собран', 'ok');
    close();
    render();
  });
  dlg.append(
    h('h2', { class: 'sheet__title' }, `Заказ № ${o.id}`),
    h('p', { class: 'muted' }, `${o.shopName} · ${STATUS[o.status]}${o.api?.isKaspiDelivery ? ' · Kaspi Доставка' : ''}`),
    o.entries ? listEl : h('p', { class: 'muted' }, 'Состав заказа ещё не загружен — нажмите «Обновить».'),
    o.entries ? scan : null,
    h('div', { class: 'sheet__actions' },
      btn('Закрыть', close, 'btn--ghost'),
      o.status === 'new' && canAccept ? btn('Принять', (e) => act('accept', e.currentTarget), 'btn--primary') : null,
      o.status === 'accepted' ? btn('Собран', (e) => act('pack', e.currentTarget), 'btn--primary', { dataset: { action: 'pack' } }) : null,
    ),
  );
  dlg.addEventListener('cancel', (e) => (e.preventDefault(), close()));
  document.body.append(dlg);
  dlg.showModal();
  if (lines.length) setTimeout(() => scan.focus(), 50);
}

async function staffSearchView() {
  const input = h('input', { type: 'search', inputmode: 'numeric', placeholder: 'Номер заказа', 'aria-label': 'Номер заказа', autocomplete: 'off' });
  const out = h('div');
  const find = async (code, el) => busy(el, async () => {
    const o = await D.staffFind(code, staffAllowed());
    if (!o) return clear(out).append(h('p', { class: 'muted' }, 'Заказ не найден.'));
    const staff = state.staff?.stores?.[o.shopId] || {};
    clear(out);
    staffOrderSheet({ ...o, shopName: staff.name || o.shopId, shopColor: staff.color });
  });
  const camera = 'BarcodeDetector' in globalThis ? btn('Сканировать камерой', async (e) => {
    const el = e.currentTarget; // before the await: currentTarget is null afterwards
    const code = await scanWithCamera().catch(() => null);
    if (code) (input.value = code), find(code, el);
  }, 'btn--block') : null;
  return h('div', null,
    card(null, field('Номер заказа или штрихкод накладной', input), btn('Найти', (e) => find(input.value, e.currentTarget), 'btn--primary btn--block', { dataset: { action: 'find' } }), camera),
    out,
  );
}

/** Camera scan (Android Chrome: BarcodeDetector). Nothing is recorded or sent. */
async function scanWithCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  const video = h('video', { playsinline: true, muted: true, class: 'scanner__video' });
  video.srcObject = stream;
  const dlg = h('dialog', { class: 'sheet scanner' }, video);
  document.body.append(dlg);
  dlg.showModal();
  await video.play();
  const detector = new globalThis.BarcodeDetector();
  try {
    for (let i = 0; i < 300 && dlg.open; i++) {
      const codes = await detector.detect(video).catch(() => []);
      if (codes[0]?.rawValue) return codes[0].rawValue;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    dlg.remove();
  }
}

async function staffProfile() {
  const m = state.staff?.member || {};
  const stores = state.staff?.stores || {};
  const allowed = staffAllowed();
  return h('div', null,
    card('Я', h('p', null, m.name || ''), h('p', { class: 'muted' }, m.email || ''), h('div', { class: 'row-between' }, h('span', null, 'Могу принимать заказы'), h('strong', null, m.can_accept ? 'да' : 'нет'))),
    card('Магазины', h('ul', { class: 'list' }, allowed.map((id) => h('li', { class: 'list__row' }, h('span', { class: 'dot', style: { background: stores[id]?.color } }), h('span', { class: 'list__main' }, stores[id]?.name || id))))),
    card('Безопасность', h('p', null, 'На этом телефоне нет сумм, цен и прибыли — только состав заказов для сборки. Если владелец отключит доступ, данные удалятся с телефона автоматически.')),
    btn('Выйти и стереть данные', async () => (await confirmSheet('Выйти?', 'Данные магазина будут удалены с телефона.', 'Выйти')) && signOut({ wipe: true }), 'btn--danger btn--block', { dataset: { action: 'logout' } }),
  );
}
