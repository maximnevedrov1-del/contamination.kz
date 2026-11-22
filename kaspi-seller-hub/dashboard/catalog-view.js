/**
 * SaudaPulse — "Выгрузка товаров" (dashboard side).
 *
 * The seller keeps the whole assortment here and puts products on sale in ALL stores
 * or only in the ones they tick. Two Kaspi mechanisms are used:
 *   1. new product cards → Kaspi Content API, with each chosen store's token;
 *   2. price & stock → each store's XML price list (uploaded to our server; Kaspi reads it
 *      by URL every 60 min). Kaspi takes products MISSING from a price list off sale, so a
 *      store's list is only switched on after the seller confirms it is complete.
 * Nothing is sent to Kaspi without an explicit click.
 */
import { h, clear } from '../shared/utils.js';
import { t, formatMoney, formatRelative } from '../shared/i18n.js';
import { validateProduct, readPriceListFile, SKU_RE } from '../shared/catalog.js';

const send = (type, payload) => chrome.runtime.sendMessage({ type, payload });

/** Copy that also works where the async clipboard API is missing or blocked (older Safari/Firefox). */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

/**
 * @param {{ toast:Function, errorText:Function, emptyState:Function, storeChip:Function, storeName:Function,
 *           dataStores:Function, renderView:Function, confirmDialog:Function }} ui
 */
