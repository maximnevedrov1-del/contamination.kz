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
import { layoutFor, normalizePrint, testSheet, TRIM_MODES } from './print-layout.js';
import { markStep } from './onboarding.js';

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

  /** Print resolution of waybills: barcodes must stay sharp on thermal label printers. */
  export const PRINT_DPI = 300;
  const PT_TO_MM = 25.4 / 72;
  const MAX_CANVAS_SIDE = 7000; // browsers refuse bigger canvases

  /**
   * Render every page of a PDF waybill into an image at PRINT_DPI. The page keeps its
   * proportions; `layoutOf` (print-layout.js) says on which paper it goes and whether
   * it is turned 90° to fit a label / cell of the other orientation.
   * @returns {Promise<Array<{ src:string, wMm:number, hMm:number, layout:ReturnType<typeof layoutFor> }>>}
   */
  async function renderPdf(pdfjs, bytes, layoutOf, { trim = false } = {}) {
    const pdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
    const images = [];
    let canvas = null;
    try {
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 }); // 1 unit = 1 pt, page rotation applied
      const scale = Math.min(PRINT_DPI / 72, MAX_CANVAS_SIDE / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      // Kaspi puts its ~100×150 mm label in the corner of an A4 page: for a label printer
      // (and 4 per A4) the empty paper is cut off, so the label prints at its real size
      // instead of A4 shrunk into a label (barcodes too small to scan).
      if (trim) canvas = cropToContent(canvas, Math.round((2 / 25.4) * PRINT_DPI));
      const mm = (px) => Math.round(((px / scale) * PT_TO_MM) * 10) / 10;
      const wMm = mm(canvas.width);
      const hMm = mm(canvas.height);
      const layout = layoutOf({ w: wMm, h: hMm });
      if (layout.rotate) canvas = rotate90(canvas);
      // PNG (lossless: barcodes stay sharp) encoded off the main thread; a blob URL instead of a
      // multi-megabyte data: string (toDataURL blocked the page ~0.1 s per waybill)
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      images.push({ src: URL.createObjectURL(blob), wMm, hMm, layout });
      canvas.width = canvas.height = 0; // free memory before the next page
      page.cleanup();
    }
  } catch (e) {
    images.forEach((i) => URL.revokeObjectURL(i.src)); // a half-rendered waybill is not shown
    throw e;
  } finally {
    if (canvas) canvas.width = canvas.height = 0;
    await pdf.destroy();
  }
  return images;
}

