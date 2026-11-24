/**
 * SaudaPulse — staff: sign-in screen of a «Компьютер склада», the packer panel
 * («сканируй и проверяй», the model of ShipStation Scan-to-Verify / pack stations), and the
 * owner's cards «Сотрудники» and «Компьютер склада».
 *
 * The packer sees only what packing needs: the queue of orders to assemble in the stores the
 * owner gave them, product photos, quantities, the scanner check, «Упаковать и напечатать».
 * No money, profit, payments, settings, tokens or other stores.
 */
import { h, clear, deadlineOf, urgencyOf } from '../shared/utils.js';
import { t, formatDate, getLang } from '../shared/i18n.js';
import { getCaptchaToken } from '../shared/captcha.js';
import { svgIcon } from '../shared/icons.js';

const send = (type, payload) => chrome.runtime.sendMessage({ type, payload });
const store = chrome.storage.local;

/* ---------- sounds: short high = ok, low = wrong ---------- */
let audio;
function beep(ok) {
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = ok ? 1200 : 220;
    o.type = ok ? 'sine' : 'square';
    g.gain.value = 0.08;
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + (ok ? 0.08 : 0.35));
  } catch {
    /* no audio: the colours still show it */
  }
}

/* ---------- order ↔ scanned code ---------- */
const digits = (s) => String(s ?? '').replace(/\D/g, '');
/**
 * Does a scanned code belong to this order? The Kaspi waybill barcode is the waybill / order
 * number, sometimes with the place number after it («…604-1»).
 */
export function codeMatchesOrder(code, order) {
  const d = digits(code);
  if (!d) return false;
  return [order.id, order.api?.code, order.api?.waybillNumber].map(digits).filter((k) => k.length >= 6).some((k) => d === k || (d.startsWith(k) && d.length - k.length <= 3));
}

/**
 * Lines to check for an order: one per product, with the needed quantity.
 * @returns {{ key:string, sku:string, name:string, need:number, done:number, how:Set<string> }[]}
 */
export function linesOf(order) {
  const map = new Map();
  for (const e of order.entries || []) {
    const key = e.sku || e.name;
    const l = map.get(key) || { key, sku: e.sku || '', name: e.name || e.category || '—', need: 0, done: 0, how: new Set() };
    l.need += e.quantity || 1;
    map.set(key, l);
  }
  return [...map.values()];
}

