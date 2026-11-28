/**
 * SaudaPulse — dashboard (Screen 2).
 *
 * Routes (location.hash): orders · returns · refusals · payments · analytics · chat · settings
 * Data comes from the service worker (ui:* messages) and chrome.storage; nothing
 * here talks to Kaspi directly. Every visible string goes through t().
 */
import {
  initI18n,
  t,
  hasKey,
  setLang,
  getLang,
  applyI18n,
  onLangChange,
  formatMoney,
  formatMoneyCompact,
  formatNumber,
  formatPercent,
  formatDate,
  formatRelative,
  formatChatTime,
  formatDuration,
} from '../shared/i18n.js';
import '../shared/selectors.js';
import { startUx } from './ux-wire.js';
import { legalUrl, SUPPORT } from '../shared/billing-config.js';
import { getCaptchaToken } from '../shared/captcha.js';
import { createCatalogView, copyText } from './catalog-view.js';
import { mountAdBanner } from './ad-banner.js';
import { FEATURES } from '../shared/features.js';
import { svgIcon } from '../shared/icons.js';
import { phoneTransferCard } from './phone-transfer.js';
import { renderLockScreen, renderPacker, teamCard, warehouseCard, journalCard } from './staff-view.js';
import { getChat, countInvoices, clearInvoices, onKeyChange, KEYS, getCosts, setPickList, getPhotos, getCatalog, withSnapshots } from '../shared/storage.js';
import { photoFor, isAllowedPhoto, fileToPhoto } from '../shared/photos.js';
import { PAPER_MODES, LABEL_PRESETS, LABEL_LIMITS, normalizePrint } from './print-layout.js';
import {
  h,
  s,
  clear,
  debounce,
  presetRange,
  startOfDay,
  endOfDay,
  dayKey,
  eachDay,
  inRange,
  groupBy,
  sumBy,
  ratio,
  compareValues,
  itemKey,
  storeCounts,
  STORE_COLORS,
  deadlineOf,
  urgencyOf,
  orderProfit,
  commissionPct,
  productKey,
} from '../shared/utils.js';
import { lineChart, barChart } from './charts.js';
import { bannerFrom, expiryNotice } from '../shared/notices.js';
import { statusBanner, supportCard, unreadAnswers, getCsat } from './support-view.js';
import { npsCard, exitCard } from './feedback-view.js';
import { storeMeter, needsUpsell, openUpsell, openCancelFlow, planNotice, telegramCard } from './growth-view.js';
import { onboardingCard, ownerInstructions, markStep, getOnboarding, ONBOARD_KEY } from './onboarding.js';

/* ===================================================================== */
/* State                                                                  */
/* ===================================================================== */

const ROUTES = ['home', 'orders', 'returns', 'refusals', 'payments', 'analytics', 'products', 'catalog', 'chat', 'settings', 'account', 'help'].filter((r) => r !== 'chat' || FEATURES.cabinet);
// API-only build: no chat (it lives in the cabinet tab, see shared/features.js)
if (!FEATURES.cabinet) document.querySelector('a[data-route=chat]')?.remove();
const TABLE_ROUTES = ['orders', 'returns', 'refusals', 'payments'];

const tableState = () => ({ sort: { key: 'date', dir: 'desc' }, status: 'all', payment: 'all', q: '', urgent: false, tab: 'all', selected: new Set(), focus: 0 });

const state = {
  /** @type {{settings:any, snapshots:Record<string,any>, lastSync:number, tabs:any[], unauthTabs:number}|null} */
  data: null,
  chat: {},
  route: 'home',
  syncing: false,
  filters: { shopId: 'all', preset: '30', from: '', to: '' },
  tables: Object.fromEntries(TABLE_ROUTES.map((r) => [r, tableState()])),
  paymentGroup: 'pending',
  analyticsTables: new Set(),
  chatUi: { active: null, unreadOnly: false, loading: false, error: null, sending: false, drafts: {}, pending: {} },
  job: null,
  invoiceCount: 0,
  costs: {},
  productsQ: '',
  disposers: [],
};

const $ = (id) => document.getElementById(id);
/** The single advertising placement (dashboard/ad-banner.js); null until the page is wired. Never awaited by business code. */
let adBanner = null;
const send = (type, payload) => chrome.runtime.sendMessage({ type, payload });

// page crashes go to the local journal for support (shared/errorlog.js)
const logPageError = (message) => chrome.runtime.sendMessage({ type: 'ui:logError', payload: { where: 'dashboard', message } }).catch(() => {});
window.addEventListener('error', (e) => logPageError(`${e.message || e.error} @${String(e.filename || '').split('/').pop()}:${e.lineno || ''}`));
window.addEventListener('unhandledrejection', (e) => logPageError(e.reason?.message || String(e.reason)));

/* ===================================================================== */
/* Generic helpers                                                        */
/* ===================================================================== */

const stores = () => state.data?.settings?.stores || {};
const enabledStores = () =>
  Object.values(stores())
    .filter((s) => s.enabled)
    .sort((a, b) => (a.alias || a.name).localeCompare(b.alias || b.name));
/** Enabled stores covered by the subscription (all of them in developer mode). */
const allowedIds = () => state.data?.allowedStoreIds || null;
const dataStores = () => enabledStores().filter((s) => !allowedIds() || allowedIds().includes(s.id));
/** Stores matching the top-bar store filter. */
const filteredStores = () => dataStores().filter((s) => state.filters.shopId === 'all' || s.id === state.filters.shopId);
const storeName = (id) => stores()[id]?.alias || stores()[id]?.name || state.data?.snapshots?.[id]?.shopName || id;
const storeColor = (id) => stores()[id]?.color || 'var(--text-3)';

/** Active date range from the top bar. */
function dateRange() {
  const f = state.filters;
  if (f.preset === 'custom' && f.from && f.to) return { from: startOfDay(f.from), to: endOfDay(f.to) };
  return presetRange(Number(f.preset === 'custom' ? 30 : f.preset));
}

/** Human message for an error code coming from the worker / content script. */
const errorText = (code) => (code && hasKey(`errors.${code}`) ? t(`errors.${code}`) : t('errors.generic', { error: code || '?' }));

function toast(message, variant = 'info', timeout = 5000) {
  const el = h('div', { class: ['toast', `toast--${variant}`], role: variant === 'error' ? 'alert' : 'status' }, h('span', { class: 'dot' }), h('div', null, message));
  $('toasts').append(el);
  setTimeout(() => el.remove(), timeout);
}

/** Modal confirmation. Resolves true on confirm. */
function confirmDialog(title, text) {
  const dlg = $('confirmDialog');
  dlg.querySelector('.dialog__title').textContent = title;
  dlg.querySelector('.dialog__text').textContent = text;
  applyI18n(dlg);
  dlg.returnValue = '';
  dlg.showModal();
  dlg.querySelector('button[value="ok"]').focus();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

/** Summarize a job result as a toast. */
function reportResults(results, okKey) {
  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  toast(t(okKey, { ok, total: results.length }), failed.length ? (ok ? 'info' : 'error') : 'ok');
  const notes = results.filter((r) => r.ok && r.info);
  if (notes.length) toast(`${errorText(notes[0].info)} (${notes.map((r) => r.orderId).slice(0, 5).join(', ')})`, 'info', 9000);
  if (failed.length) {
    const byErr = groupBy(failed, (r) => r.error || 'noResponse');
    const details = Object.entries(byErr)
      .map(([code, list]) => `${errorText(code)} (${list.map((r) => r.orderId).slice(0, 5).join(', ')}${list.length > 5 ? '…' : ''})`)
      .join('; ');
    toast(t('errors.partial', { count: failed.length, details }), 'error', 9000);
  }
}

const ICONS = {
  warn: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/></svg>',
  inbox: '<svg viewBox="0 0 24 24"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/></svg>',
};
/** Static, trusted SVG markup only (never data from Kaspi). */
const icon = (name) => {
  const span = h('span', { class: 'icon', 'aria-hidden': 'true' });
  const svg = new DOMParser().parseFromString(ICONS[name].replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '), 'image/svg+xml').documentElement;
  span.append(document.importNode(svg, true));
  return span;
};

function emptyState(title, text, action) {
  return h('div', { class: 'empty' }, h('div', { class: 'empty__icon' }, icon('inbox')), h('p', { class: 'empty__title' }, title), text && h('p', { class: 'empty__text' }, text), action);
}

const storeChip = (id) => h('span', { class: 'store-chip', style: { '--store-color': storeColor(id) } }, h('span', { class: 'dot', 'aria-hidden': 'true' }), storeName(id));
const storeBadge = (id) => h('span', { class: 'store-badge', style: { '--store-color': storeColor(id) } }, h('span', { class: 'dot', 'aria-hidden': 'true' }), storeName(id));

/** Kaspi API cancellation codes (MERCHANT_OUT_OF_STOCK…) → readable text; free text passes through. */
const reasonText = (r) => (r && /^[A-Z_]+$/.test(r) ? (hasKey(`cancelReason.${r}`) ? t(`cancelReason.${r}`) : r) : r || '');

const STATUS_VARIANT = { new: 'info', accepted: 'info', packed: 'ok', delivering: '', delivered: 'ok', cancelled: 'danger', returned: 'warn', refused: 'danger', unknown: '' };
const PAYMENT_VARIANT = { paid: 'ok', pending: 'warn', failed: 'danger', refunded: '', unknown: '' };
const statusBadge = (r) => h('span', { class: ['badge', STATUS_VARIANT[r.status] && `badge--${STATUS_VARIANT[r.status]}`], title: r.statusRaw || null }, t(`status.${r.status}`));
const paymentBadge = (r) => h('span', { class: ['badge', PAYMENT_VARIANT[r.paymentStatus] && `badge--${PAYMENT_VARIANT[r.paymentStatus]}`], title: r.paymentRaw || null }, t(`payment.${r.paymentStatus}`));

/* ===================================================================== */
/* Data selectors                                                         */
/* ===================================================================== */

const SECTION_SOURCE = { orders: 'orders', payments: 'orders', returns: 'returns', refusals: 'refusals' };

/** All rows of a section for the filtered stores and date range. */
function sectionRows(route) {
  const src = SECTION_SOURCE[route];
  const range = dateRange();
  return filteredStores().flatMap((s) =>
    (state.data.snapshots[s.id]?.sections?.[src]?.items || []).filter((it) => inRange(it.date, range)).map((it) => ({ ...it, shopId: s.id, key: itemKey(s.id, it.id) })),
  );
}

/** Notes about stores whose data for this section is cached / not visible. */
function sectionNotes(route) {
  const src = SECTION_SOURCE[route];
  return filteredStores().flatMap((s) => {
    const snap = state.data.snapshots[s.id];
    const sec = snap?.sections?.[src];
    if (!snap || snap.status !== 'ok') return [];
    if (!sec || sec.status === 'notVisible') return [t('store.sectionNotVisible', { section: t(`nav.${route === 'payments' ? 'orders' : route}`), store: storeName(s.id) })];
    if (sec.source === 'cache') return [`${storeName(s.id)}: ${t('common.stale')} · ${t('store.lastData', { time: formatRelative(sec.ts) })}`];
    return [];
  });
}

/* ===================================================================== */
/* Columns                                                                */
/* ===================================================================== */

const COLUMNS = {
  id: { label: 'table.orderId', value: (r) => r.id, render: (r) => (r.kind === 'order' || !r.kind ? h('button', { type: 'button', class: 'link mono', title: t('order.open'), onclick: (e) => (e.stopPropagation(), openOrder(r)) }, r.id) : h('span', { class: 'mono' }, r.id)) },
  store: { label: 'table.store', value: (r) => storeName(r.shopId), render: (r) => storeChip(r.shopId) },
  date: { label: 'table.date', value: (r) => (r.date ? Date.parse(r.date) : null), render: (r) => formatDate(r.date, 'datetime') },
  customer: { label: 'table.customer', value: (r) => r.customer, render: (r) => r.customer || h('span', { class: 'muted' }, '—') },
  status: { label: 'table.status', value: (r) => t(`status.${r.status}`), render: statusBadge },
  reason: { label: 'table.reason', value: (r) => reasonText(r.reason), render: (r) => reasonText(r.reason) || h('span', { class: 'muted' }, '—'), wrap: true },
  amount: { label: 'table.amount', value: (r) => r.amount, render: (r) => formatMoney(r.amount), num: true },
  payment: { label: 'table.payment', value: (r) => t(`payment.${r.paymentStatus}`), render: paymentBadge },
  deadline: { label: 'table.deadline', value: (r) => deadlineOf(r, settingsNow())?.at ?? null, render: deadlineBadge },
  profit: { label: 'table.profit', value: (r) => orderProfit(r, state.costs, settingsNow().profit)?.profit ?? null, render: profitCell, num: true },
};

function settingsNow() {
  return state.data?.settings || {};
}

/** "принять через 1 ч 20 мин" / "просрочен на 15 мин", coloured by urgency. */
function deadlineBadge(r) {
  const dl = deadlineOf(r, settingsNow());
  if (!dl) return h('span', { class: 'muted' }, '—');
  const u = urgencyOf(dl, settingsNow());
  const left = dl.at - Date.now();
  const text = u === 'overdue' ? t('deadline.overdue', { time: formatDuration(left) }) : t(`deadline.${dl.kind}`, { time: formatDuration(left) });
  const title = `${t(`deadline.${dl.kind}Title`)}: ${formatDate(dl.at, 'datetime')} · ${t(`deadline.source.${dl.source}`)}`;
  return h('span', { class: ['badge', u === 'overdue' ? 'badge--danger' : u === 'soon' ? 'badge--warn' : ''], title }, text);
}

/** Profit of an API order; "?" when a cost price or commission is missing. */
function profitCell(r) {
  const p = orderProfit(r, state.costs, settingsNow().profit);
  if (!p) return h('span', { class: 'muted' }, '—');
  // not every product of the order has a cost price yet: a dash with the reason, not a bare «?»
  if (!p.complete) return h('span', { class: 'muted', title: t('profit.incomplete') }, '—');
  return h('span', { class: p.profit < 0 ? 'neg' : null, title: t('profit.breakdown', { revenue: formatMoney(p.revenue), cogs: formatMoney(p.cogs), commission: formatMoney(p.commission), delivery: formatMoney(p.delivery) }) }, formatMoney(p.profit));
}
const SECTION_COLUMNS = {
  orders: ['id', 'store', 'date', 'customer', 'status', 'deadline', 'amount', 'profit', 'payment'],
  returns: ['id', 'store', 'date', 'status', 'reason', 'amount', 'payment'],
  refusals: ['id', 'store', 'date', 'status', 'reason', 'amount', 'payment'],
  payments: ['id', 'store', 'date', 'status', 'amount', 'payment'],
};

/* ===================================================================== */
/* Table                                                                  */
/* ===================================================================== */

function filterAndSort(route, rows) {
  const ts = state.tables[route];
  const q = ts.q.trim().toLowerCase();
  let out = rows.filter(
    (r) =>
      (ts.status === 'all' || r.status === ts.status) &&
      (route !== 'orders' || orderTabMatch(ts.tab, r)) &&
      (ts.payment === 'all' || r.paymentStatus === ts.payment) &&
      (!ts.urgent || isUrgent(r)) &&
      (!q || [r.id, r.customer, r.reason, storeName(r.shopId)].some((v) => v && String(v).toLowerCase().includes(q))),
  );
  if (route === 'payments') out = out.filter((r) => r.paymentStatus === state.paymentGroup);
  const col = COLUMNS[ts.sort.key];
  if (col) {
    // sort keys computed once per row, not twice per comparison
    const dir = ts.sort.dir === 'asc' ? 1 : -1;
    out = out.map((r) => [col.value(r), r]).sort((a, b) => compareValues(a[0], b[0]) * dir).map((x) => x[1]);
  }
  return out;
}

/** Orders quick tabs: «Горящие / Новые / В работе / Все». */
const ORDER_TABS = ['urgent', 'new', 'work', 'all'];
// Deadline urgency per row object (rows are rebuilt on every render, so the cache is too):
// with 25 000 orders the tab counters asked for it ~100 000 times per render.
let urgentMemo = new WeakMap();
function isUrgent(r) {
  let u = urgentMemo.get(r);
  if (u === undefined) urgentMemo.set(r, (u = ['soon', 'overdue'].includes(urgencyOf(deadlineOf(r, settingsNow()), settingsNow()))));
  return u;
}
function orderTabMatch(tab, r) {
  if (tab === 'urgent') return isUrgent(r);
  if (tab === 'new') return r.status === 'new';
  if (tab === 'work') return ['accepted', 'packed', 'delivering'].includes(r.status);
  return true;
}

/** Bulk actions per section. */
function bulkActions(route, selectedRows) {
  const items = selectedRows.map((r) => ({ shopId: r.shopId, orderId: r.id, url: r.url }));
  const busy = !!state.job;
  const btn = (label, onclick, primary) => h('button', { type: 'button', class: ['btn', 'btn--sm', primary && 'btn--primary'], disabled: busy, onclick }, t(label));
  if (route === 'orders')
    return [
      btn('orders.accept', () => doAccept(items)),
      btn('orders.pack', () => doPack(items), true),
      btn('orders.generateInvoices', () => doInvoices(items)),
      btn('orders.printInvoices', () => send('ui:print', { items })),
    ];
  if (route === 'returns' || route === 'refusals') return [btn(`${route}.process`, () => doProcess(items, route === 'refusals' ? 'refusal' : 'return'), true)];
  if (route === 'payments') return [btn('payments.refresh', () => doRefreshPayments(items), true)];
  return [];
}

/**
 * Render a data table with toolbar, bulk bar, keyboard navigation.
 * @param {string} route
 * @param {any[]} allRows rows before table-level filters
 */
function renderTable(route, allRows) {
  const ts = state.tables[route];
  const rows = filterAndSort(route, allRows);
  const visibleKeys = new Set(rows.map((r) => r.key));
  [...ts.selected].forEach((k) => !visibleKeys.has(k) && ts.selected.delete(k)); // drop hidden selections
  const selectedRows = rows.filter((r) => ts.selected.has(r.key));
  // Columns with nothing to show are hidden (e.g. customer for API orders, profit without cost prices).
  const cols = SECTION_COLUMNS[route].filter((key) => {
    if (key === 'customer') return allRows.some((r) => r.customer);
    if (key === 'profit') return Object.keys(state.costs || {}).length > 0;
    return true;
  });

  const statuses = [...new Set(allRows.map((r) => r.status))];
  const tabs =
    route === 'orders' &&
    h(
      'div',
      { class: 'tabs', role: 'tablist', 'aria-label': t('orders.tabsLabel') },
      ORDER_TABS.map((tab) => {
        // only active orders can be urgent / new / in work: archive rows are skipped quickly
        const n = tab === 'all' ? allRows.length : allRows.reduce((k, r) => k + (orderTabMatch(tab, r) ? 1 : 0), 0);
        return h(
          'button',
          { type: 'button', role: 'tab', class: ['tab', tab === 'urgent' && n && 'tab--danger'], 'aria-selected': String(ts.tab === tab), onclick: () => ((ts.tab = tab), ts.selected.clear(), renderView()) },
          t(`orders.tab.${tab}`),
          h('span', { class: 'tab__count' }, formatNumber(n)),
        );
      }),
    );
  const toolbar = h(
    'div',
    { class: 'toolbar' },
    h('input', {
      type: 'search',
      class: 'input',
      placeholder: t('common.searchPlaceholder'),
      'aria-label': t('common.search'),
      value: ts.q,
      dataset: { fkey: `${route}-search` },
      oninput: debounce((e) => {
        ts.q = e.target.value;
        renderView();
      }, 200),
    }),
    route !== 'orders' &&
    h(
      'select',
      { class: 'select', 'aria-label': t('table.status'), dataset: { fkey: `${route}-status` }, onchange: (e) => ((ts.status = e.target.value), renderView()) },
      h('option', { value: 'all', selected: ts.status === 'all' }, t('status.all')),
      statuses.map((st) => h('option', { value: st, selected: ts.status === st }, t(`status.${st}`))),
    ),
    route === 'orders' &&
      h(
        'select',
        { class: 'select', 'aria-label': t('table.payment'), dataset: { fkey: `${route}-payment` }, onchange: (e) => ((ts.payment = e.target.value), renderView()) },
        ['all', 'paid', 'pending', 'failed', 'refunded', 'unknown'].map((p) => h('option', { value: p, selected: ts.payment === p }, t(`payment.${p}`))),
      ),

    h('div', { class: 'toolbar__spacer' }),
    route === 'orders' && h('button', { type: 'button', class: 'btn btn--sm', onclick: () => openPickList(allRows) }, t('pick.button')),
    h('button', { type: 'button', class: 'btn btn--sm', dataset: { action: 'export', uxKey: 'act_export' }, disabled: !rows.length, title: t('export.hint'), onclick: () => exportRows(route, selectedRows.length ? selectedRows : rows) }, t('export.button')),
    h('span', { class: 'toolbar__count' }, t('table.rows', { count: rows.length })),
  );

  const bulk =
    selectedRows.length > 0 &&
    h(
      'div',
      { class: 'bulkbar', role: 'region', 'aria-label': t('common.selected', { count: selectedRows.length }) },
      h('span', { class: 'bulkbar__count' }, t('common.selected', { count: selectedRows.length })),
      bulkActions(route, selectedRows),
      h('div', { class: 'toolbar__spacer' }),
      h('button', { type: 'button', class: 'btn btn--sm btn--ghost', onclick: () => (ts.selected.clear(), renderView()) }, t('common.clearSelection')),
    );

  const notes = h('div', { class: 'notes' }, sectionNotes(route).map((n) => h('div', null, n)));

  if (!rows.length) {
    const body = state.syncing && !allRows.length ? skeletonTable(cols.length) : emptyState(t('table.emptyTitle'), allRows.length ? t('table.emptyFiltered') : t(FEATURES.cabinet ? 'table.emptyNoData' : 'table.emptyNoDataApi'));
    return h('section', { class: 'card' }, tabs, toolbar, notes, body);
  }

  const allChecked = selectedRows.length === rows.length;
  const head = h(
    'tr',
    null,
    h(
      'th',
      { class: 'col-check', scope: 'col' },
      h('input', {
        type: 'checkbox',
        'aria-label': t('common.selectAll'),
        checked: allChecked,
        indeterminate: selectedRows.length > 0 && !allChecked,
        onchange: (e) => {
          rows.forEach((r) => (e.target.checked ? ts.selected.add(r.key) : ts.selected.delete(r.key)));
          renderView();
        },
      }),
    ),
    cols.map((key) => {
      const col = COLUMNS[key];
      const active = ts.sort.key === key;
      return h(
        'th',
        { scope: 'col', class: col.num && 'num', 'aria-sort': active ? (ts.sort.dir === 'asc' ? 'ascending' : 'descending') : null },
        h(
          'button',
          {
            type: 'button',
            title: t('table.sortBy', { column: t(col.label) }),
            dataset: { fkey: `${route}-sort-${key}` },
            onclick: () => {
              ts.sort = { key, dir: active && ts.sort.dir === 'desc' ? 'asc' : active ? 'desc' : key === 'date' || key === 'amount' ? 'desc' : 'asc' };
              renderView();
            },
          },
          t(col.label),
          h('span', { class: 'sort-ind', 'aria-hidden': 'true' }, active ? (ts.sort.dir === 'asc' ? '▲' : '▼') : ''),
        ),
      );
    }),
  );

  // Page of rows: a store with thousands of orders must not draw them all at once
  // (8 000 rows took 6 s, 25 000 took 26 s). Filters, sort, search, «select all» and
  // export still work on every matching row.
  const sig = JSON.stringify([ts.q, ts.status, ts.payment, ts.tab, ts.urgent, ts.sort, state.paymentGroup, state.filters, rows.length]);
  if (ts.pageSig !== sig) (ts.page = 0), (ts.pageSig = sig);
  const pageCount = Math.max(1, Math.ceil(rows.length / TABLE_PAGE));
  ts.page = Math.min(Math.max(0, ts.page || 0), pageCount - 1);
  const first = ts.page * TABLE_PAGE;
  const shown = rows.slice(first, first + TABLE_PAGE);
  ts.focus = Math.min(ts.focus, shown.length - 1);
  const tbody = h(
    'tbody',
    null,
    shown.map((r, i) =>
      h(
        'tr',
        { tabindex: i === ts.focus ? '0' : '-1', 'aria-selected': String(ts.selected.has(r.key)), dataset: { idx: i, fkey: `${route}-row-${r.key}` } },
        h('td', { class: 'col-check' }, h('input', { type: 'checkbox', tabindex: '-1', 'aria-label': t('common.selectRow', { id: r.id }), checked: ts.selected.has(r.key), onchange: () => toggleRow(route, r.key) })),
        cols.map((key) => {
          const content = COLUMNS[key].render(r);
          // on phones the row becomes a card (CSS): cells know their column and hide when empty
          const empty = (content?.textContent ?? String(content ?? '')).trim() === '—' || content == null || content === '';
          return h('td', { class: [COLUMNS[key].num && 'num', COLUMNS[key].wrap && 'wrap', `col-${key}`, empty && 'cell--empty'], dataset: { label: t(COLUMNS[key].label) } }, content);
        }),
      ),
    ),
  );
  tbody.addEventListener('keydown', (e) => onTableKey(e, route, shown));
  tbody.addEventListener('focusin', (e) => {
    const tr = e.target.closest('tr');
    if (tr) ts.focus = Number(tr.dataset.idx);
  });

  return h(
    'section',
    { class: 'card' },
    tabs,
    toolbar,
    bulk,
    notes,
    h('div', { class: 'table-wrap' }, h('table', { class: 'data data--cards', 'aria-rowcount': rows.length }, h('thead', null, head), tbody)),
    pageCount > 1 && pager(ts, pageCount, first, shown.length, rows.length),
    h('div', { class: 'kbd-hint' }, t('table.keyboardHint')),
  );
}

const TABLE_PAGE = 100;

/** «‹ Назад · 101–200 из 8 422 · Вперёд ›» under a long table. */
function pager(ts, pageCount, first, shownCount, total) {
  const go = (p) => {
    ts.page = p;
    renderView();
    document.querySelector('#view .table-wrap')?.scrollIntoView({ block: 'start' });
  };
  return h('nav', { class: 'pager', 'aria-label': t('table.pages') },
    h('button', { type: 'button', class: 'btn btn--sm', disabled: ts.page === 0, dataset: { page: 'prev' }, onclick: () => go(ts.page - 1) }, '‹ ', t('table.prev')),
    h('span', { class: 'pager__info' }, t('table.range', { from: formatNumber(first + 1), to: formatNumber(first + shownCount), total: formatNumber(total) })),
    h('button', { type: 'button', class: 'btn btn--sm', disabled: ts.page >= pageCount - 1, dataset: { page: 'next' }, onclick: () => go(ts.page + 1) }, t('table.next'), ' ›'),
  );
}

function skeletonTable(cols) {
  return h(
    'div',
    { class: 'table-wrap', 'aria-busy': 'true' },
    h(
      'table',
      { class: 'data' },
      h(
        'tbody',
        null,
        Array.from({ length: 6 }, () => h('tr', null, Array.from({ length: cols + 1 }, () => h('td', null, h('span', { class: 'skeleton' }))))),
      ),
    ),
  );
}

function toggleRow(route, key) {
  const sel = state.tables[route].selected;
  sel.has(key) ? sel.delete(key) : sel.add(key);
  renderView();
}

/** Keyboard navigation inside a table body. */
function onTableKey(e, route, rows) {
  const tr = e.target.closest('tr');
  if (!tr) return;
  const i = Number(tr.dataset.idx);
  const ts = state.tables[route];
  const focusRow = (n) => {
    const target = tr.parentElement.children[Math.max(0, Math.min(rows.length - 1, n))];
    if (!target) return;
    tr.tabIndex = -1;
    target.tabIndex = 0;
    target.focus();
    ts.focus = Number(target.dataset.idx);
  };
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      focusRow(i + 1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      focusRow(i - 1);
      break;
    case 'Home':
      e.preventDefault();
      focusRow(0);
      break;
    case 'End':
      e.preventDefault();
      focusRow(rows.length - 1);
      break;
    case ' ':
      e.preventDefault();
      toggleRow(route, rows[i].key);
      break;
    case 'Enter':
      e.preventDefault();
      openItem(rows[i]);
      break;
    case 'Escape':
      if (ts.selected.size) {
        e.preventDefault();
        ts.selected.clear();
        renderView();
      }
      break;
    case 'a':
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        rows.forEach((r) => ts.selected.add(r.key));
        renderView();
      }
      break;
    default:
  }
}

/** The payment QR from the server config: an https or inline image only (null otherwise). */
const safeQrUrl = (u) => (typeof u === 'string' && /^(https:\/\/|data:image\/(png|jpeg|webp|gif|svg\+xml);base64,)/i.test(u.trim()) ? u.trim() : null);

/** A scraped order link, only on the store's own https origin (null otherwise). */
function safeItemUrl(row) {
  const origin = stores()[row.shopId]?.origin;
  try {
    const u = new URL(row.url);
    if (u.protocol === 'file:' ? origin === 'file://' : (u.protocol === 'https:' || u.hostname === 'localhost') && u.origin === origin) return u.href;
  } catch {
    /* no or invalid link */
  }
  return null;
}

/** Open the order/return in its store tab. Scraped links are used only on the store's own https origin. */
function openItem(row) {
  const url = safeItemUrl(row);
  if (url) chrome.tabs.create({ url });
  else send('ui:openStore', { shopId: row.shopId });
}

/* ===================================================================== */
/* Bulk actions                                                           */
/* ===================================================================== */

async function runJob(kind, type, payload, okKey) {
  state.job = { kind, done: 0, total: payload.items.length };
  renderProgress();
  renderView();
  try {
    const res = await send(type, payload);
    if (res?.results) {
      reportResults(res.results, okKey);
      // Done items leave the selection; failed ones stay selected for a retry.
      const sel = state.tables[state.route]?.selected;
      if (sel) res.results.filter((r) => r.ok).forEach((r) => sel.delete(itemKey(r.shopId, r.orderId)));
    }
    else if (res?.ok === false) toast(errorText(res.error), 'error');
    return res;
  } finally {
    state.job = null;
    renderProgress();
    refreshInvoiceCount();
    renderView();
  }
}

/* ---------- export for the accountant: what is on screen (or the ticked rows) → Excel ---------- */
function exportRows(route, list) {
  send('ui:usage', { action: 'export' }).catch(() => {});
  // A cell starting with = + - @ would run as a formula in Excel → neutralised with a leading apostrophe.
  const cell = (v) => {
    let x = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(x)) x = `'${x}`;
    return /[";\n\r]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
  };
  const head = [t('table.orderId'), t('table.store'), t('table.date'), t('table.status'), t('table.amount'), t('table.payment'), t('order.items'), t('order.qty'), t('table.profit'), t('table.reason')];
  const lines = list.map((r) => {
    const p = orderProfit(r, state.costs, settingsNow().profit);
    return [
      r.id,
      storeName(r.shopId),
      r.date ? new Date(r.date).toLocaleString(getLang() === 'kk' ? 'kk-KZ' : 'ru-RU') : '',
      t(`status.${r.status}`),
      r.amount ?? '',
      t(`payment.${r.paymentStatus}`),
      (r.entries || []).map((e) => `${e.name || e.category || ''}${e.sku ? ` [${e.sku}]` : ''} × ${e.quantity || 1}`).join(' | '),
      (r.entries || []).reduce((n, e) => n + (e.quantity || 1), 0) || '',
      p?.complete ? Math.round(p.profit) : '',
      reasonText(r.reason),
    ].map(cell).join(';');
  });
  // BOM + ";" = opens correctly in Excel with a Russian/Kazakh locale by double click
  const blob = new Blob(['\ufeff' + [head.map(cell).join(';'), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `seller-hub-${route}-${new Date().toISOString().slice(0, 10)}.csv` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(t('export.done', { count: list.length }), 'ok');
}

/* ---------- product photos (shared/photos.js) ---------- */
const photoOf = (key) => photoFor(key, state.photos || {}, state.catalog || {});

/** Product thumbnail; with `edit`, a click opens the photo dialog for that SKU. */
function thumb(key, { size = 48, edit = false, name = '', onSaved } = {}) {
  const src = photoOf(key);
  const img = src
    ? h('img', { class: 'thumb', src, alt: name || key || '', loading: 'lazy', style: { width: `${size}px`, height: `${size}px` }, onerror: (e) => e.target.replaceWith(h('span', { class: 'thumb thumb--empty', style: { width: `${size}px`, height: `${size}px` } }, '📦')) })
    : h('span', { class: 'thumb thumb--empty', style: { width: `${size}px`, height: `${size}px` }, 'aria-hidden': 'true' }, '📦');
  if (!edit || !key) return img;
  return h('button', { type: 'button', class: 'thumb-btn', title: t(src ? 'photo.change' : 'photo.add'), 'aria-label': t(src ? 'photo.change' : 'photo.add'), dataset: { photo: key }, onclick: () => openPhoto(key, name, onSaved) }, img, !src && h('span', { class: 'thumb-btn__plus' }, '+'));
}

/** Set the photo of a SKU: link to a Kaspi product image, or a file from the computer. */
function openPhoto(sku, name, onSaved) {
  let dlg = $('photoDialog');
  if (!dlg) {
    dlg = h('dialog', { id: 'photoDialog', class: 'dialog', 'aria-labelledby': 'photoTitle' });
    document.body.append(dlg);
  }
  let value = state.photos?.[sku] || '';
  const preview = h('div', { class: 'photo-preview' });
  const err = h('p', { class: 'neg small', hidden: true });
  const showPreview = () => {
    clear(preview).append(isAllowedPhoto(value) ? h('img', { src: value, alt: name || sku }) : h('span', { class: 'muted' }, photoOf(sku) && !value ? t('photo.fromCatalog') : t('photo.none')));
    if (!value && photoOf(sku)) preview.prepend(h('img', { src: photoOf(sku), alt: name || sku }));
  };
  // a link to the product page on kaspi.kz (…/shop/p/…-123456/) → the worker finds its main photo
  const isProductPage = (v) => /^https:\/\/(www\.)?kaspi\.kz\/shop\/p\//i.test(v);
  let lookup = 0;
  const url = h('input', { class: 'input', type: 'url', placeholder: 'https://kaspi.kz/shop/p/…', dataset: { field: 'photo-url' }, value: value.startsWith('data:') ? '' : value, oninput: async (e) => {
    const v = e.target.value.trim();
    if (isProductPage(v)) {
      const n = ++lookup;
      err.hidden = false;
      err.textContent = t('photo.looking');
      const res = await send('ui:photoFromLink', { link: v });
      if (n !== lookup) return; // typed again meanwhile
      if (res?.ok) (value = res.url), (err.hidden = true), showPreview();
      else err.textContent = errorText(res?.error);
      return;
    }
    err.hidden = !v || isAllowedPhoto(v);
    err.textContent = t('errors.photoNotAllowed');
    if (!v || isAllowedPhoto(v)) (value = v), showPreview();
  } });
  const file = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      value = await fileToPhoto(f);
      url.value = '';
      err.hidden = true;
      showPreview();
    } catch (x) {
      err.hidden = false;
      err.textContent = errorText(x.message);
    }
  } });
  const save = async (src) => {
    const res = await send('ui:setPhoto', { sku, src });
    if (!res?.ok) return toast(errorText(res?.error), 'error');
    state.photos = await getPhotos();
    dlg.close();
    toast(t(src ? 'photo.saved' : 'photo.removed'), 'ok');
    renderView();
    onSaved?.();
  };
  clear(dlg).append(
    h('h2', { class: 'dialog__title', id: 'photoTitle' }, t('photo.title')),
    h('p', { class: 'muted small' }, name || '', ' ', h('span', { class: 'mono' }, sku)),
    preview,
    h('label', { class: 'catalog-field' }, h('span', null, t('photo.urlLabel')), url),
    h('p', { class: 'muted small' }, t('photo.urlHint')),
    err,
    h('div', { class: 'dialog__actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => file.click() }, t('photo.file')),
      state.photos?.[sku] && h('button', { type: 'button', class: 'btn btn--ghost btn--danger', onclick: () => save(null) }, t('photo.remove')),
      h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, t('common.close')),
      h('button', { type: 'button', class: 'btn btn--primary', dataset: { action: 'photo-save', uxKey: 'act_photo-save' }, onclick: () => (isAllowedPhoto(value) ? save(value) : ((err.hidden = false), (err.textContent = t('errors.photoNotAllowed')))) }, t('photo.save')),
      file,
    ),
  );
  showPreview();
  if (!dlg.open) dlg.showModal();
}

