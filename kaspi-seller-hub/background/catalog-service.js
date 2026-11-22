/**
 * SaudaPulse — product upload ("Выгрузка товаров"), service-worker side.
 *
 *  - Catalog: the seller's whole assortment, with price/stock per store (shared/catalog.js).
 *  - Card upload: new product cards go to Kaspi through the official Content API, with
 *    the token of every store the seller picked (all stores or some).
 *  - Price list: per store, an XML price list built from the catalog and uploaded to the
 *    subscription server (Supabase Storage). The seller pastes its URL once in the Kaspi
 *    cabinet; Kaspi re-reads it every 60 min. A store's price list is only uploaded after
 *    the seller confirmed it holds the whole assortment (Kaspi takes missing products off sale).
 * API tokens never leave the worker; pages only get statuses.
 */
import * as K from './kaspi-api.js';
import * as B from './billing.js';
import { getApiTokens, getCatalog, setCatalog, getFeeds, setFeeds, getImports, setImports, getContentCache, setContentCache, getSettings, saveSettings, getCosts, setCosts, getPhotos, setPhotos, getSnapshots, setSnapshots } from '../shared/storage.js';
import { isAllowedPhoto, photosDataSize, MAX_PHOTOS_DATA } from '../shared/photos.js';
import { normalizePrint } from '../dashboard/print-layout.js';
import { validateProduct, buildPriceListXml, offerCount, mergeImport, toImportItem, shopSlug, WAREHOUSE_RE } from '../shared/catalog.js';
import { createMutex } from '../shared/utils.js';

const LOG = '[KSH catalog]';
const A = () => globalThis.KSH_SELECTORS.api;
export const ALARM_IMPORTS = 'ksh-card-imports';
const DAY = 86400000;
const lock = createMutex(); // catalog / feeds / imports writes
const FINAL = new Set(['FINISHED', 'ABORTED', 'ERROR', 'FAILED', 'CANCELLED', 'REJECTED']);

const storesOf = (settings) => Object.values(settings.stores || {});
const hashOf = async (text) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

/** Feed settings are complete enough to build a valid price list. */
const feedReady = (f) => !!(f && String(f.merchantId || '').trim() && String(f.company || '').trim() && (f.warehouses || []).some((w) => WAREHOUSE_RE.test(w)));

/* ---------------- price-list upload ---------------- */

let syncTimer = null;
const pendingShops = new Set();

/** Re-upload the price lists of these stores a few seconds later (edits are batched). */
export function scheduleFeedSync(shopIds) {
  shopIds.forEach((id) => pendingShops.add(id));
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    const ids = [...pendingShops];
    pendingShops.clear();
    syncFeeds(ids)
      .then((results) => Object.entries(results).forEach(([shopId, r]) => r?.error === 'feedDrop' && feedDropListener?.(shopId, r.drop)))
      .catch((e) => console.warn(LOG, 'feed sync', e.code || e.message));
  }, 3000);
}

let feedDropListener = null;
/** The worker shows a notification when an automatic price-list update is held back. */
export const onFeedDrop = (fn) => (feedDropListener = fn);

/**
 * Build and upload the price list of each store (only confirmed, configured stores;
 * unchanged files are not re-sent). Returns per-store results.
 */
/**
 * Kaspi takes every product missing from the price list off sale within an hour.
 * A price list that suddenly lost most of its products (catalog wiped, mass
 * "take off sale" by mistake, a restore gone wrong) is held back until the seller
 * confirms it — instead of silently emptying the store.
 */
export function isSuspiciousDrop(prev, next) {
  if (!(prev > 0)) return false;
  if (next === 0) return true;
  return prev >= 10 && next < prev * 0.5;
}