/* ===================================================================== */
/* Sign-in screen of a «Компьютер склада»                                 */
/* ===================================================================== */
export function renderLockScreen(root, ctx) {
  const ui = (ctx.state.lock ??= { tab: 'staff', step: 'pick', email: '', error: '' });
  const err = h('p', { class: 'neg small lock__err', role: 'alert' }, ui.error ? ctx.errorText(ui.error) : '');
  const fail = (res) => {
    ui.error = res?.error || 'noResponse';
    renderLockScreen(root, ctx);
  };
  const st = ctx.state.staffInfo || {};
  const known = st.known || [];
  const input = (attrs) => h('input', { class: 'input', ...attrs });

  let body;
  if (ui.tab === 'owner') {
    const pin = input({ type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: '••••', 'aria-label': t('staff.ownerPin'), dataset: { field: 'ownerPin' } });
    body = h('form', { class: 'lock__form', onsubmit: async (e) => {
      e.preventDefault();
      const res = await send('ui:ownerUnlock', { pin: pin.value });
      if (!res?.ok) return fail(res);
      ui.error = '';
      ctx.onChange();
    } }, h('label', { class: 'catalog-field' }, h('span', null, t('staff.ownerPin')), pin), h('button', { class: 'btn btn--primary', type: 'submit' }, t('staff.unlock')));
    setTimeout(() => pin.focus(), 0);
  } else if (ui.step === 'pick' && known.length) {
    const sel = h('select', { class: 'select', 'aria-label': t('staff.who'), dataset: { field: 'who' } }, known.map((k) => h('option', { value: k.email, selected: k.email === ui.email }, k.name)));
    const pin = input({ type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: '••••', 'aria-label': t('staff.pin'), dataset: { field: 'pin' } });
    body = h('form', { class: 'lock__form', onsubmit: async (e) => {
      e.preventDefault();
      ui.email = sel.value;
      const res = await send('ui:staffPinLogin', { email: sel.value, pin: pin.value });
      if (!res?.ok) return fail(res);
      ui.error = '';
      ctx.onChange();
    } },
      h('label', { class: 'catalog-field' }, h('span', null, t('staff.who')), sel),
      h('label', { class: 'catalog-field' }, h('span', null, t('staff.pin')), pin),
      h('button', { class: 'btn btn--primary', type: 'submit' }, t('staff.signIn')),
      h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => ((ui.step = 'email'), (ui.error = ''), renderLockScreen(root, ctx)) }, t('staff.firstTime')));
    setTimeout(() => pin.focus(), 0);
  } else if (ui.step === 'code') {
    const code = input({ inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456', 'aria-label': t('staff.code'), dataset: { field: 'code' } });
    const pin = input({ type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: '4–8 цифр', 'aria-label': t('staff.newPin'), dataset: { field: 'newPin' } });
    const pin2 = input({ type: 'password', inputmode: 'numeric', autocomplete: 'off', 'aria-label': t('staff.newPin2'), dataset: { field: 'newPin2' } });
    body = h('form', { class: 'lock__form', onsubmit: async (e) => {
      e.preventDefault();
      if (pin.value !== pin2.value) return fail({ error: 'staffPinMismatch' });
      const res = await send('ui:staffVerify', { email: ui.email, code: code.value, pin: pin.value });
      if (!res?.ok) return fail(res);
      Object.assign(ui, { error: '', step: 'pick' });
      ctx.onChange();
    } },
      h('p', { class: 'muted small' }, t('staff.codeSent', { email: ui.email })),
      h('label', { class: 'catalog-field' }, h('span', null, t('staff.code')), code),
      h('label', { class: 'catalog-field' }, h('span', null, t('staff.newPin')), pin),
      h('label', { class: 'catalog-field' }, h('span', null, t('staff.newPin2')), pin2),
      h('button', { class: 'btn btn--primary', type: 'submit' }, t('staff.signIn')));
    setTimeout(() => code.focus(), 0);
  } else {
    const email = input({ type: 'email', autocomplete: 'email', placeholder: 'name@example.kz', value: ui.email, 'aria-label': t('staff.email'), dataset: { field: 'email' } });
    body = h('form', { class: 'lock__form', onsubmit: async (e) => {
      e.preventDefault();
      ui.email = email.value.trim().toLowerCase();
      let captchaToken = null;
      try { captchaToken = await getCaptchaToken({ t, lang: getLang() }); } catch { return; }
      const res = await send('ui:staffRequestCode', { email: ui.email, captchaToken });
      if (!res?.ok) return fail(res);
      Object.assign(ui, { error: '', step: 'code' });
      renderLockScreen(root, ctx);
    } },
      h('p', { class: 'muted small' }, t('staff.firstHint')),
      h('label', { class: 'catalog-field' }, h('span', null, t('staff.email')), email),
      h('button', { class: 'btn btn--primary', type: 'submit' }, t('staff.getCode')),
      known.length ? h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => ((ui.step = 'pick'), (ui.error = ''), renderLockScreen(root, ctx)) }, t('common.back')) : null);
    setTimeout(() => email.focus(), 0);
  }
  const tab = (id, label) => h('button', { type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(ui.tab === id), onclick: () => ((ui.tab = id), (ui.error = ''), renderLockScreen(root, ctx)) }, label);
  clear(root).append(
    h('div', { class: 'lock' },
      h('div', { class: 'lock__card' },
        h('div', { class: 'lock__brand' }, h('img', { src: '../icons/icon-128.png', alt: '', width: 36, height: 36 }), h('div', null, h('b', null, t('staff.warehouseTitle')), h('div', { class: 'muted small' }, t('staff.warehouseSub')))),
        h('div', { class: 'tabs', role: 'tablist' }, tab('staff', t('staff.tabStaff')), tab('owner', t('staff.tabOwner'))),
        body,
        err,
      ),
    ),
  );
}

