/**
 * Kaspi Seller Hub — invoice print page.
 *
 * Reads the print queue (selected orders) and the captured invoices from
 * storage, renders each invoice on its own A4 page and calls window.print().
 *
 *  - HTML invoices are sanitized (no scripts, handlers, remote resources) and
 *    rendered inside a Shadow DOM so their CSS cannot leak between pages.
 *  - PDF invoices are rasterized page-by-page with pdf.js IF it is bundled at
 *    /vendor/pdfjs/ (see README). Without it they are shown in iframes and an
 *    "open PDF" fallback is offered, because a browser cannot print several
 *    embedded PDFs as one job.
 */
import { initI18n, t, applyI18n } from '../shared/i18n.js';
import { getInvoices, getPrintQueue, getSettings, getPickList } from '../shared/storage.js';
import { formatNumber, formatDate } from '../shared/i18n.js';
import { h, clear } from '../shared/utils.js';

const $ = (id) => document.getElementById(id);

/** Strip anything executable or remote from captured invoice markup. */
function sanitize(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, iframe, object, embed, base, link, meta, form, noscript').forEach((el) => el.remove());
  const URL_ATTRS = ['src', 'href', 'xlink:href', 'srcset', 'action', 'formaction', 'background', 'poster', 'ping', 'data', 'srcdoc', 'lowsrc', 'dynsrc'];
  // Remote url(...) in CSS would make the print page fetch from the network.
  const stripCssUrls = (css) => css.replace(/@import[^;]+;?/gi, '').replace(/url\((?!\s*['"]?data:image\/)[^)]*\)/gi, 'none');
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const val = attr.value.trim().toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      else if (URL_ATTRS.includes(name) && !(val.startsWith('data:image/') || val.startsWith('#'))) el.removeAttribute(attr.name);
      else if (name === 'style') el.setAttribute('style', stripCssUrls(attr.value));
    }
  });
  doc.querySelectorAll('style').forEach((st) => (st.textContent = stripCssUrls(st.textContent)));
  // Nodes, not an HTML string: the cleaned document is moved in without re-parsing.
  const frag = document.createDocumentFragment();
  doc.querySelectorAll('style').forEach((st) => frag.append(document.importNode(st, true)));
  [...doc.body.childNodes].forEach((n) => frag.append(document.importNode(n, true)));
  return frag;
}

function dataUrlToBytes(dataUrl) {
  const bin = atob(dataUrl.split(',')[1] || '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Load the optional bundled pdf.js. */
async function loadPdfJs() {
  try {
    const lib = await import('../vendor/pdfjs/pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs');
    return lib;
  } catch {
    return null;
  }
}

/** Render every page of a PDF invoice into images (one A4 sheet per PDF page). */
async function renderPdf(pdfjs, bytes) {
  const pdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
  const images = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    images.push(canvas.toDataURL('image/png'));
  }
  return images;
}

function pageEl(label) {
  return h('section', { class: 'page' }, h('span', { class: 'page__label' }, label));
}

/**
 * Pick list: one A4 table — product, SKU, total quantity, which orders (and
 * stores) need it, and an empty box to tick while collecting.
 */
async function renderPickList() {
  const pick = await getPickList();
  $('printBtn').addEventListener('click', () => window.print());
  document.querySelector('.bar h1').textContent = t('pick.title');
  document.title = t('pick.title');
  const pages = clear($('pages'));
  if (!pick || (!pick.lines.length && !pick.unknown.length)) {
    pages.append(h('div', { class: 'empty' }, t('pick.empty')));
    $('printBtn').disabled = true;
    return;
  }
  const units = pick.lines.reduce((n, l) => n + l.qty, 0);
  $('count').textContent = t('pick.summary', { orders: pick.orderCount, units, products: pick.lines.length });
  const orderTag = (o) => h('span', { class: 'pick-order' }, h('span', { class: 'pick-dot', style: { background: o.color } }), `${o.id}${o.qty > 1 ? ` ×${o.qty}` : ''}`);
  const page = h(
    'section',
    { class: 'page pick' },
    h('h2', null, t('pick.title')),
    h('p', { class: 'pick-meta' }, `${formatDate(pick.createdAt, 'datetime')} · ${pick.stores.join(', ')} · ${t('pick.summary', { orders: pick.orderCount, units, products: pick.lines.length })}`),
    h(
      'table',
      null,
      h('thead', null, h('tr', null, h('th', null, '✓'), h('th', null, t('pick.product')), h('th', null, t('pick.sku')), h('th', { class: 'num' }, t('pick.qty')), h('th', null, t('pick.orders')))),
      h(
        'tbody',
        null,
        pick.lines.map((l) => h('tr', null, h('td', { class: 'box' }, '☐'), h('td', null, l.name || '—'), h('td', { class: 'mono' }, l.sku || '—'), h('td', { class: 'num qty' }, formatNumber(l.qty)), h('td', null, l.orders.map(orderTag)))),
      ),
    ),
    pick.unknown.length ? h('div', { class: 'pick-unknown' }, h('b', null, t('pick.unknownTitle')), ' ', t('pick.unknownText'), h('div', null, pick.unknown.map(orderTag))) : null,
  );
  pages.append(page);
  window.print();
}

async function main() {
  await initI18n();
  const settings = await getSettings();
  if (settings.theme === 'light' || settings.theme === 'dark') document.documentElement.dataset.theme = settings.theme;
  applyI18n();
  document.title = t('print.title');
  if (new URLSearchParams(location.search).get('mode') === 'pick') return renderPickList();

  const [queue, invoices] = await Promise.all([getPrintQueue(), getInvoices()]);
  const byKey = new Map(invoices.map((i) => [`${i.shopId}::${i.orderId}`, i]));
  const wanted = queue.length ? queue : invoices.map((i) => ({ shopId: i.shopId, orderId: i.orderId }));
  const found = wanted.map((q) => byKey.get(`${q.shopId}::${q.orderId}`)).filter(Boolean);
  const missingCount = wanted.length - found.length;
  const storeName = (id) => settings.stores[id]?.alias || settings.stores[id]?.name || id;

  $('count').textContent = t('print.count', { count: found.length });
  const notices = clear($('notices'));
  if (missingCount) notices.append(h('div', { class: 'notice' }, t('print.missing', { count: missingCount })));

  const pages = clear($('pages'));
  if (!found.length) {
    pages.append(h('div', { class: 'empty' }, t('print.empty')));
    $('printBtn').disabled = true;
    return;
  }
  pages.append(h('div', { class: 'empty no-print' }, t('print.rendering')));

  const hasPdf = found.some((i) => i.kind === 'pdf');
  const pdfjs = hasPdf ? await loadPdfJs() : null;
  if (hasPdf && !pdfjs) notices.append(h('div', { class: 'notice' }, t('print.pdfFallback')));

  const fragment = document.createDocumentFragment();
  for (const inv of found) {
    const label = t('print.orderLabel', { id: inv.orderId, store: storeName(inv.shopId) });
    if (inv.kind === 'html') {
      const page = pageEl(label);
      const host = h('div');
      host.attachShadow({ mode: 'open' }).append(sanitize(inv.data));
      page.append(host);
      fragment.append(page);
    } else if (pdfjs) {
      try {
        const imgs = await renderPdf(pdfjs, dataUrlToBytes(inv.data));
        imgs.forEach((src) => {
          const page = pageEl(label);
          page.append(h('img', { class: 'pdf-page', src, alt: label }));
          fragment.append(page);
        });
      } catch (e) {
        console.error('[KSH/print] pdf render failed', inv.orderId, e);
      }
    } else {
      const blobUrl = URL.createObjectURL(new Blob([dataUrlToBytes(inv.data)], { type: 'application/pdf' }));
      const page = pageEl(label);
      page.append(
        h('iframe', { src: blobUrl, title: label }),
        h('p', { class: 'no-print' }, h('a', { href: blobUrl, target: '_blank', rel: 'noopener' }, t('print.openPdf'))),
      );
      fragment.append(page);
    }
  }
  clear(pages).append(fragment);

  $('printBtn').addEventListener('click', () => window.print());
  await Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((r) => (img.onload = img.onerror = r)))));
  if (!hasPdf || pdfjs) window.print();
}

main();
