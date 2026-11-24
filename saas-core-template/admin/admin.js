/*
 * {{APP_NAME}} — owner's admin page for subscriptions.
 * Plain script (works when opened as a local file). Talks to Supabase with the
 * public anon key + the admin's own login; every admin action is checked again
 * in the database (public.is_admin()). Client data is rendered as text only.
 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const LS = { url: 'adminPanel.url', key: 'adminPanel.key', session: 'adminPanel.session' };
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
  // Captcha page on the site (same as CAPTCHA.pageUrl in extension-core/billing-config.js); '' turns it off.
  const CAPTCHA_URL = 'https://{{APP_DOMAIN}}/captcha';
  /** Shows the Turnstile page in a frame; resolves the token, or null if the page did not answer. */
  function captchaToken() {
    if (!CAPTCHA_URL) return Promise.resolve(null);
    const origin = new URL(CAPTCHA_URL).origin;
    return new Promise((resolve, reject) => {
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000';
      const card = document.createElement('div');
      card.style.cssText = 'background:#fff;color:#111;border-radius:12px;padding:20px;width:340px;font:14px system-ui,sans-serif';
      const title = document.createElement('b');
      title.textContent = 'Проверка, что вы не робот';
      const frame = document.createElement('iframe');
      frame.src = CAPTCHA_URL + '?lang=ru';
      frame.title = 'Проверка';
      frame.style.cssText = 'display:block;border:0;width:304px;height:72px;margin:12px auto';
      const status = document.createElement('div');
      status.style.cssText = 'color:#a00;min-height:1em';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Отмена';
      card.append(title, frame, status, cancel);
      box.append(card);
      document.body.append(box);
      let done = false;
      const finish = (fn, v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        box.remove();
        fn(v);
      };
      const timer = setTimeout(() => finish(resolve, null), 6000);
      const onMsg = (e) => {
        if (e.origin !== origin || e.source !== frame.contentWindow) return;
        const d = e.data;
        if (!d || d.source !== 'saas-captcha') return;
        if (d.type === 'ready') clearTimeout(timer);
        else if (d.type === 'token' && typeof d.token === 'string' && d.token.length < 4096) finish(resolve, d.token);
        else if (d.type === 'error' || d.type === 'expired') status.textContent = 'Проверка не прошла — отметьте галочку ещё раз';
      };
      window.addEventListener('message', onMsg);
      cancel.addEventListener('click', () => finish(reject, new Error('Проверка отменена')));
    });
  }
  let tab = 'pending';
  // Lists come in pages of 100 rows: search + «Показать ещё» instead of loading everything.
  const PAGE = 100;
  const view = { search: '', limit: PAGE };
  let searchTimer = null;
  /** Search box + «показано X из Y» + «Показать ещё». */
  function listTools(total, shown, placeholder) {
    const input = el('input', { class: 'input', type: 'search', placeholder, value: view.search, 'aria-label': 'Поиск' });
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        view.search = input.value.trim();
        view.limit = PAGE;
        render().then(() => {
          const again = document.querySelector('#panel input[type=search]');
          if (again) (again.focus(), again.setSelectionRange(again.value.length, again.value.length));
        });
      }, 350);
    });
    return el('div', { class: 'row', style: 'margin:0 0 12px' }, input, el('span', { class: 'muted' }, `показано ${shown} из ${total}`));
  }
  function moreButton(total, shown) {
    if (shown >= total) return ''; // not null: replaceChildren(null) would print "null"
    return el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn', onclick: () => ((view.limit += PAGE), render()) }, `Показать ещё (${Math.min(PAGE, total - shown)})`));
  }

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
  const money = (n) => (n == null ? '—' : new Intl.NumberFormat('ru-RU').format(n) + ' {{CURRENCY_SYMBOL}}');
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

  // one refresh for all parallel requests (a refresh token works once)
  let refreshing = null;
  async function token() {
    const s = store.get(LS.session);
    if (!s) return null;
    if (s.expires_at - 60000 > Date.now()) return s.access_token;
    refreshing ??= refreshToken(s).finally(() => (refreshing = null));
    return refreshing;
  }
  async function refreshToken(s) {
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
    // tab counters in parallel with the tab itself (each request is a round trip to the server)
    rpc('admin_invoices', { p_status: 'pending', p_search: null, p_limit: 1, p_offset: 0 }).then((p) => ($('pendingCount').textContent = p.total || '')).catch(() => {});
    refreshCleanupBanner();
    rpc('admin_tickets', { p_status: 'open', p_search: null, p_limit: 1, p_offset: 0 }).then((o) => ($('ticketCount').textContent = o?.open || '')).catch(() => {});
    if (tab === 'tickets') return renderTickets(panel);
    if (tab === 'insights') return renderInsights(panel);
    if (tab === 'status') return renderStatus(panel);
    if (tab === 'accounts') return renderAccounts(panel);
    if (tab === 'config') return renderConfig(panel);
    if (tab === 'flags') return renderFlags(panel);
    if (tab === 'errors') return renderErrors(panel);
    if (tab === 'ux') return renderUx(panel);
    if (tab === 'faq') return renderFaq(panel);
    const [page, review] = await Promise.all([
      rpc('admin_invoices', { p_status: tab === 'pending' ? 'pending' : tab === 'paid' ? 'paid' : 'all', p_search: view.search || null, p_limit: view.limit, p_offset: 0 }),
      // automatic payments that need a look (migration 028; before it the call fails → no block)
      tab === 'pending' ? rpc('admin_payment_events', { p_only_review: true, p_limit: 100 }).catch(() => []) : [],
    ]);
    renderInvoices(panel, page);
    const box = paymentReview(review || []);
    if (box) panel.prepend(box);
  }

  // Payments the webhook could not match safely (028_payment_autoconfirm.sql → payment_received).
  const REVIEW_REASON = {
    no_match: 'не найден счёт с таким телефоном и суммой',
    ambiguous: 'подходят несколько счетов — выберите вручную',
    amount_mismatch: 'сумма не совпадает со счётом',
    invoice_not_pending: 'счёт уже оплачен или отменён (возможна двойная оплата — проверьте возврат)',
    invoice_not_found: 'счёт с таким номером не найден',
    phone_only: 'совпали телефон и сумма, но клиент не подтвердил этот номер в Telegram-боте — проверьте, что платил именно он, и подтвердите счёт вручную',
  };
  function paymentReview(events) {
    if (!events.length) return null;
    const rows = events.map((e) =>
      el(
        'tr',
        null,
        el('td', null, date(e.received_at, true), el('div', { class: 'muted mono' }, `${e.provider} · ${e.payment_id}`)),
        el('td', { class: 'mono' }, phone(e.phone)),
        el('td', { class: 'num big' }, money(e.amount)),
        el('td', null, e.invoice_id ? `№ ${e.invoice_id}` : '—', e.invoice_amount != null && el('div', { class: 'muted' }, `по счёту ${money(e.invoice_amount)}`)),
        el('td', null, REVIEW_REASON[e.reason] || e.reason || '—'),
        el(
          'td',
          null,
          el('button', {
            type: 'button',
            class: 'btn',
            onclick: async () => {
              const note = prompt('Что сделано с этим платежом? (например: «подтвердил счёт № 123 вручную», «вернул деньги»)', '');
              if (note === null) return;
              try {
                await rpc('admin_resolve_payment_event', { p_id: e.id, p_note: note || null });
                toast('Платёж отмечен как разобранный');
                render();
              } catch (err) {
                toast(err.message, true);
              }
            },
          }, 'Разобрано'),
        ),
      ),
    );
    return el(
      'section',
      { class: 'card' },
      el('h3', null, `Платежи на проверку: ${events.length}`),
      el('p', { class: 'muted' }, 'Эти оплаты пришли автоматически, но не подтверждены: что-то не совпало. Найдите счёт ниже, подтвердите его кнопкой «Оплата получена» (или верните деньги клиенту) и нажмите «Разобрано».'),
      el('table', null, el('thead', null, el('tr', null, ['Пришла', 'Телефон', 'Сумма', 'Счёт', 'Почему не подтверждено', ''].map((h, n) => el('th', { class: n === 2 ? 'num' : null }, h)))), el('tbody', null, rows)),
    );
  }

  function renderInvoices(panel, page) {
    const list = page.rows;
    const tools = listTools(page.total, list.length, 'Поиск: email, телефон или № счёта');
    if (!list.length) return panel.replaceChildren(tools, el('p', { class: 'muted' }, view.search ? 'Ничего не найдено.' : tab === 'pending' ? 'Новых счетов нет.' : 'Счетов нет.'));
    const help =
      tab === 'pending' &&
      el(
        'p',
        { class: 'muted' },
        'Порядок: выставьте клиенту счёт на указанную сумму по реквизитам из настроек оплаты (или проверьте поступление платежа). Когда деньги пришли — нажмите «Оплата получена».',
      );
    const rows = list.map((i) =>
      el(
        'tr',
        null,
        el('td', { class: 'mono' }, '№ ' + i.id, el('div', { class: 'muted' }, { renewal: 'продление', addon: 'доп. магазины', manual: 'выбран клиентом' }[i.kind] || '')),
        el('td', null, date(i.created_at, true)),
        el('td', null, i.email || '—', el('div', { class: 'muted mono' }, phone(i.phone)), i.status === 'pending' && referralNote(i)),
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
      tools,
      el('table', null, el('thead', null, el('tr', null, ['Счёт', 'Создан', 'Клиент', 'Тариф', 'Сумма', 'Статус', ''].map((h, n) => el('th', { class: n === 4 ? 'num' : null }, h)))), el('tbody', null, rows)),
      moreButton(page.total, list.length),
    );
  }

  // referral hint on a pending invoice (fields come from admin_invoices, migration 021; absent before it)
  function referralNote(i) {
    if (!i.referred) return null;
    const who = i.referrer_email || 'пользователь удалён';
    const tail = i.referral_will_reward
      ? 'пригласившему +14 дн. при подтверждении'
      : i.referral_rewarded
        ? 'бонус уже начислен'
        : i.kind === 'addon'
          ? 'бонус не положен (доп. магазины)'
          : 'бонус не положен';
    return el('div', { class: 'refnote' + (i.referral_will_reward ? ' refnote--on' : '') }, `Реферал: ${who} · ${tail}`);
  }

  async function confirmInvoice(i) {
    const note = prompt(`Подтвердить оплату счёта № ${i.id} на ${money(i.amount)} от ${i.email || phone(i.phone)}?\n\nМожно добавить заметку (например, номер операции):`, '');
    if (note === null) return;
    try {
      // pass what was displayed: the server refuses if the invoice was rewritten since (amount / stores)
      const r = await rpc('admin_confirm_invoice', { p_id: i.id, p_note: note || null, p_expected_amount: i.amount, p_expected_stores: i.stores });
      toast(`Оплачено до ${date(r.period_to)}. Клиент увидит это в расширении при следующей проверке.`);
      await render();
    } catch (e) {
      if (/amount_changed/.test(e.message)) {
        toast('Сумма или число магазинов в счёте изменились, пока вы его смотрели. Оплата НЕ подтверждена. Список обновлён: проверьте новую сумму и подтвердите снова.', true);
        await render();
      } else toast(e.message, true);
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

  /** Raw Storage API call with the admin's token (DELETE / POST with JSON). */
  async function storage(method, path, body) {
    const tk = await token();
    if (!tk) throw new Error('Войдите снова');
    const { url, key } = cfg();
    const res = await fetch(url + '/storage/v1/' + path, {
      method,
      headers: { apikey: key, Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) throw new Error((data && (data.message || data.error)) || 'HTTP ' + res.status);
    return data;
  }

  /** Removes every Storage object under <bucket>/<prefix>/ (price lists are <feed_id>/<shop_key>.xml). Throws on failure. */
  async function removeStoragePrefix(bucket, prefix) {
    const objs = (await storage('POST', 'object/list/' + bucket, { prefix: String(prefix), limit: 1000, offset: 0 })) || [];
    const names = objs.filter((o) => o && o.name).map((o) => `${prefix}/${o.name}`);
    if (names.length) await storage('DELETE', 'object/' + bucket, { prefixes: names });
    return names.length;
  }

  /** Runs the queued cleanups: success → admin_resolve_storage_cleanup, failure → admin_fail_storage_cleanup. */
  async function processCleanups(rows) {
    let removed = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        removed += await removeStoragePrefix(row.bucket || 'pricelists', row.object_path);
        await rpc('admin_resolve_storage_cleanup', { p_id: row.id });
      } catch (e) {
        failed += 1;
        await rpc('admin_fail_storage_cleanup', { p_id: row.id, p_error: String((e && e.message) || e) }).catch(() => {});
      }
    }
    return { removed, failed };
  }

  /** Persistent banner (not a toast) while price-list files of deleted accounts are still waiting for removal. */
  async function refreshCleanupBanner() {
    let rows = [];
    try {
      rows = (await rpc('admin_list_storage_cleanups')) || [];
    } catch {
      return; // migration 026 not applied yet or offline: no banner
    }
    let box = $('cleanupBanner');
    if (!rows.length) return box && box.remove();
    if (!box) {
      box = el('div', { id: 'cleanupBanner', class: 'cleanup-banner', role: 'alert' });
      $('panel').parentNode.insertBefore(box, $('panel'));
    }
    const last = rows.find((r) => r.last_error);
    box.replaceChildren(
      el('span', null, `Ожидают очистки Storage: ${rows.length}`, last ? ` · последняя ошибка: ${last.last_error}` : ''),
      el('button', {
        class: 'btn',
        onclick: async (ev) => {
          ev.target.disabled = true;
          try {
            const f = await processCleanups(rows);
            toast(`Удалено файлов: ${f.removed}` + (f.failed ? `, не удалось очистить: ${f.failed}` : '') + '.', f.failed > 0);
          } catch (e) {
            toast(e.message, true);
          }
          await refreshCleanupBanner();
        },
      }, 'Повторить очистку'),
    );
  }

  async function deleteAccount(a) {
    if (!confirm(`УДАЛИТЬ аккаунт ${a.email}?\n\nЭто необратимо: данные клиента, магазины, обращения и файлы прайс-листов будут стёрты. Счета и согласия сохранятся без email.`)) return;
    const typed = prompt(`Для подтверждения введите email аккаунта точно так же:\n${a.email}`, '');
    if (typed === null) return;
    if (typed.trim().toLowerCase() !== String(a.email || '').trim().toLowerCase()) return toast('Email не совпал: аккаунт НЕ удалён.', true);
    try {
      const r = await rpc('admin_delete_account', { p_user: a.user_id, p_email: typed.trim() });
      const feeds = new Set((Array.isArray(r && r.price_feeds_to_remove) ? r.price_feeds_to_remove : []).map(String));
      // the server queued one cleanup row per feed in the same transaction; run them now
      const queued = ((await rpc('admin_list_storage_cleanups').catch(() => [])) || []).filter((row) => feeds.has(String(row.object_path)));
      const f = await processCleanups(queued);
      toast(`Аккаунт удалён. Файлов прайс-листов удалено: ${f.removed}` + (f.failed ? `, не удалось очистить прайс-листов: ${f.failed} (останутся в очереди: нажмите «Повторить очистку»)` : '') + '.', f.failed > 0);
      await render();
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function renderAccounts(panel) {
    const page = await rpc('admin_accounts', { p_search: view.search || null, p_status: 'all', p_limit: view.limit, p_offset: 0 });
    const list = page.rows;
    const badge = { trial: ['badge--info', 'пробный'], active: ['badge--ok', 'оплачен'], expired: ['badge--danger', 'закончился'] };
    const rows = list.map((a) =>
      el(
        'tr',
        null,
        el('td', null, a.email || '—', el('div', { class: 'muted mono' }, phone(a.phone))),
        el('td', null, el('span', { class: 'badge ' + badge[a.status][0] }, badge[a.status][1]), a.trial_blocked && el('div', { class: 'muted' }, 'пробный уже был на этом магазине'),
          a.referral_code && el('div', { class: 'muted' }, `Код: ${a.referral_code} · приглашено: ${a.referrals_count || 0} · бонус: ${a.referral_bonus_days || 0} дн.`),
          a.referred && el('div', { class: 'muted' }, `пришёл по ссылке ${a.referrer_email || '(пользователь удалён)'}`)),
        el('td', null, a.status === 'active' ? 'до ' + date(a.paid_until) : 'пробный до ' + date(a.trial_ends_at)),
        el('td', { class: 'num' }, `${a.last_store_count ?? '—'} / ${a.status === 'active' ? a.store_limit : '—'}`),
        el('td', null, date(a.last_seen_at, true)),
        el('td', null, date(a.created_at)),
        el('td', null, a.terms_accepted_at ? date(a.terms_accepted_at, true) : '—', el('div', { class: 'muted mono' }, a.terms_version || '')),
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
          ' ',
          el('button', { type: 'button', class: 'btn btn--danger', onclick: () => deleteAccount(a) }, 'Удалить аккаунт'),
        ),
      ),
    );
    const totals = page.totals || {};
    panel.replaceChildren(
      el('p', { class: 'muted' }, `Всего: ${totals.all || 0} · пробный: ${totals.trial || 0} · оплачен: ${totals.active || 0} · закончился: ${totals.expired || 0}`),
      listTools(page.total, list.length, 'Поиск: email или телефон'),
      el('table', null, el('thead', null, el('tr', null, ['Клиент', 'Статус', 'Срок', 'Магазины (подкл./оплач.)', 'Был онлайн', 'Регистрация', 'Согласие с офертой', ''].map((h) => el('th', null, h)))), el('tbody', null, rows)),
      moreButton(page.total, list.length),
    );
  }

  /* ---------- «Пульт»: where sellers get stuck, what they use, who stays, NPS, why they leave ---------- */
  const STEP = { accounts: 'Зарегистрировались', store: 'Подключили магазин', orders: 'Заказы загрузились', print: 'Проверили печать', costs: 'Указали себестоимость', backup: 'Сохранили копию', paid: 'Оплатили' };
  const SECTION = { home: 'Главная', orders: 'Заказы', returns: 'Возвраты', refusals: 'Отказы', payments: 'Оплаты', analytics: 'Аналитика', products: 'Себестоимость', catalog: 'Выгрузка товаров', chat: 'Чат', settings: 'Настройки', account: 'Подписка', help: 'Помощь' };
  const ACTION = { accept: 'Принять заказ', pack: 'Упаковать', print: 'Печать накладных', pickList: 'Лист сборки', export: 'Выгрузка в Excel', publish: 'Выложить товар', connect: 'Подключить магазин', sync: 'Обновить', ticket: 'Вопрос в поддержку', invite: 'Пригласить сборщика', cost: 'Себестоимость' };
  const EXIT = { price: 'Дорого', notUsing: 'Не пользуюсь', missing: 'Нет нужной функции', bugs: 'Ошибки', closed: 'Закрыл магазин / перерыв', competitor: 'Ушёл к другому сервису', other: 'Другое' };
  const RISK = { detractor: ['Поставил низкую оценку (0–6)', 'badge--danger'], trialEndsNoStore: ['Пробный кончается, магазин не подключён', 'badge--danger'], noStore: ['Не подключил магазин', 'badge--warn'], inactive: ['Не заходит 7+ дней', 'badge--warn'], noPrint: ['Не настроил печать', 'badge--info'], expiredRecently: ['Подписка закончилась', 'badge--info'] };
  let insightDays = 30;
  let riskAll = false;
  const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
  const bar = (value, max, tone) => el('div', { class: 'bar' }, el('span', { class: 'bar__fill' + (tone ? ' bar__fill--' + tone : ''), style: `width:${max ? Math.max(2, (100 * value) / max) : 0}%` }));
  const tile = (label, value, hint) => el('div', { class: 'tile' }, el('div', { class: 'muted' }, label), el('div', { class: 'tile__v' }, value), hint && el('div', { class: 'muted small' }, hint));
  const hours = (h) => (h == null ? '' : h < 1 ? 'меньше часа' : h < 48 ? `≈ ${Math.round(h)} ч` : `≈ ${Math.round(h / 24)} дн.`);

  /** First 8 quotes, the rest behind «ещё N». */
  const quoteList = (list, item) => [
    el('ul', { class: 'quotes' }, list.slice(0, 8).map(item)),
    list.length > 8 && el('details', null, el('summary', { class: 'muted' }, `ещё ${list.length - 8}`), el('ul', { class: 'quotes' }, list.slice(8).map(item))),
  ];

  const UX_TYPE = { rage_click: 'Ярость-клики', form_abandoned: 'Бросили форму', help_opened: 'Открыли помощь' };
  async function renderUx(panel) {
    const r = (await rpc('admin_ux_summary', {})) || {};
    const table = (head, rows) => el('table', null,
      el('thead', null, el('tr', null, head.map((h, n) => el('th', { class: n >= head.length - 2 ? 'num' : null }, h)))),
      el('tbody', null, rows));
    const screens = (list) => list?.length
      ? table(['Экран', 'Пользователей', 'Просмотров'], list.map((x) => el('tr', null, el('td', null, x.screen_key), el('td', { class: 'num' }, x.users), el('td', { class: 'num' }, x.views))))
      : el('p', { class: 'muted' }, 'Данных пока нет.');
    panel.replaceChildren(
      el('p', { class: 'muted' }, 'Анонимные счётчики поведения (без текстов, адресов и данных маркетплейса). Из топа затыков берите темы для подсказок бота и статей блога.'),
      el('h3', null, 'Затыки'),
      r.friction?.length
        ? table(['Что', 'Элемент', 'Экран', 'Пользователей', 'Раз'], r.friction.map((x) => el('tr', null,
            el('td', null, UX_TYPE[x.event_type] || x.event_type), el('td', null, x.target_key), el('td', { class: 'muted' }, x.screen_key),
            el('td', { class: 'num' }, x.users), el('td', { class: 'num' }, x.occurrences))))
        : el('p', { class: 'muted' }, 'Затыков пока не видно.'),
      el('h3', null, 'Самые используемые экраны'), screens(r.top_screens),
      el('h3', null, 'Реже всего открывают'), screens(r.least_screens));
  }

  async function renderErrors(panel) {
    const list = (await rpc('admin_client_errors', { p_limit: 200 })) || [];
    if (!list.length) return panel.replaceChildren(el('p', { class: 'muted' }, 'Ошибок пока нет.'));
    const rows = list.map((r) => el('tr', null,
      el('td', null, r.error_code), el('td', { class: 'muted' }, r.context || '—'),
      el('td', { class: 'num' }, r.users), el('td', { class: 'num' }, r.occurrences),
      el('td', null, r.app_version || '—'), el('td', { class: 'muted' }, new Date(r.last_seen).toLocaleString('ru-RU'))));
    panel.replaceChildren(el('table', null,
      el('thead', null, el('tr', null, ['Код', 'Контекст', 'Пользователей', 'Повторов', 'Версия', 'Последний раз'].map((h, n) => el('th', { class: n === 2 || n === 3 ? 'num' : null }, h)))),
      el('tbody', null, rows)));
  }

  async function renderInsights(panel) {
    const r = await rpc('admin_insights', { p_days: insightDays });
    const f = r.funnel;
    const period = el('select', { 'aria-label': 'Период', onchange: (e) => ((insightDays = Number(e.target.value)), render()) },
      [[7, '7 дней'], [30, '30 дней'], [90, '90 дней'], [365, 'год']].map(([v, n]) => el('option', { value: v, selected: v === insightDays }, n)));
    // 1. key numbers
    const nps = r.nps;
    const csat = r.csat || {};
    const tiles = el('div', { class: 'tiles' },
      tile('Активны за неделю', r.activeWeek, `за период: ${r.activeUsers}`),
      tile('Новых за период', f.accounts),
      tile('Пробный → оплата', f.accounts ? pct(f.paid, f.accounts) + ' %' : '—', `${f.paid} из ${f.accounts}`),
      tile('NPS', nps.score == null ? '—' : (nps.score > 0 ? '+' : '') + nps.score, `${nps.answers} ответов за 90 дней`),
      tile('«Ответ помог»', csat.answers ? pct(csat.good, csat.answers) + ' %' : '—', `${csat.answers || 0} оценок`));
    // 2. funnel with the biggest drop marked
    const keys = ['accounts', 'store', 'orders', 'print', 'costs', 'backup', 'paid'];
    let worst = null;
    keys.slice(1).forEach((k, i) => {
      const prev = f[keys[i]];
      const drop = prev - f[k]; // people lost on this step
      if (k !== 'paid' && prev >= 3 && (!worst || drop > worst.drop)) worst = { k, drop };
    });
    const funnel = el('table', { class: 'funnel' }, el('tbody', null, keys.map((k, i) => el('tr', { 'data-step': k, class: worst?.k === k ? 'is-worst' : null },
      el('td', null, STEP[k], worst?.k === k ? el('span', { class: 'badge badge--danger', style: 'margin-left:6px' }, 'узкое место') : null),
      el('td', { style: 'width:45%' }, bar(f[k], f.accounts, worst?.k === k ? 'bad' : null)),
      el('td', { class: 'num' }, el('b', null, f[k])),
      el('td', { class: 'num muted' }, i ? pct(f[k], f.accounts) + ' %' : ''),
      el('td', { class: 'num muted' }, i && k !== 'paid' && f[keys[i - 1]] > f[k] ? `−${f[keys[i - 1]] - f[k]}` : ''),
      el('td', { class: 'muted' }, hours(r.hoursTo?.[k]))))));
    // 3. sections and actions
    const usage = (obj, names) => {
      const rows = Object.entries(obj || {}).sort((a, b) => b[1].users - a[1].users || b[1].times - a[1].times);
      const unused = Object.keys(names).filter((k) => !obj?.[k]);
      return el('table', null,
        el('thead', null, el('tr', null, ['', 'Продавцов', '', 'Раз'].map((x, n) => el('th', { class: n === 1 || n === 3 ? 'num' : null }, x)))),
        el('tbody', null,
          rows.map(([k, v]) => el('tr', null, el('td', null, names[k] || k), el('td', { class: 'num' }, `${v.users} (${pct(v.users, r.activeUsers)} %)`), el('td', { style: 'width:35%' }, bar(v.users, r.activeUsers)), el('td', { class: 'num' }, v.times))),
          unused.map((k) => el('tr', { class: 'muted' }, el('td', null, names[k]), el('td', { class: 'num' }, '0'), el('td', null, el('span', { class: 'badge badge--warn' }, 'никто не пользуется')), el('td', { class: 'num' }, '0')))));
    };
    // 4. cohorts
    const cohorts = el('table', { class: 'cohorts' },
      el('thead', null, el('tr', null, ['Неделя регистрации', 'Человек', '1-я неделя', '2-я', '3-я', '4-я', '5-я'].map((x, n) => el('th', { class: n ? 'num' : null }, x)))),
      el('tbody', null, (r.cohorts || []).map((c) => el('tr', null, el('td', null, date(c.week)), el('td', { class: 'num' }, c.size),
        [0, 1, 2, 3, 4].map((w) => {
          const n = c.active?.[w];
          if (n == null) return el('td', { class: 'num muted' }, '');
          const p = pct(n, c.size);
          return el('td', { class: 'num heat', style: `--p:${p / 100}` }, p + ' %');
        })))));
    // 5. NPS and exit reasons
    const npsBox = el('div', null,
      el('div', { class: 'row' },
        el('span', { class: 'badge badge--ok' }, `Сторонники 9–10: ${nps.promoters}`),
        el('span', { class: 'badge' }, `Нейтральные 7–8: ${nps.passives}`),
        el('span', { class: 'badge badge--danger' }, `Критики 0–6: ${nps.detractors}`)),
      (nps.comments || []).length
        ? quoteList(nps.comments, (c) => el('li', null, el('span', { class: 'badge ' + (c.score >= 9 ? 'badge--ok' : c.score >= 7 ? '' : 'badge--danger') }, c.score), ' ', c.comment, el('span', { class: 'muted small' }, ` — ${c.email || '—'}, ${date(c.at)}`)))
        : el('p', { class: 'muted' }, 'Комментариев пока нет.'));
    const reasons = Object.entries(r.exit?.reasons || {}).sort((a, b) => b[1] - a[1]);
    const exitTotal = reasons.reduce((n, [, v]) => n + v, 0);
    const exitBox = el('div', null,
      reasons.length
        ? el('table', null, el('tbody', null, reasons.map(([k, v]) => el('tr', null, el('td', null, EXIT[k] || k), el('td', { style: 'width:45%' }, bar(v, exitTotal, 'bad')), el('td', { class: 'num' }, `${v} (${pct(v, exitTotal)} %)`)))))
        : el('p', { class: 'muted' }, 'Ответов пока нет.'),
      (r.exit?.comments || []).length ? el('ul', { class: 'quotes' }, r.exit.comments.map((c) => el('li', null, el('span', { class: 'badge' }, EXIT[c.reason] || c.reason), ' ', c.comment, el('span', { class: 'muted small' }, ` — ${c.email || '—'}, ${date(c.at)}`)))) : null);
    // 6. who to write to first
    const risk = r.risk || [];
    const riskBox = risk.length
      ? el('table', null,
          el('thead', null, el('tr', null, ['Клиент', 'Что не так', 'Был активен', 'Регистрация', ''].map((x) => el('th', null, x)))),
          el('tbody', null, risk.map((x, n) => el('tr', { 'data-risk': x.reason, class: n >= 10 ? 'more-row' : null, hidden: n >= 10 && !riskAll },
            el('td', null, x.email || '—'),
            el('td', null, el('span', { class: 'badge ' + (RISK[x.reason]?.[1] || '') }, RISK[x.reason]?.[0] || x.reason)),
            el('td', null, x.last_active_at ? date(x.last_active_at, true) : 'не заходил'),
            el('td', null, date(x.created_at)),
            el('td', null, x.email && el('a', { class: 'btn', href: `mailto:${encodeURIComponent(x.email)}?subject=${encodeURIComponent('{{APP_NAME}} — чем помочь?')}` }, 'Написать'))))))
      : el('p', { class: 'muted' }, 'Сейчас никого — все в порядке.');
    const riskMore = risk.length > 10 && !riskAll && el('button', { type: 'button', class: 'btn', 'data-action': 'risk-all', onclick: () => ((riskAll = true), render()) }, `Показать всех (${risk.length})`);
    const section = (title, hint, ...body) => el('section', { class: 'block' }, el('h2', null, title), hint && el('p', { class: 'muted' }, hint), ...body);
    panel.replaceChildren(
      el('div', { class: 'row', style: 'margin:0 0 12px' }, el('b', null, 'Период:'), period, el('span', { class: 'muted' }, 'Только числа и ответы на опросы — без заказов и данных магазинов.')),
      tiles,
      section('Кому написать первым', `Клиенты, которые застряли или вот-вот уйдут (${risk.length}). Один звонок или письмо на этом этапе часто спасает клиента.`, riskBox, riskMore),
      section('Воронка: где застревают', `Новые клиенты за ${insightDays} дн. «Узкое место» — шаг, на котором теряется больше всего людей. Справа — сколько обычно проходит от регистрации до шага.`, funnel),
      section('Чем пользуются', 'Разделы, которые открывали, и действия — за период. То, чем никто не пользуется, — кандидат на упрощение или удаление.', el('div', { class: 'grid-2' }, el('div', null, el('h3', null, 'Разделы'), usage(r.sections, SECTION)), el('div', null, el('h3', null, 'Действия'), usage(r.actions, ACTION)))),
      section('Кто остаётся (удержание)', 'Сколько людей из каждой недели регистрации пользовались расширением через 1, 2, 3, 4 недели. Если после изменения в продукте цифры растут — изменение работает.', cohorts),
      section('Удовлетворённость (NPS)', 'Вопрос «Насколько вероятно, что порекомендуете?» 0–10. NPS = % сторонников (9–10) − % критиков (0–6), от −100 до +100. Выше 0 — хорошо, выше +30 — отлично. Спрашиваем через 14 дней работы, потом раз в 90 дней.', npsBox),
      section('Почему не продлевают', 'Ответы при окончании пробного периода или подписки.', exitBox),
    );
  }

  /* ---------- «База ответов»: what the Telegram bot answers (032_support_bot.sql) ---------- */
  const FAQ_TOPIC = { connect: 'Подключение', orders: 'Заказы и сводка', print: 'Печать', payment: 'Оплата', goods: 'Товары и склад', bot: 'Telegram-бот' };
  const QFILTER = { unanswered: 'Без ответа', not_helped: '«Не помогло»', all: 'Все вопросы' };
  let qFilter = 'unanswered';
  let faqDraft = null; // the answer being edited ({} = a new one)

  async function renderFaq(panel) {
    const [base, qs] = await Promise.all([rpc('admin_faq'), rpc('admin_bot_questions', { p_filter: qFilter, p_limit: 100 })]);
    const st = qs.stats || {};
    const tiles = el('div', { class: 'tiles' },
      tile('Вопросов в боте', st.asked || 0, 'за 7 дней'),
      tile('Ответила база', st.asked ? pct(st.answered, st.asked) + ' %' : '—', `${st.answered || 0} из ${st.asked || 0}`),
      tile('Без ответа', st.unanswered || 0, 'добавьте ответы ниже'),
      tile('«Помогло»', st.helped + st.not_helped ? pct(st.helped, st.helped + st.not_helped) + ' %' : '—', `${st.helped || 0} 👍 · ${st.not_helped || 0} 👎`),
      tile('Ушло в поддержку', st.tickets || 0, 'после ответа бота'));
    const filter = el('select', { 'aria-label': 'Какие вопросы', onchange: (e) => ((qFilter = e.target.value), render()) },
      Object.entries(QFILTER).map(([k, v]) => el('option', { value: k, selected: k === qFilter }, v)));
    const questions = qs.items.length
      ? el('table', null,
        el('thead', null, el('tr', null, ['Когда', 'Кто', 'Вопрос', 'Ответ бота', ''].map((h) => el('th', null, h)))),
        el('tbody', null, qs.items.map((x) => el('tr', null,
          el('td', { class: 'muted' }, date(x.created_at, true)),
          el('td', null, x.name || '—', ' ', el('span', { class: 'badge' }, x.lang === 'kk' ? 'KZ' : 'RU')),
          el('td', null, x.text, x.ticket_id ? el('span', { class: 'badge badge--info', style: 'margin-left:6px' }, `→ вопрос №${x.ticket_id}`) : null),
          el('td', { class: 'muted' }, x.faq ? `${x.faq}${x.helped === false ? ' 👎' : x.helped ? ' 👍' : ''}` : '—'),
          el('td', null, el('button', { type: 'button', class: 'btn', onclick: () => {
            faqDraft = x.faq_id && x.helped === false ? base.find((f) => f.id === x.faq_id) || {} : { [x.lang === 'kk' ? 'question_kk' : 'question_ru']: x.text.slice(0, 100), keywords: '' };
            render();
          } }, x.faq_id && x.helped === false ? 'Исправить ответ' : 'Добавить в базу'))))))
      : el('p', { class: 'muted' }, qFilter === 'unanswered' ? 'Все вопросы нашли ответ.' : 'Пока пусто.');
    const byTopic = Object.keys(FAQ_TOPIC).map((k) => [k, base.filter((f) => f.topic === k)]).filter(([, l]) => l.length);
    const list = byTopic.map(([k, l]) => el('div', null, el('h3', null, FAQ_TOPIC[k]),
      l.map((f) => el('section', { class: 'ticket', 'data-faq': f.id },
        el('div', { class: 'row', style: 'margin:0' },
          el('b', null, f.question_ru), f.enabled ? null : el('span', { class: 'badge badge--warn' }, 'выключен'),
          el('span', { class: 'muted' }, `показан ${f.shown} · 👍 ${f.helped} · 👎 ${f.not_helped}`),
          el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => ((faqDraft = f), render()) }, 'Изменить')),
        el('div', { class: 'muted small' }, 'Ключевые слова: ', f.keywords || '—')))));
    panel.replaceChildren(
      el('p', { class: 'muted', style: 'margin-top:0' }, 'Бот ищет ответ по ключевым словам: слово срабатывает по началу («токен» найдёт «токена»), фраза — если в вопросе есть все её слова. Правки работают сразу, бота перевыкладывать не нужно.'),
      tiles,
      faqDraft ? faqForm(faqDraft) : el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn btn--primary', onclick: () => ((faqDraft = {}), render()) }, '+ Новый ответ')),
      el('section', { class: 'block' }, el('h2', null, 'Что спрашивают в боте'), el('div', { class: 'row', style: 'margin:0 0 8px' }, filter), questions),
      el('section', { class: 'block' }, el('h2', null, `Ответы (${base.length})`), ...list));
  }

  function faqForm(f) {
    const field = (label, node) => el('label', { style: 'display:grid;gap:4px;margin-top:8px' }, el('span', { class: 'muted' }, label), node);
    const input = (v, max) => el('input', { class: 'input', value: v || '', maxlength: max, style: 'width:100%' });
    const topic = el('select', null, Object.entries(FAQ_TOPIC).map(([k, v]) => el('option', { value: k, selected: k === (f.topic || 'connect') }, v)));
    const qRu = input(f.question_ru, 100), qKk = input(f.question_kk, 100);
    const aRu = el('textarea', { maxlength: 1500, style: 'height:110px' }, f.answer_ru || ''), aKk = el('textarea', { maxlength: 1500, style: 'height:110px' }, f.answer_kk || '');
    const kw = input(f.keywords, 1000);
    const sort = el('input', { class: 'input', type: 'number', value: f.sort ?? 100, style: 'width:90px;min-width:0' });
    const enabled = el('input', { type: 'checkbox', checked: f.enabled !== false });
    const save = async () => {
      try {
        await rpc('admin_faq_save', { p: { id: f.id || null, topic: topic.value, question_ru: qRu.value, question_kk: qKk.value, answer_ru: aRu.value, answer_kk: aKk.value, keywords: kw.value, sort: Number(sort.value) || 100, enabled: enabled.checked } });
        faqDraft = null;
        toast('Сохранено — бот уже отвечает так');
        render();
      } catch (e) {
        toast(/check/.test(e.message) ? 'Заполните вопрос и ответ на обоих языках' : e.message, true);
      }
    };
    const del = async () => {
      if (!confirm('Удалить этот ответ? Счётчики тоже пропадут. Можно вместо этого выключить.')) return;
      try { await rpc('admin_faq_delete', { p_id: f.id }); faqDraft = null; toast('Удалено'); render(); } catch (e) { toast(e.message, true); }
    };
    return el('section', { class: 'block', style: 'border:1px solid var(--border);border-radius:10px;padding:12px 14px' },
      el('h2', { style: 'margin-top:0' }, f.id ? 'Изменить ответ' : 'Новый ответ'),
      el('div', { class: 'row', style: 'margin:0' }, field('Тема', topic), field('Порядок', sort), el('label', { class: 'row' }, enabled, 'Включён')),
      el('div', { class: 'grid-2' },
        el('div', null, field('Вопрос (RU) — так он виден в меню бота', qRu), field('Ответ (RU)', aRu)),
        el('div', null, field('Сұрақ (KZ)', qKk), field('Жауап (KZ)', aKk))),
      field('Ключевые слова через запятую, RU и KZ: начала слов или фразы («неверн токен, не обновл, жаңармай»)', kw),
      el('div', { class: 'row' },
        el('button', { type: 'button', class: 'btn btn--primary', onclick: save }, 'Сохранить'),
        el('button', { type: 'button', class: 'btn', onclick: () => ((faqDraft = null), render()) }, 'Отмена'),
        f.id ? el('button', { type: 'button', class: 'btn btn--danger', onclick: del }, 'Удалить') : null));
  }

  /* ---------- «Вопросы»: support tickets from the extension ---------- */
  // Ready answers for repeated questions (kept in this browser): one click instead of typing.
  const TPL_KEY = 'adminPanel.templates';
  const DEFAULT_TEMPLATES = [
    { name: 'Токен', text: 'Ключ доступа создаёт владелец аккаунта: Настройки → Интеграции → «Сформировать». Скопируйте его целиком и вставьте в приложении.' },
    { name: 'Оплата', text: 'Оплату получили, подписка продлена. Если окно оплаты не закрылось — нажмите «Обновить» в разделе «Подписка».' },
    { name: 'Сбой сервиса', text: 'Сейчас сбой на стороне внешнего сервиса, данные обновятся сами, как только он заработает. Ничего делать не нужно.' },
  ];
  const templates = () => store.get(TPL_KEY) || DEFAULT_TEMPLATES;
  const TOPIC = { connect: 'Подключение', orders: 'Заказы', print: 'Печать', payment: 'Оплата', warehouse: 'Склад', idea: 'Предложение', other: 'Другое' };
  const TSTATUS = { open: ['Ждёт ответа', 'badge--danger'], answered: ['Отвечено', 'badge--info'], closed: ['Решён', 'badge--ok'] };
  let ticketFilter = 'open';

  async function renderTickets(panel) {
    const page = await rpc('admin_tickets', { p_status: ticketFilter, p_search: view.search || null, p_limit: view.limit, p_offset: 0 });
    const filter = el('select', { onchange: (e) => ((ticketFilter = e.target.value), render()) },
      ['open', 'answered', 'closed', 'all'].map((k) => el('option', { value: k, selected: k === ticketFilter }, k === 'all' ? 'Все' : TSTATUS[k][0])));
    const tools = listTools(page.total, page.items.length, 'Поиск: email, текст, № вопроса');
    tools.prepend(filter);
    if (!page.items.length) return panel.replaceChildren(tools, el('p', { class: 'muted' }, ticketFilter === 'open' ? 'Новых вопросов нет.' : 'Ничего не найдено.'));
    panel.replaceChildren(tools, ...page.items.map(ticketBox), moreButton(page.total, page.items.length));
  }

  function ticketBox(x) {
    const kk = x.lang === 'kk';
    const reply = el('textarea', { placeholder: kk ? 'Клиент пользуется расширением на казахском — ответьте на казахском' : 'Ответ клиенту — он увидит его в расширении и получит уведомление' }, x.reply || '');
    const tplText = (t) => (kk ? t.kk || t.text : t.text || t.kk);
    const tpl = el('select', { 'aria-label': 'Шаблон ответа', onchange: (e) => { const t = templates()[e.target.value]; if (t) reply.value = tplText(t); e.target.value = ''; } },
      el('option', { value: '' }, kk ? 'Шаблон (қазақша)…' : 'Шаблон…'), templates().map((t, i) => el('option', { value: i }, t.name + (kk && !t.kk ? ' (только RU)' : !kk && !t.text ? ' (только KZ)' : ''))));

    const save = (close) => async () => {
      try {
        await rpc('admin_ticket_reply', { p_id: x.id, p_reply: reply.value, p_close: close });
        // the answer also goes to the client's Telegram, if the bot is linked (bot route /ticket-reply, migration 032)
        const tgSent = await token().then((tk) => http('/functions/v1/telegram-bot/ticket-reply', { id: x.id }, tk)).then((r) => !!r?.sent).catch(() => false);
        toast((close ? 'Ответ отправлен, вопрос закрыт' : 'Ответ отправлен') + (tgSent ? ' (и в Telegram)' : ''));
        render();
      } catch (e) {
        toast(e.message, true);
      }
    };
    const st = TSTATUS[x.status];
    return el('section', { class: 'ticket', 'data-ticket': x.id },
      el('div', { class: 'row', style: 'margin:0' },
        el('b', null, `№${x.id}`), el('span', { class: 'badge ' + st[1] }, st[0]), el('span', { class: 'badge' }, TOPIC[x.topic] || x.topic),
        el('span', { class: 'badge ' + (kk ? 'badge--warn' : ''), title: 'Язык интерфейса клиента — отвечайте на нём' }, kk ? 'KZ · қазақша' : 'RU'),
        el('span', null, x.email || '—'), el('span', { class: 'muted' }, date(x.created_at, true) + (x.version ? ' · v' + x.version : ''))),
      el('p', { class: 'ticket__msg' }, x.message),
      x.report && el('details', null, el('summary', { class: 'muted' }, 'Технический отчёт'), el('pre', { class: 'mono report' }, x.report)),
      el('div', { class: 'row' }, tpl,
        el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => {
          const name = prompt('Название шаблона', '');
          if (!name || !reply.value.trim()) return;
          store.set(TPL_KEY, [...templates(), { name: name.slice(0, 40), [kk ? 'kk' : 'text']: reply.value.trim() }]);
          toast('Шаблон сохранён');
          render();
        } }, 'Сохранить как шаблон')),
      reply,
      el('div', { class: 'row' },
        el('button', { type: 'button', class: 'btn btn--primary', 'data-action': 'reply', onclick: save(false) }, 'Ответить'),
        el('button', { type: 'button', class: 'btn', 'data-action': 'reply-close', onclick: save(true) }, x.status === 'closed' ? 'Обновить ответ' : 'Ответить и закрыть')));
  }

  /* ---------- «Состояние»: notice for every client, API health, Telegram ---------- */
  const MARKET = { primary: 'Основной канал', secondary: 'Второй канал', tertiary: 'Третий канал' };
  const KIND = { server: 'ошибка сервера', network: 'нет связи', timeout: 'таймаут', format: 'неожиданный ответ', rate: 'лимит запросов', auth: 'неверный токен', other: 'другое' };
  async function sha256hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function renderStatus(panel) {
    const [status, health, ops] = await Promise.all([rpc('get_service_status'), rpc('admin_health', { p_hours: 24 }), rpc('admin_ops_settings', {})]);
    // 1. notice
    const level = el('select', { 'aria-label': 'Уровень' }, [['info', 'Сообщение'], ['warn', 'Возможны сбои'], ['down', 'Сбой']].map(([v, n]) => el('option', { value: v, selected: status.level === v }, n)));
    const msg = el('input', { class: 'input', style: 'flex:1;min-width:280px', maxlength: 300, placeholder: 'Например: внешний сервис не отвечает с 14:00, данные обновятся сами. Чиним.', value: status.message || '' });
    const hours = el('select', { 'aria-label': 'Показывать' }, [['3', '3 часа'], ['12', '12 часов'], ['24', 'сутки'], ['0', 'пока не уберу']].map(([v, n]) => el('option', { value: v }, n)));
    const publish = async (lv) => {
      try {
        await rpc('admin_set_status', { p_level: lv, p_message: lv === 'ok' ? '' : msg.value, p_hours: Number(hours.value) || null });
        toast(lv === 'ok' ? 'Сообщение убрано' : 'Опубликовано: клиенты увидят его в течение 5 минут');
        render();
      } catch (e) {
        toast(e.message, true);
      }
    };
    // 2. health now
    const now = health.now || [];
    const nowRows = now.map((m) => {
      const bad = m.failing > 0 && m.share >= (ops.min_share || 0.3);
      const kinds = Object.entries(m.kinds || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${KIND[k] || k}: ${n}`).join(', ');
      return el('tr', { 'data-market': m.market }, el('td', null, MARKET[m.market] || m.market),
        el('td', null, el('span', { class: 'badge ' + (bad ? 'badge--danger' : m.failing ? 'badge--warn' : 'badge--ok') }, bad ? 'сбой' : m.failing ? 'есть ошибки' : 'работает')),
        el('td', { class: 'num' }, m.users), el('td', { class: 'num' }, `${m.failing} (${Math.round(m.share * 100)} %)`), el('td', { class: 'num' }, m.ok), el('td', { class: 'num' }, m.fail), el('td', { class: 'muted' }, kinds || '—'));
    });
    const hoursRows = (health.hours || []).slice(0, 48).map((r) => el('tr', null, el('td', null, date(r.bucket, true)), el('td', null, MARKET[r.market] || r.market), el('td', { class: 'num' }, r.users), el('td', { class: 'num' }, r.ok), el('td', { class: 'num' }, r.fail), el('td', { class: 'num' }, r.outage)));
    // 3. Telegram key
    const keyOut = el('div', { class: 'row', hidden: true });
    const minUsers = el('input', { class: 'input', type: 'number', min: 1, value: ops.min_users, style: 'min-width:80px;width:90px' });
    const minShare = el('input', { class: 'input', type: 'number', min: 5, max: 100, step: 5, value: Math.round(ops.min_share * 100), style: 'min-width:80px;width:90px' });
    panel.replaceChildren(
      el('h2', null, 'Сообщение для всех клиентов'),
      el('p', { class: 'muted' }, status.level === 'ok' ? 'Сейчас ничего не показывается.' : `Сейчас показывается: «${status.message}»` + (status.until ? ` до ${date(status.until, true)}` : '')),
      el('div', { class: 'row' }, level, msg, hours),
      el('div', { class: 'row' },
        el('button', { type: 'button', class: 'btn btn--primary', 'data-action': 'status-publish', onclick: () => publish(level.value) }, 'Опубликовать'),
        status.level !== 'ok' && el('button', { type: 'button', class: 'btn', 'data-action': 'status-clear', onclick: () => publish('ok') }, 'Убрать')),
      el('h2', { style: 'margin-top:24px' }, 'API маркетплейсов за последний час'),
      el('p', { class: 'muted' }, 'Только счётчики запросов от расширений клиентов (без заказов и токенов). «Сбой» — когда у многих клиентов сразу ошибки сервера или связи; неверный токен одного клиента сбоем не считается.'),
      now.length
        ? el('table', null, el('thead', null, el('tr', null, ['Площадка', 'Состояние', 'Клиентов', 'С ошибками', 'Успешно', 'Ошибок', 'Причины'].map((x, n) => el('th', { class: n >= 2 && n <= 5 ? 'num' : null }, x)))), el('tbody', null, nowRows))
        : el('p', { class: 'muted' }, 'Данных за последний час нет.'),
      hoursRows.length && el('details', { style: 'margin-top:8px' }, el('summary', { class: 'muted' }, 'По часам за сутки'),
        el('table', null, el('thead', null, el('tr', null, ['Час', 'Площадка', 'Клиентов', 'Успешно', 'Ошибок', 'Из них сбой'].map((x, n) => el('th', { class: n >= 2 ? 'num' : null }, x)))), el('tbody', null, hoursRows))),
      el('h2', { style: 'margin-top:24px' }, 'Уведомления в Telegram'),
      el('p', { class: 'muted' }, 'Каждые 10 минут задача GitHub Actions (tools/ops-alert.mjs) присылает в ваш Telegram: сбой API, новые вопросы и счета. Ей нужен свой ключ — он даёт только счётчики, без данных клиентов. Инструкция: billing/README.md → «Уведомления в Telegram».'),
      el('p', null, ops.has_key ? el('span', { class: 'badge badge--ok' }, 'ключ задан') : el('span', { class: 'badge badge--warn' }, 'ключа нет'), ops.last_digest_at ? el('span', { class: 'muted' }, ` · последняя проверка ${date(ops.last_digest_at, true)}`) : ''),
      el('div', { class: 'row' }, 'Сбой, если ошибки у ', minUsers, ' клиентов и больше, и это ', minShare, ' % клиентов',
        el('button', { type: 'button', class: 'btn', onclick: async () => {
          try {
            await rpc('admin_ops_settings', { p_min_users: Number(minUsers.value), p_min_share: Number(minShare.value) / 100 });
            toast('Сохранено');
          } catch (e) {
            toast(e.message, true);
          }
        } }, 'Сохранить')),
      el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn btn--primary', 'data-action': 'ops-key', onclick: async () => {
        if (ops.has_key && !confirm('Старый ключ перестанет работать. Создать новый?')) return;
        const raw = crypto.getRandomValues(new Uint8Array(32));
        const key = [...raw].map((b) => b.toString(16).padStart(2, '0')).join('');
        try {
          await rpc('admin_ops_settings', { p_key_hash: await sha256hex(key) });
          keyOut.replaceChildren(el('span', null, 'Ключ (показывается один раз — вставьте его в GitHub → Settings → Secrets → OPS_KEY):'), el('code', { class: 'mono', 'data-field': 'ops-key' }, key));
          keyOut.hidden = false;
        } catch (e) {
          toast(e.message, true);
        }
      } }, ops.has_key ? 'Создать новый ключ' : 'Создать ключ')),
      keyOut,
      botSection(),
    );
  }

  /* «Telegram-бот для продавцов»: username, links in the buttons, «что нового» for win-back, the bot's key */
  function botSection() {
    const box = el('div', { 'data-block': 'bot-settings' }, el('h2', { style: 'margin-top:24px' }, 'Telegram-бот для продавцов'), el('p', { class: 'muted' }, 'Загрузка…'));
    rpc('admin_growth_settings', { p: {} }).then((g) => {
      const f = {
        bot_username: el('input', { class: 'input', placeholder: '{{TELEGRAM_HANDLE}}_bot', value: g.bot_username || '' }),
        app_url: el('input', { class: 'input', placeholder: 'https://example.com', value: g.app_url || '' }),
        support_url: el('input', { class: 'input', placeholder: 'https://t.me/ваш_менеджер', value: g.support_url || '' }),
        whats_new: el('textarea', { placeholder: 'Что нового за месяц — уйдёт клиентам через 30 дней после отмены' }, g.whats_new || ''),
        whats_new_kk: el('textarea', { placeholder: 'То же на казахском — для клиентов с казахским интерфейсом (пусто → уйдёт русский текст)' }, g.whats_new_kk || ''),
      };
      const keyOut = el('div', { class: 'row', hidden: true });
      const c = g.cancellations || {};
      box.replaceChildren(
        el('h2', { style: 'margin-top:24px' }, 'Telegram-бот для продавцов'),
        el('p', { class: 'muted' }, `Подключили: ${g.linked}, заблокировали бота: ${g.blocked}. Отмены за 90 дней: скидка ${c.discount || 0}, «Старт» ${c.downgrade || 0}, заморозка ${c.freeze || 0}, отменили ${c.cancelled || 0}. Инструкция: billing/README.md → «Telegram-бот для продавцов».`),
        el('div', { class: 'grid2' }, 'Имя бота (без @)', f.bot_username, 'Сайт (кнопка «Посмотреть заказы» → /open)', f.app_url, 'Поддержка (кнопка «Поддержка»)', f.support_url, 'Что нового (win-back через 30 дней)', f.whats_new, 'Что нового — қазақша', f.whats_new_kk),
        el('div', { class: 'row' },
          el('button', { type: 'button', class: 'btn btn--primary', 'data-action': 'bot-save', onclick: async () => {
            try {
              await rpc('admin_growth_settings', { p: { bot_username: f.bot_username.value, app_url: f.app_url.value, support_url: f.support_url.value, whats_new: f.whats_new.value, whats_new_kk: f.whats_new_kk.value } });
              toast('Сохранено');
            } catch (e) {
              toast(e.message, true);
            }
          } }, 'Сохранить'),
          el('button', { type: 'button', class: 'btn', 'data-action': 'bot-key', onclick: async () => {
            if (g.has_bot_key && !confirm('Старый ключ бота перестанет работать. Создать новый?')) return;
            const key = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
            try {
              await rpc('admin_growth_settings', { p: { bot_key_hash: await sha256hex(key) } });
              keyOut.replaceChildren(el('span', null, 'Ключ бота (показывается один раз — в секреты функции BOT_KEY и GitHub BOT_KEY):'), el('code', { class: 'mono', 'data-field': 'bot-key' }, key));
              keyOut.hidden = false;
            } catch (e) {
              toast(e.message, true);
            }
          } }, g.has_bot_key ? 'Новый ключ бота' : 'Создать ключ бота')),
        keyOut,
      );
    }).catch((e) => box.replaceChildren(el('p', { class: 'muted' }, 'Бот: ' + e.message)));
    return box;
  }

  async function renderConfig(panel) {
    const c = await rpc('admin_get_config');
    const f = {};
    const num = (k) => (f[k] = el('input', { class: 'input', type: 'number', min: 0, value: c[k] }));
    f.payment_url = el('input', { class: 'input', placeholder: 'https://…/payment-qr.png', value: c.payment_url || '', style: 'min-width:420px' });
    f.terms_version = el('input', { class: 'input', value: c.terms_version || '', placeholder: '2026-11-16' });
    f.payment_instructions = el('textarea', { placeholder: 'Например: Оплатите по ссылке или QR либо дождитесь счёта на ваш номер.' }, c.payment_instructions || '');
    const preview = el('img', { class: 'qr-preview', alt: 'QR', src: c.payment_url || '', hidden: !c.payment_url });
    f.payment_url.addEventListener('input', () => {
      preview.src = f.payment_url.value;
      preview.hidden = !f.payment_url.value;
    });
    panel.replaceChildren(
      el('h2', null, 'Цены'),
      el(
        'div',
        { class: 'grid2' },
        '«Старт» (1 магазин), {{CURRENCY_SYMBOL}}/мес', num('start_price'),
        '«Мульти», {{CURRENCY_SYMBOL}}/мес', num('base_price'),
        'Магазинов в «Мульти»', num('base_stores'),
        'Каждый следующий магазин, {{CURRENCY_SYMBOL}}', num('extra_store_price'),
        'Пробный период, дней', num('trial_days'),
        'Магазинов в пробном периоде', num('trial_store_limit'),
        'Максимум месяцев в счёте', num('max_months'),
        'Напоминать об оплате за, дней', num('remind_days'),
        'Льготный период после окончания оплаты, дней', num('grace_days'),
        'Заморозка при отмене («закрыл магазин»), дней', num('freeze_days'),
      ),
      el('p', { class: 'muted' }, '«Старт» 0 {{CURRENCY_SYMBOL}} — тарифа «Старт» нет, 1 магазин платит как «Мульти».'),
      el('h2', { style: 'margin-top:20px' }, 'Оплата (payment instructions)'),
      el('div', { class: 'grid2' }, 'Ссылка на оплату или картинку QR (payment_url)', f.payment_url, '', preview, 'Инструкция для клиента', f.payment_instructions),
      el('h2', { style: 'margin-top:20px' }, 'Оферта и политика'),
      el(
        'div',
        { class: 'grid2' },
        'Версия условий',
        f.terms_version,
        '',
        el('span', { class: 'muted' }, 'Опубликовали новую редакцию оферты или политики — поменяйте версию (например, на сегодняшнюю дату). Каждый клиент при следующем открытии расширения снова поставит галочку согласия; дата и версия сохраняются во вкладке «Клиенты».'),
      ),
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
              ['start_price', 'base_price', 'base_stores', 'extra_store_price', 'trial_days', 'trial_store_limit', 'max_months', 'remind_days', 'grace_days', 'freeze_days'].forEach((k) => (p[k] = Number(f[k].value)));
              p.payment_url = f.payment_url.value.trim();
              p.payment_instructions = f.payment_instructions.value.trim();
              if (f.terms_version.value.trim()) p.terms_version = f.terms_version.value.trim();
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

  async function renderFlags(panel) {
    const [flags, bn] = await Promise.all([rpc('admin_list_feature_flags'), rpc('admin_get_system_banner')]);
    const banner = {
      on: el('input', { type: 'checkbox', checked: !!bn.active }),
      type: el('select', { class: 'input' }, ...[['info', 'Информация'], ['warn', 'Предупреждение'], ['danger', 'Авария']].map(([v, l]) => el('option', { value: v, selected: v === (bn.type || 'info') }, l))),
      text: el('input', { class: 'input', maxlength: 300, value: bn.text || '', placeholder: 'Например: внешний сервис изменил формат, часть данных может не загружаться — чиним', style: 'min-width:420px' }),
    };
    const parseEmails = (t) => t.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    const save = async (key, v) => {
      await rpc('admin_set_feature_flag', { p_key: key, p_enabled: v.enabled, p_rollout_percent: Number(v.rollout) || 0, p_allow_emails: v.emails, p_description: v.description || null });
    };
    const reload = () => renderFlags(panel);
    const rows = flags.map((f) => {
      const on = el('input', { type: 'checkbox', checked: f.enabled });
      const pct = el('input', { class: 'input', type: 'number', min: 0, max: 100, value: f.rollout_percent, style: 'width:80px' });
      const mails = el('textarea', { rows: 2, placeholder: 'по одному в строке' }, (f.allow_emails || []).join('\n'));
      const cur = () => ({ enabled: on.checked, rollout: pct.value, emails: parseEmails(mails.value), description: f.description });
      on.addEventListener('change', async () => {
        try {
          await save(f.flag_key, cur());
          toast(on.checked ? `«${f.flag_key}» включён` : `«${f.flag_key}» выключен`);
        } catch (e) {
          on.checked = !on.checked;
          toast(e.message, true);
        }
      });
      return el(
        'tr',
        null,
        el('td', null, el('b', null, f.flag_key), f.description && el('div', { class: 'muted' }, f.description)),
        el('td', null, el('label', null, on, ' Включён')),
        el('td', null, pct, ' %'),
        el('td', null, mails),
        el(
          'td',
          null,
          el('button', { type: 'button', class: 'btn btn--primary', onclick: async () => {
            try {
              await save(f.flag_key, cur());
              toast('Сохранено');
              reload();
            } catch (e) {
              toast(e.message, true);
            }
          } }, 'Сохранить'),
          ' ',
          el('button', { type: 'button', class: 'btn', onclick: async () => {
            if (!confirm(`Удалить флаг «${f.flag_key}»?`)) return;
            try {
              await rpc('admin_delete_feature_flag', { p_key: f.flag_key });
              toast('Удалено');
              reload();
            } catch (e) {
              toast(e.message, true);
            }
          } }, 'Удалить'),
        ),
      );
    });
    const n = {
      key: el('input', { class: 'input', placeholder: 'new_feature', maxlength: 63 }),
      desc: el('input', { class: 'input', placeholder: 'Что включает', style: 'min-width:280px' }),
      on: el('input', { type: 'checkbox' }),
      pct: el('input', { class: 'input', type: 'number', min: 0, max: 100, value: 0, style: 'width:80px' }),
      mails: el('textarea', { rows: 2, placeholder: 'тестовые email, по одному в строке или через запятую' }),
    };
    panel.replaceChildren(
      el('h2', null, 'Объявление в расширении'),
      el('p', { class: 'muted' }, 'Показывается всем клиентам вверху панели (приходит вместе с лицензией, обновляется в течение нескольких часов). Только текст, до 300 символов.'),
      el('div', { class: 'grid2' }, 'Показывать', el('label', null, banner.on, ' Включено'), 'Тип', banner.type, 'Текст', banner.text),
      el('div', { class: 'row', style: 'margin-top:12px' }, el('button', { type: 'button', class: 'btn btn--primary', onclick: async () => {
        try {
          await rpc('admin_set_system_banner', { p_active: banner.on.checked, p_text: banner.text.value.trim() || null, p_type: banner.type.value });
          toast(banner.on.checked ? 'Объявление включено' : 'Объявление выключено');
        } catch (e) {
          toast(e.message, true);
        }
      } }, 'Сохранить')),
      el('h2', null, 'Фича-флаги'),
      el('p', { class: 'muted' }, 'Включают новые функции у части клиентов без выпуска новой версии. Флаг — только про интерфейс: он не подписан и не защищает платные функции. Клиент получает флаги вместе с лицензией (обновляются в течение нескольких часов).'),
      rows.length
        ? el('table', null, el('thead', null, el('tr', null, ...['Флаг', 'Состояние', 'Доля клиентов', 'Тестовые email', ''].map((h) => el('th', null, h)))), el('tbody', null, ...rows))
        : el('p', { class: 'muted' }, 'Флагов пока нет.'),
      el('h2', { style: 'margin-top:20px' }, 'Новый флаг'),
      el('div', { class: 'grid2' }, 'Ключ (a-z, 0-9, _)', n.key, 'Описание', n.desc, 'Включён для всех', n.on, 'Доля клиентов, %', n.pct, 'Тестовые email', n.mails),
      el('div', { class: 'row', style: 'margin-top:16px' }, el('button', { type: 'button', class: 'btn btn--primary', onclick: async () => {
        try {
          await save(n.key.value.trim(), { enabled: n.on.checked, rollout: n.pct.value, emails: parseEmails(n.mails.value), description: n.desc.value.trim() });
          toast('Флаг создан');
          reload();
        } catch (e) {
          toast(e.message, true);
        }
      } }, 'Создать')),
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
      const body = { email: $('email').value.trim().toLowerCase(), create_user: false };
      const captcha = await captchaToken();
      if (captcha) body.gotrue_meta_security = { captcha_token: captcha };
      await http('/auth/v1/otp', body);
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
      view.search = '';
      view.limit = PAGE;
      render().catch((e) => toast(e.message, true));
    }),
  );
  $('reload').addEventListener('click', () => render().catch((e) => toast(e.message, true)));

  // Every 30 s: new invoices → counter in the tab title + a desktop notification,
  // so a payment can be confirmed (and the client unlocked) quickly.
  let known = null;
  let knownTickets = null;
  setInterval(async () => {
    if ($('app').hidden || document.querySelector('.input:focus, textarea:focus')) return;
    try {
      const page = await rpc('admin_invoices', { p_status: 'pending', p_search: null, p_limit: 20, p_offset: 0 });
      const pending = page.rows; // newest first: enough to spot new invoices
      $('pendingCount').textContent = page.total || '';
      document.title = (page.total ? `(${page.total}) ` : '') + '{{APP_NAME}} — админка';
      const open = await rpc('admin_tickets', { p_status: 'open', p_search: null, p_limit: 1, p_offset: 0 }).catch(() => null);
      if (open) {
        if (knownTickets != null && open.open > knownTickets) {
          toast('Новый вопрос в поддержку');
          try {
            if (window.Notification && Notification.permission === 'granted') new Notification('Новый вопрос {{APP_NAME}}', { body: 'Откройте вкладку «Вопросы»' });
          } catch {
            /* notifications unavailable */
          }
          if (tab === 'tickets') await render();
        }
        knownTickets = open.open;
        $('ticketCount').textContent = open.open || '';
      }
      const ids = new Set(pending.map((i) => i.id));
      const fresh = known ? pending.filter((i) => !known.has(i.id)) : [];
      known = ids;
      if (fresh.length) {
        toast(`Новый счёт: ${money(fresh[0].amount)} — ${fresh[0].email || phone(fresh[0].phone)}`);
        try {
          if (window.Notification && Notification.permission === 'granted') new Notification('Новый счёт {{APP_NAME}}', { body: `${money(fresh[0].amount)} — ${fresh[0].email || ''}` });
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