/* ===================================================================== */
/* Packer panel                                                           */
/* ===================================================================== */
export function renderPacker(root, ctx) {
  const me = ctx.state.staffInfo.active;
  const P = (ctx.state.pack ??= { current: null, lines: [], wrong: 0, startedAt: 0, flash: '', bind: null, barcodes: {}, busy: false });
  const sn = ctx.settingsNow();
  // the queue: orders to assemble in the stores this packer may see, most urgent first
  const orders = ctx
    .allOrders()
    .filter((o) => o.kind === 'order' && (o.status === 'accepted' || (o.status === 'new' && me.canAccept)) && (!me.shopIds.length || me.shopIds.includes(o.shopId)))
    .map((o) => ({ ...o, dl: deadlineOf(o, sn), urg: urgencyOf(deadlineOf(o, sn), sn) }))
    .sort((a, b) => (a.dl?.at ?? Infinity) - (b.dl?.at ?? Infinity));
  const cur = P.current && orders.find((o) => o.shopId === P.current.shopId && o.id === P.current.id);
  if (P.current && !cur) Object.assign(P, { current: null, lines: [] }); // packed or gone

  const open = (o) => {
    Object.assign(P, { current: { shopId: o.shopId, id: o.id }, lines: linesOf(o), wrong: 0, startedAt: Date.now(), flash: '', bind: null });
    renderPacker(root, ctx);
  };
  const allDone = () => P.lines.length && P.lines.every((l) => l.done >= l.need);
  const flash = (kind, text) => {
    P.flash = kind;
    P.flashText = text;
    beep(kind === 'ok');
    renderPacker(root, ctx);
    clearTimeout(P.flashTimer);
    P.flashTimer = setTimeout(() => ((P.flash = ''), renderPacker(root, ctx)), kind === 'ok' ? 500 : 1600);
  };

  /** One scan (scanner = keyboard + Enter) or a typed code. */
  P.onScan = async (code) => {
    code = String(code || '').trim();
    if (!code) return;
    if (!P.current) {
      const o = orders.find((x) => codeMatchesOrder(code, x));
      if (!o) return flash('bad', t('pack.noOrder', { code }));
      beep(true);
      return open(o);
    }
    const o = orders.find((x) => x.shopId === P.current.shopId && x.id === P.current.id);
    if (o && codeMatchesOrder(code, o)) return flash('ok', t('pack.sameOrder'));
    P.barcodes = (await store.get('ksh.barcodes'))['ksh.barcodes'] || {};
    const line = P.lines.find((l) => (P.barcodes[l.sku] || []).includes(code) && l.done < l.need);
    if (line) {
      line.done++;
      line.how.add('scan');
      return flash('ok', `${line.name}: ${line.done} / ${line.need}`);
    }
    const known = P.lines.find((l) => (P.barcodes[l.sku] || []).includes(code));
    if (known) {
      P.wrong++;
      return flash('bad', t('pack.tooMany', { name: known.name }));
    }
    const unbound = P.lines.filter((l) => l.sku && !(P.barcodes[l.sku] || []).length && l.done < l.need);
    if (unbound.length) {
      // a product without a remembered barcode: ask which one it is (once; then it is known)
      P.bind = { code, lines: unbound.map((l) => l.key) };
      beep(true);
      return renderPacker(root, ctx);
    }
    P.wrong++;
    flash('bad', t('pack.wrongItem'));
  };

  const finish = async (o) => {
    if (P.busy) return;
    P.busy = true;
    renderPacker(root, ctx);
    try {
      const item = [{ shopId: o.shopId, orderId: o.id, url: o.url }];
      if (o.status === 'new') {
        const a = await send('ui:accept', { items: item });
        const r = a?.results?.[0];
        if (!a?.ok && !r?.ok) return ctx.toast(ctx.errorText(r?.error || a?.error), 'error', 8000);
        await send('ui:packLogAdd', { entry: { action: 'accepted', shopId: o.shopId, orderId: o.id } });
      }
      const res = await send('ui:pack', { items: item });
      const r = res?.results?.[0];
      if (r && !r.ok) return ctx.toast(ctx.errorText(r.error), 'error', 8000);
      if (!r && res?.ok === false) return ctx.toast(ctx.errorText(res.error), 'error', 8000);
      const manual = P.lines.some((l) => l.how.has('manual'));
      await send('ui:packLogAdd', { entry: { action: 'packed', shopId: o.shopId, orderId: o.id, checked: manual ? 'manual' : 'scan', wrongScans: P.wrong, seconds: (Date.now() - P.startedAt) / 1000 } });
      await send('ui:print', { items: item });
      ctx.toast(t('pack.done', { id: o.id }), 'ok');
      Object.assign(P, { current: null, lines: [] });
      ctx.refresh();
    } finally {
      P.busy = false;
      renderPacker(root, ctx);
    }
  };

  const problem = async (o) => {
    const note = ctx.promptReason ? await ctx.promptReason() : '';
    if (note == null) return;
    await send('ui:packProblem', { shopId: o.shopId, orderId: o.id, note });
    ctx.toast(t('pack.problemSent'), 'ok');
    Object.assign(P, { current: null, lines: [] });
    renderPacker(root, ctx);
  };

  /* ----- layout ----- */
  const scanInput = h('input', { class: 'input pack__scan', id: 'packScan', autocomplete: 'off', placeholder: t(P.current ? 'pack.scanItem' : 'pack.scanOrder'), 'aria-label': t('pack.scanLabel'),
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = e.target.value;
        e.target.value = '';
        P.onScan(v);
      }
    } });
  const header = h('header', { class: 'pack__top' },
    h('div', { class: 'pack__who' }, h('b', null, t('pack.title')), h('span', { class: 'muted' }, ` · ${me.name}`)),
    scanInput,
    h('button', { type: 'button', class: 'btn btn--sm', dataset: { action: 'pack-refresh' }, onclick: () => ctx.refresh() }, t('common.refresh')),
    h('button', { type: 'button', class: 'btn btn--sm', dataset: { action: 'staff-logout' }, onclick: async () => {
      await send('ui:staffLogout');
      ctx.onChange();
    } }, t('staff.signOut')));

  const queue = h('aside', { class: 'pack__queue', 'aria-label': t('pack.queue') },
    h('div', { class: 'pack__qhead' }, t('pack.queueCount', { count: orders.length })),
    orders.length
      ? h('ul', { class: 'pack__list' }, orders.map((o) => h('li', null,
          h('button', { type: 'button', class: ['pack__qitem', cur && cur.id === o.id && cur.shopId === o.shopId && 'is-current', (o.urg === 'soon' || o.urg === 'overdue') && 'is-hot'], dataset: { order: o.id }, onclick: () => open(o) },
            h('span', { class: 'pack__qid' }, o.id),
            h('span', { class: 'pack__qmeta' }, ctx.storeChip(o.shopId), ' ', o.status === 'new' ? h('span', { class: 'badge badge--info' }, t('status.new')) : null),
            o.dl ? h('span', { class: ['pack__qdl', (o.urg === 'soon' || o.urg === 'overdue') && 'neg'] }, (o.urg === 'soon' || o.urg === 'overdue') ? svgIcon('fire', { size: 12 }) : null, formatDate(new Date(o.dl.at).toISOString(), 'time')) : null,
          ))))
      : h('p', { class: 'muted pack__empty' }, t('pack.queueEmpty')));

  let work;
  if (!cur) {
    // «not found» etc. must be visible here too: otherwise a scan seems to do nothing
    work = h('section', { class: ['pack__idle', P.flash && `pack--${P.flash}`] },
      P.flash ? h('div', { class: `pack__flash pack__flash--${P.flash}`, role: 'status' }, P.flashText) : null,
      svgIcon('arrow', { size: 28 }), h('h2', null, t('pack.idleTitle')), h('p', { class: 'muted' }, t('pack.idleText')));
  } else {
    const lines = P.lines;
    const ready = allDone();
    work = h('section', { class: ['pack__work', P.flash && `pack--${P.flash}`] },
      h('div', { class: 'pack__ohead' },
        h('h2', null, t('pack.order', { id: cur.id })), ctx.storeChip(cur.shopId),
        cur.dl ? h('span', { class: ['badge', (cur.urg === 'soon' || cur.urg === 'overdue') ? 'badge--danger' : 'badge--info'] }, t('pack.until', { time: formatDate(new Date(cur.dl.at).toISOString(), 'datetime') })) : null,
        h('span', { class: 'grow' }),
        h('button', { type: 'button', class: 'btn btn--sm btn--ghost', onclick: () => (Object.assign(P, { current: null, lines: [] }), renderPacker(root, ctx)) }, t('common.close'))),
      P.flash ? h('div', { class: `pack__flash pack__flash--${P.flash}`, role: 'status' }, P.flashText) : null,
      P.bind ? h('div', { class: 'pack__bind', role: 'dialog', 'aria-label': t('pack.bindTitle') },
        h('b', null, t('pack.bindTitle')), h('span', { class: 'muted small' }, ` ${P.bind.code}`),
        h('div', { class: 'pack__bindlist' }, P.bind.lines.map((k) => {
          const l = lines.find((x) => x.key === k);
          return h('button', { type: 'button', class: 'btn', onclick: async () => {
            await send('ui:setBarcode', { sku: l.sku, code: P.bind.code });
            P.bind = null;
            l.done++;
            l.how.add('scan');
            flash('ok', `${l.name}: ${l.done} / ${l.need}`);
          } }, ctx.thumb(l.key, { size: 32 }), ' ', l.name);
        })),
        h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => ((P.bind = null), (P.wrong++), renderPacker(root, ctx)) }, t('pack.bindNone'))) : null,
      h('ul', { class: 'pack__lines' }, lines.map((l) => h('li', { class: ['pack__line', l.done >= l.need && 'is-done'], dataset: { sku: l.sku } },
        ctx.thumb(l.key, { size: 96, name: l.name }),
        h('div', { class: 'pack__lname' }, h('b', null, l.name), l.sku ? h('div', { class: 'muted mono small' }, l.sku) : null),
        h('div', { class: 'pack__count' }, h('span', { class: 'pack__done' }, String(l.done)), h('span', { class: 'muted' }, ` / ${l.need}`)),
        l.done < l.need
          ? h('button', { type: 'button', class: 'btn btn--sm btn--ghost', title: t('pack.manualHint'), dataset: { action: 'manual' }, onclick: () => {
              l.done = l.need;
              l.how.add('manual');
              renderPacker(root, ctx);
            } }, t('pack.manual'))
          : h('span', { class: 'pack__ok' }, '✓')))),
      h('div', { class: 'pack__actions' },
        h('button', { type: 'button', class: 'btn btn--ghost', dataset: { action: 'pack-problem' }, onclick: () => problem(cur) }, t('pack.problem')),
        h('span', { class: 'grow' }),
        h('span', { class: 'muted small' }, ready ? t('pack.allChecked') : t('pack.checkAll')),
        h('button', { type: 'button', class: 'btn btn--primary btn--lg', dataset: { action: 'pack-finish' }, disabled: !ready || P.busy, onclick: () => finish(cur) },
          cur.status === 'new' ? t('pack.acceptAndPack') : t('pack.packAndPrint'))));
  }
  clear(root).append(h('div', { class: 'pack' }, header, h('div', { class: 'pack__body' }, queue, work)));
  // the scanner types into the page: keep the scan field focused unless a button/field is used
  if (!root.contains(document.activeElement) || document.activeElement === document.body) setTimeout(() => document.getElementById('packScan')?.focus(), 0);
}

