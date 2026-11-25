import './express-demo.css';
import { observeDemoPlayer, listenToMotion, addMotionNote } from './demo-visibility.js';

const check = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
const clock = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
const box = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 7 9-4 9 4-9 5-9-5ZM3 7v10l9 4 9-4V7M12 12v9"/></svg>';
const bolt = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 2-8 12h6l-1 8 9-12h-6l1-8Z"/></svg>';
const play = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 11 7-11 7Z"/></svg>';
const pause = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>';
const orders = [
  { id: 'KSP-2199', shop: 'Магазин 01', express: false, minutes: -4, items: 2, owner: 'Данияр' },
  { id: 'KSP-2201', shop: 'Магазин 02', express: true, minutes: 18, items: 3, owner: 'Амина' },
  { id: 'KSP-2203', shop: 'Магазин 03', express: true, minutes: 31, items: 1, owner: 'Ожидает' },
  { id: 'KSP-2205', shop: 'Магазин 01', express: false, minutes: null, items: 2, owner: 'Уточнить срок' },
];
const scenes = [
  { title: 'Срочные заказы видны сразу.', text: 'Express выделен цветом. Уже просроченный обычный заказ тоже остаётся наверху: его нельзя забыть.' },
  { title: 'Сборщик видит приоритет.', text: 'Амина получает Express-заказ из магазина 02. Владелец видит ответственного и остаток времени.' },
  { title: 'Сначала сверить комплектацию.', text: 'У заказа три товара. Перед упаковкой сборщик проверяет позиции, количество и комплектующие.' },
  { title: 'Проверить упаковку и накладную.', text: 'Отметки делает сотрудник. Чек-лист помогает не пропустить шаг, но не проверяет посылку вместо человека.' },
  { title: 'Готовность подтверждает сотрудник.', text: 'Отметьте три проверки и нажмите «Готов к курьеру». Фактическая передача подтверждается отдельно по процедуре Kaspi.' },
];
const labels = ['Приоритет', 'Назначить', 'Собрать', 'Проверить', 'Готово'];

