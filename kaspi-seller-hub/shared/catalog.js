/**
 * SaudaPulse — product catalog: validation, Kaspi XML price list, import of the
 * price list downloaded from the Kaspi cabinet (XML or Excel). Pure functions, no
 * chrome.* calls, so they run in the worker, the dashboard and unit tests alike.
 *
 * Kaspi rules (guide.kaspi.kz/partner/ru/shop/goods/price_list/q3251, q2962):
 *  - the price list holds the WHOLE assortment: a product missing from it is taken off sale;
 *  - <offer sku>: digits and Latin letters, up to 20 characters, unique;
 *  - <availability available="yes|no" storeId="PP1" preOrder="0..30" stockCount="N"/>;
 *  - <price>: whole tenge, VAT included, no spaces or decimals.
 * Card creation API (guide.kaspi.kz/partner/ru/shop/api/goods/q3219): sku up to 64 chars.
 */

/**
 * @typedef {{ on:boolean, price?:number|null, stock?:number|null, preOrder?:number|null }} StoreOffer
 * @typedef {{
 *   sku:string, title:string, brand:string, category?:string, categoryTitle?:string,
 *   description?:string, images?:string[], attributes?:Record<string, any>,
 *   price:number, stock:number, preOrder?:number|null,
 *   stores:Record<string, StoreOffer>, imported?:boolean, updatedAt?:number,
 * }} Product
 * @typedef {{ merchantId:string, company:string, warehouses:string[] }} FeedSettings
 */

export const SKU_RE = /^[A-Za-z0-9]{1,20}$/; // price-list rule for NEW products
const RESERVED_SKUS = new Set(['__proto__', 'constructor', 'prototype']); // would poison plain-object maps keyed by sku
const SKU_IMPORTED_RE = /^[^\s<>"&']{1,64}$/; // products already selling keep their sku as is
export const WAREHOUSE_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const MAX_PREORDER = 30;

const int = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[\s ₸]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n) : NaN;
};

/**
 * Normalizes and checks a product. Returns { product, errors } — errors are i18n keys
 * under catalog.err.* (plus the field), empty when valid.
 * @param {Partial<Product>} p
 */
export function validateProduct(p, { requireCard = false } = {}) {
  const errors = [];
  const sku = String(p.sku ?? '').trim();
  const product = {
    sku,
    title: String(p.title ?? '').trim().slice(0, 500),
    brand: String(p.brand ?? '').trim().slice(0, 200),
    category: String(p.category ?? '').trim(),
    categoryTitle: String(p.categoryTitle ?? '').trim(),
    description: String(p.description ?? '').trim().slice(0, 10000),
    images: (Array.isArray(p.images) ? p.images : String(p.images ?? '').split(/\s+/))
      .map((u) => String(u).trim())
      .filter(Boolean)
      .slice(0, 20),
    attributes: p.attributes && typeof p.attributes === 'object' ? { ...p.attributes } : {},
    price: int(p.price),
    stock: int(p.stock) ?? 0,
    preOrder: int(p.preOrder),
    stores: {},
    imported: !!p.imported,
    updatedAt: Date.now(),
  };
  if (!(p.imported ? SKU_IMPORTED_RE : SKU_RE).test(sku) || RESERVED_SKUS.has(sku.toLowerCase())) errors.push('sku');
  if (!product.title) errors.push('title');
  if (!product.brand) errors.push('brand');
  if (!(product.price > 0)) errors.push('price');
  if (!(product.stock >= 0)) errors.push('stock');
  if (product.preOrder != null && !(product.preOrder >= 0 && product.preOrder <= MAX_PREORDER)) errors.push('preOrder');
  if (product.images.some((u) => !/^https:\/\/[^\s]+$/i.test(u))) errors.push('images');
  if (requireCard) {
    if (!product.category) errors.push('category');
    if (!product.images.length) errors.push('images');
  }
  for (const [shopId, o] of Object.entries(p.stores || {})) {
    const offer = { on: !!o?.on, price: int(o?.price), stock: int(o?.stock), preOrder: int(o?.preOrder) };
    if (offer.price != null && !(offer.price > 0)) errors.push('price');
    if (offer.stock != null && !(offer.stock >= 0)) errors.push('stock');
    if (offer.preOrder != null && !(offer.preOrder >= 0 && offer.preOrder <= MAX_PREORDER)) errors.push('preOrder');
    product.stores[shopId] = offer;
  }
  return { product, errors: [...new Set(errors)] };
}