/* ===================================================================== */
/* Owner: «Сотрудники» and «Компьютер склада» cards                       */
/* ===================================================================== */
export function teamCard(ctx) {
  const ui = (ctx.state.team ??= { list: null, loading: false, error: '', form: { email: '', name: '', shopIds: [], canAccept: false } });
  const body = h('div', { class: 'team' });
  const stores = ctx.stores();
  const draw = () => {
    clear(body);
    if (ui.error) body.append(h('p', { class: 'neg small' }, ctx.errorText(ui.error)));
    // invite form
    const f = ui.form;
    const shopBoxes = h('div', { class: 'team__shops' }, stores.map((s) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !f.shopIds.length || f.shopIds.includes(s.id), onchange: (e) => {
      const all = stores.map((x) => x.id);
      const cur = f.shopIds.length ? f.shopIds : all;
      const next = e.target.checked ? [...new Set([...cur, s.id])] : cur.filter((x) => x !== s.id);
      f.shopIds = next.length === all.length ? [] : next;
    } }), ctx.storeChip(s.id))));
    body.append(
      h('form', { class: 'team__invite', onsubmit: async (e) => {
        e.preventDefault();
        const res = await send('ui:teamInvite', { email: f.email, name: f.name, shopIds: f.shopIds, canAccept: f.canAccept });
        if (!res?.ok) return ((ui.error = res?.error), draw());
        ui.error = '';
        ui.lastInvite = res.member;
        ui.form = { email: '', name: '', shopIds: [], canAccept: false };
        await load();
      } },
        h('label', { class: 'catalog-field' }, h('span', null, t('team.name')), h('input', { class: 'input', required: true, maxlength: 60, value: f.name, dataset: { field: 'teamName' }, oninput: (e) => (f.name = e.target.value) })),
        h('label', { class: 'catalog-field' }, h('span', null, t('team.email')), h('input', { class: 'input', type: 'email', required: true, value: f.email, dataset: { field: 'teamEmail' }, oninput: (e) => (f.email = e.target.value) })),
        h('div', { class: 'catalog-field' }, h('span', null, t('team.shops')), shopBoxes),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.canAccept, onchange: (e) => (f.canAccept = e.target.checked) }), t('team.canAccept')),
        h('button', { class: 'btn btn--primary', type: 'submit', dataset: { action: 'team-invite' } }, t('team.invite'))),
    );
    if (ui.lastInvite) {
      const text = t('team.inviteText', { name: ui.lastInvite.name, email: ui.lastInvite.email });
      body.append(h('div', { class: 'banner banner--info team__share', dataset: { block: 'invite-text' } },
        h('span', { class: 'banner__text' }, h('b', null, t('team.inviteReady')), h('pre', { class: 'team__text' }, text)),
        h('button', { type: 'button', class: 'btn btn--sm', onclick: async () => {
          await navigator.clipboard.writeText(text).catch(() => {});
          ctx.toast(t('team.copied'), 'ok');
        } }, t('team.copy')),
        h('a', { class: 'btn btn--sm', href: `https://wa.me/?text=${encodeURIComponent(text)}`, target: '_blank', rel: 'noopener' }, 'WhatsApp'),
        h('a', { class: 'btn btn--sm', href: `https://t.me/share/url?url=${encodeURIComponent(' ')}&text=${encodeURIComponent(text)}`, target: '_blank', rel: 'noopener' }, 'Telegram'),
        h('a', { class: 'btn btn--sm', href: `mailto:${encodeURIComponent(ui.lastInvite.email)}?subject=${encodeURIComponent(t('team.mailSubject'))}&body=${encodeURIComponent(text)}` }, t('team.byMail'))));
    }
    // the team
    if (ui.list == null) body.append(h('p', { class: 'muted' }, t('common.loading')));
    else if (!ui.list.length) body.append(h('p', { class: 'muted' }, t('team.empty')));
    else
      body.append(h('table', { class: 'data team__table' },
        h('thead', null, h('tr', null, [t('team.name'), t('team.email'), t('team.shops'), t('team.status'), t('team.lastSeen'), ''].map((x) => h('th', null, x)))),
        h('tbody', null, ui.list.map((m) => h('tr', { dataset: { member: m.email } },
          h('td', null, h('b', null, m.name), m.can_accept ? h('div', { class: 'muted small' }, t('team.canAcceptShort')) : null),
          h('td', null, m.email),
          h('td', null, m.shop_ids.length ? m.shop_ids.map((id) => ctx.storeChip(id)) : t('team.allShops')),
          h('td', null, h('span', { class: ['badge', m.status === 'active' ? 'badge--ok' : m.status === 'disabled' ? 'badge--danger' : 'badge--warn'] }, t(`team.st.${m.status}`))),
          h('td', { class: 'muted' }, m.last_seen_at ? ctx.formatRelative(m.last_seen_at) : '—'),
          h('td', { class: 'team__acts' },
            m.status === 'disabled'
              ? h('button', { type: 'button', class: 'btn btn--sm', dataset: { action: 'team-enable' }, onclick: () => act('ui:teamSetEnabled', { id: m.id, enabled: true }) }, t('team.enable'))
              : h('button', { type: 'button', class: 'btn btn--sm btn--danger', dataset: { action: 'team-disable' }, onclick: async () => {
                  if (await ctx.confirmDialog(t('team.disableTitle'), t('team.disableText', { name: m.name }))) act('ui:teamSetEnabled', { id: m.id, enabled: false });
                } }, t('team.disable')),
            h('button', { type: 'button', class: 'btn btn--sm btn--ghost', dataset: { action: 'team-remove' }, onclick: async () => {
              if (await ctx.confirmDialog(t('team.removeTitle'), t('team.removeText', { name: m.name }))) act('ui:teamRemove', { id: m.id });
            } }, t('common.remove'))))))));
  };
  const act = async (type, payload) => {
    const res = await send(type, payload);
    if (!res?.ok) ui.error = res?.error;
    else ui.error = '';
    await load();
  };
  const load = async () => {
    const res = await send('ui:teamList');
    if (res?.ok) Object.assign(ui, { list: res.list || [], error: ui.error });
    else Object.assign(ui, { list: [], error: res?.error });
    draw();
  };
  draw();
  if (ui.list == null && !ui.loading) {
    ui.loading = true;
    load().finally(() => (ui.loading = false));
  }
  return h('section', { class: 'card', dataset: { card: 'team' } },
    h('div', { class: 'card__header' }, h('div', null, h('h2', { class: 'card__title' }, t('team.title')), h('div', { class: 'card__sub' }, t('team.hint')))),
    h('div', { class: 'card__body' }, body));
}

