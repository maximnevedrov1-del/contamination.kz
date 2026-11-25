import './styles.css';
import { mountLiveDemo } from './live-demo.js';
import { mountConnectionDemo } from './connection-demo.js';
import { mountPickerDemo } from './picker-demo.js';
import { mountExpressDemo } from './express-demo.js';
import './readability.css';
import './landing-compact.css';
import { mountI18n } from './i18n.js';
import { mountInstallation } from './installation.js';

const icon = (name, size = 20) => {
  const paths = {
    arrow: `<path d="M5 12h14M13 6l6 6-6 6"/>`,
    check: `<path d="m5 12 4 4L19 6"/>`,
    box: `<path d="m21 8-9-5-9 5 9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8M12 13v8"/>`,
    chart: `<path d="M4 19V5M4 19h16"/><path d="m7 15 3-4 3 2 5-7"/>`,
    printer: `<path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v7H6z"/>`,
    shield: `<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>`,
    users: `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>`,
    clock: `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
    menu: `<path d="M4 6h16M4 12h16M4 18h16"/>`,
    close: `<path d="m6 6 12 12M18 6 6 18"/>`,
    spark: `<path d="m12 3-1.3 5.7L5 10l5.7 1.3L12 17l1.3-5.7L19 10l-5.7-1.3L12 3Z"/><path d="m19 16-.6 2.4L16 19l2.4.6L19 22l.6-2.4L22 19l-2.4-.6L19 16Z"/>`,
    lock: `<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>`,
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.spark}</svg>`;
};

const app = document.querySelector('#app');

app.innerHTML = `
  <div class="noise"></div>
  <header class="site-header">
    <a class="brand" href="#top" aria-label="SaudaPulse, на главную">
      <span class="brand-mark"><i></i><i></i><i></i></span>
      <span>sauda<span>pulse</span></span>
    </a>
    <nav class="main-nav" aria-label="Основная навигация">
      <a href="#live-demo">Демо</a>
      <a href="#assembly">Сборка</a>
      <a href="#economy">Экономия</a>
      <a href="#connection-demo">Подключение</a>
      <a href="#pricing">Тарифы</a>
    </nav>
    <a class="header-cta" href="#install" data-sp-install data-open-label="Открыть SaudaPulse">Установить бесплатно ${icon('arrow', 16)}</a>
    <button class="menu-btn" aria-label="Открыть меню">${icon('menu', 24)}</button>
  </header>


  <main id="top">
    <section class="hero section-shell" id="hero">
      <div class="hero-copy reveal">
        <div class="eyebrow"><span class="pulse-dot"></span> Для продавцов Kaspi в Казахстане</div>
        <h1><span class="hero-title-line">3 Kaspi - магазина.</span><br /><em>1 рабочее окно.</em></h1>
        <p class="hero-lead">Управляйте заказами, маржой и остатками по всем кабинетам без передачи паролей и себестоимости на чужие серверы. Сборщик видит только задания на упаковку — без доступа к вашим финансам и настройкам.</p>
        <div class="hero-actions">
          <a class="button button-primary" href="#install" data-sp-install data-open-label="Открыть SaudaPulse">Установить бесплатно ${icon('arrow', 16)}</a>
          <a class="text-link" href="#live-demo">Смотреть демо <span>↓</span></a>
        </div>
        <div class="hero-barrier">14 дней бесплатно, до 3 магазинов <i>•</i> Без привязки карты <i>•</i> Установка за 1 минуту</div>
        <div class="hero-proof"><span class="proof-avatars"><b>А</b><b>Д</b><b>М</b></span><span>Для владельца магазина и команды сборки</span></div>
      </div>
      <div class="hero-visual reveal reveal-delay">
        <div class="visual-orbit orbit-one"></div><div class="visual-orbit orbit-two"></div>
        <div class="dashboard-card">
          <div class="dash-top"><div><span class="dash-label">Сегодня · демо</span><strong>Операционный центр</strong></div><span class="live-status"><i></i> online</span></div>
          <div class="market-row"><span class="market-pill kaspi">K</span><span>Kaspi · Магазин 01</span><b>18 заказов</b><span class="row-state green">в работе</span></div>
          <div class="market-row"><span class="market-pill kaspi">K</span><span>Kaspi · Магазин 02</span><b>07 заказов</b><span class="row-state amber">сборка</span></div>
          <div class="market-row"><span class="market-pill kaspi">K</span><span>Kaspi · Магазин 03</span><b>12 заказов</b><span class="row-state blue">новые</span></div>
          <div class="dash-divider"></div>
          <div class="dash-bottom"><span>Всего сегодня</span><strong>37 <small>заказов</small></strong><span class="trend">+18% ${icon('chart', 15)}</span></div>
        </div>
        <div class="floating-card picker-card"><span class="float-icon">${icon('box', 18)}</span><div><b>Сборщик подключён</b><small>Видит только задания</small></div><span class="mini-check">${icon('check', 13)}</span></div>
        <div class="floating-card sync-card"><span class="sync-ring">${icon('check', 14)}</span><div><b>Синхронизировано</b><small>2 мин назад</small></div></div><div class="floating-card queue-card"><span class="float-icon lime-icon">${icon('chart', 16)}</span><div><b>3 магазина</b><small>одна очередь заказов</small></div></div><div class="floating-card role-card"><span class="sync-ring">${icon('lock', 14)}</span><div><b>Доступ сборщика</b><small>только задания</small></div></div>
      </div>

    <section class="benefits-section section-shell" aria-labelledby="benefits-title">
      <div class="benefits-heading"><span class="section-kicker">Почему SaudaPulse</span><h2 id="benefits-title">Контроль остаётся <span>у вас.</span></h2></div>
      <div class="benefits-grid">
        <article class="benefit-card"><span class="benefit-icon">${icon('lock', 22)}</span><h3>Ваши данные остаются у вас</h3><p>Себестоимость хранится только в вашем браузере, API-токены Kaspi — в зашифрованном виде (AES-GCM). На наш сервер они не передаются.</p></article>
        <article class="benefit-card"><span class="benefit-icon">${icon('box', 22)}</span><h3>От 1 до 5+ магазинов в одном окне</h3><p>Единая очередь заказов и аналитика. Нужно больше — докупите слот.</p></article>
        <article class="benefit-card"><span class="benefit-icon">${icon('users', 22)}</span><h3>Безопасный доступ для команды</h3><p>Роли для сборщиков и менеджеров без передачи логина и пароля от кабинета Kaspi.</p></article>
      </div>
    </section>
    </section>

    <section class="process-section section-shell" id="process">
      <div class="demo-anchor" id="features" hidden></div>
      <section class="product-preview section-shell" id="screens"><div class="gallery-heading"><h3>Четыре экрана для ежедневной работы</h3><p>Переключайте заказы, отгрузки, приём и аналитику.</p></div><div class="screen-tabs reveal"><button class="screen-tab active" data-screen="orders">${icon('box', 17)} Заказы</button><button class="screen-tab" data-screen="shipments">${icon('printer', 17)} Отгрузки</button><button class="screen-tab" data-screen="receiving">${icon('check', 17)} Приём</button><button class="screen-tab" data-screen="dashboard">${icon('chart', 17)} Дашборд</button></div><div class="screen-shell reveal reveal-delay"><div class="screen-topbar"><div class="screen-brand"><span class="screen-logo">K</span><span>SaudaPulse <small>Kaspi operations</small></span></div><div class="screen-store">Все магазины⌄</div><div class="screen-user"><span></span> Владелец</div></div><div class="screen-body"><aside class="screen-sidebar"><span class="side-active">${icon('box', 15)} <b>Заказы</b><i>37</i></span><span>${icon('printer', 15)} Отгрузки</span><span>${icon('check', 15)} Приём</span><span>${icon('chart', 15)} Дашборд</span><div class="side-separator"></div><span>${icon('users', 15)} Сборщики</span><span>${icon('lock', 15)} Доступы</span></aside><div class="screen-content"><div class="screen-pane active" data-pane="orders"><div class="pane-heading"><div><small>СЕГОДНЯ · ДЕМО</small><h3>Заказы</h3></div><button class="mini-button">+ Создать задачу</button></div><div class="kpi-row"><div><small>Новые</small><strong>12</strong><em>+4 за час</em></div><div><small>В сборке</small><strong>18</strong><em>6 у сборщиков</em></div><div><small>Готовы</small><strong>07</strong><em>к отгрузке</em></div></div><div class="table-card"><div class="table-head"><span>Номер заказа</span><span>Магазин</span><span>Сумма</span><span>Статус</span></div><div class="table-line"><b>#KSP-2048</b><span>Магазин 01</span><span>48 900 ₸</span><i class="status ready">готов к сборке</i></div><div class="table-line"><b>#KSP-7712</b><span>Магазин 02</span><span>16 500 ₸</span><i class="status packing">собирается</i></div><div class="table-line"><b>#KSP-4091</b><span>Магазин 03</span><span>82 300 ₸</span><i class="status new">новый</i></div></div></div><div class="screen-pane" data-pane="shipments"><div class="pane-heading"><div><small>ПОДГОТОВКА К ПЕРЕДАЧЕ</small><h3>Отгрузки</h3></div><button class="mini-button">${icon('printer', 14)} Печать накладных</button></div><div class="shipment-board"><div class="shipment-col"><b>Готовы к печати <i>07</i></b><div class="shipment-card"><strong>#KSP-2048</strong><span>3 товара · Магазин 01</span><small>Накладная готова</small></div><div class="shipment-card"><strong>#KSP-2061</strong><span>1 товар · Магазин 02</span><small>Накладная готова</small></div></div><div class="shipment-col"><b>Переданы <i>12</i></b><div class="shipment-card done"><strong>#KSP-1984</strong><span>2 товара · Магазин 03</span><small>${icon('check', 12)} Отгружено 11:42</small></div></div></div></div><div class="screen-pane" data-pane="receiving"><div class="pane-heading"><div><small>ПРИЁМКА И КОНТРОЛЬ</small><h3>Приём</h3></div><span class="screen-date">Сегодня, 14:30</span></div><div class="receiving-layout"><div class="scan-card"><div class="scan-frame">${icon('box', 31)}<span>Сканируйте штрихкод</span></div><button class="scan-button">Открыть сканер</button></div><div class="receive-list"><div><span class="receive-check">${icon('check', 13)}</span><span><b>Заказ #KSP-2048</b><small>3 из 3 товаров приняты</small></span><em>готово</em></div><div><span class="receive-check">${icon('check', 13)}</span><span><b>Заказ #KSP-2052</b><small>2 из 2 товаров приняты</small></span><em>готово</em></div><div class="receive-warning"><span class="receive-check">!</span><span><b>Заказ #KSP-2061</b><small>Не хватает 1 товара</small></span><em>проверить</em></div></div></div></div><div class="screen-pane" data-pane="dashboard"><div class="pane-heading"><div><small>АНАЛИТИКА ВЛАДЕЛЬЦА</small><h3>Дашборд</h3></div><span class="screen-date">19 ноября 2026⌄</span></div><div class="dashboard-layout"><div class="dash-kpi"><small>Выручка</small><strong>1 248 500 ₸</strong><em>+18,4% к прошлой неделе</em></div><div class="dash-kpi"><small>Заказов</small><strong>187</strong><em>+23 новых сегодня</em></div><div class="chart-card"><div><b>Заказы по дням</b><span>Последние 7 дней</span></div><div class="fake-chart"><i style="height:35%"></i><i style="height:54%"></i><i style="height:44%"></i><i style="height:71%"></i><i style="height:62%"></i><i style="height:88%"></i><i style="height:79%"></i></div></div><div class="top-stores"><b>Магазины</b><div><span>Магазин 01</span><strong>642 300 ₸</strong></div><div><span>Магазин 02</span><strong>391 200 ₸</strong></div><div><span>Магазин 03</span><strong>215 000 ₸</strong></div></div></div></div></div></div></div><div class="inline-cta"><span><b>Каждый экран отвечает на один вопрос</b><small>Что происходит с заказом прямо сейчас?</small></span><a class="button button-primary" href="#install" data-sp-install data-open-label="Открыть SaudaPulse">Установить бесплатно ${icon('arrow', 16)}</a></div></section>
      <div class="role-demo reveal"><div class="role-demo-head"><div><span class="section-kicker">Роли без лишних доступов</span><h3>Доступы по ролям</h3></div><div class="role-tabs"><button class="role-tab active" data-role="owner">Владелец</button><button class="role-tab" data-role="picker">Сборщик</button></div></div><div class="role-panels"><div class="role-panel active" data-role-panel="owner"><div class="role-panel-top"><div class="role-avatar owner-avatar">В</div><div><b>Кабинет владельца</b><small>Полный контроль магазина</small></div><span class="role-access">Все данные</span></div><div class="role-kpis"><div><small>Выручка сегодня</small><strong>248 500 ₸</strong><em>+18,4%</em></div><div><small>Заказы</small><strong>37</strong><em>12 новых</em></div><div><small>Магазины</small><strong>3</strong><em>в работе</em></div></div><div class="role-chart"><div class="role-chart-title"><b>Продажи по магазинам</b><span>Сегодня⌄</span></div><div class="role-bars"><i style="height:72%"><small>01</small></i><i style="height:51%"><small>02</small></i><i style="height:34%"><small>03</small></i></div></div></div><div class="role-panel" data-role-panel="picker"><div class="role-panel-top"><div class="role-avatar picker-avatar">С</div><div><b>Кабинет сборщика</b><small>Только рабочие задания</small></div><span class="role-access limited">Без финансов</span></div><div class="picker-summary"><div><strong>6</strong><span>заданий<br />на сегодня</span></div><div><strong>4</strong><span>собрано<br />сейчас</span></div><div><strong>12 мин</strong><span>среднее<br />время</span></div></div><div class="picker-tasks"><div><span class="task-dot in-progress"></span><b>#KSP-2048</b><small>3 товара · Магазин 01</small><em>собираю</em></div><div><span class="task-dot"></span><b>#KSP-2061</b><small>1 товар · Магазин 02</small><em>новое</em></div><div><span class="task-dot done-dot">${icon('check', 11)}</span><b>#KSP-1984</b><small>2 товара · Магазин 03</small><em>готово</em></div></div></div></div><div class="shared-dashboard"><span class="shared-icon">${icon('chart', 17)}</span><span><b>Дашборд есть у каждой роли</b><small>Владелец видит деньги и магазины. Сборщик — нагрузку, задания и скорость.</small></span><span class="shared-lock">${icon('shield', 16)}</span></div></div>
      <section class="comparison-block" id="comparison" aria-labelledby="comparison-title">
        <div class="section-intro"><span class="section-kicker">Свобода от облачной зависимости</span><h2 id="comparison-title">Почему селлеры переходят<br /><span>на SaudaPulse.</span></h2><p>Сравните контроль, стоимость и приватность в одном окне.</p></div>
        <div class="comparison-table" role="table" aria-label="Сравнение SaudaPulse с облачными сервисами">
          <div class="comparison-row comparison-head" role="row"><span role="columnheader">Критерий</span><span role="columnheader">Облачные сервисы<br /><small></small></span><span role="columnheader">SaudaPulse</span></div>
          <div class="comparison-row" role="row"><b>Хранение себестоимости и токенов</b><span>Обычно хранятся на сервере сервиса</span><strong>Хранятся только в вашем браузере, токены зашифрованы — коммерческая тайна остаётся у вас</strong></div>
          <div class="comparison-row" role="row"><b>Оплата за несколько магазинов</b><span>Часто — отдельная подписка или доплата за каждый магазин</span><strong>От 12 000 ₸ за 1 магазин и 20 000 ₸ за 3 магазина в одном окне</strong></div>
          <div class="comparison-row" role="row"><b>Тестовый период</b><span>Короткий пробный период или оплата сразу</span><strong>14 полных дней бесплатно без привязки банковской карты</strong></div>
          <div class="comparison-row" role="row"><b>Скорость и стабильность</b><span>Зависимость от нагрузки общих серверов парсинга</span><strong>Мгновенная работа прямо в браузере Chrome</strong></div>
        </div>
      </section>
    </section>

    <section class="assembly-section section-shell" id="assembly">
      <div class="demo-anchor" id="express-anchor" hidden></div>
      <div class="demo-stack-mount" id="compare"></div>
    </section>

    <section class="time-section section-shell" id="economy"><div class="time-copy reveal"><span class="section-kicker">Выгода в минутах</span><h2>Меньше вкладок.<br /><span>Больше времени на продажи.</span></h2><p>Оцените экономию времени при вашем объёме заказов. Измените параметры и сравните ручную работу с единым окном.</p></div><div class="time-calculator reveal reveal-delay"><div class="calculator-head"><div><b>Ваш рабочий день</b><small>Допущение: 1,5 мин на заказ в одном окне</small></div><span class="calc-badge">пример</span></div><label class="range-field"><span><b>Заказов в день</b><strong id="orders-value">60</strong></span><input id="orders-range" type="range" min="10" max="200" value="60" step="10" /></label><label class="range-field"><span><b>Минут на заказ сейчас</b><strong id="manual-value">3,5</strong></span><input id="manual-range" type="range" min="1" max="8" value="3.5" step="0.5" /></label><label class="range-field"><span><b>Стоимость часа владельца</b><strong><span id="hour-value">5 000</span> ₸</strong></span><input id="hour-range" type="range" min="2000" max="15000" value="5000" step="500" /></label><div class="time-results"><div class="time-result"><small>Экономия в день</small><strong id="saved-minutes">120 мин</strong><span id="saved-hours">2 ч 00 мин</span></div><div class="time-result highlight"><small>Стоимость высвобождённого времени</small><strong id="saved-money">10 000 ₸</strong><span>в день · оценка по ставке часа</span></div></div><div class="month-summary"><span>Если работать 26 дней</span><b id="saved-month">260 000 ₸ / мес</b></div><div class="calc-breakdown"><span><i class="old-dot"></i>Вручную: вкладки + телефоны</span><b id="manual-total">210 мин</b></div><div class="calc-breakdown"><span><i class="new-dot"></i>В одном окне SaudaPulse</span><b id="flow-total">90 мин</b></div><p class="calculator-note">Расчётный пример: 1,5 минуты на заказ в SaudaPulse. Результат оценивает рабочее время, а не дополнительную прибыль.</p><a class="button button-primary calc-cta" href="#install" data-sp-install data-open-label="Открыть SaudaPulse">Установить бесплатно ${icon('arrow', 16)}</a></div><div class="time-visual reveal reveal-delay-2"><div class="window-stack"><div class="work-window back-window"><div class="window-bar"><i></i><i></i><i></i><span>Телефон сборщика</span></div><div class="phone-lines"><b>Новое задание</b><span>#KSP-2048</span><span>#KSP-2052</span><span>#KSP-2061</span></div></div><div class="work-window mid-window"><div class="window-bar"><i></i><i></i><i></i><span>Kaspi-магазин 02</span></div><div class="tab-rows"><b>Заказы</b><span>Отгрузки</span><span>Статусы</span><small>Переключение между окнами</small></div></div><div class="work-window front-window"><div class="window-bar dark"><i></i><i></i><i></i><span>SaudaPulse · всё в одном</span></div><div class="flow-lines"><div><strong>37</strong><span>заказов</span><em>в одной очереди</em></div><div><strong>6</strong><span>заданий</span><em>у сборщика</em></div><div><strong>3</strong><span>магазина</span><em>под контролем</em></div></div><div class="flow-footer">${icon('check', 13)} Следующий шаг виден сразу</div></div></div></div></section>
    <div class="demo-anchor" id="how" hidden></div>
    <section class="install-section section-shell" id="install"><div class="section-intro reveal"><span class="section-kicker">Старт за несколько минут</span><h2>Как установить<br /><span>SaudaPulse.</span></h2><p class="install-mobile-note">SaudaPulse работает в Chrome на компьютере. Отправьте себе ссылку и откройте её на ПК</p><button class="button button-secondary install-copy-link" type="button" data-copy-install-link>Скопировать ссылку</button></div><div class="install-steps"><article class="install-step"><b>01</b><h3>Откройте сайт в Google Chrome на компьютере</h3><p>Рабочий кабинет запускается в Chrome на вашем ПК.</p></article><article class="install-step"><b>02</b><h3>Нажмите «Установить» — откроется магазин Chrome</h3><p>Пока расширение проходит публикацию, напишите нам — пришлём установочный файл.</p></article><article class="install-step"><b>03</b><h3>Закрепите значок SaudaPulse и подключите магазин по API-токену</h3><p>Токен хранится в браузере и нужен только для работы вашего кабинета.</p></article></div><div class="install-actions"><a class="button button-primary" href="#install" data-sp-install data-open-label="Открыть SaudaPulse">Установить в Chrome ${icon('arrow', 16)}</a><a class="button button-secondary" href="https://t.me/SaudaPulse" target="_blank" rel="noopener">Написать в Telegram</a></div><p class="install-store-note">Публикация в магазине Chrome — скоро. Напишите нам в Telegram, пришлём установочный файл</p></section>
    <section class="pricing-section section-shell" id="pricing"><div class="section-intro reveal"><span class="section-kicker">Тарифы SaudaPulse</span><h2>Начните бесплатно.<br /><span>Платите по делу.</span></h2><p>14 дней бесплатно, до 3 магазинов. Выберите пакет по количеству магазинов.</p></div><div class="pricing-grid"><article class="price-card reveal"><span class="price-label">Один магазин</span><div class="price-visual"><span class="price-dot"></span><span class="price-dot muted"></span><span class="price-dot muted"></span><b>1 кабинет</b></div><div class="price">12 000 <small>₸ / мес</small></div><p>Для продавца, который начинает с одного кабинета.</p><ul><li>${icon('check', 16)} Заказы и статусы</li><li>${icon('check', 16)} Накладные</li><li>${icon('check', 16)} Кабинет сборщика</li><li>${icon('check', 16)} Аналитика</li></ul><a class="button button-secondary" href="#install" data-sp-install data-open-label="Открыть SaudaPulse">Начать 14 дней бесплатно ${icon('arrow', 16)}</a><small class="price-note">Без привязки карты</small></article><article class="price-card featured reveal reveal-delay"><span class="price-badge">Популярный выбор</span><span class="price-label">Три магазина</span><div class="price-visual"><span class="price-dot"></span><span class="price-dot"></span><span class="price-dot"></span><b>1 очередь</b></div><div class="price">20 000 <small>₸ / мес</small></div><p>Три Kaspi-магазина в одном окне для команды.</p><ul><li>${icon('check', 16)} Всё из «Один магазин»</li><li>${icon('check', 16)} 3 Kaspi-магазина в одной очереди</li></ul><a class="button button-primary" href="#install" data-sp-install data-open-label="Открыть SaudaPulse">Начать 14 дней бесплатно ${icon('arrow', 16)}</a><small class="price-note">Без привязки карты</small></article><article class="price-card reveal reveal-delay-2"><span class="price-label">Четыре магазина</span><div class="price-visual"><span class="price-dot"></span><span class="price-dot"></span><span class="price-dot"></span><b>+ магазин</b></div><div class="price">25 000 <small>₸ / мес</small></div><p>Расширьте единую очередь ещё на один магазин.</p><ul><li>${icon('check', 16)} Всё из «Один магазин»</li><li>${icon('check', 16)} 4 Kaspi-магазина в одной очереди</li></ul><a class="button button-secondary" href="#install" data-sp-install data-open-label="Открыть SaudaPulse">Начать 14 дней бесплатно ${icon('arrow', 16)}</a><small class="price-note">Без привязки карты</small></article><article class="price-card reveal"><span class="price-label">Пять магазинов</span><div class="price-visual"><span class="price-dot"></span><span class="price-dot"></span><span class="price-dot"></span><b>+ 2 магазина</b></div><div class="price">30 000 <small>₸ / мес</small></div><p>Полный рабочий контур для растущего продавца.</p><ul><li>${icon('check', 16)} Всё из «Один магазин»</li><li>${icon('check', 16)} 5 Kaspi-магазинов в одной очереди</li></ul><a class="button button-secondary" href="#install" data-sp-install data-open-label="Открыть SaudaPulse">Начать 14 дней бесплатно ${icon('arrow', 16)}</a><small class="price-note">Без привязки карты</small></article><article class="price-card reveal"><span class="price-label">Дополнительный слот</span><div class="price-visual"><span class="price-dot"></span><span class="price-dot muted"></span><span class="price-dot muted"></span><b>+ магазин</b></div><div class="price">5 000 <small>₸ / мес</small></div><p>Подключайте дополнительные магазины по мере роста.</p><ul><li>${icon('check', 16)} Единая очередь</li><li>${icon('check', 16)} Общая аналитика</li><li>${icon('check', 16)} Поддержка команды</li></ul><p class="slot-note">Докупается в расширении в разделе «Подписка»</p></article></div></section>
    <section class="pilot-section section-shell" id="pilot">
      <div class="pilot-panel">
        <div class="pilot-copy reveal">
          <span class="section-kicker">Пилот для вашей команды</span>
          <h2><em>Начните 14 дней бесплатно с SaudaPulse.</em></h2>
          <p>Установите расширение и подключите магазин по API-токену. Карта не нужна.</p>
          <div class="pilot-note"><span>${icon('shield', 18)}</span><span>14 дней бесплатно, до 3 магазинов • Без привязки карты</span></div>
        </div>
        <form class="pilot-form reveal reveal-delay" id="pilot-form">
          <div class="form-row">
            <label>Как к вам обращаться<input required name="name" placeholder="Ваше имя" autocomplete="name" /></label>
            <label>Телефон или Telegram<input required name="contact" placeholder="+7 700 000 00 00" /></label>
          </div>
          <fieldset class="store-count-field">
            <legend>Сколько Kaspi-магазинов подключить?</legend>
            <div class="market-selects">
              <label class="check-option"><input type="radio" name="market" value="Kaspi-1" checked /><span>1 магазин</span></label>
              <label class="check-option"><input type="radio" name="market" value="Kaspi-2" /><span>2 магазина</span></label>
              <label class="check-option"><input type="radio" name="market" value="Kaspi-3" /><span>3 магазина</span></label>
              <label class="check-option"><input type="radio" name="market" value="Kaspi-4plus" /><span>4+ / своя команда</span></label>
            </div>
          </fieldset>
          <label>Примерный объём заказов в день<select name="volume"><option>До 20</option><option>20–100</option><option>100–300</option><option>300+</option></select></label>
          <label class="consent"><input required type="checkbox" name="consent" /><span>Соглашаюсь на обработку данных для связи по пилоту.</span></label>
          <button class="button button-primary submit-button" type="submit">Отправить в Telegram ${icon('arrow', 18)}</button>
          <p class="form-footnote">Данные заявки подготовятся в сообщении Telegram.</p><a class="mail-application" data-mail-application href="mailto:support@saudapulse.kz">или на почту</a>
          <a class="telegram-fallback" data-telegram-fallback href="https://t.me/SaudaPulse" target="_blank" rel="noopener" hidden>Открыть Telegram</a>
          <button class="button button-secondary new-application" data-new-application type="button" hidden>Отправить ещё одну заявку</button>
        </form>
      </div>
    </section>
  </main>
  <footer class="site-footer section-shell"><a class="brand" href="#top"><span class="brand-mark"><i></i><i></i><i></i></span><span>sauda<span>pulse</span></span></a><span>Единое окно для продавцов Казахстана · 14 дней бесплатно</span><span class="footer-legal">© 2026 SaudaPulse · ИП «НЕВЕДРОВ», ИИН/БИН 900327302429</span><span class="footer-links"><a href="https://saudapulse.kz/offer">Оферта</a><a href="https://saudapulse.kz/privacy">Политика конфиденциальности</a><a href="https://t.me/SaudaPulse">Telegram @SaudaPulse</a><a href="mailto:support@saudapulse.kz">support@saudapulse.kz</a></span></footer>
  <div class="toast" role="status" aria-live="polite"></div>
`;

mountLiveDemo(document.querySelector('#features'));
mountConnectionDemo(document.querySelector('#how'));
mountPickerDemo(document.querySelector('#compare'));
mountExpressDemo(document.querySelector('#express-anchor'));

const menuBtn = document.querySelector('.menu-btn');
const nav = document.querySelector('.main-nav');
menuBtn.addEventListener('click', () => {
  nav.classList.toggle('open');
  menuBtn.innerHTML = nav.classList.contains('open') ? icon('close', 24) : icon('menu', 24);
});
nav.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => nav.classList.remove('open')));