/* ---------- order card: contents, deadline, money, actions ---------- */
function openOrder(r) {
  let dlg = $('orderDialog');
  if (!dlg) {
    dlg = h('dialog', { id: 'orderDialog', class: 'dialog dialog--wide', 'aria-labelledby': 'orderTitle' });
    document.body.append(dlg);
  }
  const item = [{ shopId: r.shopId, orderId: r.id, url: r.url }];
  const p = orderProfit(r, state.costs, settingsNow().profit);
  const row = (label, value) => h('div', { class: 'order__row' }, h('span', { class: 'muted' }, label), h('span', null, value));
  const act = (label, fn, primary) => h('button', { type: 'button', class: ['btn', primary && 'btn--primary'], disabled: !!state.job, onclick: async () => (dlg.close(), await fn()) }, t(label));
  const entries = r.entries || [];
  clear(dlg).append(
    h(
      'div',
      { class: 'order' },
      h('div', { class: 'order__head' }, h('h2', { class: 'dialog__title', id: 'orderTitle' }, t('order.title', { id: r.id })), statusBadge(r), deadlineBadge(r)),
      h('div', { class: 'order__grid' },
        row(t('table.store'), storeChip(r.shopId)),
        row(t('table.date'), formatDate(r.date, 'datetime')),
        row(t('table.amount'), h('b', null, formatMoney(r.amount))),
        row(t('table.payment'), paymentBadge(r)),
        r.customer && row(t('table.customer'), r.customer),
        p && row(t('table.profit'), p.complete ? h('b', { class: p.profit < 0 ? 'neg' : null }, formatMoney(p.profit)) : h('a', { href: '#products', class: 'muted', onclick: () => dlg.close() }, t('order.noCost'))),
        r.reason && row(t('table.reason'), reasonText(r.reason)),
      ),
      h('h3', { class: 'order__sub' }, t('order.items')),
      entries.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
            h('thead', null, h('tr', null, h('th', { class: 'order__photo-col' }, h('span', { class: 'sr-only' }, t('photo.title'))), h('th', null, t('order.product')), h('th', { class: 'num' }, t('order.qty')), h('th', { class: 'num' }, t('order.price')), h('th', { class: 'num' }, t('products.cost')))),
            h('tbody', null, entries.map((e) => h('tr', { class: 'order__line' },
              h('td', null, thumb(productKey(e), { size: 72, edit: true, name: e.name, onSaved: () => openOrder(r) })),
              h('td', null, h('div', { class: 'order__product' }, e.name || e.category || '—'), e.sku && h('div', { class: 'muted mono small' }, e.sku)),
              h('td', { class: 'num' }, h('span', { class: ['order__qty', (e.quantity || 1) > 1 && 'order__qty--many'] }, `× ${formatNumber(e.quantity || 1)}`)),
              h('td', { class: 'num' }, formatMoney(e.total ?? (e.price || 0) * (e.quantity || 1))),
              h('td', { class: 'num' }, state.costs[productKey(e)] != null ? formatMoney(state.costs[productKey(e)]) : h('span', { class: 'muted' }, '—')),
            ))),
          ))
        : h('p', { class: 'muted' }, t('order.noItems')),
      h('div', { class: 'dialog__actions' },
        safeItemUrl(r) && h('a', { class: 'btn btn--ghost', href: safeItemUrl(r), target: '_blank', rel: 'noopener' }, t('order.openKaspi')),
        h('span', { class: 'grow' }),
        h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, t('common.close')),
        r.status === 'new' && act('order.accept', () => doAccept(item)),
        ['new', 'accepted'].includes(r.status) && act('order.pack', () => doPack(item), true),
        ['accepted', 'packed', 'delivering'].includes(r.status) && act('order.print', () => send('ui:print', { items: item })),
      ),
    ),
  );
  if (!dlg.open) dlg.showModal(); // re-rendered after a photo was set
}

const hasApi = (items) => items.some((i) => stores()[i.shopId]?.api?.connected);

async function doAccept(items) {
  if (!(await confirmDialog(t('orders.confirmAcceptTitle'), t('orders.confirmAccept', { count: items.length })))) return;
  await runJob('accept', 'ui:accept', { items }, 'orders.acceptDone');
}

async function doPack(items) {
  const shops = [...new Set(items.map((i) => storeName(i.shopId)))].join(', ');
  const text = t('orders.confirmPack', { count: items.length, stores: shops }) + (hasApi(items) ? `\n\n${t('orders.packApiNote')}` : '');
  if (!(await confirmDialog(t('orders.confirmPackTitle'), text))) return;
  await runJob('pack', 'ui:pack', { items }, 'orders.packDone');
  sync();
}

const doInvoices = (items) => runJob('invoices', 'ui:fetchInvoices', { items }, 'orders.invoicesDone');

async function doProcess(items, kind) {
  if (items.length > 1 && !(await confirmDialog(t('returns.confirmProcessTitle'), t('returns.confirmProcess', { count: items.length })))) return;
  const res = await send('ui:process', { items, kind });
  const failed = (res?.results || []).filter((r) => !r.ok);
  if (failed.length) toast(t('errors.partial', { count: failed.length, details: [...new Set(failed.map((r) => errorText(r.error)))].join('; ') }), 'error', 9000);
}

const doRefreshPayments = (items) => runJob('payments', 'ui:refreshPayments', { items }, 'payments.refreshDone');

function renderProgress() {
  const el = $('progress');
  if (!state.job) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const { done, total, kind } = state.job;
  el.querySelector('.progress__bar').style.setProperty('--p', `${total ? (done / total) * 100 : 0}%`);
  const label = { pack: 'orders.packing', accept: 'orders.accepting' }[kind] || 'orders.collecting';
  el.querySelector('.progress__label').textContent = t(label, { done, total });
}

async function refreshInvoiceCount() {
  state.invoiceCount = await countInvoices();
}

/* ===================================================================== */
/* Views: tables                                                          */
/* ===================================================================== */

function viewTable(route) {
  return renderTable(route, sectionRows(route));
}

function viewPayments() {
  const rows = sectionRows('payments');
  const groups = groupBy(rows, (r) => r.paymentStatus);
  const cards = h(
    'div',
    { class: 'groups', role: 'group', 'aria-label': t('payments.title') },
    ['pending', 'paid', 'failed', 'refunded', 'unknown'].map((g) => {
      const list = groups[g] || [];
      return h(
        'button',
        {
          type: 'button',
          class: 'group-card',
          'aria-pressed': String(state.paymentGroup === g),
          onclick: () => {
            state.paymentGroup = g;
            state.tables.payments.selected.clear();
            renderView();
          },
        },
        paymentBadge({ paymentStatus: g }),
        h('div', { class: 'group-card__value' }, formatNumber(list.length)),
        h('div', { class: 'group-card__sub' }, t('payments.groupTotal', { amount: formatMoney(sumBy(list, (r) => r.amount)) })),
      );
    }),
  );
  return h('div', null, cards, renderTable('payments', rows));
}

/* ===================================================================== */
/* Pick list                                                              */
/* ===================================================================== */

/**
 * Build the pick list (what to take from the shelf) for the selected orders, or —
 * with no selection — for every order still to assemble (new / accepted), and open it
 * on the print page. Same product in several stores = one line with a per-store split.
 */