export function warehouseCard(ctx) {
  const info = ctx.state.staffInfo || {};
  const pin = h('input', { class: 'input', type: 'password', inputmode: 'numeric', autocomplete: 'new-password', placeholder: '4–8 цифр', style: { width: '140px' }, 'aria-label': t('staff.ownerPin'), dataset: { field: 'warehousePin' } });
  const body = info.warehouse
    ? h('div', { class: 'warehouse' },
        h('p', null, h('span', { class: 'badge badge--ok' }, t('staff.warehouseOn')), ' ', t('staff.warehouseOnText')),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          h('button', { type: 'button', class: 'btn btn--primary', dataset: { action: 'owner-lock' }, onclick: async () => {
            await send('ui:ownerLock');
            ctx.onChange();
          } }, t('staff.lockNow')),
          h('button', { type: 'button', class: 'btn', dataset: { action: 'warehouse-off' }, onclick: async () => {
            await send('ui:warehouseSet', { enabled: false });
            ctx.onChange();
          } }, t('staff.warehouseOff'))))
    : h('form', { class: 'warehouse', onsubmit: async (e) => {
        e.preventDefault();
        const res = await send('ui:warehouseSet', { enabled: true, pin: pin.value });
        if (!res?.ok) return ctx.toast(ctx.errorText(res?.error), 'error');
        ctx.toast(t('staff.warehouseSaved'), 'ok');
        ctx.onChange();
      } },
        h('p', { class: 'muted small' }, t('staff.warehouseHow')),
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'end', flexWrap: 'wrap' } },
          h('label', { class: 'catalog-field' }, h('span', null, t('staff.ownerPinNew')), pin),
          h('button', { type: 'submit', class: 'btn btn--primary', dataset: { action: 'warehouse-on' } }, t('staff.warehouseEnable'))));
  return h('section', { class: 'card', dataset: { card: 'warehouse' } },
    h('div', { class: 'card__header' }, h('div', null, h('h2', { class: 'card__title' }, t('staff.warehouseTitle')), h('div', { class: 'card__sub' }, t('staff.warehouseHint')))),
    h('div', { class: 'card__body' }, body));
}

