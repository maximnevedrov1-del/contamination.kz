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

const ROUTES = ['orders', 'returns', 'refusals', 'payments', 'analytics', 'products', 'chat', 'settings'];
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
/** Stores matching the top-bar store filter. */
const filteredStores = () => enabledStores().filter((s) => state.filters.shopId === 'all' || s.id === state.filters.shopId);
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
  const counts = enabledStores().map((s) => storeCounts(state.data.snapshots[s.id]));
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
  const needsStores = state.route !== 'settings' && !enabledStores().length;
  view.append(needsStores ? noStores() : VIEWS[state.route]());
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
  return ROUTES.includes(r) ? r : 'orders';
}

/* ===================================================================== */
/* Boot                                                                   */
/* ===================================================================== */

function bindShell() {
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
