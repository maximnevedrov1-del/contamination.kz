module.exports = function fixture(shop, opts = {}) {
  if (opts.login) return `<!doctype html><html><body><form action="/login"><input type="password"></form></body></html>`;
  if (opts.public) return `<!doctype html><html><body><h1>Kaspi Магазин</h1></body></html>`;
  const shops = { A: { id: '1001', name: 'Электроника Плюс' }, B: { id: '1002', name: 'HomeStyle KZ' }, C: { id: '1003', name: 'Детский мир Алматы' } };
  const s = shops[shop];
  const d = (n, h = 10) => { const x = new Date(Date.now() - n * 86400000); return `${String(x.getDate()).padStart(2,'0')}.${String(x.getMonth()+1).padStart(2,'0')}.${x.getFullYear()} ${h}:15`; };
  const base = { A: 500000, B: 600000, C: 700000 }[shop];
  const statuses = ['Новый', 'Новый', 'Упакован', 'Выдан', 'Доставка', 'Новый', 'Выдан', 'Отменён'];
  const pays = ['Оплачен', 'Ожидает подтверждения', 'Оплачен', 'Оплачен', 'Оплачен', 'Ожидает подтверждения', 'Ошибка оплаты', 'Оплачен'];
  const names = ['Айгерим С.', 'Ерлан К.', 'Мария П.', 'Нурлан Б.', 'Динара А.', 'Тимур Ж.', 'Алия М.', 'Сергей В.'];
  let rows = '';
  for (let i = 0; i < 24; i++) {
    const id = base + i * 37;
    rows += `<tr data-testid="order-row"><td data-testid="order-code"><a href="/mc/#/orders/${id}">${id}</a></td><td data-testid="order-date">${d(i % 20, 9 + (i % 9))}</td>
    <td data-testid="order-customer">${names[i % 8]}</td><td data-testid="order-status">${statuses[i % 8]}</td><td data-testid="order-total">${(15000 + ((i * 7919 + base) % 90000)).toLocaleString('ru-RU')} ₸</td>
    <td data-testid="order-payment">${pays[i % 8]}</td><td>${statuses[i % 8] === 'Новый' ? '<button data-testid="pack-button">Упаковать</button>' : ''}</td></tr>`;
  }
  let ret = '';
  for (let i = 0; i < (shop === 'B' ? 4 : 2); i++) ret += `<tr data-testid="return-row"><td data-testid="return-order-code">${base + 900 + i}</td><td data-testid="return-date">${d(i * 3)}</td><td data-testid="return-status">Возврат</td><td data-testid="return-amount">${12000 + i * 3000} ₸</td><td data-testid="return-reason">${['Не подошёл размер', 'Брак', 'Передумал'][i % 3]}</td></tr>`;
  let ref = `<tr data-testid="refusal-row"><td data-testid="refusal-order-code">${base + 950}</td><td data-testid="refusal-date">${d(2)}</td><td data-testid="refusal-status">Отказ</td><td data-testid="refusal-amount">8 900 ₸</td><td data-testid="refusal-reason">Клиент не выкупил</td></tr>`;
  let series = '';
  for (let i = 29; i >= 0; i--) series += `<tr><td>${d(i)}</td><td>${(180000 + ((i * 31337 + base) % 260000)) * ({A:1,B:0.7,C:1.3}[shop])|0} ₸</td><td>${6 + ((i * 7 + base) % 9)}</td></tr>`;
  const prods = [['SKU-01','Наушники TWS'],['SKU-02','Чайник электрический'],['SKU-03','Детский конструктор']].map(([sku,n],i)=>`<tr><td>${sku}-${shop}</td><td>${n}</td><td>${(320000 - i*70000)*({A:1,B:0.7,C:1.3}[shop])|0} ₸</td><td>${40 - i*9}</td><td>${2 + i*(shop==='B'?3:1)}</td></tr>`).join('');
  const conv = [[`c${shop}1`, names[(base/100000)%8|0], 'Здравствуйте, когда будет доставка?', 2, '10:42'], [`c${shop}2`, names[3], 'Сәлеметсіз бе, тауар бар ма?', 1, 'вчера 18:05'], [`c${shop}3`, names[5], 'Спасибо!', 0, '12.11.2026']]
    .map(([id, n, p, u, tm]) => `<li data-testid="chat-conversation" ${opts.noconvid ? '' : `data-conversation-id="${id}"`}><span data-testid="chat-customer">${n}</span><span data-testid="chat-preview">${p}</span><time data-testid="chat-time">${tm}</time>${u ? `<span data-testid="chat-unread">${u}</span>` : ''}</li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Kaspi Магазин — ${s.name}</title></head><body>
  <header><div data-testid="merchant-menu"><span data-testid="merchant-name">${s.name}</span><span data-merchant-id="${s.id}"></span></div></header>
  <table data-testid="orders-table"><tbody>${rows}</tbody></table>
  <table class="returns-table"><tbody>${ret}</tbody></table>
  <table class="refusals-table"><tbody>${ref}</tbody></table>
  <section><div data-testid="kpi-views"><span class="value">${shop==='A'?'12 400':''}</span></div><div data-testid="kpi-orders"><span class="value">${shop==='A'?'186':''}</span></div>
  <table data-testid="daily-stats"><tbody>${series}</tbody></table><table data-testid="top-products"><tbody>${prods}</tbody></table></section>
  <ul>${conv}</ul>
  <div data-testid="chat-thread" data-conversation-id=""><div class="msgs"></div><div class="chat-composer"><textarea data-testid="chat-input"></textarea><button data-testid="chat-send">Отправить</button></div></div>
  <script>
  window.PACKFAIL = ${opts.packfail ? 'true' : 'false'};
  document.addEventListener('click', (e) => {
    const pb = e.target.closest('[data-testid="pack-button"]');
    if (pb && !window.PACKFAIL) { const tr = pb.closest('tr'); const id = tr.querySelector('[data-testid="order-code"]').textContent.trim();
      setTimeout(() => { tr.querySelector('[data-testid="order-status"]').textContent = 'Упакован'; pb.remove();
        const a = document.createElement('a'); a.dataset.testid = 'invoice-link'; a.href = '/mc/invoice/' + id + '.html'; a.textContent = 'Накладная'; document.body.append(a); }, 300); }
    const ci = e.target.closest('[data-testid="chat-conversation"]');
    if (ci) { const th = document.querySelector('[data-testid="chat-thread"]'); th.dataset.conversationId = ci.dataset.conversationId; ci.querySelector('[data-testid="chat-unread"]')?.remove();
      th.querySelector('.msgs').innerHTML = '<div data-testid="chat-message" data-message-id="m1"><span data-testid="chat-message-text">' + ci.querySelector('[data-testid="chat-preview"]').textContent + '</span><time data-testid="chat-message-time">10:42</time></div>'; }
    if (e.target.closest('[data-testid="chat-send"]')) { const ta = document.querySelector('[data-testid="chat-input"]'); const m = document.createElement('div');
      m.dataset.testid = 'chat-message'; m.className = 'chat-thread__message--outgoing'; m.innerHTML = '<span data-testid="chat-message-text"></span>'; m.firstChild.textContent = ta.value; document.querySelector('.msgs').append(m); ta.value = ''; }
  });
  </script></body></html>`;
};
