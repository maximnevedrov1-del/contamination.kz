import { observeDemoPlayer, listenToMotion, addMotionNote } from './demo-visibility.js';
import './live-demo.css';

const phases = [
  { label: 'Новый', title: 'Заказ пришёл. Уже в общей очереди.', text: 'Заказ из магазина 02 появляется рядом с заказами других магазинов.', notice: 'Новый заказ из магазина 02', detail: '3 товара · заказ #KSP-2053', action: 'Принять заказ', next: 'Следующий шаг: принять заказ', owner: 'Нужно принять', picker: 'Задание ещё не назначено', checked: 0, fresh: 12, packing: 18, ready: 7, shipped: 12 },
  { label: 'Принят', title: 'Вы приняли заказ в одном окне.', text: 'Владелец видит статус и назначает сборщика в том же рабочем пространстве.', notice: 'Заказ принят в работу', detail: 'Ответственный: сборщик Арман', action: 'Назначить сборщика', next: 'Следующий шаг: передать на сборку', owner: 'Принят в работу', picker: 'Арман назначен', checked: 0, fresh: 11, packing: 18, ready: 7, shipped: 12 },
  { label: 'В сборке', title: 'Сборщик получает своё задание.', text: 'Он видит состав заказа и отмечает товары. Финансы владельца остаются скрыты.', notice: 'Арман начал сборку', detail: 'Отмечен 1 из 3 товаров', action: 'Сборщик отмечает товары', next: 'Следующий шаг: проверить комплектацию', owner: 'В сборке у Армана', picker: 'Собирает 3 товара', checked: 1, fresh: 11, packing: 19, ready: 7, shipped: 12 },
  { label: 'Проверен', title: 'Все товары на месте. Можно упаковывать.', text: 'Отметки сборщика видны владельцу. По примеру заказа собрано 3 из 3 товаров.', notice: 'Комплектация проверена', detail: '3 из 3 товаров отмечены', action: 'Подготовить накладную', next: 'Следующий шаг: подготовить документы', owner: 'Готов к отгрузке', picker: '3 / 3 товара собраны', checked: 3, fresh: 11, packing: 18, ready: 8, shipped: 12 },
  { label: 'Накладная готова', title: 'Документы рядом с заказом.', text: 'Накладная подготовлена в том же процессе. Не нужно снова искать магазин и заказ.', notice: 'Накладная подготовлена', detail: 'Демонстрационный документ · #KSP-2053', action: 'Передать на отгрузку', next: 'Следующий шаг: передать отправление', owner: 'Документы готовы', picker: 'Посылка упакована', checked: 3, fresh: 11, packing: 18, ready: 8, shipped: 12 },
  { label: 'Отгружен', title: 'Заказ передан. Владелец видит результат.', text: 'Статус и операционные показатели обновились. Этот заказ прошёл весь путь в одном окне.', notice: 'Заказ передан на отгрузку', detail: 'Пример сценария завершён', action: 'Заказ завершён', next: 'Заказ прошёл все этапы', owner: 'Передан на отгрузку', picker: 'Задание выполнено', checked: 3, fresh: 11, packing: 18, ready: 7, shipped: 13 },
];
const stepNames = ['Новый заказ', 'Приём', 'Сборка', 'Проверка', 'Накладная', 'Отгрузка'];
const playIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 11 7-11 7Z" fill="currentColor"/></svg>';
const pauseIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14" stroke="currentColor" stroke-width="3"/></svg>';
const checkIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4 10-10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

