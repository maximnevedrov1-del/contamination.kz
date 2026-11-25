import './account-scope.css';

const lock = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M12 14v3"/></svg>';
const shop = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 8 2-5h12l2 5M4 8v12h16V8M4 8h16M9 20v-7h6v7"/><path d="M4 8v2a2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0V8"/></svg>';
const bank = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 8 9-5 9 5H3ZM5 11v7m7-7v7m7-7v7M3 21h18M3 18h18"/></svg>';
const tick = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';

export const accountScopeMarkup = `
<div class="account-access-scope" data-account-scope>
  <div class="account-scope-heading">
    <span class="account-scope-symbol">${lock}</span>
    <div><span class="account-scope-eyebrow">Понятные границы подключения</span><h3>Банковский счёт<br><span>не подключается.</span></h3></div>
    <span class="account-scope-tag">API Магазина Kaspi</span>
  </div>
  <p class="account-scope-intro">Вы передаёте токен Магазина на Kaspi.kz для работы с заказами. В этой схеме банковский кабинет остаётся отдельно.</p>
  <div class="account-scope-grid">
    <div class="account-shop-card">
      <div class="account-card-heading"><span class="account-card-icon">${shop}</span><div><h4>Ваш магазин</h4><small>Данные для работы команды</small></div><span class="account-access-pill">Через API</span></div>
      <div class="account-token-route" aria-label="Магазин передаёт данные через токен API в SaudaPulse"><span>Магазин</span><i aria-hidden="true"></i><b>API-токен</b><i aria-hidden="true"></i><span>SaudaPulse</span></div>
      <div class="account-scope-row"><span>${tick} Заказы и их состав</span><b>Для сборки</b></div>
      <div class="account-scope-row"><span>${tick} Товары и статусы</span><b>Для контроля</b></div>
      <div class="account-scope-row"><span>${tick} Суммы заказов</span><b>Для аналитики</b></div>
    </div>
    <div class="account-bank-card" data-banking-access="not-connected">
      <div class="account-card-heading"><span class="account-card-icon">${bank}</span><div><h4>Банковский кабинет</h4><small>Вне схемы подключения</small></div><span class="account-access-pill">Не подключён</span></div>
      <div class="account-bank-boundary"><span>${lock}</span><div><b>Подключение магазина не открывает банковский кабинет</b><small>Банковский доступ для этого сценария не запрашивается.</small></div></div>
      <div class="account-scope-row"><span>Баланс счёта и выписки</span><b>Не запрашиваются</b></div>
      <div class="account-scope-row"><span>Переводы и списания</span><b>Вне подключения</b></div>
      <div class="account-scope-row"><span>Реквизиты счёта</span><b>Не нужны для настройки</b></div>
    </div>
  </div>
  <div class="account-credential-note"><span>${lock}</span><p><b>Для этой формы нужен API-токен магазина.</b> Пароль банковского кабинета, PIN и SMS-коды сюда вводить не нужно.</p></div>
  <details class="account-data-explainer" data-account-explainer>
    <summary>Какие данные сервис получает для аналитики?</summary>
    <p>В рабочем сервисе через API поступают данные магазина: товары, заказы, их статусы и суммы. В заказах также могут быть имя, телефон и адрес покупателя. Это нужно для обработки и сборки заказов.</p>
    <p><strong>Выручка по заказам в дашборде отличается от баланса банковского счёта.</strong> В этой схеме сервис не подключает банковский кабинет и не запрашивает банковские выписки или право проводить переводы.</p>
    <p>API-токен даёт доступ к магазину и требует осторожного обращения. Перед настоящим подключением согласуйте получателя токена, условия обработки данных и права доступа. Демо показывает схему, а не результаты аудита рабочего сервиса.</p>
    <a href="https://guide.kaspi.kz/partner/ru/shop/api/general/q3195" target="_blank" rel="noopener noreferrer">Что Kaspi говорит о токене API ↗</a>
  </details>
</div>`;
