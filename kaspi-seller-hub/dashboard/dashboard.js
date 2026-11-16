/**
 * Kaspi Seller Hub — dashboard (Screen 2).
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
import { getChat, getInvoices, clearInvoices, onKeyChange, KEYS, getCosts, setPickList } from '../shared/storage.js';
import {
  h,
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

/* ===================================================================== */
/* State                                                                  */
/* ===================================================================== */

const ROUTES = ['orders', 'returns', 'refusals', 'payments', 'analytics', 'products', 'chat', 'settings', 'account'];
const TABLE_ROUTES = ['orders', 'returns', 'refusals', 'payments'];

const tableState = () => ({ sort: { key: 'date', dir: 'desc' }, status: 'all', payment: 'all', q: '', urgent: false, selected: new Set(), focus: 0 });

const state = {
  /** @type {{settings:any, snapshots:Record<string,any>, lastSync:number, tabs:any[], unauthTabs:number}|null} */
  data: null,
  chat: {},
  route: 'orders',
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
const send = (type, payload) => chrome.runtime.sendMessage({ type, payload });

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
  span.innerHTML = ICONS[name];
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
  id: { label: 'table.orderId', value: (r) => r.id, render: (r) => h('span', { class: 'mono' }, r.id) },
  store: { label: 'table.store', value: (r) => storeName(r.shopId), render: (r) => storeChip(r.shopId) },
  date: { label: 'table.date', value: (r) => r.date, render: (r) => formatDate(r.date, 'datetime') },
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
  if (!p.complete) return h('span', { class: 'muted', title: t('profit.incomplete') }, '?');
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
      (ts.payment === 'all' || r.paymentStatus === ts.payment) &&
      (!ts.urgent || ['soon', 'overdue'].includes(urgencyOf(deadlineOf(r, settingsNow()), settingsNow()))) &&
      (!q || [r.id, r.customer, r.reason, storeName(r.shopId)].some((v) => v && String(v).toLowerCase().includes(q))),
  );
  if (route === 'payments') out = out.filter((r) => r.paymentStatus === state.paymentGroup);
  const col = COLUMNS[ts.sort.key];
  if (col) out.sort((a, b) => compareValues(col.value(a), col.value(b)) * (ts.sort.dir === 'asc' ? 1 : -1));
  return out;
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
  const cols = SECTION_COLUMNS[route];

  const statuses = [...new Set(allRows.map((r) => r.status))];
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
    route === 'orders' &&
      h(
        'label',
        { class: 'check' },
        h('input', { type: 'checkbox', checked: ts.urgent, dataset: { fkey: 'orders-urgent' }, onchange: (e) => ((ts.urgent = e.target.checked), renderView()) }),
        t('deadline.onlyUrgent'),
      ),
    h('div', { class: 'toolbar__spacer' }),
    route === 'orders' && h('button', { type: 'button', class: 'btn btn--sm', onclick: () => openPickList(allRows) }, t('pick.button')),
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
    const body = state.syncing && !allRows.length ? skeletonTable(cols.length) : emptyState(t('table.emptyTitle'), allRows.length ? t('table.emptyFiltered') : t('table.emptyNoData'));
    return h('section', { class: 'card' }, toolbar, notes, body);
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

  ts.focus = Math.min(ts.focus, rows.length - 1);
  const tbody = h(
    'tbody',
    null,
    rows.map((r, i) =>
      h(
        'tr',
        { tabindex: i === ts.focus ? '0' : '-1', 'aria-selected': String(ts.selected.has(r.key)), dataset: { idx: i, fkey: `${route}-row-${r.key}` } },
        h('td', { class: 'col-check' }, h('input', { type: 'checkbox', tabindex: '-1', 'aria-label': t('common.selectRow', { id: r.id }), checked: ts.selected.has(r.key), onchange: () => toggleRow(route, r.key) })),
        cols.map((key) => h('td', { class: [COLUMNS[key].num && 'num', COLUMNS[key].wrap && 'wrap'] }, COLUMNS[key].render(r))),
      ),
    ),
  );
  tbody.addEventListener('keydown', (e) => onTableKey(e, route, rows));
  tbody.addEventListener('focusin', (e) => {
    const tr = e.target.closest('tr');
    if (tr) ts.focus = Number(tr.dataset.idx);
  });

  return h(
    'section',
    { class: 'card' },
    toolbar,
    bulk,
    notes,
    h('div', { class: 'table-wrap' }, h('table', { class: 'data', 'aria-rowcount': rows.length }, h('thead', null, head), tbody)),
    h('div', { class: 'kbd-hint' }, t('table.keyboardHint')),
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

/** Open the order/return in its store tab. Scraped links are used only on the store's own https origin. */
function openItem(row) {
  const origin = stores()[row.shopId]?.origin;
  let url = null;
  try {
    const u = new URL(row.url);
    if (u.protocol === 'file:' ? origin === 'file://' : (u.protocol === 'https:' || u.hostname === 'localhost') && u.origin === origin) url = u.href;
  } catch {
    /* no or invalid link */
  }
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
  state.invoiceCount = (await getInvoices()).length;
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
      const line = lines.get(k) || { name: e.name || e.category, sku: e.sku, qty: 0, orders: [] };
      line.qty += e.quantity || 1;
      line.orders.push({ id: o.id, store: storeName(o.shopId), color: storeColor(o.shopId), qty: e.quantity || 1 });
      lines.set(k, line);
    }
  }
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
      h('tr', null, ['analytics.product', 'products.category', 'nav.stores', 'analytics.units', 'analytics.revenue', 'products.cost', 'products.commission', 'products.profit', 'products.margin'].map((k, i) => h('th', { scope: 'col', class: i >= 3 && 'num' }, t(k)))),
    ),
    h(
      'tbody',
      null,
      rows.map((p) =>
        h(
          'tr',
          null,
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
          h('td', { class: ['num', p.profit < 0 && 'neg'] }, p.profit == null ? h('span', { class: 'muted', title: t('profit.incomplete') }, '?') : formatMoney(p.profit)),
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
  const kpi = (label, value, sub) => h('div', { class: 'card kpi' }, h('div', { class: 'kpi__label' }, label), h('div', { class: 'kpi__value' }, value), h('div', { class: 'kpi__sub' }, sub));

  const kpis = h(
    'div',
    { class: 'kpis' },
    kpi(t('analytics.revenue'), formatMoney(A.kpi.revenue), src),
    kpi(t('analytics.orders'), formatNumber(A.kpi.orders), src),
    kpi(t('analytics.aov'), formatMoney(A.kpi.aov), src),
    kpi(t('analytics.returnRate'), formatPercent(A.kpi.returnRate), t('nav.returns')),
    kpi(t('analytics.refusalRate'), formatPercent(A.kpi.refusalRate), t('nav.refusals')),
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
      (c) => (hasSeries ? lineChart(c, { points: A.series.map((p) => ({ x: p.x, y: p.revenue })), label: t('analytics.revenueOverTime'), yFormat: formatMoney, yFormatAxis: formatMoneyCompact, xFormat: xFmt }) : emptyChart(c)),
      seriesTable('revenue', formatMoney),
    ),
    chartCard(
      'orders',
      t('analytics.ordersOverTime'),
      src,
      (c) => (hasSeries ? lineChart(c, { points: A.series.map((p) => ({ x: p.x, y: p.orders })), label: t('analytics.ordersOverTime'), yFormat: (v) => formatNumber(v), xFormat: xFmt }) : emptyChart(c)),
      seriesTable('orders', (v) => formatNumber(v)),
    ),
  );

  const storeBars = (k) => A.perStore.map((p) => ({ label: storeName(p.store.id), color: p.store.color, value: k === 'revenue' ? p.revenue : ratio(p.returns, p.orders) }));
  const bars = h(
    'div',
    { class: 'grid-2' },
    chartCard(
      'byStoreRevenue',
      t('analytics.revenueByStore'),
      null,
      (c) => barChart(c, { bars: storeBars('revenue'), format: formatMoney, label: t('analytics.revenueByStore') }),
      { head: [t('table.store'), t('analytics.revenue')], rows: storeBars('revenue').map((b) => [b.label, formatMoney(b.value)]) },
    ),
    chartCard(
      'byStoreReturns',
      t('analytics.returnRateByStore'),
      null,
      (c) => barChart(c, { bars: storeBars('returns'), format: (v) => formatPercent(v), label: t('analytics.returnRateByStore') }),
      { head: [t('table.store'), t('analytics.returnRate')], rows: storeBars('returns').map((b) => [b.label, formatPercent(b.value)]) },
    ),
  );

  const profitBars = A.perStore.map((p) => ({ label: storeName(p.store.id), color: p.store.color, value: A.profit.per[p.store.id] ?? null }));
  const profitCard = h(
    'div',
    { class: 'grid-2' },
    chartCard('byStoreProfit', t('analytics.profitByStore'), A.profit.total ? t('analytics.profitCoverage', { complete: A.profit.complete, total: A.profit.total }) : t('analytics.profitNA'), (c) => barChart(c, { bars: profitBars, format: formatMoney, label: t('analytics.profitByStore') }), {
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
  const next = await send('ui:saveSettings', { patch });
  if (next?.stores) state.data.settings = next;
  if (!silent) toast(t('settings.saved'), 'ok', 2000);
  renderAll();
}

async function updateStore(shopId, patch) {
  const next = await send('ui:updateStore', { shopId, patch });
  if (next?.stores) state.data.settings = next;
  toast(t('settings.saved'), 'ok', 2000);
  renderAll();
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
                  h(
                    'div',
                    { class: 'swatches', role: 'group', 'aria-label': t('settings.color') },
                    STORE_COLORS.map((c, i) => h('button', { type: 'button', class: 'swatch', style: { background: c }, 'aria-pressed': String(s.color === c), 'aria-label': `${t('settings.color')} ${i + 1}`, onclick: () => patchStore({ color: c }) })),
                  ),
                ),
                h('td', null, storeChip(s.id), h('div', { class: 'muted mono' }, s.id)),
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
    : h('p', { class: 'muted' }, t('store.noStoresText'));

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
    card(t('settings.stores'), t('settings.storesHint'), storesTable),
    apiCard(),
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
    card(t('settings.notifications'), null, notif('newOrders', 'settings.notifyNewOrders'), notif('deadlines', 'settings.notifyDeadlines'), notif('newMessages', 'settings.notifyNewMessages'), notif('returns', 'settings.notifyReturns')),
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
  const tokenInput = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: t('settings.api.tokenLabel'), 'aria-label': t('settings.api.tokenLabel'), style: { flex: '1' } });
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
  return h('section', { class: 'card' }, emptyState(t('store.noStoresTitle'), t('store.noStoresText'), h('button', { type: 'button', class: 'btn btn--primary', onclick: sync }, t('common.refresh'))));
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
  const setCount = (k, v) => (document.querySelector(`[data-count="${k}"]`).textContent = v ? formatNumber(v) : '');
  setCount('orders', sum('newOrders'));
  const urgent = enabledStores().reduce(
    (n, s) => n + (state.data.snapshots[s.id]?.sections?.orders?.items || []).filter((it) => ['soon', 'overdue'].includes(urgencyOf(deadlineOf(it, settingsNow()), settingsNow()))).length,
    0,
  );
  const u = document.querySelector('[data-count="urgent"]');
  if (u) {
    u.textContent = urgent ? `🔥 ${formatNumber(urgent)}` : '';
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
function renderBanners() {
  const box = clear($('banners'));
  if (state.route === 'settings') return;
  filteredStores().forEach((s) => {
    const snap = state.data.snapshots[s.id];
    const status = snap?.status || 'noTab';
    if (status === 'ok') return;
    box.append(
      h(
        'div',
        { class: 'banner', role: 'status' },
        h('span', { class: 'banner__icon' }, icon('warn')),
        h('span', { class: 'banner__text' }, t('store.unavailable', { store: storeName(s.id), reason: status === 'error' && snap?.error ? errorText(snap.error) : t(`store.${status}`) }), snap?.ts ? h('span', { class: 'banner__meta' }, ` · ${t('store.lastData', { time: formatRelative(snap.ts) })}`) : null),
        h('button', { type: 'button', class: 'btn btn--sm', onclick: () => send('ui:openStore', { shopId: s.id }) }, t('common.openStoreTab')),
      ),
    );
  });
  if (state.data.unauthTabs > 0) {
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
  if (!lic || lic.status === 'unconfigured' || lic.status === 'loggedOut' || lic.status === 'offline') return null;
  if (lic.status === 'expired') return 'blocking';
  const inv = lic.pendingInvoice;
  if (!inv) return null;
  if (inv.kind === 'addon' && memo.get('ksh.payShown.addon') !== `${inv.id}:${inv.amount}`) return 'show';
  if (lic.renewalDue && memo.get('ksh.payShown.renewal') !== `${inv.id}:${new Date().toDateString()}`) return 'show';
  return null;
}

function maybePay() {
  if (pay.open || !state.data) return;
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
  pay.blocking = blocking || state.data?.license?.status === 'expired';
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
async function checkPayment() {
  const lic = await send('ui:billingState', { force: true });
  if (!lic) return;
  state.data.license = lic;
  if (lic.canUse && !lic.pendingInvoice) {
    closePay();
    toast(t('pay.paidToast'), 'ok', 8000);
    await loadState();
    sync();
  } else if (pay.open) renderPay();
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
    expired: t('pay.expiredText'),
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
          lic.payment?.qr_url
            ? h('img', { class: 'pay__qr', src: lic.payment.qr_url, alt: t('account.qrAlt'), referrerpolicy: 'no-referrer' })
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
      h('button', { type: 'button', class: 'btn btn--primary', autofocus: true, onclick: () => checkPayment() }, t('pay.check')),
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

/** Simple "connect a store": name + API token → then the payment window right away. */
function bindConnectDialog() {
  const dlg = $('connectDialog');
  $('connectStoreBtn').addEventListener('click', () => {
    const pr = state.data?.license?.pricing;
    $('connectPrice').textContent = pr && state.data.license.status !== 'unconfigured' ? t('connect.price', { extra: formatMoney(pr.extra_store_price), base: pr.base_stores }) : '';
    $('connectError').hidden = true;
    $('connectName').value = '';
    $('connectToken').value = '';
    applyI18n(dlg);
    dlg.showModal();
    $('connectName').focus();
  });
  $('connectCancel').addEventListener('click', () => dlg.close());
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
    dlg.close();
    toast(t('connect.done'), 'ok');
    await loadState();
    const lic = state.data.license;
    if (lic && lic.status !== 'unconfigured' && dataStores().length < enabledStores().length) await payForStores();
  });
}

/** Full-page notice shown instead of a section when there is no usable subscription. */
function paywall() {
  const lic = state.data.license || {};
  const text = lic.status === 'loggedOut' ? 'account.paywallLoggedOut' : lic.status === 'offline' ? 'account.paywallOffline' : 'account.paywallExpired';
  return h('section', { class: 'card' }, emptyState(t('account.paywallTitle'), t(text), h('a', { class: 'btn btn--primary', href: '#account' }, t('account.paywallButton'))));
}

function viewAccount() {
  const lic = state.data.license || { status: 'unconfigured' };
  const ui = (state.acct ??= { email: '', step: 'email', busy: false, error: null, stores: null, months: 1, phone: null });
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
              style: { justifyContent: 'flex-start', gap: '8px' },
              onsubmit: async (e) => {
                e.preventDefault();
                const res = await run(() => send('ui:billingRequestCode', { email: ui.email }));
                if (res?.ok) ui.step = 'code';
                renderView();
              },
            },
            emailInput,
            h('button', { type: 'submit', class: 'btn btn--primary', disabled: ui.busy }, t(ui.busy ? 'account.sending' : 'account.sendCode')),
          )
        : h(
            'form',
            {
              onsubmit: async (e) => {
                e.preventDefault();
                const res = await run(() => send('ui:billingVerify', { email: ui.email, code: codeInput.value }));
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
    { class: ['badge', lic.status === 'active' ? 'badge--ok' : lic.status === 'trial' ? 'badge--info' : 'badge--danger'] },
    t(`account.status.${lic.status}`, { date: until ? formatDate(until) : '' }),
  );
  const used = enabledStores().length;
  const statusCard = card(
    t('account.title'),
    lic.email ? t('account.loggedInAs', { email: lic.email }) : null,
    h('div', { class: 'field' }, h('div', null, statusBadge, ' ', (lic.status === 'trial' || lic.status === 'active') && h('span', { class: 'muted' }, t('account.daysLeft', { count: days }))), h('button', { type: 'button', class: 'btn btn--ghost', onclick: () => run(async () => (await send('ui:billingLogout'), await loadState())) }, t('account.logout'))),
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

  const inv = lic.pendingInvoice;
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
          h('p', null, t('account.pendingText', { phone: fmtPhone(inv.phone) })),
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
        lic.payment?.qr_url && h('img', { class: 'pending-invoice__qr', src: lic.payment.qr_url, alt: t('account.qrAlt'), referrerpolicy: 'no-referrer' }),
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

  // With an open invoice the plan form stays below it: choosing another plan replaces the invoice.
  return h('div', { class: 'settings' }, statusCard, pendingCard, planCard, historyCard);
}

const VIEWS = {
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
    const needsStores = !['settings', 'account'].includes(state.route) && !dataStores().length;
    view.append(needsStores ? noStores() : VIEWS[state.route]());
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

function renderAll() {
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
  state.data = await send('ui:getState');
  state.chat = await getChat();
  state.costs = await getCosts();
  renderAll();
  maybePay();
}

/** Ask every store tab for a fresh snapshot. */
async function sync() {
  if (state.syncing) return;
  state.syncing = true;
  renderTopbar();
  renderView();
  try {
    const res = await send('ui:sync');
    if (res?.settings) state.data = res;
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
  return ROUTES.includes(r) ? r : 'orders';
}

/* ===================================================================== */
/* Boot                                                                   */
/* ===================================================================== */

function bindShell() {
  bindConnectDialog();
  // Esc closes the payment window only when the cabinet is not blocked.
  $('payDialog').addEventListener('cancel', (e) => {
    e.preventDefault();
    if (!pay.blocking) closePay();
  });
  window.addEventListener('hashchange', () => {
    state.route = routeFromHash();
    renderAll();
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

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'bg:stateChanged' && msg.payload && !state.syncing) {
      state.data = msg.payload;
      renderTopbar();
      renderBanners();
      renderView();
      maybePay();
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
  onLangChange(() => renderAll());
  onKeyChange(KEYS.costs, (next) => {
    state.costs = next || {};
    if (state.route !== 'products') renderView();
  });
  setInterval(() => !state.syncing && renderTopbar(), 30000); // keep "updated N min ago" fresh
  // Every minute: re-evaluate the subscription (cached in the worker; dates checked
  // locally), so an expiry or a new invoice shows the QR window without waiting for a sync.
  setInterval(async () => {
    if (!state.data || state.syncing || pay.open) return;
    const lic = await send('ui:billingState', { force: false }).catch(() => null);
    if (!lic) return;
    const before = state.data.license || {};
    const changed = lic.status !== before.status || lic.canUse !== before.canUse || lic.pendingInvoice?.id !== before.pendingInvoice?.id || lic.pendingInvoice?.amount !== before.pendingInvoice?.amount;
    state.data.license = lic;
    if (changed) await loadState();
    else maybePay();
  }, 60000);
}

async function main() {
  await initI18n();
  state.route = routeFromHash();
  bindShell();
  await refreshInvoiceCount();
  await loadState();
  manageChatPolling();
  sync(); // fresh snapshot from every store tab on open
}

main();