document.querySelectorAll('.screen-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.screen;
    document.querySelectorAll('.screen-tab').forEach((item) => item.classList.toggle('active', item === tab));
    document.querySelectorAll('.screen-pane').forEach((pane) => pane.classList.toggle('active', pane.dataset.pane === target));
  });
});

document.querySelectorAll('.role-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.role;
    document.querySelectorAll('.role-tab').forEach((item) => item.classList.toggle('active', item === tab));
    document.querySelectorAll('.role-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.rolePanel === target));
  });
});

const ordersRange = document.querySelector('#orders-range');
const manualRange = document.querySelector('#manual-range');
const hourRange = document.querySelector('#hour-range');
const updateCalculator = () => {
  const orders = Number(ordersRange.value);
  const manualPerOrder = Number(manualRange.value);
  const marketFlowPerOrder = 1.5;
  const hourlyValue = Number(hourRange.value);
  const savedMinutes = Math.max(0, Math.round(orders * (manualPerOrder - marketFlowPerOrder)));
  const manualTotal = Math.round(orders * manualPerOrder);
  const flowTotal = Math.round(orders * marketFlowPerOrder);
  const money = Math.round((savedMinutes / 60) * hourlyValue / 100) * 100;
  document.querySelector('#orders-value').textContent = orders;
  document.querySelector('#manual-value').textContent = manualPerOrder.toLocaleString('ru-RU');
  document.querySelector('#hour-value').textContent = hourlyValue.toLocaleString('ru-RU');
  document.querySelector('#saved-minutes').textContent = `${savedMinutes} мин`;
  document.querySelector('#saved-hours').textContent = `${Math.floor(savedMinutes / 60)} ч ${String(savedMinutes % 60).padStart(2, '0')} мин`;
  document.querySelector('#saved-money').textContent = `${money.toLocaleString('ru-RU')} ₸`;
  document.querySelector('#saved-month').textContent = `${(money * 26).toLocaleString('ru-RU')} ₸ / мес`;
  document.querySelector('#manual-total').textContent = `${manualTotal} мин`;
  document.querySelector('#flow-total').textContent = `${flowTotal} мин`;
};
[ordersRange, manualRange, hourRange].forEach((control) => control.addEventListener('input', updateCalculator));
updateCalculator();

const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) entry.target.classList.add('visible');
  });
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach((element) => observer.observe(element));

mountI18n(document.querySelector('#app'));
mountInstallation();