export async function syncFeeds(shopIds, { force = false, allowDrop = false } = {}) {
  if (!B.isConfigured()) return {};
  // «Только чтение»: the price list Kaspi reads is not touched
  if ((await getSettings()).readOnly) return Object.fromEntries(shopIds.map((id) => [id, { ok: false, error: 'readOnly' }]));
  const out = {};
  for (const shopId of shopIds) {
    out[shopId] = await lock(async () => {
      const feeds = await getFeeds();
      const f = feeds[shopId];
      if (!f?.confirmed || !feedReady(f)) return { ok: false, error: 'feedNotReady' };
      const products = Object.values(await getCatalog());
      const xml = buildPriceListXml(f, products, shopId);
      const hash = await hashOf(xml);
      if (hash === f.hash && f.url && (!force || f.error === 'feedDrop')) {
        // the catalog came back to what Kaspi already has: nothing to upload, lift a held drop
        if (f.error) {
          feeds[shopId] = { ...f, error: null, drop: null };
          await setFeeds(feeds);
        }
        return { ok: true, unchanged: true, url: f.url };
      }
      const count = offerCount(products, shopId);
      if (f.url && !allowDrop && isSuspiciousDrop(f.offers, count)) {
        const drop = { from: f.offers, to: count };
        feeds[shopId] = { ...f, error: 'feedDrop', drop };
        await setFeeds(feeds);
        return { ok: false, error: 'feedDrop', drop };
      }
      try {
        const key = shopSlug(shopId);
        const feedId = f.feedId || (await B.ensureFeed(key)).feed_id;
        const url = await B.uploadFeed(feedId, key, xml);
        feeds[shopId] = { ...f, feedId, url, hash, uploadedAt: Date.now(), offers: count, error: null, drop: null };
        await setFeeds(feeds);
        return { ok: true, url };
      } catch (e) {
        feeds[shopId] = { ...f, error: e.code || 'feedUpload' };
        await setFeeds(feeds);
        return { ok: false, error: e.code || 'feedUpload' };
      }
    });
  }
  return out;
}

/* ---------------- card uploads (Content API) ---------------- */

async function ensureImportAlarm() {
  const pending = (await getImports()).some((i) => !FINAL.has(i.status) && Date.now() - i.at < A().importGiveUpHours * 3600000);
  if (pending) await chrome.alarms.create(ALARM_IMPORTS, { periodInMinutes: Math.max(1, A().importPollMinutes) });
  else await chrome.alarms.clear(ALARM_IMPORTS);
}

/** Re-check card uploads Kaspi is still processing. */
export async function pollImports() {
  const tokens = await getApiTokens();
  const list = await getImports();
  let changed = false;
  for (const imp of list) {
    if (FINAL.has(imp.status) || Date.now() - imp.at > A().importGiveUpHours * 3600000 || !tokens[imp.shopId]) continue;
    try {
      const st = await K.getImportStatus(tokens[imp.shopId], imp.code);
      imp.status = String(st.status || imp.status).toUpperCase();
      if (FINAL.has(imp.status)) imp.result = await K.getImportResult(tokens[imp.shopId], imp.code).catch(() => null);
      imp.checkedAt = Date.now();
      changed = true;
    } catch (e) {
      imp.error = e.code || 'apiHttp';
      changed = true;
    }
  }
  if (changed) await lock(async () => {
    // merge by code: other uploads may have been added meanwhile
    const fresh = await getImports();
    const byCode = new Map(list.map((i) => [`${i.shopId}:${i.code}`, i]));
    await setImports(fresh.map((i) => byCode.get(`${i.shopId}:${i.code}`) || i));
  });
  await ensureImportAlarm();
}

/** Upload cards of these products to these stores (one request per store). */
async function uploadCards(products, shopIds) {
  const tokens = await getApiTokens();
  const results = {};
  const items = products.map(toImportItem);
  for (const shopId of shopIds) {
    if (!tokens[shopId]) {
      results[shopId] = { ok: false, error: 'cardNeedsApi' };
      continue;
    }
    try {
      const r = await K.importProducts(tokens[shopId], items);
      const imp = { shopId, code: String(r.code || ''), status: String(r.status || 'UPLOADED').toUpperCase(), skus: products.map((p) => p.sku), at: Date.now() };
      await lock(async () => setImports([imp, ...(await getImports())].slice(0, 300)));
      results[shopId] = { ok: true, code: imp.code };
    } catch (e) {
      results[shopId] = { ok: false, error: e.code || 'apiHttp', detail: e.detail || '' };
    }
  }
  await ensureImportAlarm();
  return results;
}