/** Price / stock / pre-order of a product in one store (store value, else the default). */
export function offerFor(product, shopId) {
  const o = product.stores?.[shopId] || {};
  return {
    on: !!o.on,
    price: o.price ?? product.price,
    stock: o.stock ?? product.stock ?? 0,
    preOrder: o.preOrder ?? product.preOrder ?? null,
  };
}

const esc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
// Characters XML 1.0 does not allow at all (control chars) are dropped.
const clean = (s) => esc(String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, ''));

/**
 * Kaspi XML price list for ONE store: every product switched on for it.
 * @param {FeedSettings} feed
 * @param {Product[]} products
 * @param {string} shopId
 * @param {Date} [now]
 */
export function buildPriceListXml(feed, products, shopId, now = new Date()) {
  const warehouses = (feed.warehouses || []).filter((w) => WAREHOUSE_RE.test(w));
  if (!warehouses.length) throw new Error('noWarehouses');
  const offers = [];
  const seen = new Set();
  for (const p of products) {
    const o = offerFor(p, shopId);
    if (!o.on || seen.has(p.sku) || !(o.price > 0)) continue;
    seen.add(p.sku);
    const pre = o.preOrder > 0 ? ` preOrder="${Math.min(MAX_PREORDER, o.preOrder)}"` : '';
    const available = o.stock > 0 || o.preOrder > 0 ? 'yes' : 'no';
    offers.push(
      [
        `    <offer sku="${clean(p.sku)}">`,
        `      <model>${clean(p.title)}</model>`,
        `      <brand>${clean(p.brand)}</brand>`,
        '      <availabilities>',
        ...warehouses.map((w) => `        <availability available="${available}" storeId="${clean(w)}"${pre} stockCount="${Math.max(0, o.stock | 0)}"/>`),
        '      </availabilities>',
        `      <price>${Math.round(o.price)}</price>`,
        '    </offer>',
      ].join('\n'),
    );
  }
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<kaspi_catalog date="${now.toISOString().slice(0, 19).replace('T', ' ')}" xmlns="kaspiShopping" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="kaspiShopping http://kaspi.kz/kaspishopping.xsd">`,
    `  <company>${clean(feed.company)}</company>`,
    `  <merchantid>${clean(feed.merchantId)}</merchantid>`,
    '  <offers>',
    ...offers,
    '  </offers>',
    '</kaspi_catalog>',
    '',
  ].join('\n');
}

/** Number of offers a store's price list would contain. */
export const offerCount = (products, shopId) => products.filter((p) => offerFor(p, shopId).on && offerFor(p, shopId).price > 0).length;

/* ---------------- import: what the store sells today ---------------- */

/**
 * Kaspi XML price list → offers. Needs a DOMParser (dashboard page).
 * @returns {{ offers: Array<{sku,title,brand,price,stock,preOrder,warehouses:string[]}>, merchantId?:string, company?:string }}
 */
export function parseXmlPriceList(text, parser = new DOMParser()) {
  const doc = parser.parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('badFile');
  const pick = (el, name) => el.getElementsByTagNameNS('*', name)[0] || el.getElementsByTagName(name)[0];
  const txt = (el, name) => (pick(el, name)?.textContent || '').trim();
  const list = [...doc.getElementsByTagNameNS('*', 'offer')];
  if (!list.length && !doc.getElementsByTagNameNS('*', 'kaspi_catalog').length) throw new Error('badFile');
  const offers = list.map((o) => {
    const avs = [...o.getElementsByTagNameNS('*', 'availability')];
    const prices = [...o.getElementsByTagNameNS('*', 'cityprice')].map((c) => int(c.textContent)).filter((n) => n > 0);
    const stock = avs.reduce((m, a) => Math.max(m, int(a.getAttribute('stockCount')) || 0), 0);
    const anyYes = avs.some((a) => /^(yes|да)$/i.test(a.getAttribute('available') || ''));
    return {
      sku: (o.getAttribute('sku') || '').trim(),
      title: txt(o, 'model'),
      brand: txt(o, 'brand'),
      price: int(txt(o, 'price')) || (prices.length ? Math.min(...prices) : null),
      stock: stock || (anyYes ? 1 : 0),
      preOrder: avs.reduce((m, a) => Math.max(m, int(a.getAttribute('preOrder')) || 0), 0) || null,
      warehouses: avs.map((a) => a.getAttribute('storeId')).filter(Boolean),
    };
  });
  return { offers: offers.filter((o) => o.sku), merchantId: txt(doc, 'merchantid'), company: txt(doc, 'company') };
}

/* ---- minimal .xlsx reader (zip + XML), so no spreadsheet library has to be bundled ---- */

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Files of a zip archive: name → bytes (stored or deflated entries). */
export async function unzip(buffer, wanted = () => true) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) (eocd = i), (i = -1);
  if (eocd < 0) throw new Error('badFile');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = {};
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('badFile');
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name)) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = u8.subarray(start, start + size);
    if (method === 0) out[name] = data;
    else if (method === 8) out[name] = await inflateRaw(data);
    else throw new Error('badFile');
  }
  return out;
}

/** First worksheet of an .xlsx file as rows of strings. */
export async function readXlsx(buffer, parser = new DOMParser()) {
  const files = await unzip(buffer, (n) => n === 'xl/sharedStrings.xml' || n === 'xl/workbook.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const dec = new TextDecoder();
  const xml = (n) => (files[n] ? parser.parseFromString(dec.decode(files[n]), 'application/xml') : null);
  const shared = [...(xml('xl/sharedStrings.xml')?.getElementsByTagNameNS('*', 'si') || [])].map((si) => [...si.getElementsByTagNameNS('*', 't')].map((t) => t.textContent).join(''));
  const sheetName = Object.keys(files).filter((n) => n.startsWith('xl/worksheets/')).sort()[0];
  const sheet = sheetName && xml(sheetName);
  if (!sheet) throw new Error('badFile');
  const col = (ref) => [...ref.replace(/\d+/g, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  return [...sheet.getElementsByTagNameNS('*', 'row')].map((row) => {
    const cells = [];
    for (const c of row.getElementsByTagNameNS('*', 'c')) {
      const t = c.getAttribute('t');
      const v = c.getElementsByTagNameNS('*', 'v')[0]?.textContent ?? '';
      const val = t === 's' ? shared[Number(v)] ?? '' : t === 'inlineStr' ? [...c.getElementsByTagNameNS('*', 't')].map((x) => x.textContent).join('') : v;
      cells[col(c.getAttribute('r') || 'A1')] = String(val).trim();
    }
    return Array.from(cells, (x) => x ?? '');
  });
}

/**
 * Rows of the Excel price list → offers. Columns are found by their header
 * (SKU / Артикул, model / Название, brand / Бренд, price / Цена, PP1…PP5 = quantity or yes/no, preorder).
 */
export function rowsToOffers(rows) {
  const hIdx = rows.findIndex((r) => r.some((c) => /^(sku|артикул)/i.test(c)));
  if (hIdx < 0) throw new Error('noSkuColumn');
  const head = rows[hIdx].map((c) => String(c).trim().toLowerCase());
  const find = (re) => head.findIndex((c) => re.test(c));
  const ci = {
    sku: find(/^(sku|артикул)/),
    title: find(/^(model|модель|название|наименование)/),
    brand: find(/^(brand|бренд)/),
    price: find(/^(price|цена)/),
    pre: find(/^(preorder|pre-order|предзаказ)/),
    stock: find(/^(stock|остат)/),
  };
  if (ci.price < 0) throw new Error('noPriceColumn');
  const wh = head.map((c, i) => [c, i]).filter(([c]) => /^pp\d+$/i.test(c));
  const offers = [];
  for (const r of rows.slice(hIdx + 1)) {
    const sku = String(r[ci.sku] ?? '').trim();
    if (!sku) continue;
    // Kaspi's own file (guide.kaspi.kz …/price_list/q2962): PP1–PP5 hold the QUANTITY on each warehouse,
    // or «yes» / «no». Quantities are added up; «yes» without a number counts as 1 in stock.
    const cells = wh.map(([, i]) => String(r[i] ?? '').trim());
    const qty = cells.map((c) => (/^\d+$/.test(c) ? Number(c) : null)).filter((n) => n != null);
    const yes = cells.filter((c) => /^(yes|да|true)$/i.test(c));
    offers.push({
      sku,
      title: ci.title >= 0 ? String(r[ci.title] ?? '').trim() : '',
      brand: ci.brand >= 0 ? String(r[ci.brand] ?? '').trim() : '',
      price: int(r[ci.price]),
      stock: ci.stock >= 0 ? int(r[ci.stock]) || 0 : qty.length ? qty.reduce((a, b) => a + b, 0) : yes.length ? 1 : 0,
      preOrder: ci.pre >= 0 ? int(r[ci.pre]) || null : null,
      warehouses: wh.map(([c]) => c.toUpperCase()),
    });
  }
  return { offers };
}

/** Offers from a price-list file (XML or .xlsx), by content. */
export async function readPriceListFile(buffer, parser = new DOMParser()) {
  const head = new Uint8Array(buffer.slice(0, 4));
  if (head[0] === 0x50 && head[1] === 0x4b) return rowsToOffers(await readXlsx(buffer, parser));
  return parseXmlPriceList(new TextDecoder().decode(buffer), parser);
}

/**
 * Merge imported offers into the catalog for one store: existing products get the
 * store switched on with the imported price/stock; unknown skus become products.
 * @returns {{ catalog: Record<string, Product>, added:number, updated:number }}
 */
export function mergeImport(catalog, offers, shopId) {
  const next = { ...catalog };
  let added = 0;
  let updated = 0;
  for (const o of offers) {
    if (!o.sku || !(o.price > 0)) continue;
    const prev = next[o.sku];
    const offer = { on: true, price: o.price, stock: o.stock ?? 0, preOrder: o.preOrder ?? null };
    if (prev) {
      next[o.sku] = { ...prev, stores: { ...prev.stores, [shopId]: offer }, updatedAt: Date.now() };
      updated++;
    } else {
      next[o.sku] = { sku: o.sku, title: o.title || o.sku, brand: o.brand || '', category: '', description: '', images: [], attributes: {}, price: o.price, stock: o.stock ?? 0, preOrder: o.preOrder ?? null, stores: { [shopId]: offer }, imported: true, updatedAt: Date.now() };
      added++;
    }
  }
  return { catalog: next, added, updated };
}

/** Body of POST /shop/api/products/import for one product (card creation). */
export function toImportItem(p) {
  return {
    sku: p.sku,
    title: p.title,
    brand: p.brand,
    category: p.category,
    description: p.description || '',
    attributes: Object.entries(p.attributes || {})
      .filter(([, v]) => v !== '' && v != null && !(Array.isArray(v) && !v.length))
      .map(([code, value]) => ({ code, value })),
    images: (p.images || []).map((url) => ({ url })),
  };
}

/** Stable short key for a store in the feed file name (no ids leak into the URL). */
export function shopSlug(shopId) {
  let h = 2166136261;
  for (const ch of String(shopId)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return 'shop-' + (h >>> 0).toString(36);
}