export function mountLiveDemo(anchor) {
  if (!anchor || document.querySelector('#live-demo')) return;
  anchor.insertAdjacentHTML('afterend', `
    <section class="live-demo-section section-shell" id="live-demo" data-phase="0" data-running="false">
      <div class="live-demo-heading">
        <div><span class="section-kicker">Посмотрите процесс в движении</span><h2>Один заказ.<br><span>Весь путь перед вами.</span></h2></div>
        <div class="live-demo-caption"><p>Посмотрите путь заказа от новой заявки до отгрузки.</p></div>
      </div>
      <div class="demo-visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-demo-announcer></div>
      <div class="live-demo-player">
        <div class="live-demo-toolbar"><span class="demo-wordmark"><span class="demo-mark">s</span> saudapulse <small>ДЕМО</small></span><div class="demo-player-controls"><button type="button" data-demo-toggle>${pauseIcon} Пауза</button><button type="button" data-demo-restart><span aria-hidden="true">↻</span> Повторить</button></div></div>
        <div class="demo-story"><div class="demo-story-count"><span data-demo-chapter>01</span> / 06</div><div><h3 data-demo-title></h3><p data-demo-text></p></div></div>
        <div class="demo-workspace">
          <div class="demo-main-window">
            <div class="demo-window-header"><span class="demo-window-dots"><i></i><i></i><i></i></span><b>Операционный центр</b><span>Все 3 магазина</span></div>
            <div class="demo-metrics">
              <div><small>Новые</small><strong data-demo-fresh>12</strong></div><div><small>В сборке</small><strong data-demo-packing>18</strong></div><div><small>Готовы</small><strong data-demo-ready>7</strong></div><div><small>Отгружены</small><strong data-demo-shipped>12</strong></div>
            </div>
            <div class="demo-order"><div class="demo-order-heading"><span class="demo-kaspi">K</span><div><b>#KSP-2053</b><small>Kaspi · Магазин 02</small></div><span class="demo-order-status" data-demo-status>Новый</span></div>
              <div class="demo-product" data-demo-product="0"><span class="demo-product-symbol">A</span><div><b>Воздушный фильтр</b><small>AF-104 · 1 шт.</small></div><span class="demo-product-check">${checkIcon}</span></div>
              <div class="demo-product" data-demo-product="1"><span class="demo-product-symbol">M</span><div><b>Моторное масло 5W-30</b><small>MO-530 · 1 шт.</small></div><span class="demo-product-check">${checkIcon}</span></div>
              <div class="demo-product" data-demo-product="2"><span class="demo-product-symbol">C</span><div><b>Салонный фильтр</b><small>CF-208 · 1 шт.</small></div><span class="demo-product-check">${checkIcon}</span></div>
              <div class="demo-order-footer"><span data-demo-next></span><span class="demo-action" data-demo-action></span></div>
            </div>
          </div>
          <aside class="demo-companion"><div class="demo-owner-card"><span class="demo-role-label">Кабинет владельца</span><div class="demo-owner-kpi"><small>Выручка сегодня · пример</small><strong data-demo-revenue>248 500 ₸</strong></div><div class="demo-mini-chart" aria-hidden="true"><i style="--bar:38%"></i><i style="--bar:58%"></i><i style="--bar:46%"></i><i style="--bar:76%"></i><i style="--bar:64%"></i><i style="--bar:91%"></i><i style="--bar:82%"></i></div><div class="demo-owner-status"><i></i><span data-demo-owner></span></div></div>
            <div class="demo-picker-card"><span class="demo-role-label">Кабинет сборщика</span><div class="demo-picker-profile"><span>А</span><div><b>Арман</b><small>Задания без финансов</small></div></div><div class="demo-picker-task"><b>#KSP-2053</b><span data-demo-picker></span><div class="demo-check-progress"><i></i><i></i><i></i></div></div></div>
          </aside>
          <div class="demo-notification"><span class="demo-notification-icon">${checkIcon}</span><div><b data-demo-notice></b><small data-demo-detail></small></div><span class="demo-notification-time">ДЕМО</span></div>
        </div>
        <div class="demo-steps" aria-label="Выберите этап демонстрации">${stepNames.map((name, i) => `<button type="button" data-demo-step="${i}" aria-pressed="${i === 0}"><span class="demo-step-no">0${i + 1}</span><b>${name}</b><span class="demo-step-progress"><i></i></span></button>`).join('')}</div>
        <div class="demo-player-foot"><span>Демонстрационные данные. 18 секунд анимации показывают сценарий, а не скорость обработки заказа.</span><a href="#install" data-sp-install data-open-label="Открыть SaudaPulse">Попробовать 14 дней бесплатно <span aria-hidden="true">→</span></a></div>
      </div>
    </section>`);

  const root = document.querySelector('#live-demo');
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const updateMotionNote = addMotionNote(root, '.live-demo-toolbar');
  let phase = 0;
  let userPaused = motion.matches;
  let inView = false;
  let timer = null;

  function render(announce = false) {
    const scene = phases[phase];
    root.dataset.phase = String(phase);
    const fields = { chapter: String(phase + 1).padStart(2, '0'), title: scene.title, text: scene.text, status: scene.label, next: scene.next, action: scene.action, owner: scene.owner, picker: scene.picker, notice: scene.notice, detail: scene.detail, fresh: scene.fresh, packing: scene.packing, ready: scene.ready, shipped: scene.shipped };
    Object.entries(fields).forEach(([key, value]) => { root.querySelector(`[data-demo-${key}]`).textContent = String(value); });
    // Announce deliberate navigation, not every automatic frame.
    if (announce) root.querySelector('[data-demo-announcer]').textContent = `Этап ${phase + 1} из 6. ${scene.label}. ${scene.text}`;
    root.querySelectorAll('[data-demo-step]').forEach((step, i) => {
      step.classList.toggle('is-current', i === phase);
      step.classList.toggle('is-complete', i < phase);
      step.setAttribute('aria-pressed', String(i === phase));
    });
    root.querySelectorAll('[data-demo-product]').forEach((product, i) => product.classList.toggle('is-checked', i < scene.checked));
    root.querySelectorAll('.demo-check-progress i').forEach((dot, i) => dot.classList.toggle('is-checked', i < scene.checked));
    root.classList.remove('demo-scene-change');
    // Restart the short notification entrance for each scene.
    void root.offsetWidth;
    root.classList.add('demo-scene-change');
  }

  function syncPlayback() {
    clearInterval(timer);
    timer = null;
    const running = !userPaused && inView && !document.hidden;
    root.dataset.running = String(running);
    updateMotionNote(motion.matches, running);
    const button = root.querySelector('[data-demo-toggle]');
    button.innerHTML = running ? `${pauseIcon} Пауза` : `${playIcon} Воспроизвести`;
    button.setAttribute('aria-label', running ? 'Приостановить демонстрацию' : 'Воспроизвести демонстрацию');
    if (running) timer = setInterval(() => { phase = (phase + 1) % phases.length; render(); }, 3000);
  }

  root.querySelector('[data-demo-toggle]').addEventListener('click', () => { userPaused = root.dataset.running === 'true'; syncPlayback(); root.querySelector('[data-demo-announcer]').textContent = userPaused ? 'Демонстрация на паузе.' : 'Демонстрация воспроизводится.'; });
  root.querySelector('[data-demo-restart]').addEventListener('click', () => { phase = 0; userPaused = motion.matches; render(true); syncPlayback(); });
  root.querySelectorAll('[data-demo-step]').forEach((step) => step.addEventListener('click', () => { phase = Number(step.dataset.demoStep); userPaused = true; render(true); syncPlayback(); }));
  document.addEventListener('visibilitychange', syncPlayback);
  listenToMotion(motion, () => { if (motion.matches) userPaused = true; syncPlayback(); });
  observeDemoPlayer(root, '.live-demo-player', (visible) => { inView = visible; syncPlayback(); });
  render();
  syncPlayback();
}