async function openPickList(allRows) {
  const ts = state.tables.orders;
  const selected = allRows.filter((r) => ts.selected.has(r.key));
  const orders = selected.length ? selected : allRows.filter((r) => r.kind === 'order' && (r.status === 'new' || r.status === 'accepted'));
  if (!orders.length) return toast(t('pick.empty'), 'info');
  const lines = new Map();
  const unknown = [];
  for (const o of orders) {
    if (!o.entries?.length) {
      unknown.push({ id: o.id, store: storeName(o.shopId), color: storeColor(o.shopId) });
      continue;
    }
    for (const e of o.entries) {
      const k = productKey(e);
      const line = lines.get(k) || { name: e.name || e.category, sku: e.sku, photo: photoOf(k), qty: 0, orders: [] };
      line.qty += e.quantity || 1;
      line.orders.push({ id: o.id, store: storeName(o.shopId), color: storeColor(o.shopId), qty: e.quantity || 1 });
      lines.set(k, line);
    }
  }
  send('ui:usage', { action: 'pickList' }).catch(() => {});
  await setPickList({
    createdAt: Date.now(),
    orderCount: orders.length,
    stores: [...new Set(orders.map((o) => storeName(o.shopId)))],
    lines: [...lines.values()].sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    unknown,
  });
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/print.html?mode=pick') });
}

/* ===================================================================== */
/* View: products & cost prices                                           */
/* ===================================================================== */

/** Products sold in the period (from order contents), with cost, commission and profit. */
function productRows() {
  const map = new Map();
  for (const r of sectionRows('orders')) {
    if (!r.entries?.length || r.kind !== 'order' || ['cancelled', 'returned'].includes(r.status)) continue;
    for (const e of r.entries) {
      const k = productKey(e);
      const p = map.get(k) || { key: k, sku: e.sku, name: e.name, category: e.category, units: 0, revenue: 0, shops: new Set() };
      p.units += e.quantity || 1;
      p.revenue += e.total ?? (e.price || 0) * (e.quantity || 1);
      p.shops.add(r.shopId);
      map.set(k, p);
    }
  }
  const prof = settingsNow().profit;
  return [...map.values()].map((p) => {
    const cost = state.costs[p.sku];
    const pct = commissionPct(p.category, prof);
    const known = Number.isFinite(cost) && pct != null;
    const profit = known ? p.revenue - cost * p.units - (p.revenue * pct) / 100 : null;
    return { ...p, cost, pct, profit, margin: known && p.revenue ? profit / p.revenue : null };
  });
}

function viewProducts() {
  const prof = settingsNow().profit;
  const rows = productRows()
    .filter((p) => !state.productsQ || `${p.name} ${p.sku}`.toLowerCase().includes(state.productsQ.toLowerCase()))
    .sort((a, b) => b.revenue - a.revenue);
  const categories = [...new Set(productRows().map((p) => p.category).filter(Boolean))].sort();
  const saveProfit = (patch) => updateSettings({ profit: { ...prof, ...patch, byCategory: { ...prof.byCategory, ...(patch.byCategory || {}) } } }, { silent: true });
  const pctInput = (value, onSave, label) =>
    h('input', { class: 'input', type: 'number', min: 0, max: 100, step: 0.1, style: { width: '90px' }, value: value ?? '', placeholder: '%', 'aria-label': label, onchange: (e) => onSave(e.target.value === '' ? null : Number(e.target.value)) });

  const commissionCard = h(
    'section',
    { class: 'card', style: { marginBottom: '16px' } },
    h('div', { class: 'card__header' }, h('div', null, h('h2', { class: 'card__title' }, t('products.commissionTitle')), h('div', { class: 'card__sub' }, t('products.commissionHint')))),
    h(
      'div',
      { class: 'card__body', style: { display: 'flex', flexWrap: 'wrap', gap: '16px' } },
      h('label', { class: 'check' }, t('products.defaultCommission'), pctInput(prof.defaultCommission, (v) => saveProfit({ defaultCommission: v }), t('products.defaultCommission'))),
      categories.map((c) =>
        h(
          'label',
          { class: 'check' },
          c,
          pctInput(prof.byCategory?.[c], (v) => {
            const byCategory = { ...prof.byCategory };
            if (v == null) delete byCategory[c];
            else byCategory[c] = v;
            updateSettings({ profit: { ...prof, byCategory } }, { silent: true });
          }, c),
        ),
      ),
    ),
  );

  if (!rows.length && !state.productsQ)
    return h('div', null, commissionCard, h('section', { class: 'card' }, emptyState(t('products.emptyTitle'), t('products.emptyText'))));

  const table = h(
    'table',
    { class: 'data' },
    h(
      'thead',
      null,
      h('tr', null, h('th', { scope: 'col' }, t('photo.title')), ['analytics.product', 'products.category', 'nav.stores', 'analytics.units', 'analytics.revenue', 'products.cost', 'products.commission', 'products.profit', 'products.margin'].map((k, i) => h('th', { scope: 'col', class: i >= 3 && 'num' }, t(k)))),
    ),
    h(
      'tbody',
      null,
      rows.map((p) =>
        h(
          'tr',
          null,
          h('td', null, thumb(p.sku || p.name, { size: 44, edit: true, name: p.name })),
          h('td', { class: 'wrap' }, p.name || p.sku, p.sku ? h('div', { class: 'muted mono' }, p.sku) : null),
          h('td', { class: 'wrap muted' }, p.category || '—'),
          h('td', { class: 'wrap' }, [...p.shops].map((id) => h('div', null, storeChip(id)))),
          h('td', { class: 'num' }, formatNumber(p.units)),
          h('td', { class: 'num' }, formatMoney(p.revenue)),
          h(
            'td',
            { class: 'num' },
            p.sku
              ? h('input', {
                  class: 'input',
                  type: 'number',
                  min: 0,
                  step: 1,
                  style: { width: '110px', textAlign: 'right' },
                  value: Number.isFinite(p.cost) ? p.cost : '',
                  placeholder: '₸',
                  'aria-label': `${t('products.cost')}: ${p.name}`,
                  dataset: { fkey: `cost-${p.sku}` },
                  onchange: async (e) => {
                    await send('ui:saveCost', { sku: p.sku, cost: e.target.value === '' ? null : Number(e.target.value) });
                    state.costs = await getCosts();
                    renderView();
                  },
                })
              : '—',
          ),
          h('td', { class: 'num' }, p.pct == null ? h('span', { class: 'muted' }, '?') : formatPercent(p.pct / 100)),
          h('td', { class: ['num', p.profit < 0 && 'neg'] }, p.profit == null ? h('span', { class: 'muted', title: t('profit.incomplete') }, '—') : formatMoney(p.profit)),
          h('td', { class: 'num' }, formatPercent(p.margin)),
        ),
      ),
    ),
  );
  return h(
    'div',
    null,
    commissionCard,
    h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'toolbar' },
        h('input', { type: 'search', class: 'input', placeholder: t('products.search'), 'aria-label': t('common.search'), value: state.productsQ, dataset: { fkey: 'products-search' }, oninput: debounce((e) => ((state.productsQ = e.target.value), renderView()), 200) }),
        h('div', { class: 'toolbar__spacer' }),
        h('span', { class: 'toolbar__count' }, t('products.hint')),
      ),
      h('div', { class: 'table-wrap' }, table),
    ),
  );
}

/* ===================================================================== */
/* View: analytics                                                        */
/* ===================================================================== */

const REVENUE_EXCLUDED = new Set(['cancelled', 'refused', 'returned']);

/**
 * Aggregate analytics for the filtered stores. Prefers the daily series parsed
 * from each store's Kaspi analytics page; falls back to the loaded orders list.
 */
function computeAnalytics() {
  const range = dateRange();
  const days = eachDay(range.from, range.to);
  const perStore = filteredStores().map((s) => {
    const snap = state.data.snapshots[s.id];
    const a = snap?.sections?.analytics?.status === 'ok' ? snap.sections.analytics.data : null;
    const orders = (snap?.sections?.orders?.items || []).filter((o) => inRange(o.date, range));
    const returns = (snap?.sections?.returns?.items || []).filter((o) => inRange(o.date, range));
    const refusals = (snap?.sections?.refusals?.items || []).filter((o) => inRange(o.date, range));
    const daily = new Map();
    let source = null;
    if (a?.series?.length) {
      source = 'kaspi';
      a.series.filter((p) => inRange(p.date, range)).forEach((p) => daily.set(dayKey(p.date), { revenue: p.revenue, orders: p.orders }));
    } else if (snap?.sections?.orders?.status === 'ok') {
      source = 'orders';
      orders
        .filter((o) => !REVENUE_EXCLUDED.has(o.status))
        .forEach((o) => {
          const k = dayKey(o.date);
          const d = daily.get(k) || { revenue: 0, orders: 0 };
          d.revenue += o.amount || 0;
          d.orders += 1;
          daily.set(k, d);
        });
    }
    const revenue = source ? sumBy([...daily.values()], (d) => d.revenue) : null;
    const orderCount = source ? sumBy([...daily.values()], (d) => d.orders) : null;
    const hasReturns = snap?.sections?.returns?.status === 'ok';
    const hasRefusals = snap?.sections?.refusals?.status === 'ok';
    return {
      store: s,
      source,
      daily,
      revenue,
      orders: orderCount,
      returns: hasReturns ? returns.length : null,
      refusals: hasRefusals ? refusals.length : null,
      kpi: a?.kpi || {},
      products: (a?.topProducts || []).map((p) => ({ ...p, shopId: s.id })),
    };
  });

  const withData = perStore.filter((p) => p.source);
  const total = (k) => (withData.length ? sumBy(withData, (p) => p[k]) : null);
  const revenue = total('revenue');
  const orders = total('orders');
  const returnsKnown = perStore.filter((p) => p.returns != null && p.orders);
  const refusalsKnown = perStore.filter((p) => p.refusals != null && p.orders);
  const viewsKnown = perStore.filter((p) => p.kpi.views && p.kpi.orders != null);

  const series = days.map((d) => {
    const vals = withData.map((p) => p.daily.get(d));
    return {
      x: d,
      revenue: withData.length ? sumBy(vals, (v) => v?.revenue ?? 0) : null,
      orders: withData.length ? sumBy(vals, (v) => v?.orders ?? 0) : null,
    };
  });

  return {
    perStore,
    series,
    sources: new Set(withData.map((p) => p.source)),
    kpi: {
      revenue,
      orders,
      aov: ratio(revenue, orders),
      returnRate: returnsKnown.length ? ratio(sumBy(returnsKnown, (p) => p.returns), sumBy(returnsKnown, (p) => p.orders)) : null,
      refusalRate: refusalsKnown.length ? ratio(sumBy(refusalsKnown, (p) => p.refusals), sumBy(refusalsKnown, (p) => p.orders)) : null,
      conversion: viewsKnown.length ? ratio(sumBy(viewsKnown, (p) => p.kpi.orders), sumBy(viewsKnown, (p) => p.kpi.views)) : null,
    },
    products: perStore.flatMap((p) => p.products),
    profit: computeProfit(),
  };
}

/** Profit over orders that have contents; incomplete ones (missing cost/commission) are counted, not guessed. */
function computeProfit() {
  const rows = sectionRows('orders');
  const per = {};
  let profit = 0;
  let revenue = 0;
  let complete = 0;
  let total = 0;
  for (const r of rows) {
    const p = orderProfit(r, state.costs, settingsNow().profit);
    if (!p) continue;
    total++;
    if (!p.complete) continue;
    complete++;
    profit += p.profit;
    revenue += p.revenue;
    per[r.shopId] = (per[r.shopId] || 0) + p.profit;
  }
  return { profit: complete ? profit : null, margin: complete && revenue ? profit / revenue : null, complete, total, per };
}

/** A chart card with a chart/table toggle (table = accessible alternative). */
function chartCard(id, title, sub, drawChart, tableRows) {
  const showTable = state.analyticsTables.has(id);
  const body = h('div', { class: 'card__body' });
  const card = h(
    'section',
    { class: 'card' },
    h(
      'div',
      { class: 'card__header' },
      h('div', null, h('h2', { class: 'card__title' }, title), sub && h('div', { class: 'card__sub' }, sub)),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn--sm btn--ghost',
          'aria-pressed': String(showTable),
          dataset: { fkey: `chart-toggle-${id}` },
          onclick: () => {
            showTable ? state.analyticsTables.delete(id) : state.analyticsTables.add(id);
            renderView();
          },
        },
        t(showTable ? 'common.showChart' : 'common.showTable'),
      ),
    ),
    body,
  );
  if (showTable) {
    body.append(
      h(
        'div',
        { class: 'table-wrap' },
        h('table', { class: 'data' }, h('thead', null, h('tr', null, tableRows.head.map((c, i) => h('th', { scope: 'col', class: i && 'num' }, c)))), h('tbody', null, tableRows.rows.map((r) => h('tr', null, r.map((c, i) => h('td', { class: i && 'num' }, c)))))),
      ),
    );
  } else {
    const chart = h('div', { class: 'chart', 'aria-label': t('analytics.chartLabel', { title }) });
    body.append(chart);
    requestAnimationFrame(() => state.disposers.push(drawChart(chart)));
  }
  return card;
}

function viewAnalytics() {
  if (!filteredStores().length) return noStores();
  const A = computeAnalytics();
  const src = A.sources.has('kaspi') && !A.sources.has('orders') ? t('analytics.sourceKaspi') : A.sources.size ? t('analytics.sourceOrders') : t('analytics.noData');
  // a KPI with `go` is a button: it opens the list behind the number (same period and store)
  const kpi = (label, value, sub, go) =>
    h(go ? 'button' : 'div', { class: ['card', 'kpi', go && 'kpi--link'], ...(go ? { type: 'button', title: t('home.showOrders'), onclick: go } : {}) }, h('div', { class: 'kpi__label' }, label), h('div', { class: 'kpi__value' }, value), h('div', { class: 'kpi__sub' }, sub));
  const openList = (route) => () => (location.hash = route);

  const kpis = h(
    'div',
    { class: 'kpis' },
    kpi(t('analytics.revenue'), formatMoney(A.kpi.revenue), src, openList('orders')),
    kpi(t('analytics.orders'), formatNumber(A.kpi.orders), src, openList('orders')),
    kpi(t('analytics.aov'), formatMoney(A.kpi.aov), src),
    kpi(t('analytics.returnRate'), formatPercent(A.kpi.returnRate), t('nav.returns'), openList('returns')),
    kpi(t('analytics.refusalRate'), formatPercent(A.kpi.refusalRate), t('nav.refusals'), openList('refusals')),
    kpi(t('analytics.conversion'), formatPercent(A.kpi.conversion, 2), A.kpi.conversion == null ? t('analytics.conversionNA') : t('analytics.conversionHint')),
    kpi(t('analytics.profit'), formatMoney(A.profit.profit), A.profit.total ? t('analytics.profitCoverage', { complete: A.profit.complete, total: A.profit.total }) : t('analytics.profitNA')),
    kpi(t('analytics.margin'), formatPercent(A.profit.margin), A.profit.total ? t('analytics.profitCoverage', { complete: A.profit.complete, total: A.profit.total }) : t('analytics.profitNA')),
  );

  const hasSeries = A.series.some((p) => p.revenue);
  const xFmt = (d) => formatDate(d, 'short');
  const seriesTable = (k, fmt) => ({ head: [t('table.date'), t(`analytics.${k}`)], rows: A.series.map((p) => [formatDate(p.x), fmt(p[k])]) });
  const emptyChart = (c) => {
    c.append(h('div', { class: 'chart-empty' }, t('analytics.noData')));
    return () => {};
  };

  const lines = h(
    'div',
    { class: 'grid-2' },
    chartCard(
      'revenue',
      t('analytics.revenueOverTime'),
      src,
      (c) => (hasSeries ? lineChart(c, { points: A.series.map((p) => ({ x: p.x, y: p.revenue })), label: t('analytics.revenueOverTime'), yFormat: formatMoney, yFormatAxis: formatMoneyCompact, xFormat: xFmt, onPick: (p) => drillTo({ day: startOfDay(p.x) }), pickHint: t('analytics.clickDay') }) : emptyChart(c)),
      seriesTable('revenue', formatMoney),
    ),
    chartCard(
      'orders',
      t('analytics.ordersOverTime'),
      src,
      (c) => (hasSeries ? lineChart(c, { points: A.series.map((p) => ({ x: p.x, y: p.orders })), label: t('analytics.ordersOverTime'), yFormat: (v) => formatNumber(v), xFormat: xFmt, onPick: (p) => drillTo({ day: startOfDay(p.x) }), pickHint: t('analytics.clickDay') }) : emptyChart(c)),
      seriesTable('orders', (v) => formatNumber(v)),
    ),
  );

  const storeBars = (k) => A.perStore.map((p) => ({ id: p.store.id, label: storeName(p.store.id), color: p.store.color, value: k === 'revenue' ? p.revenue : ratio(p.returns, p.orders) }));
  // a click on a store's bar shows the whole dashboard for that store only
  const pickStore = (b) => {
    state.filters.shopId = state.filters.shopId === b.id ? 'all' : b.id;
    renderAll();
  };
  const bars = h(
    'div',
    { class: 'grid-2' },
    chartCard(
      'byStoreRevenue',
      t('analytics.revenueByStore'),
      null,
      (c) => barChart(c, { bars: storeBars('revenue'), format: formatMoney, label: t('analytics.revenueByStore'), onPick: pickStore, pickHint: t('analytics.clickStore') }),
      { head: [t('table.store'), t('analytics.revenue')], rows: storeBars('revenue').map((b) => [b.label, formatMoney(b.value)]) },
    ),
    chartCard(
      'byStoreReturns',
      t('analytics.returnRateByStore'),
      null,
      (c) => barChart(c, { bars: storeBars('returns'), format: (v) => formatPercent(v), label: t('analytics.returnRateByStore'), onPick: pickStore, pickHint: t('analytics.clickStore') }),
      { head: [t('table.store'), t('analytics.returnRate')], rows: storeBars('returns').map((b) => [b.label, formatPercent(b.value)]) },
    ),
  );

  const profitBars = A.perStore.map((p) => ({ id: p.store.id, label: storeName(p.store.id), color: p.store.color, value: A.profit.per[p.store.id] ?? null }));
  const profitCard = h(
    'div',
    { class: 'grid-2' },
    chartCard('byStoreProfit', t('analytics.profitByStore'), A.profit.total ? t('analytics.profitCoverage', { complete: A.profit.complete, total: A.profit.total }) : t('analytics.profitNA'), (c) => barChart(c, { bars: profitBars, format: formatMoney, label: t('analytics.profitByStore'), onPick: pickStore, pickHint: t('analytics.clickStore') }), {
      head: [t('table.store'), t('analytics.profit')],
      rows: profitBars.map((b) => [b.label, formatMoney(b.value)]),
    }),
  );

  const productTable = (title, list) =>
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'card__header' }, h('h2', { class: 'card__title' }, title)),
      list.length
        ? h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'data' },
              h(
                'thead',
                null,
                h('tr', null, [t('analytics.product'), t('table.store'), t('analytics.revenue'), t('analytics.units'), t('analytics.returnRate')].map((c, i) => h('th', { scope: 'col', class: i > 1 && 'num' }, c))),
              ),
              h(
                'tbody',
                null,
                list.map((p) =>
                  h(
                    'tr',
                    null,
                    h('td', { class: 'wrap' }, p.name || p.sku, p.sku && p.name ? h('div', { class: 'muted mono' }, p.sku) : null),
                    h('td', null, storeChip(p.shopId)),
                    h('td', { class: 'num' }, formatMoney(p.revenue)),
                    h('td', { class: 'num' }, formatNumber(p.units)),
                    h('td', { class: 'num' }, formatPercent(p.returnRate)),
                  ),
                ),
              ),
            ),
          )
        : h('div', { class: 'card__body muted' }, t('analytics.noProducts')),
    );

  const byRevenue = [...A.products].sort((a, b) => compareValues(b.revenue, a.revenue)).slice(0, 10);
  const byReturns = A.products.filter((p) => p.returnRate != null).sort((a, b) => b.returnRate - a.returnRate).slice(0, 10);

  return h('div', null, kpis, lines, bars, profitCard, h('div', { class: 'grid-2' }, productTable(t('analytics.topByRevenue'), byRevenue), productTable(t('analytics.topByReturns'), byReturns)));
}

/* ===================================================================== */
/* View: chat                                                             */
/* ===================================================================== */

/** Conversations from all filtered stores, newest first. */
function conversations() {
  const ids = new Set(filteredStores().map((s) => s.id));
  return Object.entries(state.chat)
    .filter(([shopId]) => ids.has(shopId))
    .flatMap(([shopId, c]) => (c.conversations || []).map((conv) => ({ ...conv, shopId, key: itemKey(shopId, conv.id) })))
    .filter((c) => !state.chatUi.unreadOnly || c.unread > 0 || c.key === state.chatUi.active)
    .sort((a, b) => compareValues(b.time, a.time));
}

