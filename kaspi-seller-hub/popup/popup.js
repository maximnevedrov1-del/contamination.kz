/**
 * SaudaPulse — popup (Screen 1): quick status across stores.
 * Shows cached data instantly, then asks the worker for a fresh sync.
 */
import { initI18n, t, setLang, getLang, applyI18n, formatNumber, formatRelative, formatMoney } from '../shared/i18n.js';
import { h, clear, storeCounts, sumCounts, deadlineOf, urgencyOf } from '../shared/utils.js';
import { FEATURES } from '../shared/features.js';
import { withSnapshots } from '../shared/storage.js';
import { svgIcon } from '../shared/icons.js';

const $ = (id) => document.getElementById(id);
const send = (type, payload) => chrome.runtime.sendMessage({ type, payload });

let state = null;
let syncing = false;

/** Apply the theme stored in settings. */
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function renderLang() {
  document.querySelectorAll('#langSwitch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === getLang())));
}

/** Visible, enabled stores in a stable order. */
function storeList() {
  const stores = Object.values(state?.settings?.stores || {}).filter((s) => s.enabled);
  return stores.sort((a, b) => (a.alias || a.name).localeCompare(b.alias || b.name));
}

function render() {
  applyI18n();
  renderLang();
  // No usable subscription → one clear call to action instead of stale numbers.
  const lic = state.license;
  const blocked = lic && !lic.canUse;
  const inv = lic?.pendingInvoice;
  const needPay = !!inv && !lic.freeAccess && !lic.needsConsent && (lic.renewalDue || blocked || inv.kind === 'addon');
  $('licenseNotice').hidden = !(blocked || needPay);
  if (lic?.needsConsent) $('licenseNotice').textContent = `${t('terms.popup')} →`;
  else if (needPay) $('licenseNotice').textContent = `${t('notifications.payTitle', { amount: formatMoney(inv.amount) })} — ${t('pay.openQr')}`;
  else if (blocked) $('licenseNotice').textContent = `${t(`account.status.${lic.status}`, { date: '' })} — ${t('account.paywallButton')}`;
  const allowed = state.allowedStoreIds;
  const stores = storeList().filter((s) => !allowed || allowed.includes(s.id));
  const counts = stores.map((s) => storeCounts(state.snapshots[s.id]));
  const totals = sumCounts(counts);

  const totalsEl = clear($('totals'));
  // every number opens the list behind it in the dashboard
  [
    ['newOrders', 'popup.newOrders', 'orders'],
    ['returns', 'popup.returns', 'returns'],
    ['refusals', 'popup.refusals', 'refusals'],
    ['unpaid', 'popup.unpaid', 'payments'],
  ].forEach(([k, label, route]) =>
    totalsEl.append(
      h('button', { type: 'button', class: 'pp-total', dataset: { route }, title: t(label), onclick: async () => { await send('ui:openDashboard', { route }); window.close(); } },
        h('div', { class: 'pp-total__value' }, totals[k] == null ? '—' : formatNumber(totals[k])), h('div', { class: 'pp-total__label' }, t(label))),
    ),
  );

  // Orders whose deadline is near or missed, across enabled stores.
  const urgent = stores.reduce(
    (n, s) => n + (state.snapshots[s.id]?.sections?.orders?.items || []).filter((it) => ['soon', 'overdue'].includes(urgencyOf(deadlineOf(it, state.settings), state.settings))).length,
    0,
  );
  $('urgent').hidden = !urgent;
  clear($('urgent'));
  if (urgent) $('urgent').append(svgIcon('fire', { size: 16 }), ' ', t('deadline.popup', { count: urgent }));

  const list = clear($('storeList'));
  if (!stores.length) list.append(h('li', { class: 'pp-empty' }, t(FEATURES.cabinet ? 'popup.noStores' : 'popup.noStoresApi')));
  stores.forEach((s, i) => {
    const snap = state.snapshots[s.id];
    const c = counts[i];
    const status = snap?.status || 'noTab';
    const n = (v) => (v == null ? '—' : formatNumber(v));
    list.append(
      h(
        'li',
        { class: ['pp-store', status !== 'ok' && 'pp-store--off'], style: { '--store-color': s.color } },
        h('div', { class: 'pp-store__name' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { title: s.alias || s.name }, s.alias || s.name)),
        h(
          'div',
          { class: 'pp-store__counts' },
          h('span', { title: t('popup.newOrders') }, h('b', null, n(c.newOrders)), ' ', t('popup.newOrders').toLowerCase()),
          h('span', { title: t('popup.returns') }, svgIcon('return', { size: 14, label: t('popup.returns') }), h('b', null, n(c.returns))),
          h('span', { title: t('popup.refusals') }, svgIcon('cancel', { size: 14, label: t('popup.refusals') }), h('b', null, n(c.refusals))),
          h('span', { title: t('popup.unpaid') }, svgIcon('wallet', { size: 14, label: t('popup.unpaid') }), h('b', null, n(c.unpaid))),
        ),
        status !== 'ok' &&
          h(
            'div',
            { class: 'pp-store__status' },
            h('span', { class: 'badge badge--warn' }, t(`store.${status}`)),
            ' ',
            h('button', { type: 'button', class: 'linklike', onclick: () => send('ui:openStore', { shopId: s.id }) }, t('common.openStoreTab')),
          ),
      ),
    );
  });

  $('updated').textContent = syncing ? t('common.refreshing') : state.lastSync ? t('common.updated', { time: formatRelative(state.lastSync) }) : t('common.neverUpdated');
  $('refreshBtn').querySelector('svg').classList.toggle('spin', syncing);
}

async function refresh() {
  syncing = true;
  render();
  try {
    state = await withSnapshots(await send('ui:sync'));
  } finally {
    syncing = false;
    render();
  }
}

async function main() {
  await initI18n();
  state = await withSnapshots(await send('ui:getState'));
  applyTheme(state.settings.theme);
  render();

  $('langSwitch').addEventListener('click', async (e) => {
    const lang = e.target.closest('button')?.dataset.lang;
    if (!lang || lang === getLang()) return;
    await setLang(lang);
    state.settings.lang = lang;
    render();
  });
  $('refreshBtn').addEventListener('click', refresh);
  $('licenseNotice').addEventListener('click', async () => {
    await send('ui:openDashboard', { route: 'pay' });
    window.close();
  });
  $('urgent').addEventListener('click', async () => {
    await send('ui:openDashboard', { route: 'orders' });
    window.close();
  });
  $('openDashboard').addEventListener('click', async () => {
    await send('ui:openDashboard', { route: 'orders' });
    window.close();
  });
  // Not async: a returned promise would count as a reply to other pages' messages.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'bg:stateChanged' && msg.payload) {
      withSnapshots(msg.payload).then((st) => {
        state = st;
        render();
      });
    }
  });

  refresh();
}

main();
