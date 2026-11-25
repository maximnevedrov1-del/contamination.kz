import { accountScopeMarkup } from './account-scope.js';
import { observeDemoPlayer, listenToMotion, addMotionNote } from './demo-visibility.js';
import './connection-demo.css';

// Deliberately fake. No clipboard, credentials, storage, or API requests.
const fakeToken = 'DEMO-KASPI-7F2A-EXAMPLE';
const scenes = [
  { title: 'Откройте «Настройки → Токен API».', text: 'В кабинете Kaspi руководитель компании формирует токен. Здесь показана схема этого шага.', state: 'Ожидает подключения', copy: 'Скопировать', token: 'Сюда вставляется API-токен', notice: 'Начните с токена API', detail: 'Ни логин, ни пароль Kaspi в SaudaPulse не вводятся.' },
  { title: 'Скопируйте API-токен.', text: 'Один ключ связывает конкретный магазин с сервисом. В этом примере ключ вымышленный.', state: 'Токен скопирован · демо', copy: 'Скопировано', token: 'Сюда вставляется API-токен', notice: 'Токен скопирован в демо', detail: 'Настоящий буфер обмена не используется.' },
  { title: 'Вставьте токен в SaudaPulse.', text: 'Укажите понятное название магазина и вставьте его токен в поле подключения.', state: 'Готов к проверке · демо', copy: 'Скопировано', token: fakeToken, notice: 'Токен на месте', detail: 'Показан только вымышленный ключ DEMO-.' },
  { title: 'Нажмите «Подключить магазин».', text: 'Сервис проверяет API-доступ. В анимации проверка имитируется, запрос в Kaspi не отправляется.', state: 'Проверяем подключение · демо', copy: 'Скопировано', token: fakeToken, notice: 'Проверяем доступ', detail: 'Это анимация проверки, не реальный запрос.' },
  { title: 'Магазин появился в общем окне.', text: 'Пример готов: три магазина в одной очереди. Для следующего магазина повторяется тот же сценарий.', state: 'Магазин подключён · демо', copy: 'Скопировано', token: fakeToken, notice: 'Магазин 03 добавлен', detail: 'Дашборд и заказы ниже — демонстрационные.' },
];
const stepLabels = ['Получить токен', 'Скопировать', 'Вставить', 'Проверить', 'Готово'];
const play = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 11 7-11 7Z" fill="currentColor"/></svg>';
const pause = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14" stroke="currentColor" stroke-width="3"/></svg>';
const check = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