/** Latest card-upload state of a sku in a store (for the table). */
function cardState(imports, sku, shopId) {
  const imp = imports.find((i) => i.shopId === shopId && i.skus?.includes(sku));
  if (!imp) return null;
  const r = imp.result?.result?.[sku] || imp.result?.result?.[` ${sku}`];
  const state = String(r?.state || r?.status || imp.status || '').toUpperCase();
  const errors = r?.errors || r?.messages || null;
  return { state, at: imp.at, errors: errors ? JSON.stringify(errors).slice(0, 300) : null, uploadError: imp.error || null };
}

/* ---------------- content dictionaries (cached) ---------------- */

async function cached(key, ttl, load) {
  const cache = await getContentCache();
  const hit = cache[key];
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const data = await load();
  const next = Object.fromEntries(Object.entries(await getContentCache()).filter(([, v]) => Date.now() - v.at < DAY).slice(-200));
  next[key] = { at: Date.now(), data };
  await setContentCache(next);
  return data;
}

async function tokenFor(shopId) {
  const tokens = await getApiTokens();
  const id = shopId && tokens[shopId] ? shopId : Object.keys(tokens)[0];
  if (!id) throw Object.assign(new Error('cardNeedsApi'), { code: 'cardNeedsApi' });
  return tokens[id];
}

/* ---------------- UI handlers ---------------- */