function viewChat() {
  if (!filteredStores().length) return noStores();
  const ui = state.chatUi;
  const list = conversations();
  const totalUnread = sumBy(list, (c) => c.unread);

  const filters = h(
    'div',
    { class: 'chat__filters' },
    h(
      'label',
      null,
      h('input', { type: 'checkbox', checked: ui.unreadOnly, dataset: { fkey: 'chat-unread' }, onchange: (e) => ((ui.unreadOnly = e.target.checked), renderView()) }),
      t('chat.unreadOnly'),
    ),
    h('div', { class: 'toolbar__spacer' }),
    totalUnread > 0 && h('span', { class: 'badge badge--danger' }, t('chat.unread', { count: totalUnread })),
  );

  const items = h(
    'ul',
    { class: 'chat__items', role: 'listbox', 'aria-label': t('chat.conversations') },
    list.map((c, i) => {
      const selected = ui.active === c.key;
      return h(
        'li',
        {
          role: 'option',
          class: ['conv', c.unread > 0 && 'conv--unread'],
          'aria-selected': String(selected),
          tabindex: selected || (!ui.active && i === 0) ? '0' : '-1',
          dataset: { key: c.key, fkey: `conv-${c.key}` },
          onclick: () => openConversation(c),
        },
        h('span', { class: 'conv__name' }, c.customer || t('chat.customer')),
        h('span', { class: 'conv__time' }, formatChatTime(c.time)),
        h('span', { class: 'conv__preview', style: { gridColumn: '1 / -1' } }, c.preview || ''),
        h('div', { class: 'conv__meta' }, storeBadge(c.shopId), c.orderId && h('span', { class: 'muted', style: { fontSize: '12px' } }, t('chat.order', { id: c.orderId })), c.unread > 0 && h('span', { class: 'unread-pill', 'aria-label': t('chat.unread', { count: c.unread }) }, c.unread)),
      );
    }),
  );
  items.addEventListener('keydown', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    const all = [...items.children];
    const i = all.indexOf(li);
    const go = (n) => {
      const target = all[Math.max(0, Math.min(all.length - 1, n))];
      li.tabIndex = -1;
      target.tabIndex = 0;
      target.focus();
    };
    if (e.key === 'ArrowDown') (e.preventDefault(), go(i + 1));
    else if (e.key === 'ArrowUp') (e.preventDefault(), go(i - 1));
    else if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), openConversation(list[i]));
  });

  const left = h(
    'div',
    { class: 'chat__list' },
    filters,
    list.length
      ? items
      : emptyState(t('chat.noConversations'), t('chat.noConversationsText'), h('button', { type: 'button', class: 'btn', onclick: openChatTabs }, t('chat.openChatTabs'))),
  );

  return h('section', { class: 'card chat' }, left, renderThread());
}

function renderThread() {
  const ui = state.chatUi;
  const conv = ui.active && conversations().find((c) => c.key === ui.active);
  const pane = h('div', { class: 'chat__thread' });
  if (!ui.active) return (pane.append(emptyState(t('chat.selectConversation'))), pane);

  const [shopId, conversationId] = ui.active.split('::');
  const cached = state.chat[shopId]?.threads?.[conversationId]?.messages || [];
  const messages = [...cached, ...(ui.pending[ui.active] || [])];

  pane.append(
    h(
      'div',
      { class: 'thread__header' },
      h('span', { class: 'thread__title' }, conv?.customer || t('chat.customer')),
      storeBadge(shopId),
      h('span', { class: 'muted', style: { fontSize: '12px' } }, t('chat.pollEvery', { sec: Math.max(30, state.data.settings.chatPollSec) })),
      h('button', { type: 'button', class: 'btn btn--sm', onclick: () => send('ui:openStore', { shopId }) }, t('common.openInStore')),
    ),
  );

  const box = h('div', { class: 'thread__messages', role: 'log', 'aria-live': 'polite', 'aria-label': conv?.customer || '' });
  if (ui.loading && !messages.length) box.append(h('div', { class: 'muted' }, t('chat.loadingThread')));
  if (ui.error) box.append(h('div', { class: 'banner' }, icon('warn'), h('span', { class: 'banner__text' }, t('chat.threadError', { error: errorText(ui.error) }))));
  messages.forEach((m) =>
    box.append(
      h(
        'div',
        { class: ['msg', `msg--${m.from}`, m.pending && 'msg--pending'], lang: '' /* original language of the message */ },
        m.text,
        h('span', { class: 'msg__time' }, [m.from === 'seller' ? t('chat.you') : conv?.customer || t('chat.customer'), m.pending ? t('chat.sending') : formatChatTime(m.time)].filter(Boolean).join(' · ')),
      ),
    ),
  );
  pane.append(box);
  requestAnimationFrame(() => (box.scrollTop = box.scrollHeight));

  const textarea = h('textarea', {
    rows: 2,
    placeholder: t('chat.placeholder'),
    'aria-label': t('chat.placeholder'),
    dataset: { fkey: `composer-${ui.active}` },
    value: ui.drafts[ui.active] || '',
    oninput: (e) => (ui.drafts[ui.active] = e.target.value),
    onkeydown: (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        sendReply();
      }
    },
  });
  pane.append(
    h('div', { class: 'composer' }, textarea, h('button', { type: 'button', class: 'btn btn--primary', disabled: ui.sending, onclick: sendReply }, t(ui.sending ? 'chat.sending' : 'chat.send'))),
    h('div', { class: 'composer__hint' }, t('chat.sendHint')),
  );
  return pane;
}

async function openConversation(c) {
  const ui = state.chatUi;
  ui.active = c.key;
  ui.error = null;
  ui.loading = true;
  renderView();
  const res = await send('ui:chatThread', { shopId: c.shopId, conversationId: c.id });
  ui.loading = false;
  if (!res?.ok) ui.error = res?.error || 'noResponse';
  state.chat = await getChat();
  if (ui.active === c.key) renderView();
}

async function sendReply() {
  const ui = state.chatUi;
  const key = ui.active;
  const text = (ui.drafts[key] || '').trim();
  if (!key || !text || ui.sending) return;
  const [shopId, conversationId] = key.split('::');
  ui.sending = true;
  ui.pending[key] = [...(ui.pending[key] || []), { id: `p${Date.now()}`, from: 'seller', text, pending: true }];
  ui.drafts[key] = '';
  renderView();
  const res = await send('ui:chatSend', { shopId, conversationId, text });
  ui.sending = false;
  ui.pending[key] = [];
  if (res?.ok) toast(t(res.verified ? 'chat.sent' : 'chat.sentUnverified'), res.verified ? 'ok' : 'info');
  else {
    ui.drafts[key] = text; // keep the text so nothing is lost
    toast(t('chat.sendFailed', { error: errorText(res?.error) }), 'error');
  }
  state.chat = await getChat();
  renderView();
}

async function openChatTabs() {
  const res = await send('ui:openChatTabs');
  toast(t('chat.chatTabsOpened', { count: res?.opened || 0 }), 'info');
}

let chatTimer = null;
/** While the chat view is open, poll at the configured interval. */
function manageChatPolling() {
  clearInterval(chatTimer);
  if (state.route !== 'chat') return;
  const sec = Math.max(30, state.data?.settings?.chatPollSec || 30);
  const tick = async () => {
    state.chat = (await send('ui:chatList')) || state.chat;
    const ui = state.chatUi;
    if (ui.active && !ui.sending) {
      const [shopId, conversationId] = ui.active.split('::');
      await send('ui:chatThread', { shopId, conversationId, passive: true });
      state.chat = await getChat();
    }
    if (state.route === 'chat') renderView();
  };
  tick();
  chatTimer = setInterval(tick, sec * 1000);
}

/* ===================================================================== */
/* View: settings                                                         */
/* ===================================================================== */

/** Settings are written by the worker (under its lock), never directly from here. */
async function updateSettings(patch, { silent } = {}) {
  uxSaved = true;
  const next = await send('ui:saveSettings', { patch });
  if (next?.stores) state.data.settings = next;
  if (!silent) toast(t('settings.saved'), 'ok', 2000);
  renderAll();
}

async function updateStore(shopId, patch) {
  uxSaved = true;
  const next = await send('ui:updateStore', { shopId, patch });
  if (next?.stores) state.data.settings = next;
  toast(t('settings.saved'), 'ok', 2000);
  renderAll();
}

/** «Печать накладных»: every seller has a different printer — chosen once per computer. */
function printCard(st) {
  const pr = normalizePrint(st.print);
  const save = (patch) => updateSettings({ print: normalizePrint({ ...pr, ...patch }) }, { silent: true });
  const seg = h('div', { class: 'seg seg--wrap', role: 'group', 'aria-label': t('settings.printTitle') },
    PAPER_MODES.map((m) => h('button', { type: 'button', 'aria-pressed': String(pr.paper === m), dataset: { paper: m }, onclick: () => save({ paper: m }) }, t(`settings.paper.${m}`))));
  const num = (key, max, label) => h('label', { class: 'check' }, t(label), h('input', { class: 'input', type: 'number', min: LABEL_LIMITS.min, max, step: 1, style: { width: '80px' }, value: pr[key], dataset: { label: key }, onchange: (e) => save({ [key]: e.target.value }) }));
  const labelBox = pr.paper === 'label' &&
    h('div', { class: 'field' },
      h('span', { class: 'field__label' }, t('settings.labelSize')),
      h('div', { class: 'seg seg--wrap', role: 'group' },
        LABEL_PRESETS.map(([w, hh]) => h('button', { type: 'button', 'aria-pressed': String(w === pr.labelW && hh === pr.labelH), dataset: { label: `${w}x${hh}` }, onclick: () => save({ labelW: w, labelH: hh }) }, `${w}×${hh}`))),

      h('div', { style: { display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '8px' } }, num('labelW', LABEL_LIMITS.maxW, 'settings.labelW'), num('labelH', LABEL_LIMITS.maxH, 'settings.labelH')),
    );
  return h('section', { class: 'card', dataset: { card: 'print' } },
    h('div', { class: 'card__header' },
      h('div', null, h('h2', { class: 'card__title' }, t('settings.printTitle')), h('div', { class: 'card__sub' }, t('settings.printHint'))),
      h('button', { type: 'button', class: 'btn', dataset: { action: 'print-test', uxKey: 'act_print-test' }, onclick: () => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/print.html?mode=test') }) }, t('settings.printTest')),
    ),
    h('div', { class: 'card__body' },
      seg,
      labelBox,
      h('p', { class: 'muted small', style: { marginTop: '10px' } }, t(`settings.printTips.${pr.paper}`)),
    ),
  );
}

function viewSettings() {
  const st = state.data.settings;
  const card = (title, hint, ...body) => h('section', { class: 'card' }, h('div', { class: 'card__header' }, h('div', null, h('h2', { class: 'card__title' }, title), hint && h('div', { class: 'card__sub' }, hint))), h('div', { class: 'card__body' }, ...body));
  const all = Object.values(st.stores);

  const storesTable = all.length
    ? h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'data' },
          h('thead', null, h('tr', null, ['settings.color', 'settings.storeName', 'settings.alias', 'settings.status', 'settings.lastSeen', 'settings.enabled', ''].map((k) => h('th', { scope: 'col' }, k ? t(k) : '')))),
          h(
            'tbody',
            null,
            all.map((s) => {
              const snap = state.data.snapshots[s.id];
              const status = snap?.status || 'noTab';
              const patchStore = (p) => updateStore(s.id, p);
              return h(
                'tr',
                null,
                h(
                  'td',
                  null,
                  // one dot per store; the palette opens on click (10 dots per row were noisy)
                  h('details', { class: 'color-pick' },
                    h('summary', { class: 'swatch swatch--current', style: { background: s.color }, 'aria-label': t('settings.color'), title: t('settings.color') }),
                    h(
                      'div',
                      { class: 'swatches color-pick__menu', role: 'group', 'aria-label': t('settings.color') },
                      STORE_COLORS.map((c, i) => h('button', { type: 'button', class: 'swatch', style: { background: c }, 'aria-pressed': String(s.color === c), 'aria-label': `${t('settings.color')} ${i + 1}`, onclick: () => patchStore({ color: c }) })),
                    ),
                  ),
                ),
                h('td', { title: s.id }, storeChip(s.id)),
                h('td', null, h('input', { class: 'input', value: s.alias || '', placeholder: s.name, 'aria-label': t('settings.alias'), onchange: (e) => patchStore({ alias: e.target.value.trim() }) })),
                h('td', null, h('span', { class: ['badge', status === 'ok' ? 'badge--ok' : 'badge--warn'] }, t(`store.${status === 'ok' ? 'online' : status}`))),
                h('td', { class: 'muted' }, s.lastSeen ? formatRelative(s.lastSeen) : '—'),
                h('td', null, h('input', { type: 'checkbox', checked: s.enabled, 'aria-label': t('settings.enabled'), onchange: (e) => patchStore({ enabled: e.target.checked }) })),
                h(
                  'td',
                  null,
                  h('button', { type: 'button', class: 'btn btn--sm btn--ghost', onclick: () => send('ui:openStore', { shopId: s.id }) }, t('common.open')),
                  h('button', { type: 'button', class: 'btn btn--sm btn--ghost btn--danger', onclick: () => removeStore(s) }, t('common.remove')),
                ),
              );
            }),
          ),
        ),
      )
    : h('p', { class: 'muted' }, t(FEATURES.cabinet ? 'store.noStoresText' : 'store.noStoresTextApi'));

  const seg = (value, options, onPick) =>
    h(
      'div',
      { class: 'seg', role: 'group' },
      options.map(([v, label]) => h('button', { type: 'button', 'aria-pressed': String(value === v), onclick: () => onPick(v) }, label)),
    );

  const notif = (key, label) =>
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.notifications[key], onchange: (e) => updateSettings({ notifications: { ...st.notifications, [key]: e.target.checked } }) }), t(label));

  const missing = Object.values(state.data.snapshots).filter((s) => s.missingSelectors?.length);
  const version = Object.values(state.data.snapshots).find((s) => s.selectorsVersion)?.selectorsVersion || globalThis.KSH_SELECTORS?.version || '—';

  return h(
    'div',
    { class: 'settings' },
    card(t('settings.stores'), t(FEATURES.cabinet ? 'settings.storesHint' : 'settings.storesHintApi'), storesTable),
    apiCard(),
    card(t('readOnly.title'), t('readOnly.hint'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', dataset: { setting: 'readOnly' }, checked: !!st.readOnly, onchange: (e) => updateSettings({ readOnly: e.target.checked }) }), t('readOnly.toggle'))),
    card(
      t('settings.appearance'),
      null,
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('common.language')), seg(getLang(), [['ru', 'Русский'], ['kk', 'Қазақша']], changeLang)),
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'field__label' }, t('common.theme')),
        seg(st.theme, [['system', t('settings.themeSystem')], ['light', t('settings.themeLight')], ['dark', t('settings.themeDark')]], (v) => updateSettings({ theme: v }, { silent: true })),
      ),
    ),
    card(
      t('settings.chat'),
      t('settings.pollIntervalHint'),
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'field__label', for: 'pollSec' }, t('settings.pollInterval')),
        h('input', { id: 'pollSec', type: 'number', min: 30, step: 5, class: 'input', style: { width: '100px' }, value: st.chatPollSec, onchange: (e) => updateSettings({ chatPollSec: Math.max(30, Number(e.target.value) || 30) }) }),
      ),
    ),
    card(
      t('settings.deadlines'),
      t('settings.deadlinesHint'),
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'field__label', for: 'acceptHours' }, t('settings.acceptHours')),
        h('input', { id: 'acceptHours', type: 'number', min: 0, step: 0.5, class: 'input', style: { width: '100px' }, value: st.deadlines.acceptHours ?? '', onchange: (e) => updateSettings({ deadlines: { ...st.deadlines, acceptHours: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) } }) }),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'field__label', for: 'warnHours' }, t('settings.warnHours')),
        h('input', { id: 'warnHours', type: 'number', min: 0, step: 0.5, class: 'input', style: { width: '100px' }, value: st.deadlines.warnHours ?? 2, onchange: (e) => updateSettings({ deadlines: { ...st.deadlines, warnHours: Math.max(0, Number(e.target.value) || 0) } }) }),
      ),
    ),
    printCard(st),
    teamCard(staffCtx()),
    warehouseCard(staffCtx()),
    journalCard(staffCtx()),
    state.data.license?.status && !['unconfigured', 'loggedOut'].includes(state.data.license.status) ? telegramCard(tgCtx()) : null,
    card(t('settings.notifications'), null, notif('newOrders', 'settings.notifyNewOrders'), notif('deadlines', 'settings.notifyDeadlines'), notif('newMessages', 'settings.notifyNewMessages'), notif('returns', 'settings.notifyReturns')),
    card(
      t('backup.title'),
      t('backup.text'),
      h(
        'div',
        { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        h('button', { type: 'button', class: 'btn btn--primary', dataset: { action: 'backup-save', uxKey: 'act_backup-save' }, onclick: async () => {
          const res = await send('ui:backupExport');
          if (!res?.ok) return toast(errorText(res?.error), 'error');
          const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(res.backup, null, 1)], { type: 'application/json' })), download: `seller-hub-backup-${new Date().toISOString().slice(0, 10)}.json` });
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
          toast(t('backup.saved'), 'ok');
          markStep('backup');
        } }, t('backup.save')),
        h('button', { type: 'button', class: 'btn', onclick: (e) => e.currentTarget.nextElementSibling.click() }, t('backup.restore')),
        h('input', { type: 'file', accept: '.json,application/json', hidden: true, dataset: { action: 'backup-file', uxKey: 'act_backup-file' }, onchange: async (e) => {
          const file = e.target.files[0];
          e.target.value = '';
          if (!file) return;
          if (file.size > 100 * 1024 * 1024) return toast(errorText('backupTooBig'), 'error');
          let backup;
          try {
            backup = JSON.parse(await file.text(), (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v));
          } catch {
            return toast(errorText('backupInvalid'), 'error');
          }
          if (backup?.app !== 'kaspi-seller-hub') return toast(errorText('backupInvalid'), 'error');
          if (!(await confirmDialog(t('backup.restoreTitle'), t('backup.restoreConfirm', { date: formatDate(backup.createdAt), products: Object.keys(backup.catalog || {}).length, costs: Object.keys(backup.costs || {}).length })))) return;
          const res = await send('ui:backupImport', { backup });
          if (!res?.ok) return toast(errorText(res?.error), 'error');
          toast(t('backup.restored', { products: res.products, costs: res.costs }), 'ok', 9000);
          if (res.storesSkipped) toast(t('backup.storesSkipped', { count: res.storesSkipped }), 'info', 12000);
          state.costs = await getCosts();
          await loadState();
        } }),
      ),
      h('p', { class: 'muted small' }, t('backup.note')),
    ),
    phoneTransferCard({ t, send, toast, errorText, reload: loadState }),
    card(
      t('settings.data'),
      t('settings.invoicesStored', { count: state.invoiceCount }),
      h(
        'div',
        { class: 'field' },
        h(
          'div',
          { style: { display: 'flex', gap: '8px' } },
          h('button', { type: 'button', class: 'btn', onclick: async () => (await send('ui:clearCache'), toast(t('settings.cleared'), 'ok'), loadState()) }, t('settings.clearCache')),
          h('button', { type: 'button', class: 'btn', onclick: async () => (await clearInvoices(), await refreshInvoiceCount(), toast(t('settings.cleared'), 'ok'), renderView()) }, t('settings.clearInvoices')),
        ),
      ),
    ),
    card(
      t('settings.diagnostics'),
      t('settings.diagnosticsHint'),
      h('div', { class: 'muted' }, t('settings.selectorsVersion', { version })),
      missing.length
        ? missing.map((s) => h('div', { class: 'field', style: { alignItems: 'flex-start' } }, storeChip(s.shopId), h('div', { class: 'chips' }, s.missingSelectors.map((k) => h('code', { class: 'chip-code' }, k)))))
        : h('div', null, h('span', { class: 'badge badge--ok' }, t('settings.noMissing'))),
    ),
  );
}

/** Settings › "Connect by Kaspi API": per-store token status + connect form. */
function apiCard() {
  const all = Object.values(state.data.settings.stores);
  const ui = (state.apiForm ??= { shopId: '', name: '', busy: false, error: null });
  const rows = all.map((s) => {
    const api = s.api;
    const statusEl = api?.connected
      ? h(
          'span',
          { class: ['badge', api.error ? 'badge--danger' : 'badge--ok'] },
          api.error ? t('settings.api.lastError', { error: errorText(api.error) }) : t('settings.api.connected', { last4: api.last4 || '' }),
        )
      : h('span', { class: 'badge' }, t('settings.api.notConnected'));
    return h(
      'div',
      { class: 'field' },
      h('div', null, storeChip(s.id), ' ', statusEl, api?.lastOkAt ? h('div', { class: 'field__hint' }, t('common.updated', { time: formatRelative(api.lastOkAt) })) : null),
      api?.connected &&
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn--sm btn--ghost btn--danger',
            onclick: async () => {
              await send('ui:disconnectApi', { shopId: s.id });
              await loadState();
            },
          },
          t('settings.api.disconnect'),
        ),
    );
  });

  const select = h(
    'select',
    { class: 'select', 'aria-label': t('settings.api.store'), onchange: (e) => ((ui.shopId = e.target.value), renderView()) },
    h('option', { value: '', selected: !ui.shopId }, t('settings.api.newStore')),
    all.map((s) => h('option', { value: s.id, selected: ui.shopId === s.id }, s.alias || s.name)),
  );
  const nameInput = !ui.shopId && h('input', { class: 'input', placeholder: t('settings.api.storeName'), 'aria-label': t('settings.api.storeName'), value: ui.name, dataset: { fkey: 'api-name' }, oninput: (e) => (ui.name = e.target.value) });
  // The token field is never pre-filled and its value is not kept in page state.
  const tokenInput = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: t('settings.api.tokenLabel'), 'aria-label': t('settings.api.tokenLabel'), style: { flex: '1' }, dataset: { apiToken: '1' } });
  const connect = h(
    'button',
    {
      type: 'button',
      class: 'btn btn--primary',
      disabled: ui.busy,
      onclick: async () => {
        ui.busy = true;
        ui.error = null;
        renderView();
        const res = await send('ui:connectApi', { shopId: ui.shopId || null, name: ui.name, token: tokenInput.value });
        ui.busy = false;
        if (res?.ok) {
          Object.assign(ui, { shopId: '', name: '' });
          toast(t('settings.api.connectedToast'), 'ok', 8000);
          await loadState();
        } else {
          ui.error = res?.error || 'noResponse';
          renderView();
        }
      },
    },
    t(ui.busy ? 'settings.api.connecting' : 'settings.api.connect'),
  );

  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'card__header' }, h('div', null, h('h2', { class: 'card__title' }, t('settings.api.title')), h('div', { class: 'card__sub' }, t('settings.api.hint')))),
    h(
      'div',
      { class: 'card__body' },
      rows,
      h('div', { class: 'field', style: { justifyContent: 'flex-start', gap: '8px', flexWrap: 'wrap' } }, select, nameInput, tokenInput, connect),
      ui.error && h('div', { class: 'banner', role: 'alert' }, icon('warn'), h('span', { class: 'banner__text' }, errorText(ui.error))),
      h('div', { class: 'field__hint' }, t('settings.api.howTo')),
      h('div', { class: 'field__hint' }, t('settings.api.securityNote')),
    ),
  );
}