export function mountConnectionDemo(anchor) {
  if (!anchor || document.querySelector('#connection-demo')) return;
  anchor.insertAdjacentHTML('beforebegin', `
    <section class="connection-section section-shell" id="connection-demo" data-phase="0" data-running="false">
      <div class="connection-heading"><div><span class="section-kicker">Подключение видно по шагам</span><h2><span>Подключение по API-токену</span></h2></div><div class="connection-intro"><p>Скопируйте токен из кабинета Kaspi и добавьте магазин в SaudaPulse.</p><a class="text-link" href="#install" data-sp-install data-open-label="Открыть SaudaPulse">Попробовать 14 дней бесплатно <span aria-hidden="true">→</span></a></div></div>
      <div class="connection-player">
        <div class="connection-bar"><span><i></i> Подключение магазина <small>ДЕМО</small></span><div class="demo-player-controls"><button type="button" data-connect-toggle>${play} Воспроизвести</button><button type="button" data-connect-restart><span aria-hidden="true">↻</span> Повторить</button></div></div>
        <div class="connection-story"><span data-connect-chapter>01 / 05</span><div><h3 data-connect-title></h3><p data-connect-text></p></div></div>
        <div class="connection-workspace">
          <div class="connect-source"><div class="connect-window-bar"><span class="connect-kaspi">K</span><b>Кабинет Kaspi</b><small>Схема</small></div><div class="connect-source-body"><span class="connect-breadcrumb">Настройки <span>›</span> Токен API</span><h4>Ваш API-токен</h4><p>Токен формирует руководитель компании в веб-кабинете продавца.</p><div class="connect-token-source"><span>DEMO-KASPI-7F2A-EXAMPLE</span><small>Вымышленный ключ</small></div><button type="button" class="connect-copy-button" data-connect-copy>${check}<span data-connect-copy-label>Скопировать</span></button><div class="connect-copy-memory"><span>${check}</span><div><b>Токен скопирован</b><small>Внутри анимации, не в ваш буфер обмена</small></div></div><a href="https://guide.kaspi.kz/partner/ru/shop/api/general/q3196" target="_blank" rel="noopener noreferrer">Официальная инструкция Kaspi ↗</a></div></div>
          <div class="connect-transfer" aria-hidden="true"><span>→</span><i></i><small>API</small></div>
          <div class="connect-target"><div class="connect-window-bar"><span class="connect-flow-mark">s</span><b>SaudaPulse</b><small>Добавить магазин</small></div><div class="connect-target-body"><div class="connect-form-preview"><span class="connect-form-label">Название магазина</span><div class="connect-name-field">Магазин 03 <span>Kaspi</span></div><span class="connect-form-label">API-токен из кабинета Kaspi</span><div class="connect-token-field"><span data-connect-token>Сюда вставляется API-токен</span><button type="button" data-connect-paste>Вставить · демо</button></div><button type="button" class="connect-add-button" data-connect-add>Подключить магазин <span>→</span></button><p class="connect-field-note">Токен относится к магазину. Банковский кабинет для этого подключения не нужен. Здесь только демо: реальные ключи вводить нельзя.</p></div><div class="connect-result-preview"><div class="connect-result-top"><span>${check}</span><div><b>Магазин 03 подключён</b><small>Пример успешного подключения</small></div></div><div class="connect-result-metrics"><div><small>Магазинов в окне</small><strong data-connect-store-count>2</strong></div><div><small>Заказов · пример</small><strong>37</strong></div><div><small>Кабинетов сборки</small><strong>1</strong></div></div><div class="connect-store-row"><i>K</i><b>Магазин 01</b><span>в общем окне</span></div><div class="connect-store-row"><i>K</i><b>Магазин 02</b><span>в общем окне</span></div><div class="connect-store-row connect-added-store"><i>K</i><b>Магазин 03</b><span>${check} добавлен</span></div></div></div><div class="connect-state"><i></i><span data-connect-state></span></div></div>
          <div class="connect-pointer" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 3v17l5-5 4 7 3-2-4-7h7Z" fill="#172419" stroke="#fff" stroke-width="1.5"/></svg></div>
        </div>
        <div class="connection-notification"><span>${check}</span><div><b data-connect-notice></b><small data-connect-detail></small></div></div>
        <div class="connection-step-controls" aria-label="Этапы подключения">${stepLabels.map((label, i) => `<button type="button" data-connect-step="${i}" aria-pressed="${i === 0}"><span>0${i + 1}</span><b>${label}</b><i></i></button>`).join('')}</div>
        <div class="connection-player-foot"><span>14 секунд — длительность демо, а не гарантия времени настройки.</span><a href="#install" data-sp-install data-open-label="Открыть SaudaPulse">Попробовать 14 дней бесплатно <span aria-hidden="true">→</span></a></div>
      </div>
      ${accountScopeMarkup}
      <details class="connect-policy" data-connect-policy><summary>Какие данные передаются при настоящем подключении?</summary><p>API-токен даёт доступ к информации о заказах и товарах. В реальном SaaS токен передаётся сервису, а данные магазина поступают через API для общей очереди и аналитики. Заказы могут содержать персональные данные покупателей.</p><p>Банковский кабинет в этой схеме не подключается. При этом данные магазина поступают сервису для обработки заказов. Место и сроки хранения, права доступа и условия обработки данных согласуются перед пилотом. Демо не подтверждает безопасность рабочего backend.</p><p>Kaspi предупреждает: не сообщайте токен посторонним. Проверяйте получателя и условия доступа до передачи настоящего ключа. В этом демо используются только вымышленные значения.</p></details>
      <div class="demo-visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-connect-announcer></div>
    </section>`);

  const root = anchor.previousElementSibling;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const updateMotionNote = addMotionNote(root, '.connection-bar');
  let phase = 0;
  let paused = motion.matches;
  let inView = false;
  let timer = null;

  function render(announce = false) {
    const scene = scenes[phase];
    root.dataset.phase = String(phase);
    const fields = { chapter: `0${phase + 1} / 05`, title: scene.title, text: scene.text, state: scene.state, 'copy-label': scene.copy, token: scene.token, notice: scene.notice, detail: scene.detail, 'store-count': phase === 4 ? 3 : 2 };
    Object.entries(fields).forEach(([name, value]) => { root.querySelector(`[data-connect-${name}]`).textContent = String(value); });
    root.querySelectorAll('[data-connect-step]').forEach((button, i) => { button.classList.toggle('is-current', i === phase); button.classList.toggle('is-done', i < phase); button.setAttribute('aria-pressed', String(i === phase)); });
    if (announce) root.querySelector('[data-connect-announcer]').textContent = `Шаг ${phase + 1} из 5. ${scene.title}`;
    root.classList.remove('connection-scene-change');
    void root.offsetWidth;
    root.classList.add('connection-scene-change');
  }

  function sync() {
    clearInterval(timer);
    timer = null;
    const running = !paused && inView && !document.hidden;
    root.dataset.running = String(running);
    updateMotionNote(motion.matches, running);
    const button = root.querySelector('[data-connect-toggle]');
    button.innerHTML = running ? `${pause} Пауза` : `${play} Воспроизвести`;
    button.setAttribute('aria-label', running ? 'Поставить демо подключения на паузу' : 'Воспроизвести демо подключения');
    if (running) timer = setInterval(() => { phase = (phase + 1) % scenes.length; render(); }, 2800);
  }
  function selectStep(next) { phase = next; paused = true; render(true); sync(); }
  root.querySelectorAll('[data-connect-step]').forEach(button => button.addEventListener('click', () => selectStep(Number(button.dataset.connectStep))));
  root.querySelector('[data-connect-copy]').addEventListener('click', () => selectStep(1));
  root.querySelector('[data-connect-paste]').addEventListener('click', () => selectStep(2));
  root.querySelector('[data-connect-add]').addEventListener('click', () => { phase = 3; paused = false; render(true); sync(); });
  root.querySelector('[data-connect-toggle]').addEventListener('click', () => { paused = root.dataset.running === 'true'; sync(); });
  root.querySelector('[data-connect-restart]').addEventListener('click', () => { phase = 0; paused = motion.matches; render(true); sync(); });
  document.addEventListener('visibilitychange', sync);
  listenToMotion(motion, () => { if (motion.matches) paused = true; sync(); });
  observeDemoPlayer(root, '.connection-player', (visible) => { inView = visible; sync(); });
  render();
  sync();
}