export function catalogHandlers({ allowedShopIds }) {
  /** Stores the seller may use now (subscription limit) that are switched on. */
  const usable = async () => {
    const settings = await getSettings();
    const allowed = await allowedShopIds(settings);
    return storesOf(settings).filter((s) => s.enabled && (!allowed || allowed.includes(s.id)));
  };

  return {
    'ui:catalogState': async () => {
      const [catalog, feeds, imports, tokens, settings] = await Promise.all([getCatalog(), getFeeds(), getImports(), getApiTokens(), getSettings()]);
      const stores = storesOf(settings).filter((s) => s.enabled);
      const products = Object.values(catalog)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .map((p) => ({ ...p, cards: Object.fromEntries(stores.map((s) => [s.id, cardState(imports, p.sku, s.id)]).filter(([, v]) => v)) }));
      const feedView = Object.fromEntries(
        stores.map((s) => {
          const f = feeds[s.id] || {};
          return [s.id, { merchantId: f.merchantId || '', company: f.company || '', warehouses: f.warehouses || ['PP1'], confirmed: !!f.confirmed, url: f.url || null, uploadedAt: f.uploadedAt || null, offers: offerCount(Object.values(catalog), s.id), uploadedOffers: f.offers ?? null, error: f.error || null, drop: f.drop || null, ready: feedReady(f) }];
        }),
      );
      return {
        ok: true,
        products,
        feeds: feedView,
        apiStores: stores.filter((s) => tokens[s.id]).map((s) => s.id),
        serverFeeds: B.isConfigured(),
        pendingImports: imports.filter((i) => !FINAL.has(i.status)).length,
      };
    },

    'ui:catalogSave': async ({ product, originalSku }) => {
      const { product: p, errors } = validateProduct(product);
      if (errors.length) return { ok: false, error: 'catalogInvalid', fields: errors };
      const touched = new Set();
      const duplicate = await lock(async () => {
        const catalog = await getCatalog();
        if (catalog[p.sku] && originalSku !== p.sku) return true; // a new / renamed product may not take an existing sku
        if (originalSku && originalSku !== p.sku) {
          Object.entries(catalog[originalSku]?.stores || {}).forEach(([id, o]) => o.on && touched.add(id));
          delete catalog[originalSku];
        }
        Object.entries(catalog[p.sku]?.stores || {}).forEach(([id, o]) => o.on && touched.add(id));
        Object.entries(p.stores).forEach(([id, o]) => o.on && touched.add(id));
        catalog[p.sku] = { ...catalog[p.sku], ...p };
        await setCatalog(catalog);
        return false;
      });
      if (duplicate) return { ok: false, error: 'skuExists', fields: ['sku'] };
      scheduleFeedSync([...touched]);
      return { ok: true, sku: p.sku };
    },

    'ui:catalogDelete': async ({ skus }) => {
      const touched = new Set();
      await lock(async () => {
        const catalog = await getCatalog();
        for (const sku of skus || []) {
          Object.entries(catalog[sku]?.stores || {}).forEach(([id, o]) => o.on && touched.add(id));
          delete catalog[sku];
        }
        await setCatalog(catalog);
      });
      scheduleFeedSync([...touched]);
      return { ok: true };
    },

    /**
     * Put products on sale in the chosen stores (all or some): switch them on in each
     * store's price list and, if asked, upload their cards to Kaspi with each store's token.
     */
    'ui:catalogPublish': async ({ skus, shopIds, createCard = false, on = true }) => {
      const allowed = new Set((await usable()).map((s) => s.id));
      const targets = (shopIds || []).filter((id) => allowed.has(id));
      if (!targets.length) return { ok: false, error: 'noStoresChosen' };
      let products = [];
      await lock(async () => {
        const catalog = await getCatalog();
        for (const sku of skus || []) {
          const p = catalog[sku];
          if (!p) continue;
          p.stores = { ...p.stores };
          for (const id of targets) p.stores[id] = { ...(p.stores[id] || {}), on };
          p.updatedAt = Date.now();
          products.push(p);
        }
        await setCatalog(catalog);
      });
      const cards = {};
      if (on && createCard) {
        const bad = products.map((p) => [p.sku, validateProduct(p, { requireCard: true }).errors]).filter(([, e]) => e.length);
        if (bad.length) return { ok: false, error: 'cardIncomplete', skus: bad.map(([s]) => s), fields: [...new Set(bad.flatMap(([, e]) => e))] };
        Object.assign(cards, await uploadCards(products, targets));
      }
      scheduleFeedSync(targets);
      return { ok: true, stores: targets, cards };
    },

    'ui:catalogImport': async ({ shopId, offers, merchantId, company, warehouses }) => {
      if (!(await usable()).some((s) => s.id === shopId)) return { ok: false, error: 'storeOverLimit' };
      let res;
      await lock(async () => {
        res = mergeImport(await getCatalog(), offers || [], shopId);
        await setCatalog(res.catalog);
        const feeds = await getFeeds();
        const f = feeds[shopId] || {};
        const wh = [...new Set((warehouses || []).filter((w) => WAREHOUSE_RE.test(w)))];
        feeds[shopId] = { ...f, merchantId: f.merchantId || merchantId || '', company: f.company || company || '', warehouses: f.warehouses?.length ? f.warehouses : wh.length ? wh : ['PP1'], importedAt: Date.now(), importedCount: (offers || []).length };
        await setFeeds(feeds);
      });
      scheduleFeedSync([shopId]);
      return { ok: true, added: res.added, updated: res.updated };
    },

    'ui:feedSettings': async ({ shopId, merchantId, company, warehouses, confirmed }) => {
      const wh = [...new Set(String(Array.isArray(warehouses) ? warehouses.join(',') : warehouses || '').split(/[\s,;]+/).map((w) => w.trim()).filter(Boolean))];
      if (wh.some((w) => !WAREHOUSE_RE.test(w))) return { ok: false, error: 'badWarehouse' };
      await lock(async () => {
        const feeds = await getFeeds();
        feeds[shopId] = { ...feeds[shopId], merchantId: String(merchantId || '').trim().slice(0, 64), company: String(company || '').trim().slice(0, 200), warehouses: wh.length ? wh : ['PP1'], confirmed: !!confirmed };
        await setFeeds(feeds);
      });
      if (confirmed) return { ok: true, sync: (await syncFeeds([shopId], { force: true }))[shopId] };
      return { ok: true };
    },

    'ui:feedSync': async ({ shopIds, allowDrop }) => ({ ok: true, results: await syncFeeds(shopIds || [], { force: true, allowDrop: !!allowDrop }) }),

    /** XML text for "Скачать файл" (also works without the subscription server). */
    'ui:feedXml': async ({ shopId }) => {
      const f = (await getFeeds())[shopId];
      if (!feedReady(f)) return { ok: false, error: 'feedNotReady' };
      return { ok: true, xml: buildPriceListXml(f, Object.values(await getCatalog()), shopId), name: `kaspi-price-${(await getSettings()).stores[shopId]?.name || shopId}.xml` };
    },

    'ui:contentCategories': async ({ shopId }) => {
      const token = await tokenFor(shopId);
      return { ok: true, list: await cached('categories', DAY, () => K.getCategories(token)) };
    },
    'ui:contentAttributes': async ({ shopId, category }) => {
      const token = await tokenFor(shopId);
      return { ok: true, list: await cached(`attrs:${category}`, DAY, () => K.getAttributes(token, category)) };
    },
    'ui:contentValues': async ({ shopId, category, attribute }) => {
      const token = await tokenFor(shopId);
      return { ok: true, list: await cached(`vals:${category}:${attribute}`, DAY, () => K.getAttributeValues(token, category, attribute)) };
    },
    /**
     * Backup of what lives only in this browser: settings, cost prices, catalog, price-list
     * settings. API tokens are NOT included (a file with tokens would give access to the stores).
     */
    /** The seller's photo for a SKU (Kaspi image link or a resized file); null removes it. */
    'ui:setPhoto': async ({ sku, src }) => {
      if (typeof sku !== 'string' || !sku.trim() || sku.length > 200) return { ok: false, error: 'catalogInvalid' };
      if (src != null && !isAllowedPhoto(src)) return { ok: false, error: 'photoNotAllowed' };
      const full = await lock(async () => {
        const photos = await getPhotos();
        if (src == null) delete photos[sku];
        else {
          const prev = photos[sku];
          photos[sku] = src;
          if (src.startsWith('data:') && photosDataSize(photos) > MAX_PHOTOS_DATA) {
            if (prev == null) delete photos[sku];
            else photos[sku] = prev;
            return true; // nothing written
          }
        }
        await setPhotos(photos);
        return false;
      });
      return full ? { ok: false, error: 'photoLimit' } : { ok: true };
    },

    'ui:backupExport': async () => {
      const [settings, costs, catalog, feeds, photos, snaps] = await Promise.all([getSettings(), getCosts(), getCatalog(), getFeeds(), getPhotos(), getSnapshots()]);
      return {
        ok: true,
        backup: {
          app: 'kaspi-seller-hub',
          version: 1,
          createdAt: new Date().toISOString(),
          settings: { lang: settings.lang, theme: settings.theme, chatPollSec: settings.chatPollSec, notifications: settings.notifications, deadlines: settings.deadlines, profit: settings.profit, print: settings.print },
          stores: Object.fromEntries(storesOf(settings).map((s) => [s.id, { name: s.name, alias: s.alias || '', color: s.color }])),
          costs,
          photos,
          catalog,
          // orders: per-store snapshots, only for stores listed above (no tokens / session / licence here)
          snapshots: Object.fromEntries(storesOf(settings).filter((st) => snaps[st.id]).map((st) => [st.id, snaps[st.id]])),
          feeds: Object.fromEntries(Object.entries(feeds).map(([id, f]) => [id, { merchantId: f.merchantId || '', company: f.company || '', warehouses: f.warehouses || [] }])),
        },
      };
    },

    /** Restore a backup: merged into the current data (the file wins for the same product / cost). */
    'ui:backupImport': async ({ backup }) => {
      const b = backup;
      if (!b || b.app !== 'kaspi-seller-hub' || b.version !== 1 || typeof b !== 'object') return { ok: false, error: 'backupInvalid' };
      const settings = await getSettings();
      // Store ids differ after a reinstall (API stores get a new id) → match stores by name.
      const byName = new Map(storesOf(settings).map((s) => [String(s.name).trim().toLowerCase(), s.id]));
      const idMap = {};
      for (const [oldId, st] of Object.entries(b.stores || {})) {
        const now = settings.stores[oldId] ? oldId : byName.get(String(st?.name || '').trim().toLowerCase());
        if (now) idMap[oldId] = now;
      }
      const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
      let products = 0;
      let costsN = 0;
      const touched = new Set();
      await lock(async () => {
        const costs = await getCosts();
        for (const [k, v] of Object.entries(b.costs || {}).slice(0, 50000)) if (typeof k === 'string' && k.length <= 200 && num(v) != null) (costs[k] = num(v)), costsN++;
        await setCosts(costs);
        const photos = await getPhotos();
        let photoBytes = photosDataSize(photos);
        for (const [k, v] of Object.entries(b.photos || {}).slice(0, 20000)) {
          if (typeof k !== 'string' || k.length > 200 || !isAllowedPhoto(v)) continue;
          const add = v.startsWith('data:') ? v.length : 0;
          if (add && photoBytes + add > MAX_PHOTOS_DATA) continue; // over the total limit: the rest of the files are skipped
          photoBytes += add;
          photos[k] = v;
        }
        await setPhotos(photos);
        const catalog = await getCatalog();
        for (const raw of Object.values(b.catalog || {}).slice(0, 50000)) {
          const stores = Object.fromEntries(Object.entries(raw?.stores || {}).filter(([id]) => idMap[id]).map(([id, o]) => [idMap[id], o]));
          const { product, errors } = validateProduct({ ...raw, stores, imported: true });
          if (errors.length) continue;
          product.imported = !!raw.imported;
          catalog[product.sku] = { ...catalog[product.sku], ...product };
          Object.entries(product.stores).forEach(([id, o]) => o.on && touched.add(id));
          products++;
        }
        await setCatalog(catalog);
        // orders: only for stores present in the file and here; a store that already has a snapshot keeps it
        if (b.snapshots && typeof b.snapshots === 'object') {
          const snaps = await getSnapshots();
          let added = false;
          for (const [oldId, sn] of Object.entries(b.snapshots)) {
            const id = idMap[oldId];
            if (!id || snaps[id] || !sn || typeof sn !== 'object' || Array.isArray(sn) || !sn.sections || typeof sn.sections !== 'object') continue;
            snaps[id] = sn;
            added = true;
          }
          if (added) await setSnapshots(snaps);
        }
        const feeds = await getFeeds();
        for (const [oldId, f] of Object.entries(b.feeds || {})) {
          const id = idMap[oldId];
          if (!id || feeds[id]?.merchantId) continue; // keep what is already set up here
          feeds[id] = { ...feeds[id], merchantId: String(f?.merchantId || '').slice(0, 64), company: String(f?.company || '').slice(0, 200), warehouses: (f?.warehouses || []).filter((w) => WAREHOUSE_RE.test(w)), confirmed: false };
        }
        await setFeeds(feeds);
        const st = b.settings || {};
        const patch = {};
        if (['ru', 'kk'].includes(st.lang)) patch.lang = st.lang;
        if (['system', 'light', 'dark'].includes(st.theme)) patch.theme = st.theme;
        if (st.print && typeof st.print === 'object') patch.print = normalizePrint(st.print);
        if (st.notifications && typeof st.notifications === 'object') patch.notifications = { ...settings.notifications, ...Object.fromEntries(Object.entries(st.notifications).filter(([k, v]) => k in settings.notifications && typeof v === 'boolean')) };
        if (st.deadlines && num(st.deadlines.acceptHours) != null) patch.deadlines = { acceptHours: num(st.deadlines.acceptHours), warnHours: num(st.deadlines.warnHours) ?? settings.deadlines.warnHours };
        if (st.profit && typeof st.profit === 'object') patch.profit = { defaultCommission: num(st.profit.defaultCommission), byCategory: Object.fromEntries(Object.entries(st.profit.byCategory || {}).filter(([, v]) => num(v) != null).map(([k, v]) => [String(k).slice(0, 200), num(v)])) };
        const fresh = await getSettings();
        for (const [oldId, stx] of Object.entries(b.stores || {})) {
          const id = idMap[oldId];
          if (id && fresh.stores[id]) fresh.stores[id] = { ...fresh.stores[id], alias: String(stx.alias || fresh.stores[id].alias || '').slice(0, 100), color: /^#[0-9a-f]{6}$/i.test(stx.color) ? stx.color : fresh.stores[id].color };
        }
        await saveSettings({ ...patch, stores: fresh.stores });
      });
      scheduleFeedSync([...touched]);
      return { ok: true, products, costs: costsN, stores: Object.keys(idMap).length, storesSkipped: Object.keys(b.stores || {}).length - Object.keys(idMap).length };
    },

    'ui:cardsRefresh': async () => {
      await pollImports();
      return { ok: true };
    },
  };
}