async function removeStore(s) {
  if (!(await confirmDialog(t('common.remove'), t('settings.removeStoreConfirm', { store: s.alias || s.name })))) return;
  await send('ui:removeStore', { shopId: s.id });
  if (state.filters.shopId === s.id) state.filters.shopId = 'all';
  toast(t('settings.cleared'), 'ok', 2000);
  await loadState();
}

/* ===================================================================== */
/* Shell: top bar, sidebar, banners                                       */
/* ===================================================================== */

function noStores() {
  return h('section', { class: 'card' }, emptyState(t('store.noStoresTitle'), t(FEATURES.cabinet ? 'store.noStoresText' : 'store.noStoresTextApi'), h('button', { type: 'button', class: 'btn btn--primary', onclick: () => $('connectStoreBtn').click() }, t('connect.button'))));
}

function applyTheme() {
  const theme = state.data?.settings?.theme || 'system';
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function renderTopbar() {
  $('pageTitle').textContent = t(`${state.route}.title`);
  $('pageSubtitle').textContent = t(`${state.route}.subtitle`);
  document.title = `${t(`${state.route}.title`)} · ${t('app.name')}`;

  const meter = $('storeMeter');
  if (meter) {
    const current = state.filters.shopId === 'all' ? t('common.allStores') : storeName(state.filters.shopId);
    clear(meter).append(storeMeter({ lic: state.data?.license, used: enabledStores().length, current, onAdd: () => addStore() }) || '');
  }
  const hasFilters = ['orders', 'returns', 'refusals', 'payments', 'analytics', 'products'].includes(state.route);
  $('dataFilters').hidden = !hasFilters;
  // phones: the filters fold into one button that says what is selected («30 дней · Все магазины»)
  const ft = $('filtersToggle');
  ft.hidden = !hasFilters;
  const f = state.filters;
  const period = f.preset === 'custom' ? (f.from && f.to ? `${formatDate(startOfDay(f.from), 'short')} – ${formatDate(startOfDay(f.to), 'short')}` : t('topbar.custom')) : t(`topbar.last${f.preset}`);
  ft.textContent = `${period} · ${f.shopId === 'all' ? t('common.allStores') : storeName(f.shopId)} ▾`;
  ft.setAttribute('aria-expanded', String(document.body.classList.contains('filters-open')));
  const sel = clear($('storeFilter'));
  sel.append(h('option', { value: 'all' }, t('common.allStores')));
  enabledStores().forEach((s) => sel.append(h('option', { value: s.id, selected: state.filters.shopId === s.id }, s.alias || s.name)));
  sel.value = state.filters.shopId;

  document.querySelectorAll('#rangeSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === state.filters.preset)));
  $('customRange').hidden = state.filters.preset !== 'custom';
  document.querySelectorAll('#langSwitch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === getLang())));

  $('refreshLabel').textContent = t(state.syncing ? 'common.refreshing' : 'common.refresh');
  $('refreshBtn').querySelector('svg').classList.toggle('spin', state.syncing);
  $('refreshBtn').disabled = state.syncing;
  $('lastSync').textContent = state.data?.lastSync ? t('common.updated', { time: formatRelative(state.data.lastSync) }) : t('common.neverUpdated');
  renderProgress();
}

function renderSidebar() {
  document.querySelectorAll('.nav__item').forEach((a) => (a.dataset.route === state.route ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  // Plan chip: "Пробный период до …" / "Оплачено до …" / "Подписка закончилась".
  const lic = state.data.license;
  const chip = $('planChip');
  if (chip) {
    const show = lic && lic.status !== 'unconfigured';
    chip.hidden = !show;
    if (show) {
      const until = lic.status === 'active' ? lic.paidUntil : lic.trialEndsAt;
      chip.textContent = t(`account.status.${lic.status}`, { date: until ? formatDate(until) : '' });
      chip.className = ['plan-chip', `plan-chip--${lic.status}`].join(' ');
    }
  }
  const counts = dataStores().map((s) => storeCounts(state.data.snapshots[s.id]));
  const sum = (k) => counts.reduce((n, c) => n + (c[k] || 0), 0);
  const unread = enabledStores().reduce((n, s) => n + sumBy(state.chat[s.id]?.conversations || [], (c) => c.unread), 0);
  const setCount = (k, v) => {
    const el = document.querySelector(`[data-count="${k}"]`);
    if (el) el.textContent = v ? formatNumber(v) : ''; // the chat item is absent in the API-only build
  };
  setCount('orders', sum('newOrders'));
  setCount('help', unreadAnswers(state.tickets));
  const urgent = enabledStores().reduce(
    (n, s) => n + (state.data.snapshots[s.id]?.sections?.orders?.items || []).filter((it) => ['soon', 'overdue'].includes(urgencyOf(deadlineOf(it, settingsNow()), settingsNow()))).length,
    0,
  );
  const u = document.querySelector('[data-count="urgent"]');
  if (u) {
    clear(u);
    if (urgent) u.append(svgIcon('fire', { size: 12 }), formatNumber(urgent));
    u.title = urgent ? t('deadline.sidebar', { count: urgent }) : '';
  }
  setCount('returns', sum('returns'));
  setCount('refusals', sum('refusals'));
  setCount('payments', sum('unpaid'));
  setCount('chat', unread);

  const list = clear($('sidebarStores'));
  enabledStores().forEach((s) => {
    const status = state.data.snapshots[s.id]?.status || 'noTab';
    list.append(
      h(
        'li',
        { class: 'sidebar__store', style: { '--store-color': s.color } },
        h('span', { class: 'dot', 'aria-hidden': 'true' }),
        h('span', { class: 'sidebar__store-name', title: s.alias || s.name }, s.alias || s.name),
        h('span', { class: ['sidebar__store-state', status !== 'ok' && 'sidebar__store-state--off'] }, t(`store.${status === 'ok' ? 'online' : status}`)),
      ),
    );
  });
}

/** Per-store "unavailable" banners — never block the other stores. */
const KASPI_ORIGINS = ['https://kaspi.kz/*', 'https://mc.shop.kaspi.kz/*', 'https://idmc.shop.kaspi.kz/*'];

function renderBanners() {
  const box = clear($('banners'));
  // the owner's announcement from the licence (incidents, Kaspi layout changes): plain text only
  const sys = bannerFrom(state.data?.license);
  if (sys)
    box.append(h('div', { class: `banner banner--${sys.type}`, role: sys.type === 'info' ? 'status' : 'alert', dataset: { banner: 'system' } },
      h('span', { class: 'banner__icon' }, icon(sys.type === 'info' ? 'info' : 'warn')),
      h('span', { class: 'banner__text' }, sys.text)));
  // 1–3 days left: a soft reminder (the pay dialog and the Home to-do cover the earlier days)
  const exp = expiryNotice(state.data?.license);
  if (exp)
    box.append(h('div', { class: 'banner banner--warn', role: 'status', dataset: { banner: 'expiry' } },
      h('span', { class: 'banner__icon' }, icon('warn')),
      h('span', { class: 'banner__text' }, t(exp.kind === 'trial' ? 'notices.expiryTrial' : 'notices.expiryPaid', { days: exp.days })),
      h('button', { type: 'button', class: 'btn btn--sm btn--primary', dataset: { action: 'renew', uxKey: 'act_renew' }, onclick: () => (location.hash = state.data.license.pendingInvoice ? 'pay' : 'account') }, t('notices.renew'))));
  // the owner's notice for everyone («Kaspi не отвечает, чиним»)
  const notice = statusBanner(state.serviceStatus);
  if (notice) box.append(notice);
  // grace days / frozen / cancelled
  const plan = planNotice(state.data?.license, { onPay: () => openPay(false), onResume: resumeSubscription });
  if (plan) box.append(plan);
  // «Только чтение» is always visible: nothing the seller clicks changes Kaspi
  if (state.data?.settings?.readOnly)
    box.append(h('div', { class: 'banner banner--info', role: 'status', dataset: { banner: 'readonly' } },
      h('span', { class: 'banner__icon' }, icon('info')),
      h('span', { class: 'banner__text' }, h('b', null, t('readOnly.title')), ' — ', t('readOnly.banner')),
      h('a', { class: 'btn btn--sm', href: '#settings' }, t('readOnly.change'))));
  // Firefox (and Chrome with "on click" site access) may not grant kaspi.kz at install time.
  if (state.kaspiAccess === false)
    box.append(
      h(
        'div',
        { class: 'banner', role: 'alert' },
        icon('warn'),
        h('span', { class: 'banner__text' }, t('access.text')),
        h('button', {
          type: 'button',
          class: 'btn btn--sm btn--primary',
          onclick: async () => {
            const ok = await chrome.permissions.request({ origins: KASPI_ORIGINS }).catch(() => false);
            state.kaspiAccess = ok;
            renderBanners();
            if (ok) sync();
          },
        }, t('access.button')),
      ),
    );
  if (state.route === 'settings') return;
  filteredStores().forEach((s) => {
    const snap = state.data.snapshots[s.id];
    const status = snap?.status || 'noTab';
    if (status === 'ok') return;
    // Kaspi down 3 times in a row → the store rests 10 minutes; say plainly what is shown
    const api = state.data.settings?.stores?.[s.id]?.api;
    if (status === 'error' && api && (api.fails || 0) >= 3) {
      box.append(h('div', { class: 'banner banner--warn', role: 'status', dataset: { banner: 'kaspi-down' } },
        h('span', { class: 'banner__icon' }, icon('warn')),
        h('span', { class: 'banner__text' }, t('store.kaspiDown', { store: storeName(s.id), time: api.lastOkAt ? formatDate(api.lastOkAt, 'datetime') : '—' }))));
      return;
    }
    box.append(
      h(
        'div',
        { class: 'banner', role: 'status' },
        h('span', { class: 'banner__icon' }, icon('warn')),
        h('span', { class: 'banner__text' }, t('store.unavailable', { store: storeName(s.id), reason: status === 'error' && snap?.error ? errorText(snap.error) : t(`store.${status}`) }), snap?.ts ? h('span', { class: 'banner__meta' }, ` · ${t('store.lastData', { time: formatRelative(snap.ts) })}`) : null),
        api?.connected
          ? h('button', { type: 'button', class: 'btn btn--sm btn--primary', dataset: { action: 'reconnect-api' }, onclick: () => reconnectApi(s.id) }, t('settings.api.reconnect'))
          : h('button', { type: 'button', class: 'btn btn--sm', onclick: () => send('ui:openStore', { shopId: s.id }) }, t('common.openStoreTab')),
      ),
    );
  });
  if (FEATURES.cabinet && state.data.unauthTabs > 0) {
    box.append(h('div', { class: 'banner banner--info', role: 'status' }, h('span', { class: 'banner__icon' }, icon('info')), h('span', { class: 'banner__text' }, t('store.unauthTabs', { count: state.data.unauthTabs }))));
  }
  // Stores above the plan's limit: not synced until the subscription covers them.
  if (allowedIds() && state.data.license?.canUse) {
    enabledStores()
      .filter((s) => !allowedIds().includes(s.id))
      .forEach((s) =>
        box.append(
          h(
            'div',
            { class: 'banner', role: 'status' },
            h('span', { class: 'banner__icon' }, icon('warn')),
            h('span', { class: 'banner__text' }, t('account.overLimitBanner', { store: storeName(s.id), limit: state.data.license.storeLimit })),
            h('button', { type: 'button', class: 'btn btn--sm btn--primary', onclick: payForStores }, t('account.addStores')),
          ),
        ),
      );
  }
}

/* ===================================================================== */
/* View: subscription                                                     */
/* ===================================================================== */

/** "77011234567" → "+7 701 123 45 67" */
const fmtPhone = (p) => (p && /^7\d{10}$/.test(p) ? `+7 ${p.slice(1, 4)} ${p.slice(4, 7)} ${p.slice(7, 9)} ${p.slice(9)}` : p || '');

/** Same formula as public.billing_price() on the server (display only — the server computes the invoice). */
const priceOf = (pr, stores, months) => (pr.base_price + Math.max(0, stores - pr.base_stores) * pr.extra_store_price) * months;

/* ---------- consent to the offer and privacy policy (clickwrap) ---------- */

/** «☐ Я принимаю условия Публичной оферты и даю согласие … Политикой конфиденциальности» */
function consentLabel(checked, onchange) {
  const link = (kind, key) => h('a', { href: legalUrl(kind), target: '_blank', rel: 'noopener' }, t(key));
  const box = h('input', { type: 'checkbox', checked, dataset: { fkey: 'consent' }, onchange: (e) => onchange(e.target.checked) });
  return h('label', { class: 'consent' }, box, h('span', null, t('terms.before'), link('offer', 'terms.offer'), t('terms.middle'), link('privacy', 'terms.privacy'), t('terms.after')));
}

const terms = { open: false };

/** Blocking window: tick the box → «Принимаю». Shown at login-less moments, e.g. new texts. */
function openTerms() {
  const dlg = $('termsDialog');
  const lic = state.data?.license || {};
  terms.open = true;
  let checked = false;
  let busy = false;
  const render = () => {
    const accept = h(
      'button',
      {
        type: 'button',
        class: 'btn btn--primary',
        disabled: !checked || busy,
        onclick: async () => {
          busy = true;
          render();
          const res = await send('ui:billingAcceptTerms');
          busy = false;
          if (res?.ok) {
            closeTerms();
            state.data.license = res.license;
            toast(t('terms.accepted'), 'ok');
            await loadState();
          } else {
            render();
            toast(errorText(res?.error), 'error');
          }
        },
      },
      t(busy ? 'terms.saving' : 'terms.accept'),
    );
    clear(dlg).append(
      h(
        'div',
        { class: 'pay terms' },
        h('h2', { class: 'pay__title', id: 'termsTitle' }, t(lic.termsAcceptedAt ? 'terms.updatedTitle' : 'terms.title')),
        h('p', { class: 'pay__sub' }, t(lic.termsAcceptedAt ? 'terms.updatedText' : 'terms.text')),
        consentLabel(checked, (v) => ((checked = v), render())),
        h(
          'div',
          { class: 'pay__actions' },
          accept,
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn--ghost',
              onclick: async () => {
                await send('ui:billingLogout');
                closeTerms();
                await loadState();
              },
            },
            t('pay.logout'),
          ),
        ),
      ),
    );
  };
  render();
  if (!dlg.open) dlg.showModal();
}

function closeTerms() {
  terms.open = false;
  const dlg = $('termsDialog');
  if (dlg.open) dlg.close();
}

/* ---------- Kaspi payment window ---------- */

const pay = { open: false, blocking: false, timer: null };
const memo = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage blocked: the window may simply show again */
    }
  },
};

/**
 * When the payment window opens by itself:
 *  - subscription expired → always, and it cannot be closed (cabinet blocked);
 *  - add-on stores waiting for payment → once per invoice amount;
 *  - renewal due (≤ remind_days left) → once a day.
 * @returns {'blocking'|'show'|null}
 */
function payMode(lic) {
  if (!lic || lic.freeAccess || ['unconfigured', 'loggedOut', 'offline', 'invalid', 'clock', 'frozen'].includes(lic.status)) return null; // free access: no payment prompts, nothing blocks
  const inv = lic.pendingInvoice;
  if (!inv) return null;
  if (inv.kind === 'addon' && memo.get('ksh.payShown.addon') !== `${inv.id}:${inv.amount}`) return 'show';
  if (lic.renewalDue && memo.get('ksh.payShown.renewal') !== `${inv.id}:${new Date().toDateString()}`) return 'show';
  return null;
}

function maybePay() {
  if (pay.open || terms.open || !state.data) return;
  if (state.data.license?.needsConsent) return openTerms(); // the offer comes before any payment
  if (state.forcePay && state.data.license?.pendingInvoice) {
    state.forcePay = false;
    return openPay(false);
  }
  const mode = payMode(state.data.license);
  if (mode) openPay(mode === 'blocking');
}

function rememberShown(lic) {
  const inv = lic?.pendingInvoice;
  if (!inv) return;
  if (inv.kind === 'addon') memo.set('ksh.payShown.addon', `${inv.id}:${inv.amount}`);
  else memo.set('ksh.payShown.renewal', `${inv.id}:${new Date().toDateString()}`);
}

function openPay(blocking = false) {
  const dlg = $('payDialog');
  pay.open = true;
  pay.blocking = !!blocking && !state.data?.license?.freeAccess;
  renderPay();
  if (!dlg.open) dlg.showModal();
  rememberShown(state.data.license);
  clearInterval(pay.timer);
  pay.timer = setInterval(checkPayment, 15000); // activation shows up within seconds of confirmation
}

function closePay() {
  clearInterval(pay.timer);
  pay.open = false;
  const dlg = $('payDialog');
  if (dlg.open) dlg.close();
}

/** Re-check the licence; when the invoice is paid, unlock everything at once. */
async function checkPayment(manual = false) {
  if (!manual && document.hidden) return; // tab in the background: no polling, re-checked when shown
  const lic = await send('ui:billingState', { force: true, reconcile: false }); // only «is it paid yet?»
  if (!lic) return;
  state.data.license = lic;
  if (lic.canUse && !lic.pendingInvoice) {
    closePay();
    toast(t('pay.paidToast'), 'ok', 8000);
    await loadState();
    sync();
  } else if (pay.open) renderPay();
}

/** «Номер счёта: № N» + Copy — the number the seller quotes when paying or writing to support. */
function invoiceNumber(id) {
  return h('div', { class: 'invoice-no', dataset: { block: 'invoice-no' }, style: { display: 'flex', gap: '8px', alignItems: 'center', margin: '8px 0' } },
    h('b', { style: { fontSize: '1.15em' } }, t('notices.invoiceNo', { id })),
    h('button', { type: 'button', class: 'btn btn--sm', dataset: { action: 'copy-invoice-no', uxKey: 'act_copy-invoice-no' }, onclick: async () => {
      await copyText(String(id));
      toast(t('notices.copied'), 'ok');
    } }, t('notices.copy')));
}

function renderPay() {
  const dlg = $('payDialog');
  const lic = state.data.license || {};
  const inv = lic.pendingInvoice;
  const expired = lic.status === 'expired';
  const kind = expired ? 'expired' : inv?.kind === 'addon' ? 'addon' : 'renewal';
  const extra = inv ? Math.max(0, inv.stores - (lic.storeLimit || 0)) : 0;
  const until = lic.coverageEnd ? formatDate(lic.coverageEnd) : '';
  const title = {
    expired: t('pay.expiredTitle'),
    addon: t('pay.addonTitle', { count: extra || 1 }),
    renewal: t('pay.renewTitle', { count: lic.daysLeft ?? 0, date: until }),
  }[kind];
  const sub = {
    expired: lic.trialBlocked && !lic.paidUntil ? t('account.trialUsed') : t('pay.expiredText'),
    addon: t('pay.addonText', { date: until }),
    renewal: t('pay.renewText', { stores: inv?.stores ?? '' }),
  }[kind];
  const phoneInput = h('input', { class: 'input', type: 'tel', placeholder: t('account.phonePlaceholder'), value: fmtPhone(lic.phone), style: { width: '190px' }, 'aria-label': t('pay.phoneLabel') });
  const body = h(
    'div',
    { class: 'pay' },
    h('h2', { class: 'pay__title', id: 'payTitle' }, title),
    h('p', { class: 'pay__sub' }, sub),
    inv
      ? [
          h('div', { class: 'pay__amount' }, formatMoney(inv.amount)),
          h('div', { class: 'pay__details' }, t('pay.details', { id: inv.id, stores: inv.stores })),
          invoiceNumber(inv.id),
          h('p', { class: 'muted pay__hint', dataset: { block: 'pay-hint' } }, t('notices.payHint')),
          safeQrUrl(lic.payment?.qr_url)
            ? h('img', { class: 'pay__qr', src: safeQrUrl(lic.payment.qr_url), alt: t('account.qrAlt'), referrerpolicy: 'no-referrer' })
            : h('div', { class: 'pay__noqr' }, t('pay.noQr')),
          h('p', { class: 'pay__instr' }, lic.payment?.instructions || t('pay.defaultInstr', { amount: formatMoney(inv.amount) })),
          h(
            'form',
            {
              class: 'pay__phone',
              onsubmit: async (e) => {
                e.preventDefault();
                const res = await send('ui:billingSetPhone', { phone: phoneInput.value });
                if (res?.ok) {
                  state.data.license = res.license;
                  toast(t('pay.phoneSaved'), 'ok');
                  renderPay();
                } else toast(errorText(res?.error), 'error');
              },
            },
            h('span', { class: 'muted', style: { alignSelf: 'center' } }, t('pay.phoneLabel')),
            phoneInput,
            h('button', { type: 'submit', class: 'btn btn--sm' }, t('common.save')),
          ),
        ]
      : h('p', { class: 'muted' }, t('pay.preparing')),
    h(
      'div',
      { class: 'pay__actions' },
      h('button', { type: 'button', class: 'btn btn--primary', autofocus: true, onclick: () => checkPayment(true) }, t('pay.check')),
      !pay.blocking && h('button', { type: 'button', class: 'btn', onclick: closePay }, t('pay.later')),
      // blocked cabinet: the only other way out is another account
      pay.blocking &&
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn--ghost',
            onclick: async () => {
              await send('ui:billingLogout');
              closePay();
              await loadState();
            },
          },
          t('pay.logout'),
        ),
    ),
    h('p', { class: 'pay__wait' }, t('pay.waiting')),
    // ended: the window cannot be closed, so «почему не продлеваете» lives here too
    pay.blocking && (state.feedbackDue === 'exit' || feedbackUi.exit.done) &&
      h('details', { class: 'pay__exit', dataset: { block: 'pay-exit' }, open: feedbackUi.exit.open || null, ontoggle: (e) => (feedbackUi.exit.open = e.target.open) },
        h('summary', null, t('feedback.exit.notRenewing')),
        exitCard({ ui: feedbackUi.exit, toast, errorText, rerender: () => renderPay() })),
    inv && h('p', { class: 'pay__legal' }, t('terms.payBefore'), h('a', { href: legalUrl('offer'), target: '_blank', rel: 'noopener' }, t('terms.offerShort')), t('terms.payAfter')),
  );
  clear(dlg).append(body);
}