export function mountExpressDemo(anchor) {
  if (!anchor || document.querySelector('#express-demo')) return;
  anchor.insertAdjacentHTML('beforebegin', `
  <section class="express-section section-shell" id="express-demo" data-phase="0" data-running="false" data-order-status="waiting">
    <div class="express-heading"><div><span class="section-kicker">Сроки и качество под контролем</span><h2>Express-заказы<br><span>не теряются в очереди.</span></h2></div><div class="express-intro"><p>Срочность, ответственный и срок передачи видны рядом с заказом. Чек-лист помогает проверить комплектацию и упаковку.</p><a class="text-link" href="#install" data-sp-install data-open-label="Открыть SaudaPulse">Попробовать 14 дней бесплатно <span aria-hidden="true">→</span></a></div></div>
    <div class="express-player">
      <div class="express-toolbar"><span><i></i> Контроль передачи <small>ЖИВОЕ ДЕМО</small></span><div class="demo-player-controls"><button type="button" data-express-toggle>${play} Воспроизвести</button><button type="button" data-express-restart>↻ Повторить</button></div></div>
      <div class="express-story"><span data-express-chapter>01 / 05</span><div><h3 data-express-title></h3><p data-express-text></p></div></div>
      <div class="express-kpis"><div><small>Express в очереди</small><strong>2</strong><span>из 3 магазинов · пример</span></div><div class="express-kpi-warning"><small>Срок требует внимания</small><strong>2</strong><span>1 задержка + 1 близкий срок</span></div><div><small>Чек-лист заказа</small><strong data-pack-count>0 / 3</strong><span>отметки сотрудника</span></div></div>
      <div class="express-workspace">
        <div class="express-queue"><div class="express-queue-head"><div><h4>Очередь сборки</h4><small>Просрочки → Express → остальные</small></div><div class="express-filters" aria-label="Фильтр заказов"><button type="button" data-express-filter="all" aria-pressed="true">Все</button><button type="button" data-express-filter="express" aria-pressed="false">Express</button></div></div><div class="express-order-list" data-express-list></div><p class="express-queue-note">Срок неизвестен? Сверьте его в Kaspi. Таймер не подменяет время передачи в кабинете.</p></div>
        <div class="express-packing"><div class="express-packing-top"><span class="express-label">${bolt} Express</span><span>Магазин 02</span></div><h4>#KSP-2201</h4><div class="express-due"><span>${clock} До передачи курьеру</span><strong data-express-countdown>18 мин</strong><small>Демонстрационные часы ускорены</small></div><div class="express-assignee"><span class="express-avatar">А</span><div><b data-express-owner>Ожидает назначения</b><small>Ответственный за сборку</small></div><span class="express-assignee-state" data-express-stage>В очереди</span></div><div class="express-items-progress"><div><b>Комплектация</b><span data-express-items>0 из 3 товаров</span></div><div class="express-progress-track"><i data-express-progress></i></div></div>
          <fieldset class="express-checklist"><legend>Перед готовностью к курьеру</legend><label><input type="checkbox" data-pack-check="0"><span><b>Товары и комплектующие сверены</b><small>Позиции, количество и комплектность</small></span></label><label><input type="checkbox" data-pack-check="1"><span><b>Упаковка проверена</b><small>По требованиям Kaspi для категории товара</small></span></label><label><input type="checkbox" data-pack-check="2"><span><b>Накладная прикреплена</b><small>Сверьте номер заказа и количество мест</small></span></label></fieldset>
          <button class="express-ready-button" type="button" data-express-ready disabled>${box} Готов к курьеру · демо</button><p class="express-handover" data-courier-handover="not-confirmed">Передача курьеру ещё не подтверждена</p>
        </div>
      </div>
      <div class="express-notification"><span>${clock}</span><div><b data-express-notice></b><small>Контроль сроков и отметок, а не гарантия отзыва</small></div></div>
      <div class="express-steps" role="group" aria-label="Этапы обработки Express-заказа">${labels.map((label,i)=>`<button type="button" data-express-step="${i}" aria-pressed="${i===0}"><span>0${i+1}</span><b>${label}</b></button>`).join('')}</div>
      <div class="express-demo-note"><span>Демо · заказы, сроки и сотрудники вымышленные. Отметки не передаются Kaspi.</span><a href="#install" data-sp-install data-open-label="Открыть SaudaPulse">Попробовать 14 дней бесплатно <span aria-hidden="true">→</span></a></div>
    </div>
    <details class="express-rules"><summary>Как это связано с требованиями Kaspi?</summary><p>Kaspi требует своевременно принимать Express-заказы и передавать их до времени, указанного в кабинете. За нарушения Express могут отключить. Задержки передачи на Kaspi Доставку считаются отдельным показателем качества: это не то же самое, что рейтинг по отзывам.</p><p>Kaspi рекомендует прочную упаковку и полную комплектацию для улучшения качества. Чек-лист — подтверждение сотрудника, а не автоматическая проверка упаковки. Рекомендации зависят от категории товара; фиксацию упаковки на видео организуют отдельно.</p><p>API документирует признак Express и плановую дату передачи. В пилоте проверим доступность даты и её соответствие сроку в кабинете. При отсутствии даты необходимо уточнить срок в Kaspi. Сервис не гарантирует рост рейтинга или положительные отзывы.</p><div><a target="_blank" rel="noopener noreferrer" href="https://guide.kaspi.kz/partner/ru/shop/delivery/express/q2958">Правила Express ↗</a><a target="_blank" rel="noopener noreferrer" href="https://guide.kaspi.kz/partner/ru/shop/quality_index/rating/q2251">Рекомендации по рейтингу ↗</a><a target="_blank" rel="noopener noreferrer" href="https://guide.kaspi.kz/partner/ru/shop/delivery/shipping/q3000">Подготовка и упаковка ↗</a></div></details>
    <div class="demo-visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-express-announcer></div>
  </section>`);
  const root = anchor.previousElementSibling;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const motionNote = addMotionNote(root, '.express-toolbar');
  let phase = 0;
  let checks = [false,false,false];
  let readyConfirmed = false;
  let filter = 'all';
  let paused = motion.matches;
  let inView = false;
  let timer = null;

  function render(announce=false) {
    const scene = scenes[phase];
    const allChecked = checks.every(Boolean);
    root.dataset.phase = String(phase);
    root.dataset.orderStatus = readyConfirmed && allChecked ? 'ready' : phase>=2 ? 'packing' : phase===1 ? 'assigned' : 'waiting';
    root.querySelector('[data-express-title]').textContent = scene.title;
    root.querySelector('[data-express-text]').textContent = scene.text;
    root.querySelector('[data-express-chapter]').textContent = `0${phase+1} / 05`;
    root.querySelector('[data-pack-count]').textContent = `${checks.filter(Boolean).length} / 3`;
    root.querySelector('[data-express-owner]').textContent = phase>=1 ? 'Амина' : 'Ожидает назначения';
    root.querySelector('[data-express-stage]').textContent = readyConfirmed ? 'Готов к курьеру' : ['В очереди','Назначен','Сборка','Проверка','Проверка'][phase];
    root.querySelector('[data-express-countdown]').textContent = `${18-phase*2} мин`;
    root.querySelector('[data-express-items]').textContent = `${phase>=2 ? 3 : 0} из 3 товаров`;
    root.querySelector('[data-express-progress]').style.width = phase>=2 ? '100%' : '0%';
    root.querySelector('[data-express-ready]').disabled = !allChecked;
    root.querySelectorAll('[data-pack-check]').forEach((checkbox,i)=>{checkbox.checked=checks[i];});
    root.querySelectorAll('[data-express-step]').forEach((button,i)=>button.setAttribute('aria-pressed',String(i===phase)));
    root.querySelectorAll('[data-express-filter]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.expressFilter===filter)));
    root.querySelector('[data-express-notice]').textContent = readyConfirmed ? 'Готов к курьеру. Подтвердите фактическую передачу отдельно.' : phase===4 ? 'Отметьте проверки вручную и подтвердите готовность кнопкой.' : phase===3 ? 'Проверьте упаковку и накладную до отметки готовности.' : 'Express-заказ из магазина 02 требует внимания сборщика.';
    const visible = orders.filter(o=>filter==='all'||o.express).sort((a,b)=>{
      const overdueA=a.minutes!==null && a.minutes-phase*2<0;
      const overdueB=b.minutes!==null && b.minutes-phase*2<0;
      if(overdueA!==overdueB)return overdueA ? -1 : 1;
      if(a.express!==b.express)return a.express ? -1 : 1;
      return (a.minutes??Infinity)-(b.minutes??Infinity);
    });
    root.querySelector('[data-express-list]').innerHTML = visible.map(o=>{
      const remaining=o.minutes===null ? null : o.minutes-phase*2;
      const overdue=remaining!==null&&remaining<0;
      const selected=o.id==='KSP-2201';
      const status=selected ? (readyConfirmed ? 'Готов к курьеру' : ['Ожидает','Назначен','Сборка','Проверка','Проверка'][phase]) : overdue ? 'Проверить задержку' : 'Ожидает';
      return `<div class="express-order ${selected?'is-selected':''} ${overdue?'is-overdue':''}" data-express-order-id="${o.id}"><div class="express-order-title"><b>#${o.id}</b><span class="${o.express?'express-label':'express-standard'}">${o.express ? bolt+' Express' : 'Kaspi Доставка'}</span></div><div class="express-order-meta"><span>${o.shop} · ${o.items} ${o.items===1?'товар':'товара'}</span><b class="${overdue?'express-overdue':remaining===null?'express-unknown':'express-remaining'}">${remaining===null ? 'Уточнить срок в Kaspi' : overdue ? `Задержка ${Math.abs(remaining)} мин` : `${remaining} мин до передачи`}</b></div><div class="express-order-bottom"><span>${selected&&phase>=1 ? 'Амина' : selected ? 'Без сборщика' : o.owner}</span><span>${status}</span></div></div>`;
    }).join('');
    if(announce)root.querySelector('[data-express-announcer]').textContent=`Шаг ${phase+1} из 5. ${scene.title}`;
  }
  function sync() {
    clearInterval(timer);timer=null;
    const running=!paused&&inView&&!document.hidden;
    root.dataset.running=String(running);motionNote(motion.matches,running);
    const button=root.querySelector('[data-express-toggle]');
    button.innerHTML=running ? `${pause} Пауза` : `${play} Воспроизвести`;
    button.setAttribute('aria-label',running?'Поставить Express-демо на паузу':'Воспроизвести Express-демо');
    if(running)timer=setInterval(()=>{phase=(phase+1)%scenes.length;if(phase===0){checks=[false,false,false];readyConfirmed=false;}render();},3000);
  }
  root.querySelectorAll('[data-express-step]').forEach(button=>button.addEventListener('click',()=>{phase=Number(button.dataset.expressStep);if(phase===0){checks=[false,false,false];}readyConfirmed=false;paused=true;render(true);sync();}));
  root.querySelectorAll('[data-express-filter]').forEach(button=>button.addEventListener('click',()=>{filter=button.dataset.expressFilter;render();}));
  root.querySelectorAll('[data-pack-check]').forEach((checkbox,i)=>checkbox.addEventListener('change',()=>{checks[i]=checkbox.checked;readyConfirmed=false;paused=true;if(phase===4&&!checks.every(Boolean))phase=3;render();sync();}));
  root.querySelector('[data-express-ready]').addEventListener('click',()=>{if(!checks.every(Boolean))return;readyConfirmed=true;phase=4;paused=true;render(true);sync();});
  root.querySelector('[data-express-toggle]').addEventListener('click',()=>{paused=root.dataset.running==='true';sync();});
  root.querySelector('[data-express-restart]').addEventListener('click',()=>{phase=0;checks=[false,false,false];readyConfirmed=false;filter='all';paused=motion.matches;render(true);sync();});
  document.addEventListener('visibilitychange',sync);
  listenToMotion(motion,()=>{if(motion.matches)paused=true;sync();});
  observeDemoPlayer(root,'.express-player',visible=>{inView=visible;sync();});
  render();sync();
}
