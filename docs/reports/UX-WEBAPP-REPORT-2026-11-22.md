# SaudaPulse — бесшовный UX «как веб-приложение» (2026-11-22)

## 1. Автооткрытие вкладки при установке и защита от дублей
`kaspi-seller-hub/background/service-worker.js`:
- `onInstalled` (стр. 1512): при `details.reason === 'install'` вызывает `openDashboard('home', 'welcome=1')` и открывает `dashboard/dashboard.html?welcome=1#home`. Прежняя работа обработчика (чистка кэша, будильники, `discoverTabs`) сохранена.
- `openDashboard` (стр. 1101–1103) сначала ищет уже открытую вкладку `dashboard.html`. Если она есть, делает её активной и выводит её окно на передний план (`windows.update({focused:true})`), иначе создаёт новую вкладку. Повторный вызов, пока первый ещё не завершился, возвращает тот же результат и не открывает вторую вкладку.
- `chrome.action.onClicked` не добавлен: у иконки есть попап (`default_popup`), и при нём это событие не срабатывает. Кнопка попапа открывает кабинет через сообщение `ui:openDashboard`, то есть через тот же `openDashboard`, поэтому дублей вкладок нет.
- `dashboard/dashboard.js`: параметр `?welcome=1` запускает приветственный тур через 300 мс, затем параметр убирается из адреса (`history.replaceState`). Без параметра тур, как и раньше, запускается при первом запуске.

## 2. Переход с saudapulse.kz в кабинет
- `manifest.json`: добавлен `"externally_connectable": { "matches": ["https://saudapulse.kz/*", "https://*.saudapulse.kz/*"] }`. В сборке для Firefox секция удаляется, там она не поддерживается (`tools/build-release.mjs`).
- `onMessageExternal` (стр. 1501) принимает сообщения только с https-адресов `saudapulse.kz` и его поддоменов. Имя хоста проверяется точно функцией `isSaudaPulseOrigin` (стр. 1495).
  - `{type:'OPEN_DASHBOARD'}`: открывает кабинет или переключает на уже открытую вкладку, отвечает `{ok:true}`.
  - `{type:'PING'}`: отвечает `{ok:true, version}`.
  - Любое другое сообщение или чужой адрес: `{ok:false}`.
- Сайт (`kaspi-seller-hub/site/app.js`): кнопки с атрибутом `data-sp-open` отправляют расширению `OPEN_DASHBOARD` и ждут ответ 800 мс. Если ответа нет или произошла ошибка, кнопка работает как обычная ссылка (на Chrome Web Store).
- ⚠️ В `site/site.config.json` поля `extensionId` и `storeUrl` пока пустые. До их заполнения кнопки ведут на `#support` («Открыть аналитику» — на `#features`). ID расширения станет постоянным только после публикации в Chrome Web Store.
- Папки `marketflow/` в репозитории нет. Лендинг saudapulse.kz здесь — это `kaspi-seller-hub/site/`, все правки сайта сделаны в нём.

## 3. Тексты на лендинге
| | RU | KK |
|---|---|---|
| Главная кнопка | Подключить магазин Kaspi за 1 минуту | Kaspi дүкенін 1 минутта қосу |
| Вторая кнопка | Открыть аналитику | Аналитиканы ашу |
| Пояснение под кнопками | Работает локально в вашем браузере Chrome — данные не покидают ваш компьютер | Chrome браузеріңізде жергілікті жұмыс істейді — деректер компьютеріңізден шықпайды |

Слово «расширение»/«кеңейтім» убрано из шапки первого экрана. Оно осталось в FAQ, в шагах установки и в мета-описании.

## 4. Сборки и тесты
- `node tools/build-release.mjs` прошёл, `externally_connectable` есть в собранном манифесте.
- `dist/saudapulse-chrome-release.zip` пересобран: 1 799 194 байт, без `.map`, `tests/` и `.git`.
- `node tools/build-site.mjs` прошёл. Сборки через `npm run build` у сайта нет. Собранные страницы в браузере не открывались.
- Unit-тесты, все 9 прошли: robust 38, locales 1116 ключей, storage-split 16, token-crypto 7, license-signature 11, license-flow 26, bot-run 8, feature-flags и notices в порядке.
- Браузерные e2e-тесты не запускались.

## 5. Изменённые файлы
Все в `kaspi-seller-hub/`:
- `background/service-worker.js`
- `dashboard/dashboard.js`
- `manifest.json`
- `tools/build-release.mjs`
- `site/app.js`
- `site/index.html`
- `site/kk/index.html`
- `site/site.config.json`
- `site/styles.css`
