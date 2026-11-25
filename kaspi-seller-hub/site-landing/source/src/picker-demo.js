import { observeDemoPlayer, listenToMotion, addMotionNote } from './demo-visibility.js';
import './picker-demo.css';

// Identical sample baskets: six units per order. These are not real employee statistics.
const people = [
  { id: 'arman', name: 'Арман', initial: 'А', minutes: 40, orders: 10, units: 60, cycle: 4, queue: 2, order: '#KSP-2081' },
  { id: 'aigerim', name: 'Айгерим', initial: 'А', minutes: 60, orders: 10, units: 60, cycle: 6, queue: 5, order: '#KSP-2082' },
];
const scenes = [
  { title: 'Одинаковые заказы. Два сборщика.', text: 'Оба начинают заказ из 6 одинаковых товарных единиц. Владелец видит прогресс каждого.', minute: 0, notice: 'Два задания начаты', detail: 'Заказы #KSP-2081 и #KSP-2082 · демонстрация' },
  { title: 'Прогресс виден без звонков.', text: 'Арман отметил 3 товара, Айгерим — 2. Текущий статус рядом со временем сборки.', minute: 2, notice: 'Отметки сборщиков обновились', detail: 'Арман: 3 / 6 · Айгерим: 2 / 6 · пример' },
  { title: 'Один заказ готов. Второй ещё в сборке.', text: 'Арман завершил заказ за 4 минуты. Айгерим собирает оставшиеся 2 товара.', minute: 4, notice: 'Заказ Армана собран', detail: 'У Айгерим осталось 2 товара: можно проверить причину задержки.' },
  { title: 'Сравнивайте время и состав заказа.', text: 'Оба заказа готовы. В примере разница — 2 минуты на одинаковый набор товаров.', minute: 6, notice: 'Оба заказа собраны', detail: 'Арман: 4 мин · Айгерим: 6 мин · одинаковые товары' },
  { title: 'Передайте ожидающее задание.', text: 'Владелец переносит одно ещё не начатое задание от Айгерим к Арману. Всего заданий не меняется.', minute: 6, notice: 'Ожидающее задание перенесено', detail: '#KSP-2083: Айгерим → Арман · пример действия владельца' },
];
const names = ['Старт', 'Прогресс', 'Первый готов', 'Сравнение', 'Баланс нагрузки'];
const check = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const play = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 11 7-11 7Z" fill="currentColor"/></svg>';
const pause = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14" stroke="currentColor" stroke-width="3"/></svg>';
const format = (n) => n.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function mountPickerDemo(anchor) {
  if (!anchor || document.querySelector('#picker-demo')) return;
  anchor.insertAdjacentHTML('beforeend', `
    <div class="picker-comparison" id="picker-demo" data-phase="0" data-running="false">
      <div class="picker-section-heading"><div><span class="section-kicker">Скорость команды под контролем</span><h2>Два сборщика.<br><span>Сравнение в одном окне.</span></h2></div><div><p>Сравнивайте темп сборки и распределяйте задания между сотрудниками.</p></div></div>
      <div class="picker-player">
        <div class="picker-toolbar"><div class="demo-wordmark"><span class="demo-mark">s</span> saudapulse <small>КАБИНЕТ ВЛАДЕЛЬЦА · ДЕМО</small></div><div class="demo-player-controls"><button type="button" data-picker-toggle>${play} Воспроизвести</button><button type="button" data-picker-restart>↻ Повторить</button></div></div>
        <div class="picker-story"><div><h3 data-picker-title></h3><p data-picker-text></p></div><span class="picker-demo-clock"><small>Время в примере</small><b data-picker-clock>00:00</b></span></div>
        <div class="picker-cards">${people.map(person => `
          <article class="picker-person" data-picker-card data-picker="${person.id}">
            <header><span class="picker-person-avatar">${person.initial}</span><div><h4>${person.name}</h4><small>Сборщик · 3 магазина</small></div><span class="picker-person-state" data-status>Сборка</span></header>
            <div class="picker-person-metrics"><div><small>Собрано заказов</small><b data-done>10</b></div><div><small>Собрано товаров</small><b data-units>60</b></div><div><small>Среднее время</small><b><span data-average></span><em> мин / заказ</em></b></div></div>
            <div class="picker-speed"><small>Скорость сборки</small><b><span data-speed></span><em> товара / мин</em></b><span class="picker-speed-bar"><i data-speed-bar></i></span></div>
            <div class="picker-current"><div><b>${person.order}</b><span>6 одинаковых товаров</span></div><div class="picker-progress"><span data-progress>0 / 6</span><small>отмечено</small></div><div class="picker-unit-track">${Array.from({length:6},()=>`<i>${check}</i>`).join('')}</div><div class="picker-current-foot"><span data-elapsed>0 мин</span><b data-current-status>Сборка начата</b></div></div>
            <div class="picker-queue"><span>Ожидают начала сборки</span><b data-queue>${person.queue}</b></div>
          </article>`).join('')}
        </div>
        <div class="picker-analysis"><div class="picker-chart"><header><b>Сравнение темпа</b><small>Товарные единицы / активная минута</small></header>${people.map(p=>`<div class="picker-chart-row"><span>${p.name}</span><div><i data-chart-bar="${p.id}"></i></div><b data-chart-rate="${p.id}"></b></div>`).join('')}<p>Среднее по завершённым заказам в этом примере.</p></div><div class="picker-insight"><span class="picker-insight-badge">Владелец видит разницу</span><b data-picker-insight></b><p>Сначала проверьте наличие товара, сложность заказа и паузы. Разный темп сам по себе не означает плохую работу.</p><button type="button" data-picker-reassign>Передать ожидающее задание →</button></div></div>
        <div class="picker-notification"><span>${check}</span><div><b data-picker-notice></b><small data-picker-detail></small></div></div>
        <div class="picker-phase-controls" role="group" aria-label="Выберите этап сравнения сборщиков">${names.map((name,i)=>`<button type="button" data-picker-step="${i}" aria-pressed="${i===0}"><span>0${i+1}</span><b>${name}</b><i></i></button>`).join('')}</div>
        <div class="picker-player-footer"><span>Демонстрационные данные. 15 секунд анимации показывают 6 минут условного процесса, а не реальное время сборки.</span><a href="#install" data-sp-install data-open-label="Открыть SaudaPulse">Попробовать 14 дней бесплатно <span aria-hidden="true">→</span></a></div>
      </div>
      <details class="picker-method"><summary>Как сравнивать сборщиков корректно?</summary><p>В демо каждый завершённый заказ содержит 6 одинаковых товарных единиц. До текущего задания у каждого по 10 заказов: у Армана 40 минут активной сборки, у Айгерим 60. Скорость — число собранных единиц, делённое на активные минуты. Среднее время — активные минуты, делённые на число завершённых заказов. Текущий заказ включается в эти показатели после завершения.</p><p>В реальном продукте время и отметки товаров нужно фиксировать в кабинете сборщика. Для честного сравнения учитываются состав заказа, склад, маршрут, наличие товара, перерывы и ошибки комплектации. Результаты демонстрации не доказывают гарантированного ускорения команды.</p></details>
      <div class="demo-visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-picker-announcer></div>
    </div>`);

  const root = anchor.querySelector('#picker-demo');
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const updateMotionNote = addMotionNote(root, '.picker-toolbar');
  let phase = 0;
  let paused = motion.matches;
  let inView = false;
  let timer = null;

  function render(announce = false) {
    const scene = scenes[phase];
    root.dataset.phase = String(phase);
    const fields = { title: scene.title, text: scene.text, clock: `0${scene.minute}:00`, notice: scene.notice, detail: scene.detail };
    Object.entries(fields).forEach(([key,value])=>{root.querySelector(`[data-picker-${key}]`).textContent=value;});
    people.forEach((person,index) => {
      const card = root.querySelector(`[data-picker="${person.id}"]`);
      const finished = scene.minute >= person.cycle;
      const completed = Math.min(6, Math.floor(scene.minute * (6 / person.cycle)));
      const orders = person.orders + Number(finished);
      const units = person.units + (finished ? 6 : 0);
      const minutes = person.minutes + (finished ? person.cycle : 0);
      const rate = units / minutes;
      const values = { done: orders, units, average: format(minutes / orders), speed: format(rate), progress: `${completed} / 6`, elapsed: `${Math.min(scene.minute,person.cycle)} мин`, queue: person.queue + (phase === 4 ? (index === 0 ? 1 : -1) : 0), status: finished ? 'Заказ готов' : 'В сборке', 'current-status': finished ? 'Комплектация завершена' : 'Отмечаются товары' };
      Object.entries(values).forEach(([key,value])=>{card.querySelector(`[data-${key}]`).textContent=String(value);});
      card.classList.toggle('is-finished',finished);
      card.querySelectorAll('.picker-unit-track i').forEach((dot,i)=>dot.classList.toggle('is-checked',i<completed));
      card.querySelector('[data-speed-bar]').style.width=`${rate/2*100}%`;
      root.querySelector(`[data-chart-bar="${person.id}"]`).style.width=`${rate/2*100}%`;
      root.querySelector(`[data-chart-rate="${person.id}"]`).textContent=format(rate);
    });
    root.querySelector('[data-picker-insight]').textContent=`Разница среднего времени: ${people[1].minutes/people[1].orders-people[0].minutes/people[0].orders} мин / заказ`;
    root.querySelector('[data-picker-reassign]').disabled=phase===4;
    root.querySelector('[data-picker-reassign]').textContent=phase===4?'Задание передано · демо':'Передать ожидающее задание →';
    root.querySelectorAll('[data-picker-step]').forEach((button,i)=>{button.classList.toggle('is-current',i===phase);button.setAttribute('aria-pressed',String(i===phase));});
    if(announce) root.querySelector('[data-picker-announcer]').textContent=scene.title+' '+scene.text;
    root.classList.remove('picker-scene-change');
    void root.offsetWidth;
    root.classList.add('picker-scene-change');
  }
  function sync() {
    clearInterval(timer);
    timer=null;
    const running=!paused&&inView&&!document.hidden;
    root.dataset.running=String(running);
    updateMotionNote(motion.matches, running);
    const button=root.querySelector('[data-picker-toggle]');
    button.innerHTML=running?`${pause} Пауза`:`${play} Воспроизвести`;
    button.setAttribute('aria-label',running?'Приостановить сравнение сборщиков':'Воспроизвести сравнение сборщиков');
    if(running) timer=setInterval(()=>{phase=(phase+1)%scenes.length;render();},3000);
  }
  const select=(next)=>{phase=next;paused=true;render(true);sync();};
  root.querySelectorAll('[data-picker-step]').forEach(button=>button.addEventListener('click',()=>select(Number(button.dataset.pickerStep))));
  root.querySelector('[data-picker-reassign]').addEventListener('click',()=>select(4));
  root.querySelector('[data-picker-toggle]').addEventListener('click',()=>{paused=root.dataset.running==='true';sync();});
  root.querySelector('[data-picker-restart]').addEventListener('click',()=>{phase=0;paused=motion.matches;render(true);sync();});
  document.addEventListener('visibilitychange',sync);
  listenToMotion(motion,()=>{if(motion.matches)paused=true;sync();});
  observeDemoPlayer(root, '.picker-player', (visible) => { inView=visible;sync(); });
  render();
  sync();
}
