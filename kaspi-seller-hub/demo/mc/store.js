/*
 * Kaspi Seller Hub — DEMO store page (NOT Kaspi). Builds a fake seller cabinet
 * that matches the placeholder selectors in shared/selectors.js, with dates
 * relative to today. Used only for manual testing — see README › Demo.
 */
(() => {
  const SHOPS = {
    A: { id: '1001', name: 'Электроника Плюс', base: 500000, k: 1 },
    B: { id: '1002', name: 'HomeStyle KZ', base: 600000, k: 0.7 },
    C: { id: '1003', name: 'Детский мир Алматы', base: 700000, k: 1.3 },
  };
  const s = SHOPS[window.DEMO_SHOP] || SHOPS.A;
  const page = location.pathname.split('/').pop();
  const pad = (n) => String(n).padStart(2, '0');
  const day = (n, h = 10) => { const x = new Date(Date.now() - n * 86400000); return `${pad(x.getDate())}.${pad(x.getMonth() + 1)}.${x.getFullYear()} ${pad(h)}:15`; };
  const money = (n) => `${Math.round(n).toLocaleString('ru-RU')} ₸`;
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  const statuses = ['Новый', 'Новый', 'Упакован', 'Выдан', 'Передан в доставку', 'Новый', 'Выдан', 'Отменён'];
  const pays = ['Оплачен', 'Ожидает подтверждения', 'Оплачен', 'Оплачен', 'Оплачен', 'Ожидает подтверждения', 'Не оплачен', 'Оплачен'];
  const names = ['Айгерим С.', 'Ерлан К.', 'Мария П.', 'Нурлан Б.', 'Динара А.', 'Тимур Ж.', 'Алия М.', 'Сергей В.'];

  let orders = '';
  for (let i = 0; i < 24; i++) {
    const id = s.base + i * 37;
    const st = statuses[i % 8];
    orders += `<tr data-testid="order-row"><td data-testid="order-code"><a href="#/orders/${id}">${id}</a></td>
      <td data-testid="order-date">${day(i % 20, 9 + (i % 9))}</td><td data-testid="order-customer">${names[(i + s.base / 100000) % 8]}</td>
      <td data-testid="order-status">${st}</td><td data-testid="order-total">${money(15000 + ((i * 7919 + s.base) % 90000))}</td>
      <td data-testid="order-payment">${pays[i % 8]}</td><td>${st === 'Новый' ? '<button data-testid="pack-button">Упаковать</button>' : ''}</td></tr>`;
  }
  const reasons = ['Не подошёл размер', 'Брак', 'Передумал', 'Не соответствует описанию'];
  let returns = '';
  for (let i = 0; i < (window.DEMO_SHOP === 'B' ? 4 : 2); i++) {
    const id = s.base + 900 + i;
    returns += `<tr data-testid="return-row"><td data-testid="return-order-code"><a href="${page}#/returns/${id}">${id}</a></td><td data-testid="return-date">${day(i * 3)}</td>
      <td data-testid="return-status">Возврат</td><td data-testid="return-amount">${money(12000 + i * 3000)}</td><td data-testid="return-reason">${reasons[i % 4]}</td></tr>`;
  }
  const refusals = `<tr data-testid="refusal-row"><td data-testid="refusal-order-code"><a href="${page}#/refusals/${s.base + 950}">${s.base + 950}</a></td><td data-testid="refusal-date">${day(2)}</td>
    <td data-testid="refusal-status">Отказ</td><td data-testid="refusal-amount">8 900 ₸</td><td data-testid="refusal-reason">Клиент не выкупил</td></tr>`;
  let series = '';
  for (let i = 29; i >= 0; i--) series += `<tr><td>${day(i)}</td><td>${money((180000 + ((i * 31337 + s.base) % 260000)) * s.k)}</td><td>${6 + ((i * 7 + s.base) % 9)}</td></tr>`;
  const products = [['SKU-01', 'Наушники TWS'], ['SKU-02', 'Чайник электрический'], ['SKU-03', 'Детский конструктор']]
    .map(([sku, n], i) => `<tr><td>${sku}-${window.DEMO_SHOP}</td><td>${n}</td><td>${money((320000 - i * 70000) * s.k)}</td><td>${40 - i * 9}</td><td>${2 + i * (window.DEMO_SHOP === 'B' ? 3 : 1)}</td></tr>`).join('');
  const convs = [
    [`c${s.id}1`, names[(s.base / 100000) % 8], 'Здравствуйте, когда будет доставка?', 2, '10:42'],
    [`c${s.id}2`, names[3], 'Сәлеметсіз бе, тауар бар ма?', 1, 'вчера 18:05'],
    [`c${s.id}3`, names[5], 'Спасибо, всё пришло!', 0, day(4)],
  ].map(([id, n, p, u, t]) => `<li data-testid="chat-conversation" data-conversation-id="${id}"><b data-testid="chat-customer">${n}</b>
     <span data-testid="chat-preview">${p}</span> <time data-testid="chat-time">${t}</time>${u ? ` <span data-testid="chat-unread">${u}</span>` : ''}</li>`).join('');

  document.title = `ДЕМО — ${s.name}`;
  document.body.innerHTML = `
  <div class="demo-banner">ДЕМО-страница, не Kaspi. Магазин: <b>${esc(s.name)}</b>. Всё, что делает расширение, видно здесь.</div>
  <header data-testid="merchant-menu"><span data-testid="merchant-name">${esc(s.name)}</span><span data-merchant-id="${s.id}"></span></header>
  <main>
    <section><h2>Заказы</h2><table data-testid="orders-table"><tbody>${orders}</tbody></table></section>
    <section><h2>Возвраты</h2><table class="returns-table"><tbody>${returns}</tbody></table>
             <h2>Отказы</h2><table class="refusals-table"><tbody>${refusals}</tbody></table></section>
    <section><h2>Аналитика</h2>
      <div data-testid="kpi-views">Просмотры: <span class="value">${window.DEMO_SHOP === 'A' ? '12 400' : ''}</span></div>
      <div data-testid="kpi-orders">Заказы: <span class="value">${window.DEMO_SHOP === 'A' ? '186' : ''}</span></div>
      <table data-testid="daily-stats"><tbody>${series}</tbody></table>
      <table data-testid="top-products"><tbody>${products}</tbody></table></section>
    <section><h2>Чат</h2><ul class="chat-list">${convs}</ul>
      <div data-testid="chat-thread" data-conversation-id=""><div class="msgs"><i>Откройте диалог</i></div>
        <div class="chat-composer"><textarea data-testid="chat-input"></textarea><button data-testid="chat-send">Отправить</button></div></div></section>
    <section id="invoices"><h2>Накладные</h2></section>
  </main>`;

  document.addEventListener('click', (e) => {
    const pb = e.target.closest('[data-testid="pack-button"]');
    if (pb) {
      const tr = pb.closest('tr');
      const id = tr.querySelector('[data-testid="order-code"]').textContent.trim();
      setTimeout(() => {
        tr.querySelector('[data-testid="order-status"]').textContent = 'Упакован';
        pb.remove();
        const inv = document.createElement('div');
        inv.dataset.testid = 'invoice-preview';
        inv.className = 'invoice';
        inv.innerHTML = `<style>.inv h1{font:20px sans-serif}.inv td{border:1px solid #000;padding:6px 10px}</style><div class="inv"><h1>Накладная (ДЕМО) № ${id}</h1>
          <table><tr><td>Продавец</td><td>${esc(s.name)}</td></tr><tr><td>Заказ</td><td>${id}</td></tr>
          <tr><td>Получатель</td><td>${esc(tr.querySelector('[data-testid="order-customer"]').textContent)}</td></tr>
          <tr><td>Сумма</td><td>${esc(tr.querySelector('[data-testid="order-total"]').textContent)}</td></tr></table></div>`;
        document.getElementById('invoices').append(inv);
      }, 400);
    }
    const ci = e.target.closest('[data-testid="chat-conversation"]');
    if (ci) {
      const th = document.querySelector('[data-testid="chat-thread"]');
      th.dataset.conversationId = ci.dataset.conversationId;
      ci.querySelector('[data-testid="chat-unread"]')?.remove();
      th.querySelector('.msgs').innerHTML = `<div data-testid="chat-message" data-message-id="m1"><span data-testid="chat-message-text">${esc(ci.querySelector('[data-testid="chat-preview"]').textContent)}</span> <time data-testid="chat-message-time">10:42</time></div>`;
    }
    if (e.target.closest('[data-testid="chat-send"]')) {
      const ta = document.querySelector('[data-testid="chat-input"]');
      if (!ta.value.trim()) return;
      const m = document.createElement('div');
      m.dataset.testid = 'chat-message';
      m.className = 'chat-thread__message--outgoing';
      m.innerHTML = '<span data-testid="chat-message-text"></span>';
      m.firstChild.textContent = ta.value;
      document.querySelector('.msgs').append(m);
      ta.value = '';
    }
  });
})();