/** Over-limit stores or the account page: create/refresh the invoice and show the QR. */
async function payForStores() {
  const res = await send('ui:billingAddon');
  if (res?.ok === false) return toast(errorText(res.error), 'error');
  if (res?.license) state.data.license = res.license;
  openPay(false);
}

const tgUi = { waiting: false };
function tgCtx() {
  if (state.tg === undefined) {
    state.tg = null;
    send('ui:tgStatus').then((r) => {
      state.tg = r?.ok ? r.tg : { linked: false, error: r?.error };
      if (state.route === 'settings') renderView();
    });
  }
  return { tg: state.tg, ui: tgUi, toast, errorText, rerender: () => renderView(), onTg: (tg) => ((state.tg = tg), renderView()) };
}

/** «Разморозить» / «Возобновить подписку». */
async function resumeSubscription() {
  const res = await send('ui:resumeSubscription');
  if (!res?.ok) return toast(errorText(res?.error), 'error');
  toast(t('plan.resumed'), 'ok');
  await loadState();
}

/** Account page: the plan, a running discount, «перейти на Старт» planned, «Отменить подписку». */
/** «Поддержать проект» (Stage 04): the server says whether ads are shown; nothing here limits any function. */
function supporterCard(lic) {
  if (!lic || ['loggedOut', 'unconfigured'].includes(lic.status)) return null;
  if (state.supEnt === undefined && !state.supLoading) {
    state.supLoading = true;
    send('ui:supporterGet', { force: true }).then((r) => { state.supEnt = r?.ok ? r.entitlements : null; })
      .catch(() => { state.supEnt = null; }).finally(() => { state.supLoading = false; if (state.route === 'account') renderView(); });
  }
  const e = state.supEnt;
  if (!e) return null;
  const ui2 = (state.supUi ??= { months: 1, msg: '' });
  const act = (type, payload) => run(async () => {
    const r = await send(type, payload);
    if (r?.ok) { state.supEnt = r.entitlements; ui2.msg = ''; adBanner?.refresh(); } else { const k = `account.supporter.err.${r?.error}`; ui2.msg = hasKey(k) ? t(k) : errorText(r?.error); }
    renderView();
    return r;
  });
  const inv = e.pendingInvoice;
  const price = formatMoney(e.priceMonth);
  const body = [];
  if (e.adFree) {
    body.push(h('p', null, h('span', { class: 'badge badge--ok' }, t('account.supporter.active')), ' ', t(e.cancelAt ? 'account.supporter.endsCancelled' : 'account.supporter.until', { date: formatDate(e.endsAt) })));
    body.push(h('p', { class: 'muted' }, t('account.supporter.same')));
  } else {
    body.push(h('p', null, t(e.status === 'expired' ? 'account.supporter.expired' : 'account.supporter.free', { price })));
    body.push(h('p', { class: 'muted' }, t('account.supporter.same')));
  }
  if (inv) {
    body.push(h('div', { class: 'pending-invoice__body' },
      h('div', null,
        h('p', null, t('account.supporter.invoice', { amount: formatMoney(inv.amount), months: inv.months })),
        h('p', { class: 'muted' }, t('notices.payHint')),
        lic.payment?.instructions && h('p', { class: 'pending-invoice__instr' }, lic.payment.instructions),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          h('button', { type: 'button', class: 'btn', disabled: ui.busy, onclick: () => act('ui:supporterGet', { force: true }) }, t('account.checkStatus')),
          h('button', { type: 'button', class: 'btn btn--ghost btn--danger', disabled: ui.busy, onclick: () => act('ui:supporterCancel') }, t('account.supporter.cancelInvoice'))),
      ),
      safeQrUrl(lic.payment?.qr_url) && h('img', { class: 'pending-invoice__qr', src: safeQrUrl(lic.payment.qr_url), alt: t('account.qrAlt'), referrerpolicy: 'no-referrer' })));
  } else if (e.paymentsEnabled) {
    const months = [1, 3, 6, 12].filter((m) => m <= e.maxMonths);
    const sel = h('select', { class: 'input', 'aria-label': t('account.supporter.months'), onchange: (ev) => { ui2.months = Number(ev.target.value); renderView(); } },
      ...months.map((m) => h('option', { value: String(m), selected: m === ui2.months }, t('account.supporter.monthsOpt', { count: m, amount: formatMoney(e.priceMonth * m) }))));
    body.push(h('div', { class: 'field', style: { justifyContent: 'flex-start', gap: '8px', flexWrap: 'wrap' } }, sel,
      h('button', { type: 'button', class: 'btn btn--primary', disabled: ui.busy, dataset: { action: 'supporter-subscribe' }, onclick: () => act('ui:supporterCreate', { months: ui2.months }) },
        t(e.adFree ? 'account.supporter.extend' : 'account.supporter.subscribe'))));
  } else {
    body.push(h('p', { class: 'muted', dataset: { block: 'supporter-unavailable' } }, t('account.supporter.unavailable')));
  }
  if (e.adFree && !e.cancelAt) body.push(h('button', { type: 'button', class: 'btn btn--ghost btn--sm', disabled: ui.busy, onclick: () => act('ui:supporterCancel') }, t('account.supporter.cancel')));
  if (e.adFree && e.cancelAt) body.push(h('button', { type: 'button', class: 'btn btn--sm', disabled: ui.busy, onclick: () => act('ui:supporterResume') }, t('account.supporter.resume')));
  if (ui2.msg) body.push(h('p', { class: 'muted', role: 'status' }, ui2.msg));
  return h('section', { class: 'card', dataset: { card: 'supporter' } },
    h('div', { class: 'card__header' }, h('div', null, h('h2', { class: 'card__title' }, t('account.supporter.title')), h('div', { class: 'card__sub' }, t('account.supporter.sub', { price })))),
    h('div', { class: 'card__body' }, ...body));
}

function subscriptionCard(lic) {
  if (lic.freeAccess || !['active', 'grace', 'frozen'].includes(lic.status) || !lic.paidUntil) return null; // free access: no cancel / freeze / discount flows
  const pr = lic.pricing || {};
  const name = lic.plan === 'start' ? t('plan.start', { price: formatMoney(pr.start_price || 12000) }) : t('plan.multi', { price: formatMoney(pr.base_price || 20000), stores: pr.base_stores || 3, extra: formatMoney(pr.extra_store_price || 5000) });
  const disc = lic.discount?.pct > 0 ? h('p', { dataset: { block: 'discount' } }, '🎁 ', t('plan.discount', { pct: lic.discount.pct, count: lic.discount.left })) : null;
  return h('section', { class: 'card', dataset: { card: 'subscription' } },
    h('div', { class: 'card__header' }, h('div', null, h('h2', { class: 'card__title' }, t('plan.title')), h('div', { class: 'card__sub' }, name))),
    h('div', { class: 'card__body support' },
      disc,
      lic.downgradeNext ? h('p', { class: 'muted' }, t('plan.downgradeNext')) : null,
      lic.cancelAt
        ? h('div', null, h('p', null, t('plan.cancelled', { date: formatDate(lic.paidUntil) })), h('button', { type: 'button', class: 'btn btn--primary', dataset: { action: 'resume', uxKey: 'act_resume' }, onclick: resumeSubscription }, t('plan.resume')))
        : lic.status !== 'frozen' && h('div', null, h('button', { type: 'button', class: 'btn btn--ghost btn--sm', dataset: { action: 'cancel-subscription', uxKey: 'act_cancel-subscription' }, onclick: () => openCancelFlow({ lic, toast, errorText, onLicense: (l) => { if (l) state.data.license = l; renderAll(); } }) }, t('plan.cancelBtn')))));
}

/** Opens the «connect a store» form (set by bindConnectDialog). */
let openConnectDialog = () => {};

/** «+ Добавить магазин»: on «Старт» at the limit → the upsell window first, never a dead end. */
function addStore() {
  const lic = state.data?.license;
  const used = enabledStores().length;
  if (!needsUpsell(lic, used)) return openConnectDialog();
  openUpsell({
    lic,
    used,
    toast,
    errorText,
    onConnect: () => openConnectDialog(),
    onLicense: (l) => {
      if (l) state.data.license = l;
      renderAll();
    },
    onPay: async (total) => {
      const res = await send('ui:billingAddon', { total });
      if (res?.ok === false) return toast(errorText(res.error), 'error');
      if (res?.license) state.data.license = res.license;
      openPay(false);
    },
  });
}

/** Simple "connect a store": name + API token → then the payment window right away. */
function bindConnectDialog() {
  const dlg = $('connectDialog');
  $('connectStoreBtn').addEventListener('click', () => addStore());
  openConnectDialog = () => {
    const pr = state.data?.license?.pricing;
    $('connectPrice').textContent = pr && state.data.license.status !== 'unconfigured' ? t('connect.price', { extra: formatMoney(pr.extra_store_price), base: pr.base_stores }) : '';
    $('connectError').hidden = true;
    $('connectName').value = '';
    $('connectToken').value = '';
    $('connectOwner').replaceChildren(ownerInstructions(copyText, toast));
    applyI18n(dlg);
    dlg.showModal();
    $('connectName').focus();
  };
  $('connectCancel').addEventListener('click', () => dlg.close());
  // where the Kaspi API token is: screenshots of the seller cabinet, step by step (help/token.gif)
  $('connectTokenHelp').addEventListener('click', () => openGif('token'));
  $('connectForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('connectSubmit');
    btn.disabled = true;
    btn.textContent = t('connect.checking');
    const res = await send('ui:connectApi', { shopId: null, name: $('connectName').value, token: $('connectToken').value });
    btn.disabled = false;
    btn.textContent = t('connect.submit');
    if (!res?.ok) {
      $('connectError').textContent = errorText(res?.error);
      $('connectError').hidden = false;
      return;
    }
    $('connectToken').value = '';
    dlg.close('ok');
    toast(t('connect.done'), 'ok');
    await loadState();
    const lic = state.data.license;
    if (lic && lic.status !== 'unconfigured' && dataStores().length < enabledStores().length) await payForStores();
  });
}

/** Full-page notice shown instead of a section when there is no usable subscription. */
function paywall() {
  const lic = state.data.license || {};
  if (lic.needsConsent) return h('section', { class: 'card' }, emptyState(t('terms.title'), t('terms.text'), h('button', { type: 'button', class: 'btn btn--primary', onclick: openTerms }, t('terms.open'))));
  const text = { loggedOut: 'account.paywallLoggedOut', offline: 'account.paywallOffline', invalid: 'account.paywallInvalid', clock: 'account.paywallClock', frozen: 'plan.paywallFrozen' }[lic.status] || (lic.trialBlocked ? 'account.trialUsed' : 'account.paywallExpired');
  return h('div', { class: 'settings' }, h('section', { class: 'card' }, emptyState(t('account.paywallTitle'), t(text), h('a', { class: 'btn btn--primary', href: '#account' }, t('account.paywallButton')))), exitEl());
}

function viewAccount() {
  const lic = state.data.license || { status: 'unconfigured' };
  const ui = (state.acct ??= { email: '', step: 'email', busy: false, error: null, stores: null, months: 1, phone: null, consent: false });
  const card = (title, sub, ...body) => h('section', { class: 'card' }, h('div', { class: 'card__header' }, h('div', null, h('h2', { class: 'card__title' }, title), sub && h('div', { class: 'card__sub' }, sub))), h('div', { class: 'card__body' }, ...body));
  const errBox = () => ui.error && h('div', { class: 'banner', role: 'alert' }, icon('warn'), h('span', { class: 'banner__text' }, errorText(ui.error)));
  const run = async (fn) => {
    ui.busy = true;
    ui.error = null;
    renderView();
    try {
      const res = await fn();
      if (res?.ok === false) ui.error = res.error || 'noResponse';
      return res;
    } finally {
      ui.busy = false;
      renderView();
    }
  };

  if (lic.status === 'unconfigured') return h('div', { class: 'settings' }, card(t('account.status.unconfigured'), null, h('p', { class: 'muted' }, t('account.unconfiguredText'))));

  // ---- login (email → code) ----
  if (lic.status === 'loggedOut') {
    const emailInput = h('input', { class: 'input', type: 'email', autocomplete: 'email', placeholder: 'name@example.kz', 'aria-label': t('account.email'), value: ui.email, dataset: { fkey: 'acct-email' }, oninput: (e) => (ui.email = e.target.value), disabled: ui.step === 'code' });
    const codeInput = h('input', { class: 'input', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456', 'aria-label': t('account.code'), dataset: { fkey: 'acct-code' }, style: { width: '140px' } });
    const body =
      ui.step === 'email'
        ? h(
            'form',
            {
              class: 'field',
              style: { justifyContent: 'flex-start', gap: '8px', flexWrap: 'wrap' },
              onsubmit: async (e) => {
                e.preventDefault();
                if (!ui.consent) return;
                const res = await run(async () => {
                  let captchaToken = null;
                  try { captchaToken = await getCaptchaToken({ t, lang: getLang() }); } catch { return { ok: true, cancelled: true }; }
                  return send('ui:billingRequestCode', { email: ui.email, captchaToken });
                });
                if (res?.cancelled) return;
                if (res?.ok) ui.step = 'code';
                renderView();
              },
            },
            emailInput,
            h('button', { type: 'submit', class: 'btn btn--primary', disabled: ui.busy || !ui.consent }, t(ui.busy ? 'account.sending' : 'account.sendCode')),
            consentLabel(ui.consent, (v) => ((ui.consent = v), renderView())),
          )
        : h(
            'form',
            {
              onsubmit: async (e) => {
                e.preventDefault();
                const res = await run(() => send('ui:billingVerify', { email: ui.email, code: codeInput.value, consent: ui.consent }));
                if (res?.ok) {
                  state.acct = null;
                  await loadState();
                }
              },
            },
            h('p', { class: 'muted' }, t('account.codeSent', { email: ui.email })),
            h(
              'div',
              { class: 'field', style: { justifyContent: 'flex-start', gap: '8px' } },
              codeInput,
              h('button', { type: 'submit', class: 'btn btn--primary', disabled: ui.busy }, t(ui.busy ? 'account.verifying' : 'account.verify')),
              h('button', { type: 'button', class: 'btn btn--ghost', onclick: () => ((ui.step = 'email'), (ui.error = null), renderView()) }, t('account.changeEmail')),
            ),
          );
    return h('div', { class: 'settings' }, card(t('account.loginTitle'), t('account.loginText'), body, errBox()));
  }

  // ---- logged in ----
  const until = lic.status === 'active' ? lic.paidUntil : lic.trialEndsAt;
  const days = until ? Math.max(0, Math.ceil((new Date(until).getTime() - Date.now()) / 86400000)) : 0;
  const statusBadge = h(
    'span',
    { class: ['badge', lic.freeAccess || lic.status === 'active' ? 'badge--ok' : lic.status === 'trial' ? 'badge--info' : 'badge--danger'] },
    lic.freeAccess ? t('account.freeAccess') : t(`account.status.${lic.status}`, { date: until ? formatDate(until) : '' }),
  );
  const used = enabledStores().length;
  const statusCard = card(
    t('account.title'),
    lic.email ? t('account.loggedInAs', { email: lic.email }) : null,
    h('div', { class: 'field' }, h('div', null, statusBadge, ' ', !lic.freeAccess && (lic.status === 'trial' || lic.status === 'active') && h('span', { class: 'muted' }, t('account.daysLeft', { count: days }))), h('button', { type: 'button', class: 'btn btn--ghost', onclick: () => run(async () => (await send('ui:billingLogout'), await loadState())) }, t('account.logout'))),
    lic.storeLimit != null && h('div', { class: ['muted', used > lic.storeLimit && 'neg'] }, t('account.storeUsage', { used, limit: lic.storeLimit })),
  );

  const pr = lic.pricing || { base_price: 20000, base_stores: 3, extra_store_price: 5000, max_months: 12, max_stores: 50 };
  ui.stores ??= Math.max(pr.base_stores, used, lic.status === 'active' ? lic.storeLimit || 0 : 0);
  ui.phone ??= fmtPhone(lic.phone);
  const stores = Math.max(pr.base_stores, Math.min(pr.max_stores || 50, Number(ui.stores) || pr.base_stores));
  const months = Math.max(1, Math.min(pr.max_months || 12, Number(ui.months) || 1));
  const extraCount = Math.max(0, stores - pr.base_stores);
  const monthly = priceOf(pr, stores, 1);

  const planCard = card(
    t('account.planTitle'),
    t('account.planText', { base: formatMoney(pr.base_price), baseStores: pr.base_stores, extra: formatMoney(pr.extra_store_price) }),
    h(
      'div',
      { class: 'field', style: { justifyContent: 'flex-start', gap: '16px', flexWrap: 'wrap' } },
      h('label', { class: 'check' }, t('account.storesLabel'), h('input', { class: 'input', type: 'number', min: pr.base_stores, max: pr.max_stores || 50, value: stores, style: { width: '80px' }, dataset: { fkey: 'acct-stores' }, onchange: (e) => ((ui.stores = e.target.value), renderView()) })),
      h(
        'label',
        { class: 'check' },
        t('account.monthsLabel'),
        h('select', { class: 'select', dataset: { fkey: 'acct-months' }, onchange: (e) => ((ui.months = e.target.value), renderView()) }, Array.from({ length: pr.max_months || 12 }, (_, i) => h('option', { value: i + 1, selected: i + 1 === months }, String(i + 1)))),
      ),
      h('label', { class: 'check' }, t('account.phoneLabel'), h('input', { class: 'input', type: 'tel', autocomplete: 'tel', placeholder: t('account.phonePlaceholder'), value: ui.phone, style: { width: '190px' }, dataset: { fkey: 'acct-phone' }, oninput: (e) => (ui.phone = e.target.value) })),
    ),
    // a confirmed phone (Telegram «Поделиться номером», 031_phone_verified.sql) lets a payment confirm itself
    h('div', { class: 'muted', dataset: { fkey: 'acct-phone-verified' } }, lic.phoneVerified ? t('account.phoneVerified') : t('account.phoneVerifyHint')),
    h('div', { class: 'muted' }, extraCount ? t('account.priceLine', { base: formatMoney(pr.base_price), baseStores: pr.base_stores, extraCount, extra: formatMoney(pr.extra_store_price) }) : t('account.priceLineBase', { base: formatMoney(pr.base_price), baseStores: pr.base_stores }), ` = ${t('account.perMonth', { amount: formatMoney(monthly) })}`),
    h(
      'div',
      { class: 'field' },
      h('strong', { style: { fontSize: '18px' } }, t('account.total', { amount: formatMoney(monthly * months) })),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn--primary',
          disabled: ui.busy,
          onclick: () => run(async () => {
            const res = await send('ui:billingCreateInvoice', { stores, months, phone: ui.phone });
            if (res?.ok) await loadState();
            return res;
          }),
        },
        t(ui.busy ? 'account.creating' : 'account.createInvoice'),
      ),
    ),
    errBox(),
  );

  const inv = lic.pendingInvoice && lic.pendingInvoice.kind !== 'supporter' ? lic.pendingInvoice : null;
  const pendingCard =
    inv &&
    h(
      'section',
      { class: 'card pending-invoice' },
      h('div', { class: 'card__header' }, h('h2', { class: 'card__title' }, t('account.pendingTitle', { id: inv.id, amount: formatMoney(inv.amount) }))),
      h(
        'div',
        { class: 'card__body pending-invoice__body' },
        h(
          'div',
          null,
          invoiceNumber(inv.id),
          h('p', null, t('account.pendingText', { phone: fmtPhone(inv.phone) })),
          h('p', { class: 'muted', dataset: { block: 'pay-hint' } }, t('notices.payHint')),
          lic.payment?.instructions && h('p', { class: 'pending-invoice__instr' }, lic.payment.instructions),
          h('p', { class: 'muted' }, t('account.pendingDetails', { stores: inv.stores, months: inv.months, date: formatDate(inv.created_at, 'datetime') })),
          h(
            'div',
            { style: { display: 'flex', gap: '8px' } },
            h('button', { type: 'button', class: 'btn btn--primary', onclick: () => openPay(false) }, t('pay.openQr')),
            h('button', { type: 'button', class: 'btn', disabled: ui.busy, onclick: () => run(async () => ((state.data.license = await send('ui:billingState', { force: true })), await loadState())) }, t('account.checkStatus')),
            h('button', { type: 'button', class: 'btn btn--ghost btn--danger', disabled: ui.busy, onclick: () => run(async () => { const r = await send('ui:billingCancelInvoice', { id: inv.id }); await loadState(); return r; }) }, t('account.cancelInvoice')),
          ),
        ),
        safeQrUrl(lic.payment?.qr_url) && h('img', { class: 'pending-invoice__qr', src: safeQrUrl(lic.payment.qr_url), alt: t('account.qrAlt'), referrerpolicy: 'no-referrer' }),
      ),
    );

  const history = (lic.invoices || []).filter((i) => i.status !== 'pending');
  const historyCard = card(
    t('account.historyTitle'),
    null,
    history.length
      ? h(
          'table',
          { class: 'data' },
          h('tbody', null, history.map((i) =>
            h(
              'tr',
              null,
              h('td', { class: 'mono' }, `№ ${i.id}`),
              h('td', null, formatDate(i.created_at)),
              h('td', null, `${i.stores} · ${i.months}`),
              h('td', { class: 'num' }, formatMoney(i.amount)),
              h('td', null, h('span', { class: ['badge', i.status === 'paid' ? 'badge--ok' : ''] }, t(`account.invoiceStatus.${i.status}`))),
              h('td', { class: 'muted' }, i.status === 'paid' && i.period_to ? t('account.paidPeriod', { from: formatDate(i.period_from), to: formatDate(i.period_to) }) : ''),
            ),
          )),
        )
      : h('p', { class: 'muted' }, t('account.noInvoices')),
  );

  // ---- referral: invite a friend (+14 days for you, +7 days trial for them) ----
  if (state.refInfo === undefined && !state.refLoading) {
    state.refLoading = true;
    send('ui:billingReferral').then((r) => {
      state.refInfo = r?.ok ? r.referral : null;
      state.refPending = r?.pending || '';
    }).catch(() => { state.refInfo = null; }).finally(() => { state.refLoading = false; if (state.route === 'account') renderView(); });
  }
  const ref = state.refInfo;
  const refLink = ref ? `https://saudapulse.kz/?ref=${ref.code}` : '';
  const refState = (state.refUi ??= { msg: '', ok: false, copied: false, code: null });
  const refApply = async (code) => {
    const res = await send('ui:billingApplyReferral', { code });
    if (res?.ok) {
      refState.ok = true; refState.msg = t('account.referral.applied', { days: res.result?.bonus_days || 7 });
      state.refInfo = { ...state.refInfo, applied: true, can_apply: false }; state.refPending = '';
    } else {
      const k = `account.referral.err.${res?.error}`;
      refState.ok = false; refState.msg = hasKey(k) ? t(k) : errorText(res?.error);
    }
    renderView();
  };
  const refCodeInput = h('input', { class: 'input', placeholder: 'SP-XXXXXX', 'aria-label': t('account.referral.codeLabel'), maxlength: '12', value: refState.code ?? state.refPending ?? '', dataset: { fkey: 'ref-code' }, style: { width: '160px' }, oninput: (e) => (refState.code = e.target.value) });
  const referralCard = ref && h(
    'section',
    { class: 'card' },
    h('div', { class: 'card__header' }, h('div', null, h('h2', { class: 'card__title' }, t('account.referral.title')), h('div', { class: 'card__sub' }, t('account.referral.sub')))),
    h(
      'div',
      { class: 'card__body' },
      h(
        'div',
        { class: 'field', style: { justifyContent: 'flex-start', gap: '8px', flexWrap: 'wrap' } },
        h('input', { class: 'input', readonly: true, value: refLink, 'aria-label': t('account.referral.linkLabel'), style: { flex: '1 1 260px', minWidth: '0' }, onfocus: (e) => e.target.select() }),
        h('button', {
          type: 'button',
          class: 'btn btn--sm',
          onclick: async () => {
            try { await navigator.clipboard.writeText(refLink); refState.copied = true; } catch { refState.copied = false; }
            refState.msg = refState.copied ? '' : refState.msg;
            renderView();
            if (refState.copied) send('ui:trackFunnel', { event: 'referral_shared' }).catch(() => {});
            if (refState.copied) setTimeout(() => { refState.copied = false; renderView(); }, 2000);
          },
        }, refState.copied ? t('account.referral.copied') : t('account.referral.copy')),
      ),
      h('p', { class: 'muted' }, t('account.referral.stats', { count: ref.count || 0, days: ref.bonus_days || 0 })),
      ref.can_apply &&
        h(
          'form',
          {
            class: 'field',
            style: { justifyContent: 'flex-start', gap: '8px', flexWrap: 'wrap' },
            onsubmit: async (e) => { e.preventDefault(); if (!ui.busy) await refApply(refCodeInput.value); },
          },
          h('span', { class: 'muted' }, t('account.referral.haveCode')),
          refCodeInput,
          h('button', { type: 'submit', class: 'btn btn--sm btn--primary', disabled: ui.busy }, t('account.referral.apply')),
        ),
      refState.msg && h('p', { class: refState.ok ? 'badge badge--ok' : 'muted', role: 'status' }, refState.msg),
    ),
  );

  // With an open invoice the plan form stays below it: choosing another plan replaces the invoice.
  return h('div', { class: 'settings' }, statusCard, subscriptionCard(lic), supporterCard(lic), exitEl(), pendingCard, referralCard, lic.freeAccess ? null : planCard, historyCard);
}

