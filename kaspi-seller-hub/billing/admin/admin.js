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
    if (shown >= total) return null;
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
    const pending = await rpc('admin_invoices', { p_status: 'pending', p_search: null, p_limit: 20, p_offset: 0 });
    $('pendingCount').textContent = pending.total || '';
    const open = await rpc('admin_tickets', { p_status: 'open', p_search: null, p_limit: 1, p_offset: 0 }).catch(() => null);
    $('ticketCount').textContent = open?.open || '';
    if (tab === 'tickets') return renderTickets(panel);
    if (tab === 'status') return renderStatus(panel);
    if (tab === 'accounts') return renderAccounts(panel);
    if (tab === 'config') return renderConfig(panel);
    const page = await rpc('admin_invoices', { p_status: tab === 'pending' ? 'pending' : tab === 'paid' ? 'paid' : 'all', p_search: view.search || null, p_limit: view.limit, p_offset: 0 });
    renderInvoices(panel, page);
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
      tools,
      el('table', null, el('thead', null, el('tr', null, ['Счёт', 'Создан', 'Клиент', 'Тариф', 'Сумма', 'Статус', ''].map((h, n) => el('th', { class: n === 4 ? 'num' : null }, h)))), el('tbody', null, rows)),
      moreButton(page.total, list.length),
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
    const page = await rpc('admin_accounts', { p_search: view.search || null, p_status: 'all', p_limit: view.limit, p_offset: 0 });
    const list = page.rows;
    const badge = { trial: ['badge--info', 'пробный'], active: ['badge--ok', 'оплачен'], expired: ['badge--danger', 'закончился'] };
    const rows = list.map((a) =>
      el(
        'tr',
        null,
        el('td', null, a.email || '—', el('div', { class: 'muted mono' }, phone(a.phone))),
        el('td', null, el('span', { class: 'badge ' + badge[a.status][0] }, badge[a.status][1]), a.trial_blocked && el('div', { class: 'muted' }, 'пробный уже был на этом магазине')),
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

  /* ---------- «Вопросы»: support tickets from the extension ---------- */
  // Ready answers for repeated questions (kept in this browser): one click instead of typing.
  const TPL_KEY = 'kshAdmin.templates';
  const DEFAULT_TEMPLATES = [
    { name: 'Токен', text: 'Токен API создаёт руководитель магазина: кабинет продавца Kaspi → Настройки → Токен API → «Сформировать». Скопируйте его целиком и вставьте в расширении: «+ Подключить магазин».' },
    { name: 'Принтер', text: 'Настройки → «Печать накладных»: выберите свой принтер и размер этикетки, затем «Пробная печать». В окне печати поставьте масштаб 100 % и поля «Нет».' },
    { name: 'Оплата', text: 'Оплату получили, подписка продлена. Если окно оплаты не закрылось — нажмите «Обновить» в разделе «Подписка».' },
    { name: 'Сбой Kaspi', text: 'Сейчас сбой на стороне Kaspi, заказы обновятся сами, как только Kaspi заработает. Ничего делать не нужно.' },
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
    const reply = el('textarea', { placeholder: 'Ответ клиенту — он увидит его в расширении и получит уведомление' }, x.reply || '');
    const tpl = el('select', { 'aria-label': 'Шаблон ответа', onchange: (e) => { const t = templates()[e.target.value]; if (t) reply.value = t.text; e.target.value = ''; } },
      el('option', { value: '' }, 'Шаблон…'), templates().map((t, i) => el('option', { value: i }, t.name)));
    const save = (close) => async () => {
      try {
        await rpc('admin_ticket_reply', { p_id: x.id, p_reply: reply.value, p_close: close });
        toast(close ? 'Ответ отправлен, вопрос закрыт' : 'Ответ отправлен');
        render();
      } catch (e) {
        toast(e.message, true);
      }
    };
    const st = TSTATUS[x.status];
    return el('section', { class: 'ticket', 'data-ticket': x.id },
      el('div', { class: 'row', style: 'margin:0' },
        el('b', null, `№${x.id}`), el('span', { class: 'badge ' + st[1] }, st[0]), el('span', { class: 'badge' }, TOPIC[x.topic] || x.topic),
        el('span', null, x.email || '—'), el('span', { class: 'muted' }, date(x.created_at, true) + (x.version ? ' · v' + x.version : ''))),
      el('p', { class: 'ticket__msg' }, x.message),
      x.report && el('details', null, el('summary', { class: 'muted' }, 'Технический отчёт'), el('pre', { class: 'mono report' }, x.report)),
      el('div', { class: 'row' }, tpl,
        el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => {
          const name = prompt('Название шаблона', '');
          if (!name || !reply.value.trim()) return;
          store.set(TPL_KEY, [...templates(), { name: name.slice(0, 40), text: reply.value.trim() }]);
          toast('Шаблон сохранён');
          render();
        } }, 'Сохранить как шаблон')),
      reply,
      el('div', { class: 'row' },
        el('button', { type: 'button', class: 'btn btn--primary', 'data-action': 'reply', onclick: save(false) }, 'Ответить'),
        el('button', { type: 'button', class: 'btn', 'data-action': 'reply-close', onclick: save(true) }, x.status === 'closed' ? 'Обновить ответ' : 'Ответить и закрыть')));
  }

  /* ---------- «Состояние»: notice for every client, API health, Telegram ---------- */
  const MARKET = { kaspi: 'Kaspi', ozon: 'Ozon', wb: 'Wildberries' };
  const KIND = { server: 'ошибка сервера', network: 'нет связи', timeout: 'таймаут', format: 'неожиданный ответ', rate: 'лимит запросов', auth: 'неверный токен', other: 'другое' };
  async function sha256hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function renderStatus(panel) {
    const [status, health, ops] = await Promise.all([rpc('get_service_status'), rpc('admin_health', { p_hours: 24 }), rpc('admin_ops_settings', {})]);
    // 1. notice
    const level = el('select', { 'aria-label': 'Уровень' }, [['info', 'Сообщение'], ['warn', 'Возможны сбои'], ['down', 'Сбой']].map(([v, n]) => el('option', { value: v, selected: status.level === v }, n)));
    const msg = el('input', { class: 'input', style: 'flex:1;min-width:280px', maxlength: 300, placeholder: 'Например: Kaspi не отвечает с 14:00, заказы обновятся сами. Чиним.', value: status.message || '' });
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
    );
  }

  async function renderConfig(panel) {
    const c = await rpc('admin_get_config');
    const f = {};
    const num = (k) => (f[k] = el('input', { class: 'input', type: 'number', min: 0, value: c[k] }));
    f.kaspi_qr_url = el('input', { class: 'input', placeholder: 'https://…/kaspi-qr.png', value: c.kaspi_qr_url || '', style: 'min-width:420px' });
    f.terms_version = el('input', { class: 'input', value: c.terms_version || '', placeholder: '2026-11-16' });
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
              ['base_price', 'base_stores', 'extra_store_price', 'trial_days', 'trial_store_limit', 'max_months', 'remind_days'].forEach((k) => (p[k] = Number(f[k].value)));
              p.kaspi_qr_url = f.kaspi_qr_url.value.trim();
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
      document.title = (page.total ? `(${page.total}) ` : '') + 'Seller Hub — админка';
      const open = await rpc('admin_tickets', { p_status: 'open', p_search: null, p_limit: 1, p_offset: 0 }).catch(() => null);
      if (open) {
        if (knownTickets != null && open.open > knownTickets) {
          toast('Новый вопрос в поддержку');
          try {
            if (window.Notification && Notification.permission === 'granted') new Notification('Новый вопрос Seller Hub', { body: 'Откройте вкладку «Вопросы»' });
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
