/*
 * Kaspi Seller Hub — owner's admin page for subscriptions.
 * Plain script (works when opened as a local file). Talks to Supabase with the
 * public anon key + the admin's own login; every admin action is checked again
 * in the database (public.is_admin()). Client data is rendered as text only.
 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const LS = { url: 'kshAdmin.url', key: 'kshAdmin.key', session: 'kshAdmin.session' };
  const store = {
    get: (k) => {
      try {
        return JSON.parse(localStorage.getItem(k));
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {
        /* storage blocked */
      }
    },
    del: (k) => {
      try {
        localStorage.removeItem(k);
      } catch {
        /* storage blocked */
      }
    },
  };
  let tab = 'pending';

  /* ---------- helpers ---------- */
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k in n && typeof v !== 'string') n[k] = v;
      else n.setAttribute(k, v);
    });
    kids.flat().forEach((c) => c != null && c !== false && n.append(c instanceof Node ? c : document.createTextNode(String(c))));
    return n;
  }
  const money = (n) => (n == null ? '—' : new Intl.NumberFormat('ru-RU').format(n) + ' ₸');
  const date = (v, time) => (v ? new Intl.DateTimeFormat('ru-RU', time ? { dateStyle: 'short', timeStyle: 'short' } : { dateStyle: 'short' }).format(new Date(v)) : '—');
  const phone = (p) => (p && /^7\d{10}$/.test(p) ? `+7 ${p.slice(1, 4)} ${p.slice(4, 7)} ${p.slice(7, 9)} ${p.slice(9)}` : p || '—');
  function toast(text, error) {
    const t = el('div', { class: 'toast' + (error ? ' toast--error' : '') }, text);
    $('msg').append(t);
    setTimeout(() => t.remove(), 6000);
  }

  /* ---------- Supabase calls ---------- */
  const cfg = () => ({ url: (store.get(LS.url) || '').replace(/\/$/, ''), key: store.get(LS.key) || '' });

  async function http(path, body, token) {
    const { url, key } = cfg();
    const res = await fetch(url + path, {
      method: 'POST',
      headers: { apikey: key, Authorization: 'Bearer ' + (token || key), 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) throw new Error((data && (data.message || data.msg || data.error_description || data.error)) || 'HTTP ' + res.status);
    return data;
  }

  async function token() {
    const s = store.get(LS.session);
    if (!s) return null;
    if (s.expires_at - 60000 > Date.now()) return s.access_token;
    try {
      const f = await http('/auth/v1/token?grant_type=refresh_token', { refresh_token: s.refresh_token });
      store.set(LS.session, { ...s, access_token: f.access_token, refresh_token: f.refresh_token, expires_at: Date.now() + f.expires_in * 1000 });
      return f.access_token;
    } catch {
      store.del(LS.session);
      return null;
    }
  }

  async function rpc(fn, args) {
    const tk = await token();
    if (!tk) {
      show();
      throw new Error('Войдите снова');
    }
    return http('/rest/v1/rpc/' + fn, args || {}, tk);
  }

  /* ---------- screens ---------- */
  async function show() {
    const { url, key } = cfg();
    $('url').value = url;
    $('key').value = key;
    const configured = !!(url && key);
    const s = store.get(LS.session);
    $('connCard').hidden = configured && !!s;
    $('loginCard').hidden = !configured || !!s;
    $('app').hidden = !s;
    $('logout').hidden = !s;
    $('who').textContent = s ? s.email : '';
    if (s) {
      try {
        if (!(await rpc('is_admin'))) {
          toast('Этот email не администратор. Добавьте его в таблицу admins (см. billing/README.md).', true);
          $('panel').replaceChildren(el('p', { class: 'muted' }, 'Нет прав администратора.'));
          return;
        }
        await render();
      } catch (e) {
        toast(e.message, true);
      }
    }
  }

  async function render() {
    document.querySelectorAll('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    const panel = $('panel');
    panel.replaceChildren(el('p', { class: 'muted' }, 'Загрузка…'));
    const pending = await rpc('admin_invoices', { p_status: 'pending' });
    $('pendingCount').textContent = pending.length || '';
    if (tab === 'accounts') return renderAccounts(panel);
    if (tab === 'config') return renderConfig(panel);
    const list = tab === 'pending' ? pending : await rpc('admin_invoices', { p_status: tab === 'paid' ? 'paid' : 'all' });
    renderInvoices(panel, list);
  }

  function renderInvoices(panel, list) {
    if (!list.length) return panel.replaceChildren(el('p', { class: 'muted' }, tab === 'pending' ? 'Новых счетов нет.' : 'Счетов нет.'));
    const help =
      tab === 'pending' &&
      el(
        'p',
        { class: 'muted' },
        'Порядок: в приложении Kaspi Pay выставьте удалённый счёт на номер клиента на указанную сумму (или проверьте оплату по QR). Когда деньги пришли — нажмите «Оплата получена».',
      );
    const rows = list.map((i) =>
      el(
        'tr',
        null,
        el('td', { class: 'mono' }, '№ ' + i.id, el('div', { class: 'muted' }, { renewal: 'продление', addon: 'доп. магазины', manual: 'выбран клиентом' }[i.kind] || '')),
        el('td', null, date(i.created_at, true)),
        el('td', null, i.email || '—', el('div', { class: 'muted mono' }, phone(i.phone))),
        el('td', null, i.kind === 'addon' ? `до ${i.stores} маг., доплата до конца периода` : `${i.stores} маг. × ${i.months} мес.`, el('div', { class: 'muted' }, `подключено магазинов: ${i.last_store_count ?? '—'}`)),
        el('td', { class: 'num big' }, money(i.amount)),
        el(
          'td',
          null,
          el('span', { class: 'badge ' + (i.status === 'paid' ? 'badge--ok' : i.status === 'pending' ? 'badge--warn' : '') }, { pending: 'ждёт оплаты', paid: 'оплачен', cancelled: 'отменён' }[i.status]),
          i.status === 'paid' && el('div', { class: 'muted' }, `${date(i.period_from)} — ${date(i.period_to)}`),
          i.admin_note && el('div', { class: 'muted' }, i.admin_note),
        ),
        el(
          'td',
          null,
          i.status === 'pending' &&
            el(
              'div',
              { class: 'row' },
              el('button', { type: 'button', class: 'btn btn--ok', onclick: () => confirmInvoice(i) }, 'Оплата получена'),
              el('button', { type: 'button', class: 'btn btn--danger', onclick: () => cancelInvoice(i) }, 'Отменить'),
            ),
        ),
      ),
    );
    panel.replaceChildren(
      ...(help ? [help] : []),
      el('table', null, el('thead', null, el('tr', null, ['Счёт', 'Создан', 'Клиент', 'Тариф', 'Сумма', 'Статус', ''].map((h, n) => el('th', { class: n === 4 ? 'num' : null }, h)))), el('tbody', null, rows)),
    );
  }

  async function confirmInvoice(i) {
    const note = prompt(`Подтвердить оплату счёта № ${i.id} на ${money(i.amount)} от ${i.email || phone(i.phone)}?\n\nМожно добавить заметку (например, номер операции Kaspi):`, '');
    if (note === null) return;
    try {
      const r = await rpc('admin_confirm_invoice', { p_id: i.id, p_note: note || null });
      toast(`Оплачено до ${date(r.period_to)}. Клиент увидит это в расширении при следующей проверке.`);
      await render();
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function cancelInvoice(i) {
    if (!confirm(`Отменить счёт № ${i.id}?`)) return;
    try {
      await rpc('admin_cancel_invoice', { p_id: i.id, p_note: null });
      await render();
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function renderAccounts(panel) {
    const list = await rpc('admin_accounts');
    const badge = { trial: ['badge--info', 'пробный'], active: ['badge--ok', 'оплачен'], expired: ['badge--danger', 'закончился'] };
    const rows = list.map((a) =>
      el(
        'tr',
        null,
        el('td', null, a.email || '—', el('div', { class: 'muted mono' }, phone(a.phone))),
        el('td', null, el('span', { class: 'badge ' + badge[a.status][0] }, badge[a.status][1])),
        el('td', null, a.status === 'active' ? 'до ' + date(a.paid_until) : 'пробный до ' + date(a.trial_ends_at)),
        el('td', { class: 'num' }, `${a.last_store_count ?? '—'} / ${a.status === 'active' ? a.store_limit : '—'}`),
        el('td', null, date(a.last_seen_at, true)),
        el('td', null, date(a.created_at)),
        el(
          'td',
          null,
          el(
            'button',
            {
              type: 'button',
              class: 'btn',
              onclick: async () => {
                const days = prompt(`Подарить дни клиенту ${a.email}? Сколько дней:`, '7');
                if (!days) return;
                try {
                  await rpc('admin_grant_days', { p_user: a.user_id, p_days: Number(days), p_stores: null });
                  toast('Готово');
                  await render();
                } catch (e) {
                  toast(e.message, true);
                }
              },
            },
            '+ дни',
          ),
        ),
      ),
    );
    const totals = list.reduce((m, a) => ((m[a.status] = (m[a.status] || 0) + 1), m), {});
    panel.replaceChildren(
      el('p', { class: 'muted' }, `Всего: ${list.length} · пробный: ${totals.trial || 0} · оплачен: ${totals.active || 0} · закончился: ${totals.expired || 0}`),
      el('table', null, el('thead', null, el('tr', null, ['Клиент', 'Статус', 'Срок', 'Магазины (подкл./оплач.)', 'Был онлайн', 'Регистрация', ''].map((h) => el('th', null, h)))), el('tbody', null, rows)),
    );
  }

  async function renderConfig(panel) {
    const c = await rpc('admin_get_config');
    const f = {};
    const num = (k) => (f[k] = el('input', { class: 'input', type: 'number', min: 0, value: c[k] }));
    f.kaspi_qr_url = el('input', { class: 'input', placeholder: 'https://…/kaspi-qr.png', value: c.kaspi_qr_url || '', style: 'min-width:420px' });
    f.payment_instructions = el('textarea', { placeholder: 'Например: Оплатите по QR в приложении Kaspi или дождитесь счёта на ваш номер.' }, c.payment_instructions || '');
    const preview = el('img', { class: 'qr-preview', alt: 'QR', src: c.kaspi_qr_url || '', hidden: !c.kaspi_qr_url });
    f.kaspi_qr_url.addEventListener('input', () => {
      preview.src = f.kaspi_qr_url.value;
      preview.hidden = !f.kaspi_qr_url.value;
    });
    panel.replaceChildren(
      el('h2', null, 'Цены'),
      el(
        'div',
        { class: 'grid2' },
        'Цена в месяц, ₸', num('base_price'),
        'Магазинов в базовой цене', num('base_stores'),
        'Каждый следующий магазин, ₸', num('extra_store_price'),
        'Пробный период, дней', num('trial_days'),
        'Магазинов в пробном периоде', num('trial_store_limit'),
        'Максимум месяцев в счёте', num('max_months'),
        'Напоминать об оплате за, дней', num('remind_days'),
      ),
      el('h2', { style: 'margin-top:20px' }, 'Оплата через Kaspi'),
      el('div', { class: 'grid2' }, 'Ссылка на картинку QR Kaspi Pay', f.kaspi_qr_url, '', preview, 'Инструкция для клиента', f.payment_instructions),
      el(
        'div',
        { class: 'row', style: 'margin-top:16px' },
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn--primary',
            onclick: async () => {
              const p = {};
              ['base_price', 'base_stores', 'extra_store_price', 'trial_days', 'trial_store_limit', 'max_months', 'remind_days'].forEach((k) => (p[k] = Number(f[k].value)));
              p.kaspi_qr_url = f.kaspi_qr_url.value.trim();
              p.payment_instructions = f.payment_instructions.value.trim();
              try {
                await rpc('admin_update_config', { p });
                toast('Сохранено. Новые цены действуют для новых счетов.');
              } catch (e) {
                toast(e.message, true);
              }
            },
          },
          'Сохранить',
        ),
        el('span', { class: 'muted' }, 'Изменение цен не меняет уже выставленные счета.'),
      ),
    );
  }

  /* ---------- events ---------- */
  $('saveConn').addEventListener('click', () => {
    store.set(LS.url, $('url').value.trim());
    store.set(LS.key, $('key').value.trim());
    show();
  });
  $('sendCode').addEventListener('click', async () => {
    try {
      await http('/auth/v1/otp', { email: $('email').value.trim().toLowerCase(), create_user: false });
      $('codeRow').hidden = false;
      toast('Код отправлен на почту');
    } catch (e) {
      toast(e.message, true);
    }
  });
  $('verify').addEventListener('click', async () => {
    try {
      const s = await http('/auth/v1/verify', { type: 'email', email: $('email').value.trim().toLowerCase(), token: $('code').value.trim() });
      store.set(LS.session, { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: Date.now() + s.expires_in * 1000, email: s.user && s.user.email });
      show();
    } catch (e) {
      toast(e.message, true);
    }
  });
  $('logout').addEventListener('click', () => {
    store.del(LS.session);
    show();
  });
  document.querySelectorAll('.tabs [role=tab]').forEach((b) =>
    b.addEventListener('click', () => {
      tab = b.dataset.tab;
      render().catch((e) => toast(e.message, true));
    }),
  );
  $('reload').addEventListener('click', () => render().catch((e) => toast(e.message, true)));

  // Every 30 s: new invoices → counter in the tab title + a desktop notification,
  // so a payment can be confirmed (and the client unlocked) quickly.
  let known = null;
  setInterval(async () => {
    if ($('app').hidden || document.querySelector('.input:focus, textarea:focus')) return;
    try {
      const pending = await rpc('admin_invoices', { p_status: 'pending' });
      $('pendingCount').textContent = pending.length || '';
      document.title = (pending.length ? `(${pending.length}) ` : '') + 'Seller Hub — оплаты';
      const ids = new Set(pending.map((i) => i.id));
      const fresh = known ? pending.filter((i) => !known.has(i.id)) : [];
      known = ids;
      if (fresh.length) {
        toast(`Новый счёт: ${money(fresh[0].amount)} — ${fresh[0].email || phone(fresh[0].phone)}`);
        try {
          if (window.Notification && Notification.permission === 'granted') new Notification('Новый счёт Seller Hub', { body: `${money(fresh[0].amount)} — ${fresh[0].email || ''}` });
        } catch {
          /* notifications unavailable */
        }
        if (tab === 'pending') await render();
      }
    } catch {
      /* offline: try again later */
    }
  }, 30000);
  try {
    if (window.Notification && Notification.permission === 'default') Notification.requestPermission();
  } catch {
    /* notifications unavailable */
  }
  show();
})();