/* ===================================================================== */
/* View: home — what to do now + today's numbers (opened first)           */
/* ===================================================================== */

/** Orders of every store covered by the subscription, without the date filter. */
function allOrders() {
  // dates are ISO strings in snapshots; `ts` = milliseconds for comparisons
  return dataStores().flatMap((s) => (state.data.snapshots[s.id]?.sections?.orders?.items || []).map((it) => ({ ...it, shopId: s.id, ts: it.date ? new Date(it.date).getTime() : 0 })));
}

/* ---------- interactive dashboard: drill-down, count-up, sparklines ---------- */

/**
 * Open the orders list already filtered: by a day, the last N days, a store.
 * Every number on Home and every point / bar of a chart leads to its orders.
 */
function drillTo({ day = null, days = null, shopId = null, tab = 'all' } = {}) {
  const f = state.filters;
  if (day) Object.assign(f, { preset: 'custom', from: dayKey(day), to: dayKey(day) });
  else if (days) Object.assign(f, ['7', '30', '90'].includes(String(days)) ? { preset: String(days), from: '', to: '' } : { preset: 'custom', from: dayKey(Date.now() - (days - 1) * 86400000), to: dayKey(Date.now()) });
  if (shopId) f.shopId = shopId;
  Object.assign(state.tables.orders, { tab, q: '', page: 0 });
  if (state.route === 'orders') renderAll();
  else location.hash = 'orders';
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Numbers «count up» when Home is first opened. The page re-renders right after opening
 * (the first refresh), so the animation runs on one clock: a re-render inside the
 * window continues it instead of restarting or cutting it off.
 */
const COUNT_MS = 700;
function animateCounts(root, t0) {
  if (reducedMotion() || performance.now() - t0 >= COUNT_MS) return;
  root.querySelectorAll('[data-count-to]').forEach((el) => {
    const to = Number(el.dataset.countTo);
    const fmt = el.dataset.countFmt === 'money' ? formatMoney : (v) => formatNumber(v);
    if (!(to > 0)) return;
    const dur = COUNT_MS;
    const step = (now) => {
      const k = Math.min(1, Math.max(0, (now - t0) / dur));
      el.textContent = fmt(Math.round(to * (1 - (1 - k) ** 3)));
      if (k < 1 && el.isConnected) requestAnimationFrame(step);
    };
    step(performance.now()); // first frame now: no flash of the final number
    requestAnimationFrame(step);
  });
}

/** Tiny trend line of daily values (no axes): the shape of the week / month at a glance. */
function sparkline(values, label) {
  const W = 120;
  const H = 30;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${((i / Math.max(1, values.length - 1)) * W).toFixed(1)},${(H - 2 - (v / max) * (H - 4)).toFixed(1)}`);
  return s('svg', { class: 'spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': label },
    s('path', { d: `M0,${H} L${pts.join(' L')} L${W},${H} Z`, class: 'spark__area' }),
    s('path', { d: `M${pts.join(' L')}`, class: 'spark__line' }));
}

/** Banner of an API store: open Settings with that store preselected in the API card and focus the token field. */
function reconnectApi(shopId) {
  const ui = (state.apiForm ??= { shopId: '', name: '', busy: false, error: null });
  Object.assign(ui, { shopId, error: null });
  location.hash = 'settings';
  setTimeout(() => {
    const el = document.querySelector('[data-api-token]');
    el?.closest('.card')?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    el?.focus();
  }, 150);
}

/** Settings card (found by a selector inside it): open Settings, scroll to it, highlight it. */
function goToCard(selector) {
  location.hash = 'settings';
  setTimeout(() => {
    const el = document.querySelector(selector)?.closest('.card');
    el?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    el?.classList.add('is-highlight');
    setTimeout(() => el?.classList.remove('is-highlight'), 2000);
  }, 300);
}

function onboardCtx() {
  return {
    stores: enabledStores().length,
    loaded: dataStores().some((s) => state.data.snapshots[s.id]?.sections?.orders),
    costs: Object.keys(state.costs || {}).length,
    flags: state.onboard || {},
    go: {
      store: () => $('connectStoreBtn').click(),
      orders: () => sync(),
      print: () => goToCard('[data-card=print]'),
      costs: () => (location.hash = 'products'),
      backup: () => goToCard('[data-action=backup-save]'),
    },
    onHide: async () => {
      await markStep('hidden');
      state.onboard = await getOnboarding();
      renderView();
    },
  };
}

const feedbackUi = { nps: { score: null, comment: '', done: false }, exit: { reason: null, comment: '', done: false } };
function npsCtx() {
  return {
    ui: feedbackUi.nps,
    toast,
    errorText,
    rerender: () => renderView(),
    onDone: (later) => {
      state.feedbackDue = null;
      if (later) feedbackUi.nps.done = false;
      renderView();
    },
  };
}
/** «Почему не продлеваете?» — on the paywall and the subscription page once it has ended. */
const exitEl = () => (state.feedbackDue === 'exit' || feedbackUi.exit.done ? exitCard({ ui: feedbackUi.exit, toast, errorText, rerender: () => renderView() }) : null);
/** Control panel: which section was opened (numbers only, background/usage.js). */
function noteSection() {
  if (staffMode()) return;
  send('ui:usage', { section: state.route }).catch(() => {});
  // anonymous UX counters (shared/ux-telemetry.js): section view; Settings left after >15 s without a change = abandoned
  if (!ux) return;
  if (uxLast === 'settings') ux.formClosed('settings', uxSaved);
  uxSaved = false; uxLast = state.route;
  ux.screenView(state.route);
  if (state.route === 'settings') ux.formOpened('settings');
}
let ux = null, uxLast = null, uxSaved = false;

function viewHome() {
  const orders = allOrders();
  const sn = settingsNow();
  const lic = state.data.license || {};
  const urgent = orders.filter((o) => ['soon', 'overdue'].includes(urgencyOf(deadlineOf(o, sn), sn)));
  const fresh = orders.filter((o) => o.status === 'new');
  const unpaid = orders.filter((o) => o.paymentStatus === 'pending');
  const unread = enabledStores().reduce((n, s) => n + sumBy(state.chat[s.id]?.conversations || [], (c) => c.unread), 0);
  const tokens = state.data.apiStores || [];
  const noCost = productRows().filter((p) => state.costs[p.key] == null).length;
  const goOrders = (tab) => () => {
    state.tables.orders.tab = tab;
    location.hash = 'orders';
  };

  // 1. what to do now (only what needs a click)
  const todo = [
    urgent.length && { tone: 'danger', icon: 'fire', text: t('home.todo.urgent', { count: urgent.length }), action: t('home.open'), go: goOrders('urgent') },
    fresh.length && { tone: 'info', icon: 'sparkle', text: t('home.todo.new', { count: fresh.length }), action: t('home.open'), go: goOrders('new') },
    unread && { tone: 'info', icon: 'chat', text: t('home.todo.chat', { count: unread }), action: t('home.open'), go: () => (location.hash = 'chat') },
    unreadAnswers(state.tickets) && { tone: 'info', icon: 'chat', text: t('home.todo.support', { count: unreadAnswers(state.tickets) }), action: t('home.open'), go: () => (location.hash = 'help') },
    state.packProblems?.length && { tone: 'danger', icon: 'warn', text: t('home.todo.packProblems', { count: state.packProblems.length }), action: t('home.open'), go: () => ((location.hash = 'settings'), setTimeout(() => document.querySelector('[data-card=journal]')?.scrollIntoView({ block: 'start' }), 300)) },
    lic.pendingInvoice && !lic.freeAccess && { tone: 'warn', icon: 'card', text: t('home.todo.invoice', { amount: formatMoney(lic.pendingInvoice.amount) }), action: t('home.pay'), go: () => (location.hash = 'pay') },
    lic.status === 'trial' && !lic.freeAccess && lic.daysLeft != null && lic.daysLeft <= 5 && !lic.pendingInvoice && { tone: 'warn', icon: 'hourglass', text: t('home.todo.trial', { count: lic.daysLeft }), action: t('home.open'), go: () => (location.hash = 'account') },
    unpaid.length && { tone: 'muted', icon: 'wallet', text: t('home.todo.unpaid', { count: unpaid.length }), action: t('home.open'), go: () => ((state.paymentGroup = 'pending'), (location.hash = 'payments')) },
  ].filter(Boolean);
  const todoCard = h(
    'section',
    { class: 'card home-todo' },
    h('div', { class: 'card__header' }, h('h2', { class: 'card__title' }, t('home.todoTitle'))),
    todo.length
      ? h('ul', { class: 'todo' }, todo.map((x) => h('li', { class: ['todo__item', `todo__item--${x.tone}`] }, h('span', { class: 'todo__icon', 'aria-hidden': 'true' }, svgIcon(x.icon)), h('span', { class: 'todo__text' }, x.text), h('button', { type: 'button', class: 'btn btn--sm', onclick: x.go }, x.action))))
      : h('p', { class: 'home-ok' }, '✅ ', t('home.allDone')),
  );

  // 2. numbers: today / yesterday / 7 / 30 days
  const day0 = startOfDay(new Date());
  const period = (fromDays, toDays) => {
    const from = day0.getTime() - fromDays * 86400000;
    const to = toDays === 0 ? Date.now() : day0.getTime() - (toDays - 1) * 86400000 - 1;
    const list = orders.filter((o) => o.ts >= from && o.ts <= to && !REVENUE_EXCLUDED.has(o.status));
    return { revenue: sumBy(list, (o) => o.amount || 0), count: list.length };
  };
  const tiles = [
    ['home.today', period(0, 0)],
    ['home.yesterday', period(1, 1)],
    ['home.week', period(6, 0)],
    ['home.month', period(29, 0)],
  ];
  // daily revenue for the sparklines of «7 дней» / «30 дней»
  const daily = (n) => Array.from({ length: n }, (_, i) => {
    const from = day0.getTime() - (n - 1 - i) * 86400000;
    return sumBy(orders.filter((o) => o.ts >= from && o.ts < from + 86400000 && !REVENUE_EXCLUDED.has(o.status)), (o) => o.amount || 0);
  });
  const drill = {
    'home.today': { day: Date.now() },
    'home.yesterday': { day: Date.now() - 86400000 },
    'home.week': { days: 7 },
    'home.month': { days: 30 },
  };
  const tilesEl = h('div', { class: 'tiles' }, tiles.map(([k, v]) =>
    h('button', { type: 'button', class: 'tile tile--link', dataset: { tile: k.split('.')[1] }, title: t('home.showOrders'), onclick: () => drillTo(drill[k]) },
      h('div', { class: 'tile__label' }, t(k)),
      h('div', { class: 'tile__value', dataset: { countTo: Math.round(v.revenue), countFmt: 'money' } }, formatMoney(v.revenue)),
      h('div', { class: 'tile__sub' }, t('home.orders', { count: v.count })),
      k === 'home.week' || k === 'home.month' ? sparkline(daily(k === 'home.week' ? 7 : 30), t(k)) : null,
    )));

  // 3. stores at a glance
  const storesEl = dataStores().length
    ? h(
        'section',
        { class: 'card' },
        h('div', { class: 'card__header' }, h('h2', { class: 'card__title' }, t('home.storesTitle'))),
        h(
          'div',
          { class: 'home-stores' },
          dataStores().map((s) => {
            const mine = orders.filter((o) => o.shopId === s.id);
            const today = mine.filter((o) => o.ts >= day0.getTime() && !REVENUE_EXCLUDED.has(o.status));
            const snap = state.data.snapshots[s.id];
            const ok = snap?.status === 'ok';
            return h(
              'button',
              { type: 'button', class: 'home-store home-store--link', title: t('home.showOrders'), dataset: { store: s.id }, onclick: () => drillTo({ shopId: s.id, days: 30 }) },
              h('div', { class: 'home-store__head' }, storeChip(s.id), h('span', { class: ['badge', ok ? 'badge--ok' : 'badge--warn'] }, t(`store.${ok ? 'online' : snap?.status || 'noTab'}`))),
              h('div', { class: 'home-store__nums' },
                h('div', null, h('b', null, formatMoney(sumBy(today, (o) => o.amount || 0))), h('span', null, t('home.today'))),
                h('div', null, h('b', null, formatNumber(mine.filter((o) => o.status === 'new').length)), h('span', null, t('home.newShort'))),
              ),
            );
          }),
        ),
      )
    : null;

  // Orders came by token; assortment and stock come only from the store's price list (Kaspi's API has no product list)
  const noPriceList = enabledStores().filter((s) => s.api?.connected && state.stockState && !state.stockState.imported?.[s.id]);
  const priceListEl = noPriceList.length
    ? h('section', { class: 'card home-pricelist', dataset: { card: 'pricelist' } },
        h('div', { class: 'card__header' }, h('div', null,
          h('h2', { class: 'card__title' }, t('home.priceList.title')),
          h('div', { class: 'card__sub' }, t('home.priceList.text', { stores: noPriceList.map((s) => s.alias || s.name).join(', ') })))),
        h('div', { class: 'card__body' },
          h('ol', { class: 'small', style: { margin: '0 0 12px', paddingLeft: '20px', display: 'grid', gap: '4px' } },
            h('li', null, t('home.priceList.step1')),
            h('li', null, t('home.priceList.step2')),
            h('li', null, t('home.priceList.step3'))),
          h('p', { class: 'muted small', style: { margin: '0 0 12px' } }, t('home.priceList.photos')),
          h('button', { type: 'button', class: 'btn btn--primary', dataset: { action: 'pricelist-import' }, onclick: () => (location.hash = 'catalog') }, t('home.priceList.action'))))
    : null;

  // NPS (when the server says it is time) — a card, never a blocking window
  const npsEl = state.feedbackDue === 'nps' || feedbackUi.nps.done ? npsCard(npsCtx()) : null;

  // 4. «Первые шаги»: until everything that makes the extension useful is done (dashboard/onboarding.js)
  const stepsEl = onboardingCard(onboardCtx());

  // new seller: first steps on top; working seller: today's tasks and numbers first
  return enabledStores().length ? h('div', { class: 'home' }, priceListEl, todoCard, npsEl, stepsEl, tilesEl, storesEl) : h('div', { class: 'home' }, stepsEl);
}

// "Выгрузка товаров": catalog, put products on sale in all / chosen stores, price lists.
const catalogView = createCatalogView({ toast, errorText, emptyState, storeChip, storeName, dataStores, renderView: () => renderView(), confirmDialog, thumb, photoOf, salesOf: () => productRows() });

/* =====================================================================
 * Learning inside the interface
 *  - guideCard(): «Как это работает» — 3–4 steps for the current section; shown by itself
 *    on the first visit, again with the «?» button in the top bar;
 *  - startTour(): first-launch tour that points at the main controls;
 *  - the Help page lists every guide.
 * ===================================================================== */
const GUIDE_ROUTES = ['home', 'orders', 'returns', 'refusals', 'payments', 'analytics', 'products', 'catalog', 'chat', 'settings', 'account'].filter((r) => r !== 'chat' || FEATURES.cabinet);
// Short screen recordings (help/*.gif, made on demo data by the project's recorder).
const GUIDE_GIFS = { home: 'connect', orders: 'orders', products: 'products', catalog: 'catalog', settings: 'settings', token: 'token' };
const gifUrl = (route) => (GUIDE_GIFS[route] ? chrome.runtime.getURL(`help/${GUIDE_GIFS[route]}.gif`) : null);

/** The recording in a window; the GIF is loaded only when asked for. */
function openGif(route) {
  ux?.help(`gif_${route}`);
  let dlg = $('gifDialog');
  if (!dlg) {
    dlg = h('dialog', { id: 'gifDialog', class: 'dialog dialog--gif', 'aria-labelledby': 'gifTitle' });
    dlg.addEventListener('click', (e) => e.target === dlg && dlg.close());
    document.body.append(dlg);
  }
  clear(dlg).append(
    h('div', { class: 'gif' },
      h('div', { class: 'gif__head' }, h('h2', { class: 'dialog__title', id: 'gifTitle' }, t(`guide.gif.${GUIDE_GIFS[route]}`)), h('button', { type: 'button', class: 'btn btn--sm', onclick: () => dlg.close() }, t('common.close'))),
      h('img', { class: 'gif__img', src: gifUrl(route), alt: t(`guide.gif.${GUIDE_GIFS[route]}`), width: 840, height: 525 }),
      h('ol', { class: 'guide__steps' }, guideSteps(route).map((x) => h('li', null, x))),
    ),
  );
  dlg.showModal();
}

const guideSteps = (route) => [1, 2, 3, 4, 5].map((n) => `guide.${route}.s${n}`).filter(hasKey).map((k) => t(k));

function guideCard(route, { dismissible = true } = {}) {
  return h(
    'section',
    { class: 'card guide', dataset: { guide: route } },
    h('div', { class: 'guide__head' }, h('span', { class: 'guide__badge' }, t('guide.badge')), h('h2', { class: 'card__title' }, t(`guide.${route}.title`))),
    h('ol', { class: 'guide__steps' }, guideSteps(route).map((x) => h('li', null, x))),
    dismissible &&
      h('div', { class: 'guide__actions' },
        h('button', { type: 'button', class: 'btn btn--sm btn--primary', onclick: () => (memo.set(`ksh.guide.${route}`, '1'), (state.guideOpen = false), renderView()) }, t('guide.gotIt')),
        gifUrl(route) && h('button', { type: 'button', class: 'btn btn--sm', dataset: { action: 'gif', uxKey: 'act_gif' }, onclick: () => openGif(route) }, '▶ ', t('guide.watch')),
        h('a', { class: 'btn btn--sm btn--ghost', href: '#help' }, t('guide.all')),
      ),
  );
}
const guideVisible = (route) => GUIDE_ROUTES.includes(route) && (state.guideOpen || !memo.get(`ksh.guide.${route}`));

const TOUR = [
  { sel: '#connectStoreBtn', key: 'connect' },
  { sel: 'a[data-route=home]', key: 'home' },
  { sel: 'a[data-route=orders]', key: 'orders' },
  { sel: 'a[data-route=catalog]', key: 'catalog' },
  { sel: '#guideBtn', key: 'guide', main: true },
  { sel: 'a[data-route=help]', key: 'help' },
];
const tour = { i: -1, el: null };

function endTour() {
  document.querySelector('.tour-target')?.classList.remove('tour-target');
  tour.el?.remove();
  tour.el = null;
  tour.i = -1;
  memo.set('ksh.tourDone', '1');
  setMenu(false);
}

function showTourStep(i) {
  const step = TOUR.at(i);
  if (!step) return endTour();
  tour.i = i;
  document.querySelector('.tour-target')?.classList.remove('tour-target');
  const narrow = window.matchMedia('(max-width: 760px)').matches;
  setMenu(narrow && !step.main); // on a phone the menu items live in the slide-in menu
  const target = document.querySelector(step.sel);
  target?.classList.add('tour-target');
  target?.scrollIntoView({ block: 'nearest' });
  tour.el?.remove();
  tour.el = h(
    'div',
    { class: 'tour', role: 'dialog', 'aria-label': t('tour.title') },
    h('div', { class: 'tour__count' }, t('tour.step', { n: i + 1, total: TOUR.length })),
    h('h3', { class: 'tour__title' }, t(`tour.${step.key}.title`)),
    h('p', { class: 'tour__text' }, t(`tour.${step.key}.text`)),
    h('div', { class: 'tour__actions' },
      h('button', { type: 'button', class: 'btn btn--sm btn--ghost', dataset: { tour: 'skip' }, onclick: endTour }, t('tour.skip')),
      h('span', { class: 'grow' }),
      i > 0 && h('button', { type: 'button', class: 'btn btn--sm', onclick: () => showTourStep(i - 1) }, t('tour.back')),
      h('button', { type: 'button', class: 'btn btn--sm btn--primary', dataset: { tour: 'next' }, onclick: () => showTourStep(i + 1) }, t(i === TOUR.length - 1 ? 'tour.done' : 'tour.next')),
    ),
  );
  document.body.append(tour.el);
  // beside the target on a wide screen, at the bottom on a phone (never over the target)
  requestAnimationFrame(() => {
    if (!tour.el) return;
    const r = target?.getBoundingClientRect();
    const w = tour.el.offsetWidth, hgt = tour.el.offsetHeight;
    if (narrow || !r) {
      // phone: full-width card at the bottom — or at the top when the target itself is low on the screen
      const low = r && r.top + r.height / 2 > window.innerHeight / 2;
      return Object.assign(tour.el.style, { left: '12px', right: '12px', width: 'auto', top: low ? '12px' : 'auto', bottom: low ? 'auto' : '12px' });
    }
    const right = r.right + 16 + w <= window.innerWidth;
    const left = right ? r.right + 16 : Math.max(12, r.left - w - 16);
    const top = Math.min(Math.max(12, r.top - 8), window.innerHeight - hgt - 12);
    Object.assign(tour.el.style, { left: `${left}px`, top: `${top}px` });
    tour.el.querySelector('[data-tour=next]').focus();
  });
}

function startTour() {
  ux?.help('tour');
  if (document.querySelector('dialog[open]')) return; // consent / payment windows come first
  location.hash = 'home';
  showTourStep(0);
}

/* ---------- help: how-to answers + support contacts ---------- */
/** «Сообщить о проблеме»: copy a report (version, browser, last errors) for the support chat. */
function reportCard() {
  const status = h('div', { class: 'card__sub' }, t('help.report.text'));
  return h('section', { class: 'card', dataset: { card: 'report' } },
    h('div', { class: 'card__header' },
      h('div', null, h('h2', { class: 'card__title' }, t('help.report.title')), status),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        h('button', { type: 'button', class: 'btn btn--primary', dataset: { action: 'copy-report', uxKey: 'act_copy-report' }, onclick: async () => {
          const res = await send('ui:diagnostics');
          if (!res?.ok) return toast(errorText(res?.error), 'error');
          await copyText(res.text);
          toast(t('help.report.copied', { count: res.count }), 'ok', 6000);
        } }, t('help.report.copy')),
        h('button', { type: 'button', class: 'btn', dataset: { action: 'clear-report', uxKey: 'act_clear-report' }, onclick: async () => {
          await send('ui:clearErrors');
          toast(t('help.report.cleared'), 'ok');
        } }, t('help.report.clear')),
      ),
    ),
  );
}

const supportUi = { topic: 'other', draft: '', withReport: true, sending: false };
function supportCtx() {
  const lic = state.data?.license || {};
  return {
    signedIn: !['loggedOut', 'unconfigured'].includes(lic.status),
    tickets: state.tickets,
    csat: state.csat,
    onCsat: (id, score) => (state.csat = { ...(state.csat || {}), [id]: score }),
    ui: supportUi,
    toast,
    errorText,
    onTickets: refreshTickets,
  };
}
/** Re-read the seller's questions from the server (the help page, after sending or reading). */
async function refreshTickets() {
  const res = await send('ui:tickets').catch(() => null);
  if (res?.list) state.tickets = { at: Date.now(), list: res.list };
  renderTopbar();
  if (state.route === 'help') renderView();
}

function viewHelp() {
  const waDigits = String(SUPPORT.whatsapp || '').replace(/\D/g, '');
  const contacts = [
    waDigits && h('a', { class: 'btn btn--primary', href: `https://wa.me/${waDigits}`, target: '_blank', rel: 'noopener' }, 'WhatsApp'),
    SUPPORT.telegram && h('a', { class: 'btn', href: `https://t.me/${SUPPORT.telegram.replace(/^@/, '')}`, target: '_blank', rel: 'noopener' }, 'Telegram'),
    SUPPORT.email && h('a', { class: 'btn', href: `mailto:${SUPPORT.email}` }, SUPPORT.email),
  ].filter(Boolean);
  const faq = ['connect', 'token', 'accept', 'printer', 'profit', 'upload', 'backup', 'pay', 'telegram', 'phone'];
  return h(
    'div',
    { class: 'settings' },
    h('section', { class: 'card' },
      h('div', { class: 'card__header' }, h('div', null, h('h2', { class: 'card__title' }, t('help.contactTitle')), h('div', { class: 'card__sub' }, contacts.length ? SUPPORT.hours || t('help.contactText') : t('help.noContacts')))),
      contacts.length ? h('div', { class: 'card__body', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, contacts) : null,
    ),
    h('section', { class: 'card' },
      h('div', { class: 'card__header' }, h('div', null, h('h2', { class: 'card__title' }, t('help.guidesTitle')), h('div', { class: 'card__sub' }, t('help.guidesText'))), h('button', { type: 'button', class: 'btn btn--primary', dataset: { action: 'tour', uxKey: 'act_tour' }, onclick: startTour }, t('help.startTour'))),
      h('div', { class: 'card__body faq' }, GUIDE_ROUTES.map((r) => h('details', { class: 'faq__item', dataset: { guide: r } }, h('summary', null, t(`guide.${r}.title`)), h('ol', { class: 'guide__steps' }, guideSteps(r).map((x) => h('li', null, x))), h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, gifUrl(r) && h('button', { type: 'button', class: 'btn btn--sm btn--primary', dataset: { action: 'gif', uxKey: 'act_gif' }, onclick: () => openGif(r) }, '▶ ', t('guide.watch')), h('a', { class: 'btn btn--sm', href: `#${r}` }, t('help.openSection')))))),
    ),
    supportCard(supportCtx()),
    reportCard(),
    h('section', { class: 'card' },
      h('div', { class: 'card__header' }, h('h2', { class: 'card__title' }, t('help.faqTitle'))),
      h('div', { class: 'card__body faq' }, faq.map((k) => h('details', { class: 'faq__item' }, h('summary', null, t(`help.q.${k}`)), h('p', null, t(`help.a.${k}`))))),
    ),
    h('p', { class: 'muted small' }, h('a', { href: legalUrl('offer'), target: '_blank', rel: 'noopener' }, t('terms.offer')), ' · ', h('a', { href: legalUrl('privacy'), target: '_blank', rel: 'noopener' }, t('terms.privacy'))),
  );
}