/** Owner: packing journal (last entries) — who packed what, how it was checked, problems. */
export function journalCard(ctx) {
  const ui = (ctx.state.journal ??= { log: null });
  const body = h('div');
  const draw = () => {
    clear(body);
    if (!ui.log) return body.append(h('p', { class: 'muted' }, t('common.loading')));
    if (!ui.log.length) return body.append(h('p', { class: 'muted' }, t('journal.empty')));
    body.append(h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', null, h('tr', null, [t('journal.when'), t('journal.who'), t('journal.what'), t('table.order'), t('journal.check'), t('journal.note')].map((x) => h('th', null, x)))),
      h('tbody', null, ui.log.slice(0, 100).map((r) => h('tr', { class: r.action === 'problem' && 'row--problem' },
        h('td', { class: 'muted' }, formatDate(new Date(r.at).toISOString(), 'datetime')),
        h('td', null, r.staff || t('journal.owner')),
        h('td', null, t(`journal.a.${r.action}`)),
        h('td', null, r.orderId ? [r.orderId, ' ', r.shopId ? ctx.storeChip(r.shopId) : null] : '—'),
        h('td', null, r.checked ? t(`journal.c.${r.checked}`) : '—', r.wrongScans ? h('span', { class: 'neg small' }, ` · ${t('journal.wrong', { count: r.wrongScans })}`) : null, r.seconds ? h('span', { class: 'muted small' }, ` · ${Math.round(r.seconds / 60) || '<1'} ${t('journal.min')}`) : null),
        h('td', { class: 'wrap' }, r.note || '')))))));
  };
  send('ui:packLogGet').then((res) => ((ui.log = res?.log || []), draw()));
  draw();
  return h('section', { class: 'card', dataset: { card: 'journal' } },
    h('div', { class: 'card__header' }, h('div', null, h('h2', { class: 'card__title' }, t('journal.title')), h('div', { class: 'card__sub' }, t('journal.hint')))),
    h('div', { class: 'card__body' }, body));
}