/** Canvas cut to its non-white content plus a margin (px). An empty page is returned as is. */
export function cropToContent(canvas, margin = 0) {
  const { width: w, height: h } = canvas;
  // The edges are found on a copy 4× smaller (reading back a 300-dpi page took most of the time);
  // the crop itself is cut from the full-size page, with one small pixel (4 px) of extra room.
  const F = 4;
  const sw = Math.max(1, Math.ceil(w / F));
  const sh = Math.max(1, Math.ceil(h / F));
  const small = document.createElement('canvas');
  small.width = sw;
  small.height = sh;
  const sctx = small.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(canvas, 0, 0, sw, sh); // averaging keeps thin lines visible (darker than 235)
  const data = sctx.getImageData(0, 0, sw, sh).data;
  small.width = small.height = 0;
  let top = sh, left = sw, right = -1, bottom = -1;
  for (let y = 0; y < sh; y++) {
    const row = y * sw * 4;
    for (let x = 0; x < sw; x++) {
      const i = row + x * 4;
      if (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0) return canvas;
  left *= F;
  top *= F;
  right = right * F + F - 1;
  bottom = bottom * F + F - 1;
  left = Math.max(0, left - margin);
  top = Math.max(0, top - margin);
  right = Math.min(w - 1, right + margin + 1);
  bottom = Math.min(h - 1, bottom + margin + 1);
  const out = document.createElement('canvas');
  out.width = right - left + 1;
  out.height = bottom - top + 1;
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = false; // 1:1 copy, barcodes stay sharp
  octx.drawImage(canvas, left, top, out.width, out.height, 0, 0, out.width, out.height);
  canvas.width = canvas.height = 0;
  return out;
}

/** Turn a canvas 90° clockwise (a landscape waybill on a portrait label). */
function rotate90(canvas) {
  const out = document.createElement('canvas');
  out.width = canvas.height;
  out.height = canvas.width;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.translate(out.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(canvas, 0, 0);
  canvas.width = canvas.height = 0;
  return out;
}

/**
 * Pages of the waybill's own size: one named @page per distinct size, so a batch can
 * mix A4 waybills and labels and each prints on its own paper size.
 */
const sheetSizes = new Map();
function sheetPage(wMm, hMm) {
  const name = `wb-${String(wMm).replace('.', '_')}x${String(hMm).replace('.', '_')}`;
  if (!sheetSizes.has(name)) {
    sheetSizes.set(name, `@page ${name} { size: ${wMm}mm ${hMm}mm; margin: 0; }`);
    let style = document.getElementById('sheetSizes');
    if (!style) document.head.append((style = h('style', { id: 'sheetSizes' })));
    style.textContent = [...sheetSizes.values()].join('\n');
  }
  return name;
}

function pageEl(label) {
  return h('section', { class: 'page' }, h('span', { class: 'page__label' }, label));
}

/** An empty sheet of the layout's paper: no margins of its own, a grid of cells. */
function sheetEl(layout, extraClass) {
  const { sheet, padding, cols, rows } = layout;
  const el = h('section', { class: ['page', 'page--sheet', extraClass] });
  Object.assign(el.style, {
    width: `${sheet.w}mm`,
    height: `${sheet.h}mm`,
    minHeight: '0',
    padding: `${padding}mm`,
    gridTemplateColumns: `repeat(${cols}, 1fr)`,
    gridTemplateRows: `repeat(${rows}, 1fr)`,
  });
  el.style.setProperty('page', sheetPage(sheet.w, sheet.h));
  return el;
}

/**
 * Waybill images → sheets. One waybill per sheet, or four per A4 in «A4 — 4 на лист».
 * @param {Array<{src:string, label:string, layout:ReturnType<typeof layoutFor>}>} items
 */
function buildSheets(items) {
  const out = [];
  let sheet = null;
  let free = 0;
  for (const it of items) {
    const perSheet = it.layout.cols * it.layout.rows;
    if (!sheet || free === 0) {
      sheet = sheetEl(it.layout, perSheet > 1 && 'page--grid');
      free = perSheet;
      out.push(sheet);
    }
    sheet.append(h('div', { class: 'cell' }, h('img', { class: 'pdf-page', src: it.src, alt: it.label }), h('span', { class: 'cell__label' }, it.label)));
    free--;
  }
  return out;
}

/**
 * Test print: a frame of the chosen paper with a 50 mm ruler and fine stripes, so the
 * seller checks once that nothing is cut off, the scale is 100 % and barcodes come out sharp.
 */
async function renderTestPage(settings) {
  const print = normalizePrint(settings.print);
  const size = testSheet(print);
  document.querySelector('.bar h1').textContent = t('printTest.title');
  document.title = t('printTest.title');
  $('count').textContent = `${size.w} × ${size.h} ${t('printTest.mm')}`;
  $('printBtn').addEventListener('click', () => window.print());
  const page = sheetEl({ sheet: size, padding: 0, cols: 1, rows: 1 }, 'page--test');
  const ticks = Array.from({ length: 11 }, (_, i) => h('span', { class: 'ruler__tick', style: { left: `${i * 5}mm` } }, i % 2 === 0 ? String(i / 2) : ''));
  page.append(
    h('div', { class: 'test' },
      h('div', { class: 'test__corner test__corner--tl' }), h('div', { class: 'test__corner test__corner--tr' }),
      h('div', { class: 'test__corner test__corner--bl' }), h('div', { class: 'test__corner test__corner--br' }),
      h('b', null, t('printTest.title')),
      h('div', null, `${size.w} × ${size.h} ${t('printTest.mm')} · ${t(`settings.paper.${print.paper}`)}`),
      h('div', { class: 'ruler' }, ticks),
      h('div', { class: 'small' }, t('printTest.ruler')),
      h('div', { class: 'stripes' }),
      h('div', { class: 'small' }, t('printTest.stripes')),
      h('div', { class: 'small' }, t('printTest.frame')),
    ),
  );
  clear($('pages')).append(page);
  window.print();
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
      h('thead', null, h('tr', null, h('th', null, '✓'), h('th', null, ''), h('th', null, t('pick.product')), h('th', null, t('pick.sku')), h('th', { class: 'num' }, t('pick.qty')), h('th', null, t('pick.orders')))),
      h(
        'tbody',
        null,
        pick.lines.map((l) => h('tr', null, h('td', { class: 'box' }, '☐'), h('td', { class: 'pick-photo' }, l.photo ? h('img', { src: l.photo, alt: '' }) : ''), h('td', null, l.name || '—'), h('td', { class: 'mono' }, l.sku || '—'), h('td', { class: 'num qty' }, formatNumber(l.qty)), h('td', null, l.orders.map(orderTag)))),
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
  const mode = new URLSearchParams(location.search).get('mode');
  if (mode === 'pick') return renderPickList();
  if (mode === 'test') {
    markStep('print'); // «Первые шаги»: the printer was tried
    return renderTestPage(settings);
  }

  const [queue, invoices] = await Promise.all([getPrintQueue(), getInvoices()]);
  const byKey = new Map(invoices.map((i) => [`${i.shopId}::${i.orderId}`, i]));
  // no queue (page opened directly): the newest waybills only, not every one ever saved
  const MAX_UNQUEUED = 100;
  const wanted = queue.length ? queue : [...invoices].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, MAX_UNQUEUED).map((i) => ({ shopId: i.shopId, orderId: i.orderId }));
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
  markStep('print'); // «Первые шаги»: waybills printed at least once

  const print = normalizePrint(settings.print);
  const originals = h('div', { class: 'notice notice--links' }, h('span', null, t('print.originalsTitle')));
  const hasPdf = found.some((i) => i.kind === 'pdf');
  const pdfjs = hasPdf ? await loadPdfJs() : null;
  if (hasPdf && !pdfjs) notices.append(h('div', { class: 'notice' }, t('print.pdfFallback')));

  const fragment = document.createDocumentFragment();
  const waybills = []; // rendered PDF pages, laid out on sheets after the loop
  // PDFs render two at a time (one is parsed in the pdf.js worker while the other is drawn);
  // the waybills keep the queue's order
  const rendered = new Map();
  const jobs = found.filter((inv) => inv.kind === 'pdf' && pdfjs);
  let next = 0;
  await Promise.all([0, 1].map(async () => {
    while (next < jobs.length) {
      const inv = jobs[next++];
      rendered.set(inv, await renderPdf(pdfjs, dataUrlToBytes(inv.data), (pageMm) => layoutFor(pageMm, print), { trim: TRIM_MODES.has(print.paper) }).catch((e) => e));
    }
  }));
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
        const imgs = rendered.get(inv);
        if (imgs instanceof Error) throw imgs;
        imgs.forEach(({ src, layout }) => waybills.push({ src, layout, label }));
        // the PDF copy is made on click, not for every waybill up front
        const link = h('a', { href: '#', target: '_blank', rel: 'noopener' }, t('print.openOriginal', { id: inv.orderId }));
        link.addEventListener('click', () => {
          if (link.href.startsWith('blob:')) return;
          link.href = blobUrl(new Blob([dataUrlToBytes(inv.data)], { type: 'application/pdf' }));
        });
        originals.append(link);
      } catch (e) {
        console.error('[KSH/print] pdf render failed', inv.orderId, e);
      }
    } else {
      const url = blobUrl(new Blob([dataUrlToBytes(inv.data)], { type: 'application/pdf' }));
      const page = pageEl(label);
      page.append(
        h('iframe', { src: url, title: label }),
        h('p', { class: 'no-print' }, h('a', { href: url, target: '_blank', rel: 'noopener' }, t('print.openPdf'))),
      );
      fragment.append(page);
    }
  }
  waybills.forEach((w) => blobUrls.add(w.src));
  buildSheets(waybills).forEach((sheet) => fragment.append(sheet));
  clear(pages).append(fragment);
  if (originals.childElementCount) notices.append(originals);

  $('printBtn').addEventListener('click', () => window.print());
  await Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((r) => (img.onload = img.onerror = r)))));
  if (!hasPdf || pdfjs) window.print();
}

/** Blob URLs of this page: released when the tab is closed or reloaded. */
const blobUrls = new Set();
function blobUrl(blob) {
  const url = URL.createObjectURL(blob);
  blobUrls.add(url);
  return url;
}
addEventListener('pagehide', () => blobUrls.forEach((u) => URL.revokeObjectURL(u)));

main();