const VIEWS = {
  help: viewHelp,
  home: viewHome,
  catalog: catalogView.view,
  orders: () => viewTable('orders'),
  returns: () => viewTable('returns'),
  refusals: () => viewTable('refusals'),
  payments: viewPayments,
  analytics: viewAnalytics,
  products: viewProducts,
  chat: viewChat,
  settings: viewSettings,
  account: viewAccount,
};

/** Re-render the content area, preserving focus on the same logical control. */
function renderView() {
  const active = document.activeElement;
  const fkey = active?.dataset?.fkey;
  const selStart = active && 'selectionStart' in active ? active.selectionStart : null;
  state.disposers.forEach((d) => d?.());
  state.disposers = [];

  const view = clear($('view'));
  if (!state.data) return;
  const lic = state.data.license;
  if (lic && !lic.canUse && state.route !== 'account') view.append(paywall());
  else {
    const needsStores = !['home', 'settings', 'account', 'catalog', 'help'].includes(state.route) && !dataStores().length;
    if (guideVisible(state.route)) view.append(guideCard(state.route));
    view.append(needsStores ? noStores() : VIEWS[state.route]());
    if (state.route === 'home') animateCounts(view, (state.countStart ??= performance.now()));
  }
  renderSidebar();

  if (fkey) {
    const el = view.querySelector(`[data-fkey="${CSS.escape(fkey)}"]`);
    if (el) {
      el.focus();
      if (selStart != null && 'setSelectionRange' in el) {
        try {
          el.setSelectionRange(selStart, selStart);
        } catch {
          /* not a text input */
        }
      }
    }
  }
}

/* ---------- «Компьютер склада»: who uses this computer now ---------- */
function staffMode() {
  const s = state.staffInfo;
  if (!s?.warehouse || s.ownerUnlocked) return null;
  return s.active ? 'packer' : 'lock';
}

/** Reason for «Проблема с заказом» (no stock, damaged…), null = cancelled. */
function promptReason() {
  return new Promise((resolve) => {
    let dlg = $('reasonDialog');
    if (!dlg) {
      dlg = h('dialog', { id: 'reasonDialog', class: 'dialog', dataset: { uxForm: '1' } });
      document.body.append(dlg);
    }
    const reasons = ['noStock', 'damaged', 'wrongItem', 'other'];
    let pick = reasons[0];
    const note = h('textarea', { class: 'input', rows: 2, maxlength: 150, placeholder: t('pack.reasonNote') });
    clear(dlg).append(
      h('h2', { class: 'dialog__title' }, t('pack.problem')),
      h('div', { class: 'reason-list' }, reasons.map((r) => h('label', { class: 'check' }, h('input', { type: 'radio', name: 'reason', checked: r === pick, onchange: () => (pick = r) }), t(`pack.reason.${r}`)))),
      note,
      h('div', { class: 'dialog__actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => (dlg.close(), resolve(null)) }, t('common.cancel')),
        h('button', { type: 'button', class: 'btn btn--primary', dataset: { action: 'reason-send', uxKey: 'act_reason-send' }, onclick: () => (dlg.close('ok'), resolve(`${t(`pack.reason.${pick}`)}${note.value.trim() ? `: ${note.value.trim()}` : ''}`)) }, t('pack.send'))),
    );
    dlg.showModal();
  });
}

/** What the staff screens need from the dashboard. */
function staffCtx() {
  return {
    state,
    errorText,
    toast,
    confirmDialog,
    storeChip,
    thumb,
    promptReason,
    settingsNow,
    allOrders,
    formatRelative,
    stores: enabledStores,
    refresh: () => sync(),
    onChange: refreshStaff,
  };
}

async function refreshStaff() {
  state.staffInfo = await send('ui:staffState').catch(() => null);
  state.pack = null;
  // the sign-in screen keeps its message («владелец отключил ваш доступ»…); it only goes back to
  // the «choose your name» step when that list changed
  if (state.lock) state.lock.step = state.lock.step === 'code' ? 'code' : 'pick';
  renderAll();
}

function renderStaffRoot() {
  const mode = staffMode();
  const root = $('staffRoot');
  document.body.classList.toggle('staff-mode', !!mode);
  root.hidden = !mode;
  if (mode === 'lock') renderLockScreen(root, staffCtx());
  else if (mode === 'packer') renderPacker(root, staffCtx());
  else clear(root);
  return !!mode;
}

function renderAll() {
  // a locked warehouse computer / a packer: nothing of the owner's dashboard is drawn
  if (renderStaffRoot()) return;
  applyTheme();
  applyI18n();
  renderTopbar();
  renderBanners();
  renderView();
}

/* ===================================================================== */
/* Data loading                                                           */
/* ===================================================================== */

async function loadState() {
  // everything local in parallel; the first paint never waits for the network
  const [data, staffInfo, local, chat, costs, photos, catalog, onboard, csat] = await Promise.all([
    send('ui:getState').then(withSnapshots),
    send('ui:staffState').catch(() => null),
    chrome.storage.local.get(['ksh.tickets', 'ksh.packLog']),
    getChat(),
    getCosts(),
    getPhotos(),
    getCatalog(),
    getOnboarding(),
    getCsat(),
  ]);
  state.stockState = await send('ui:stockState').catch(() => null); // which stores have their price list (assortment + stock)
  Object.assign(state, { data, staffInfo, chat, costs, photos, catalog, onboard, csat });
  state.tickets = local['ksh.tickets'] || null;
  state.packProblems = (local['ksh.packLog'] || []).filter((r) => r.action === 'problem' && r.at > Date.now() - 86400000);
  renderAll();
  maybePay();
  loadExtras();
}

/** Owner's notice and the survey due: from the server (cached in the worker) — drawn when they arrive. */
async function loadExtras() {
  const [status, due] = await Promise.all([send('ui:serviceStatus').catch(() => null), send('ui:feedbackDue').catch(() => null)]);
  const serviceStatus = status?.status || null;
  const feedbackDue = due?.due || null;
  const changed = JSON.stringify(serviceStatus) !== JSON.stringify(state.serviceStatus) || feedbackDue !== state.feedbackDue;
  state.serviceStatus = serviceStatus;
  state.feedbackDue = feedbackDue;
  if (!changed || staffMode()) return;
  renderBanners();
  renderView();
  if (pay.open) renderPay();
}

/** Ask every store tab for a fresh snapshot. */
async function sync() {
  if (state.syncing) return;
  state.syncing = true;
  renderTopbar();
  renderView();
  try {
    const res = await send('ui:sync');
    if (res?.settings) state.data = await withSnapshots(res);
    else if (res?.ok === false) toast(errorText(res.error), 'error');
    state.chat = await getChat();
  } finally {
    state.syncing = false;
    renderAll();
    maybePay();
  }
}

async function changeLang(lang) {
  if (lang === getLang()) return;
  await setLang(lang);
  state.data.settings.lang = lang;
  renderAll();
}

function routeFromHash() {
  const r = location.hash.replace('#', '');
  // "#pay" (from the popup / notification) = subscription page with the QR window open
  if (r === 'pay') {
    state.forcePay = true;
    return 'account';
  }
  return ROUTES.includes(r) ? r : 'home';
}

/* ===================================================================== */
/* Boot                                                                   */
/* ===================================================================== */

function setMenu(open) {
  document.body.classList.toggle('nav-open', open);
  $('scrim').hidden = !open;
  $('menuBtn').setAttribute('aria-expanded', String(open));
}

function bindShell() {
  bindConnectDialog();
  // narrow window: ☰ opens the menu; choosing a section or tapping outside closes it
  $('guideBtn').addEventListener('click', () => {
    ux?.help(`guide_${state.route}`);
    if (!GUIDE_ROUTES.includes(state.route)) return (location.hash = 'help');
    const shown = !!document.querySelector('#view > .guide');
    state.guideOpen = !shown; // «?» shows the guide; pressed again, hides it for good
    if (shown) memo.set(`ksh.guide.${state.route}`, '1');
    renderView();
  });
  $('menuBtn').addEventListener('click', () => setMenu(!document.body.classList.contains('nav-open')));
  $('scrim').addEventListener('click', () => setMenu(false));
  $('sidebar').addEventListener('click', (e) => e.target.closest('a, button') && setMenu(false));
  document.addEventListener('keydown', (e) => e.key === 'Escape' && document.body.classList.contains('nav-open') && setMenu(false));
  // Esc closes the payment window only when the cabinet is not blocked.
  $('termsDialog').addEventListener('cancel', (e) => e.preventDefault());
  document.addEventListener('visibilitychange', () => !document.hidden && pay.open && checkPayment()); // must answer: accept or log out
  $('payDialog').addEventListener('cancel', (e) => {
    e.preventDefault();
    if (!pay.blocking) closePay();
  });
  window.addEventListener('hashchange', () => {
    state.route = routeFromHash();
    state.guideOpen = false;
    if (state.route === 'catalog') catalogView.reload();
    if (state.route === 'help') refreshTickets();
    noteSection();
    // a soft cross-fade between sections; instant where unsupported or motion is reduced
    if (document.startViewTransition && !reducedMotion()) document.startViewTransition(() => renderAll());
    else renderAll();
    manageChatPolling();
    $('view').focus({ preventScroll: true });
  });

  $('storeFilter').addEventListener('change', (e) => {
    state.filters.shopId = e.target.value;
    renderAll();
  });
  $('rangeSeg').addEventListener('click', (e) => {
    const preset = e.target.closest('button')?.dataset.preset;
    if (!preset) return;
    state.filters.preset = preset;
    if (preset === 'custom' && !state.filters.from) {
      const r = presetRange(30);
      state.filters.from = dayKey(r.from);
      state.filters.to = dayKey(r.to);
      $('dateFrom').value = state.filters.from;
      $('dateTo').value = state.filters.to;
    }
    renderAll();
  });
  const onDate = () => {
    state.filters.from = $('dateFrom').value;
    state.filters.to = $('dateTo').value;
    if (state.filters.from && state.filters.to && state.filters.from > state.filters.to) [state.filters.from, state.filters.to] = [state.filters.to, state.filters.from];
    renderView();
  };
  $('dateFrom').addEventListener('change', onDate);
  $('dateTo').addEventListener('change', onDate);

  $('langSwitch').addEventListener('click', (e) => {
    const lang = e.target.closest('button')?.dataset.lang;
    if (lang) changeLang(lang);
  });
  $('themeToggle').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    updateSettings({ theme: dark ? 'light' : 'dark' }, { silent: true });
  });
  $('refreshBtn').addEventListener('click', sync);
  $('filtersToggle').addEventListener('click', () => {
    document.body.classList.toggle('filters-open');
    renderTopbar();
  });

  // Not an async listener: a returned promise counts as a reply in Chrome and would
  // answer other pages' messages to the worker (the popup got an empty state).
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'bg:staffChanged') refreshStaff(); // signed out / switched off by the owner
    if (msg?.type === 'bg:photosChanged') getPhotos().then((p) => ((state.photos = p), renderView())); // photos found on Kaspi
    if (msg?.type === 'bg:stateChanged' && msg.payload && !state.syncing) {
      withSnapshots(msg.payload).then((data) => {
        state.data = data;
        renderTopbar();
        renderBanners();
        renderView();
        maybePay();
      });
    }
    if (msg?.type === 'bg:progress' && state.job) {
      state.job.done = msg.payload.done;
      state.job.total = msg.payload.total;
      renderProgress();
    }
    if (msg?.type === 'bg:chatUpdated' && msg.payload) {
      state.chat = msg.payload;
      renderSidebar();
      if (state.route === 'chat') renderView();
    }
  });

  onKeyChange(KEYS.settings, (next) => {
    if (!state.data || !next) return;
    const pollChanged = next.chatPollSec !== state.data.settings.chatPollSec;
    state.data.settings = next;
    applyTheme();
    if (pollChanged) manageChatPolling();
  });
  onLangChange(() => { renderAll(); adBanner?.rerender(); });
  // photos: set here, or products added in «Выгрузка товаров» (their first image)
  onKeyChange(KEYS.photos, (next) => {
    state.photos = next || {};
    if (!$('photoDialog')?.open) renderView();
  });
  onKeyChange(KEYS.catalog, (next) => {
    state.catalog = next || {};
  });
  // «Первые шаги»: the print tab or a backup marks a step → Home updates by itself
  onKeyChange(ONBOARD_KEY, (next) => {
    state.onboard = next || {};
    if (state.route === 'home') renderView();
  });
  onKeyChange(KEYS.costs, (next) => {
    state.costs = next || {};
    if (state.route !== 'products') renderView();
  });
  setInterval(() => !state.syncing && renderTopbar(), 30000); // keep "updated N min ago" fresh
  // Every minute: re-evaluate the subscription (cached in the worker; dates checked
  // locally), so an expiry or a new invoice shows the QR window without waiting for a sync.
  setInterval(async () => {
    if (!state.data || state.syncing || pay.open || terms.open) return;
    const lic = await send('ui:billingState', { force: false }).catch(() => null);
    if (!lic) return;
    const before = state.data.license || {};
    const changed = lic.status !== before.status || lic.canUse !== before.canUse || lic.needsConsent !== before.needsConsent || lic.pendingInvoice?.id !== before.pendingInvoice?.id || lic.pendingInvoice?.amount !== before.pendingInvoice?.amount;
    state.data.license = lic;
    if (changed) await loadState();
    else maybePay();
  }, 60000);
}

async function main() {
  await initI18n();
  state.route = routeFromHash();
  state.kaspiAccess = chrome.permissions?.contains ? await chrome.permissions.contains({ origins: KASPI_ORIGINS }).catch(() => true) : true;
  ux = startUx({ enabled: () => !staffMode() });
  bindShell();
  await refreshInvoiceCount();
  await loadState();
  try { adBanner = mountAdBanner({ root: $('adSlot'), send, t, enabled: () => !staffMode() }); adBanner.start(); } catch { /* an advertising failure must never stop the dashboard */ }
  if (state.route === 'help') refreshTickets();
  noteSection();
  manageChatPolling();
  sync(); // fresh snapshot from every store tab on open
  // First launch → the tour. Not under browser automation (it would sit on top of the page under test).
  // ?welcome=1 comes from the post-install tab: start the tour at once, then drop the param.
  let welcome = false;
  try {
    const u = new URL(location.href);
    if (u.searchParams.has('welcome')) {
      welcome = u.searchParams.get('welcome') === '1';
      u.searchParams.delete('welcome');
      history.replaceState(null, '', u.pathname + u.search + u.hash);
    }
  } catch { /* ignore */ }
  if (!navigator.webdriver && (welcome || !memo.get('ksh.tourDone'))) setTimeout(startTour, welcome ? 300 : 1200);
}

main();