export function createCatalogView(ui) {
  const cat = { data: null, loading: false, q: '', selected: new Set(), error: null };

  async function load() {
    if (cat.loading) return;
    cat.loading = true;
    try {
      const res = await send('ui:catalogState');
      if (res?.ok) (cat.data = res), (cat.error = null);
      else cat.error = res?.error || 'noResponse';
    } finally {
      cat.loading = false;
      ui.renderView();
    }
  }
  const stores = () => ui.dataStores();
  const fail = (res) => ui.toast(res?.fields?.length ? `${ui.errorText(res.error)}: ${res.fields.map((f) => t(`catalog.field.${f}`)).join(', ')}` : ui.errorText(res?.error), 'error', 8000);

  /* ---------- store picker: "Все магазины" + each store ---------- */
  function storePicker(initial, onChange) {
    const list = stores();
    const chosen = new Set(initial ?? list.map((s) => s.id));
    const boxes = [];
    const all = h('input', { type: 'checkbox', dataset: { fkey: 'cat-all' } });
    const sync = () => {
      all.checked = list.every((s) => chosen.has(s.id));
      all.indeterminate = !all.checked && chosen.size > 0;
      onChange?.([...chosen]);
    };
    all.addEventListener('change', () => {
      list.forEach((s) => (all.checked ? chosen.add(s.id) : chosen.delete(s.id)));
      boxes.forEach((b) => (b.checked = all.checked));
      sync();
    });
    const rows = list.map((s) => {
      const b = h('input', { type: 'checkbox', checked: chosen.has(s.id), dataset: { shop: s.id } });
      b.addEventListener('change', () => (b.checked ? chosen.add(s.id) : chosen.delete(s.id), sync()));
      boxes.push(b);
      return h('label', { class: 'check' }, b, ui.storeChip(s.id), !cat.data?.apiStores.includes(s.id) && h('span', { class: 'muted small' }, t('catalog.noApi')));
    });
    queueMicrotask(sync);
    return { el: h('div', { class: 'store-picker' }, h('label', { class: 'check store-picker__all' }, all, h('strong', null, t('catalog.allStores'))), rows), chosen: () => [...chosen] };
  }

  /* ---------- category + attributes (Kaspi dictionaries) ---------- */
  async function attributeForm(box, product, shopId) {
    clear(box);
    if (!product.category) return;
    box.append(h('p', { class: 'muted' }, t('catalog.loadingAttrs')));
    const res = await send('ui:contentAttributes', { shopId, category: product.category });
    clear(box);
    if (!res?.ok) return box.append(h('p', { class: 'neg' }, ui.errorText(res?.error)));
    product.attributes ||= {};
    const label = (code) => code.split('*').pop().split('.').pop();
    for (const a of res.list) {
      const val = product.attributes[a.code];
      let input;
      const set = (v) => (v === '' || v == null ? delete product.attributes[a.code] : (product.attributes[a.code] = v));
      if (a.type === 'boolean') {
        input = h('select', { class: 'select', onchange: (e) => set(e.target.value === '' ? null : e.target.value === 'true') }, h('option', { value: '' }, '—'), h('option', { value: 'true', selected: val === true }, t('catalog.yes')), h('option', { value: 'false', selected: val === false }, t('catalog.no')));
      } else if (a.type === 'number') {
        input = h('input', { class: 'input', type: 'number', value: val ?? '', onchange: (e) => set(e.target.value === '' ? null : Number(e.target.value)) });
      } else {
        const listId = `vals-${Math.random().toString(36).slice(2)}`;
        const dl = h('datalist', { id: listId });
        input = h('input', { class: 'input', list: a.type === 'enum' ? listId : null, value: Array.isArray(val) ? val.join(', ') : val ?? '', placeholder: a.multiValued ? t('catalog.multiHint') : '', onchange: (e) => {
          const v = e.target.value.trim();
          set(a.multiValued && v.includes(',') ? v.split(',').map((x) => x.trim()).filter(Boolean) : v);
        } });
        if (a.type === 'enum')
          input.addEventListener('focus', async () => {
            if (dl.childElementCount) return;
            const r = await send('ui:contentValues', { shopId, category: product.category, attribute: a.code });
            if (r?.ok) r.list.forEach((v) => dl.append(h('option', { value: v.code }, v.name)));
          }, { once: true });
        box.append(dl);
      }
      box.append(h('label', { class: 'catalog-field' }, h('span', null, label(a.code), a.mandatory && h('b', { class: 'neg' }, ' *')), input));
    }
  }

  /* ---------- product dialog ---------- */
  function dialog() {
    let dlg = document.getElementById('productDialog');
    if (!dlg) {
      dlg = h('dialog', { id: 'productDialog', class: 'dialog dialog--wide', 'aria-labelledby': 'productTitle' });
      document.body.append(dlg);
    }
    return dlg;
  }

  async function openProduct(existing) {
    const dlg = dialog();
    const p = structuredClone(existing || { sku: '', title: '', brand: '', price: '', stock: 0, preOrder: null, description: '', images: [], attributes: {}, category: '', stores: {} });
    const apiShop = cat.data.apiStores[0] || null;
    const onIds = Object.entries(p.stores || {}).filter(([, o]) => o.on).map(([id]) => id);
    let picked = existing ? onIds : stores().map((s) => s.id);
    const picker = storePicker(picked, (ids) => ((picked = ids), renderOverrides()));
    const overridesBox = h('div', { class: 'catalog-overrides' });
    const attrsBox = h('div', { class: 'catalog-attrs' });
    const createCard = h('input', { type: 'checkbox', checked: !existing && !!apiShop, disabled: !apiShop });
    const field = (key, input, hint) => h('label', { class: 'catalog-field' }, h('span', null, t(`catalog.field.${key}`)), input, hint && h('small', { class: 'muted' }, hint));
    const inp = (key, attrs = {}) => h('input', { class: 'input', value: p[key] ?? '', ...attrs, oninput: (e) => (p[key] = e.target.value) });

    function renderOverrides() {
      clear(overridesBox);
      if (picked.length < 2) return;
      overridesBox.append(h('p', { class: 'muted small' }, t('catalog.overridesHint')));
      for (const id of picked) {
        const o = (p.stores[id] ||= { on: true });
        overridesBox.append(
          h('div', { class: 'catalog-override' }, ui.storeChip(id),
            h('input', { class: 'input', type: 'number', min: 1, placeholder: t('catalog.field.price'), value: o.price ?? '', 'aria-label': t('catalog.field.price'), oninput: (e) => (o.price = e.target.value === '' ? null : e.target.value) }),
            h('input', { class: 'input', type: 'number', min: 0, placeholder: t('catalog.field.stock'), value: o.stock ?? '', 'aria-label': t('catalog.field.stock'), oninput: (e) => (o.stock = e.target.value === '' ? null : e.target.value) }),
          ),
        );
      }
    }

    // category: searchable list from Kaspi (needs one store with an API token)
    const catList = h('datalist', { id: 'catalogCategories' });
    const catInput = h('input', { class: 'input', list: 'catalogCategories', value: p.categoryTitle || p.category || '', placeholder: apiShop ? t('catalog.categoryPh') : t('catalog.categoryNoApi'), disabled: !apiShop });
    let categories = [];
    if (apiShop)
      send('ui:contentCategories', { shopId: apiShop }).then((r) => {
        if (!r?.ok) return ui.toast(ui.errorText(r?.error), 'error');
        categories = r.list;
        r.list.forEach((c) => catList.append(h('option', { value: c.title }, c.code)));
      });
    catInput.addEventListener('change', () => {
      const c = categories.find((x) => x.title === catInput.value || x.code === catInput.value);
      if ((c?.code || '') === p.category) return; // same category: keep the values already entered
      p.category = c?.code || '';
      p.categoryTitle = c?.title || '';
      p.attributes = {};
      attributeForm(attrsBox, p, apiShop);
    });
    if (p.category && apiShop) attributeForm(attrsBox, p, apiShop);

    const save = async (publish) => {
      // "Сохранить" keeps where the product sells; "Выложить" applies the chosen stores
      for (const s of stores()) p.stores[s.id] = { ...(p.stores[s.id] || {}), on: publish ? picked.includes(s.id) : !!existing?.stores?.[s.id]?.on };
      p.images = String(Array.isArray(p.images) ? p.images.join('\n') : p.images || '').split(/\s+/).filter(Boolean);
      const local = validateProduct(p, { requireCard: publish && createCard.checked });
      if (local.errors.length) return fail({ error: 'catalogInvalid', fields: local.errors });
      if (publish && !picked.length) return ui.toast(t('catalog.pickStores'), 'error');
      const res = await send('ui:catalogSave', { product: p, originalSku: existing?.sku || null });
      if (!res?.ok) return fail(res);
      if (publish && createCard.checked) {
        const pub = await send('ui:catalogPublish', { skus: [p.sku], shopIds: picked, createCard: true });
        reportPublish(pub);
      } else ui.toast(publish ? t('catalog.inPriceLists', { count: picked.length }) : t('catalog.saved'), 'ok');
      dlg.close();
      await load();
    };

    clear(dlg).append(
      h('form', { method: 'dialog', class: 'catalog-form', onsubmit: (e) => e.preventDefault() },
        h('h2', { class: 'dialog__title', id: 'productTitle' }, existing ? t('catalog.editTitle') : t('catalog.newTitle')),
        h('div', { class: 'catalog-grid' },
          field('sku', inp('sku', { maxlength: existing?.imported ? 64 : 20, dataset: { fkey: 'cat-sku' } }), t('catalog.skuHint')),
          field('title', inp('title')),
          field('brand', inp('brand')),
          field('price', inp('price', { type: 'number', min: 1 }), t('catalog.priceHint')),
          field('stock', inp('stock', { type: 'number', min: 0 })),
          field('preOrder', inp('preOrder', { type: 'number', min: 0, max: 30 }), t('catalog.preOrderHint')),
        ),
        h('fieldset', { class: 'catalog-section' }, h('legend', null, t('catalog.whereTitle')), picker.el, overridesBox),
        h('fieldset', { class: 'catalog-section' },
          h('legend', null, t('catalog.cardTitle')),
          h('label', { class: 'check' }, createCard, h('span', null, t('catalog.createCard'))),
          h('p', { class: 'muted small' }, apiShop ? t('catalog.cardHint') : t('catalog.cardNeedsApi')),
          field('category', h('span', null, catInput, catList)),
          field('description', h('textarea', { class: 'input', rows: 3, oninput: (e) => (p.description = e.target.value) }, p.description || '')),
          field('images', h('textarea', { class: 'input', rows: 2, placeholder: 'https://…/photo1.jpg', oninput: (e) => (p.images = e.target.value) }, (p.images || []).join('\n')), t('catalog.imagesHint')),
          attrsBox,
        ),
        h('div', { class: 'dialog__actions' },
          existing && h('button', { type: 'button', class: 'btn btn--ghost neg', onclick: async () => {
            if (!(await ui.confirmDialog(t('catalog.deleteTitle'), t('catalog.deleteText', { sku: existing.sku })))) return;
            await send('ui:catalogDelete', { skus: [existing.sku] });
            dlg.close();
            await load();
          } }, t('catalog.delete')),
          h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, t('common.cancel')),
          h('button', { type: 'button', class: 'btn', onclick: () => save(false) }, t('catalog.saveOnly')),
          h('button', { type: 'button', class: 'btn btn--primary', dataset: { action: 'publish' }, onclick: () => save(true) }, t('catalog.savePublish')),
        ),
      ),
    );
    renderOverrides();
    dlg.showModal();
  }

  function reportPublish(res) {
    if (!res?.ok) return fail(res);
    ui.toast(t('catalog.inPriceLists', { count: res.stores.length }), 'ok');
    const cards = Object.entries(res.cards || {});
    const bad = cards.filter(([, r]) => !r.ok);
    if (cards.length && !bad.length) ui.toast(t('catalog.cardsSent', { count: cards.length }), 'ok', 7000);
    bad.forEach(([id, r]) => ui.toast(`${ui.storeName(id)}: ${ui.errorText(r.error)}`, 'error', 9000));
  }

  /* ---------- bulk: put selected products on sale / take off ---------- */
  async function bulk(on) {
    const skus = [...cat.selected];
    if (!skus.length) return;
    const dlg = dialog();
    const picker = storePicker(stores().map((s) => s.id));
    const createCard = h('input', { type: 'checkbox', disabled: !on || !cat.data.apiStores.length });
    clear(dlg).append(
      h('form', { method: 'dialog', class: 'catalog-form', onsubmit: (e) => e.preventDefault() },
        h('h2', { class: 'dialog__title' }, on ? t('catalog.bulkOnTitle', { count: skus.length }) : t('catalog.bulkOffTitle', { count: skus.length })),
        h('p', { class: 'dialog__text' }, on ? t('catalog.bulkOnText') : t('catalog.bulkOffText')),
        h('fieldset', { class: 'catalog-section' }, h('legend', null, t('catalog.whereTitle')), picker.el),
        on && h('label', { class: 'check' }, createCard, h('span', null, t('catalog.createCard'))),
        h('div', { class: 'dialog__actions' },
          h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, t('common.cancel')),
          h('button', { type: 'button', class: ['btn', on ? 'btn--primary' : 'btn--danger'], dataset: { action: 'bulk' }, onclick: async () => {
            const ids = picker.chosen();
            if (!ids.length) return ui.toast(t('catalog.pickStores'), 'error');
            const res = await send('ui:catalogPublish', { skus, shopIds: ids, createCard: on && createCard.checked, on });
            if (on) reportPublish(res);
            else if (res?.ok) ui.toast(t('catalog.takenOff', { count: skus.length }), 'ok');
            else fail(res);
            if (res?.ok) (cat.selected.clear(), dlg.close(), await load());
          } }, on ? t('catalog.putOnSale') : t('catalog.takeOff')),
        ),
      ),
    );
    dlg.showModal();
  }

  /* ---------- price lists per store ---------- */
  function feedCard() {
    const list = stores();
    const rows = list.map((s) => {
      const f = cat.data.feeds[s.id] || {};
      const v = { merchantId: f.merchantId, company: f.company, warehouses: (f.warehouses || ['PP1']).join(', '), confirmed: f.confirmed };
      const status = !f.ready ? ['warn', t('catalog.feed.needsSetup')] : !f.confirmed ? ['warn', t('catalog.feed.notConfirmed')] : f.error ? ['danger', ui.errorText(f.error)] : f.url ? ['ok', t('catalog.feed.live', { count: f.uploadedOffers ?? f.offers, when: f.uploadedAt ? formatRelative(f.uploadedAt) : '' })] : ['info', t('catalog.feed.waiting')];
      const fileInput = h('input', { type: 'file', accept: '.xml,.xlsx', hidden: true, onchange: async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        try {
          if (/\.xlsx$/i.test(file.name) && typeof DecompressionStream === 'undefined') return ui.toast(ui.errorText('xlsxUnsupported'), 'error', 9000);
          const parsed = await readPriceListFile(await file.arrayBuffer());
          if (!parsed.offers.length) return ui.toast(t('catalog.importEmpty'), 'error');
          const ok = await ui.confirmDialog(t('catalog.importTitle'), t('catalog.importConfirm', { count: parsed.offers.length, store: ui.storeName(s.id) }));
          if (!ok) return;
          const res = await send('ui:catalogImport', { shopId: s.id, offers: parsed.offers, merchantId: parsed.merchantId, company: parsed.company, warehouses: [...new Set(parsed.offers.flatMap((o) => o.warehouses || []))] });
          if (!res?.ok) return fail(res);
          ui.toast(t('catalog.imported', { added: res.added, updated: res.updated }), 'ok', 8000);
          await load();
        } catch (err) {
          ui.toast(ui.errorText(err.message === 'noSkuColumn' || err.message === 'noPriceColumn' ? err.message : 'badFile'), 'error', 8000);
        }
      } });
      const confirmBox = h('input', { type: 'checkbox', checked: !!v.confirmed, onchange: (e) => (v.confirmed = e.target.checked) });
      const txt = (key, extra = {}) => h('input', { class: 'input', value: v[key] || '', ...extra, oninput: (e) => (v[key] = e.target.value) });
      return h('div', { class: 'feed', dataset: { shop: s.id } },
        h('div', { class: 'feed__head' }, ui.storeChip(s.id), h('span', { class: ['badge', `badge--${status[0]}`] }, status[1]), h('span', { class: 'muted small' }, t('catalog.feed.offers', { count: f.offers || 0 }))),
        h('div', { class: 'feed__grid' },
          h('label', { class: 'catalog-field' }, h('span', null, t('catalog.feed.merchantId')), txt('merchantId', { placeholder: '12345678' })),
          h('label', { class: 'catalog-field' }, h('span', null, t('catalog.feed.company')), txt('company')),
          h('label', { class: 'catalog-field' }, h('span', null, t('catalog.feed.warehouses')), txt('warehouses', { placeholder: 'PP1, PP2' })),
        ),
        h('label', { class: 'check feed__confirm' }, confirmBox, h('span', null, t('catalog.feed.confirm'))),
        f.url && h('div', { class: 'feed__url' }, h('code', null, f.url), h('button', { type: 'button', class: 'btn btn--sm', onclick: () => copyText(f.url).then(() => ui.toast(t('catalog.feed.copied'), 'ok')) }, t('catalog.feed.copy'))),
        f.url && h('p', { class: 'muted small' }, t('catalog.feed.howTo')),
        f.error === 'feedDrop' && f.drop && h('div', { class: 'banner banner--danger feed__drop' },
          h('span', { class: 'banner__text' }, t('catalog.feed.dropText', { from: f.drop.from, to: f.drop.to })),
          h('button', { type: 'button', class: 'btn btn--sm btn--danger', dataset: { action: 'allow-drop' }, onclick: async () => {
            const ok = await ui.confirmDialog(t('catalog.feed.dropTitle'), t('catalog.feed.dropConfirm', { from: f.drop.from, to: f.drop.to, store: ui.storeName(s.id) }));
            if (!ok) return;
            const res = await send('ui:feedSync', { shopIds: [s.id], allowDrop: true });
            const r = res?.results?.[s.id];
            if (!r?.ok) ui.toast(ui.errorText(r?.error || res?.error), 'error', 8000);
            else ui.toast(t('catalog.feed.saved'), 'ok');
            await load();
          } }, t('catalog.feed.dropAllow')),
        ),
        h('div', { class: 'feed__actions' },
          h('button', { type: 'button', class: 'btn btn--primary btn--sm', onclick: async () => {
            const res = await send('ui:feedSettings', { shopId: s.id, merchantId: v.merchantId, company: v.company, warehouses: v.warehouses, confirmed: v.confirmed });
            if (!res?.ok) return fail(res);
            if (res.sync && !res.sync.ok) ui.toast(ui.errorText(res.sync.error), 'error', 8000);
            else ui.toast(t('catalog.feed.saved'), 'ok');
            await load();
          } }, t('catalog.feed.save')),
          h('button', { type: 'button', class: 'btn btn--sm', onclick: () => fileInput.click() }, t('catalog.feed.import')),
          h('button', { type: 'button', class: 'btn btn--sm', disabled: !f.ready, onclick: async () => {
            const res = await send('ui:feedXml', { shopId: s.id });
            if (!res?.ok) return fail(res);
            const a = h('a', { href: URL.createObjectURL(new Blob([res.xml], { type: 'application/xml' })), download: res.name });
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
          } }, t('catalog.feed.download')),
          fileInput,
        ),
      );
    });
    return h('section', { class: 'card' },
      h('div', { class: 'card__header' }, h('div', null, h('h2', { class: 'card__title' }, t('catalog.feed.title')), h('div', { class: 'card__sub' }, cat.data.serverFeeds ? t('catalog.feed.sub') : t('catalog.feed.subNoServer')))),
      h('div', { class: 'card__body' }, h('div', { class: 'banner banner--warn' }, h('span', { class: 'banner__text' }, t('catalog.feed.warning'))), rows),
    );
  }

  /* ---------- main view ---------- */
  function cardBadge(c) {
    if (!c) return null;
    const s = c.uploadError ? 'ERROR' : c.state;
    const v = /FINISHED|SUCCESS|APPROVED/.test(s) ? 'ok' : /ERROR|FAIL|REJECT|ABORT/.test(s) ? 'danger' : 'info';
    const label = v === 'ok' ? t('catalog.card.done') : v === 'danger' ? t('catalog.card.error') : t('catalog.card.checking');
    return h('span', { class: ['badge', `badge--${v}`, 'small'], title: c.errors || c.uploadError || s }, label);
  }

  function view() {
    if (!cat.data) {
      load();
      return h('section', { class: 'card' }, h('div', { class: 'card__body' }, cat.error ? ui.errorText(cat.error) : t('common.loading')));
    }
    const list = stores();
    const products = cat.data.products.filter((p) => !cat.q || `${p.sku} ${p.title} ${p.brand}`.toLowerCase().includes(cat.q.toLowerCase()));
    const toolbar = h('div', { class: 'catalog-toolbar' },
      h('button', { type: 'button', class: 'btn btn--primary', dataset: { action: 'new' }, onclick: () => openProduct(null) }, t('catalog.add')),
      h('input', { class: 'input', type: 'search', placeholder: t('catalog.search'), value: cat.q, dataset: { fkey: 'cat-q' }, oninput: (e) => ((cat.q = e.target.value), ui.renderView()) }),
      h('span', { class: 'grow' }),
      cat.selected.size > 0 && h('span', { class: 'muted' }, t('catalog.selected', { count: cat.selected.size })),
      h('button', { type: 'button', class: 'btn', disabled: !cat.selected.size, onclick: () => bulk(true) }, t('catalog.putOnSale')),
      h('button', { type: 'button', class: 'btn', disabled: !cat.selected.size, onclick: () => bulk(false) }, t('catalog.takeOff')),
      cat.data.pendingImports > 0 && h('button', { type: 'button', class: 'btn btn--ghost', onclick: async () => (await send('ui:cardsRefresh'), load()) }, t('catalog.checkCards', { count: cat.data.pendingImports })),
    );
    const allBox = h('input', { type: 'checkbox', 'aria-label': t('catalog.selectAll'), checked: products.length > 0 && products.every((p) => cat.selected.has(p.sku)), onchange: (e) => (products.forEach((p) => (e.target.checked ? cat.selected.add(p.sku) : cat.selected.delete(p.sku))), ui.renderView()) });
    const table = products.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'data catalog-table' },
          h('thead', null, h('tr', null, h('th', null, allBox), h('th', null, t('catalog.field.sku')), h('th', null, t('catalog.field.title')), h('th', { class: 'num' }, t('catalog.field.price')), h('th', { class: 'num' }, t('catalog.field.stock')), list.map((s) => h('th', null, ui.storeChip(s.id))))),
          h('tbody', null, products.map((p) =>
            h('tr', { dataset: { sku: p.sku } },
              h('td', null, h('input', { type: 'checkbox', checked: cat.selected.has(p.sku), 'aria-label': p.sku, onchange: (e) => (e.target.checked ? cat.selected.add(p.sku) : cat.selected.delete(p.sku), ui.renderView()) })),
              h('td', { class: 'mono' }, h('a', { href: '#catalog', onclick: (e) => (e.preventDefault(), openProduct(p)) }, p.sku)),
              h('td', null, p.title, h('div', { class: 'muted small' }, p.brand, p.categoryTitle && ` · ${p.categoryTitle}`)),
              h('td', { class: 'num' }, formatMoney(p.price)),
              h('td', { class: 'num' }, p.stock ?? 0, p.preOrder ? h('div', { class: 'muted small' }, t('catalog.preOrderDays', { count: p.preOrder })) : null),
              list.map((s) => {
                const o = p.stores?.[s.id];
                return h('td', null, o?.on ? h('span', { class: 'badge badge--ok' }, t('catalog.onSale')) : h('span', { class: 'muted' }, '—'), ' ', cardBadge(p.cards?.[s.id]));
              }),
            ),
          )),
        ))
      : ui.emptyState(t('catalog.emptyTitle'), t('catalog.emptyText'));
    return h('div', { class: 'catalog' },
      h('section', { class: 'card', style: { marginBottom: '16px' } }, h('div', { class: 'card__body' }, toolbar, table)),
      list.length ? feedCard() : null,
    );
  }

  return { view, reload: load, isSkuValid: (s) => SKU_RE.test(s) };
}
