# Launch-ready: 2026-11-22

## Деплой telegram-bot
- Функция `telegram-bot` задеплоена через Supabase MCP в проект zraktrilvwrfpcbmkqwi (v4 -> v5, ACTIVE, verify_jwt=false как и раньше). Файлы: index.js + bot.js.
- Проверка `curl POST .../functions/v1/telegram-bot` НЕ выполнена: прокси песочницы блокирует хост (CONNECT 403, код 000). Ожидаемый ответ 401 не подтверждён, нужна проверка вручную.

## Авто-открытие кабинета
- onInstalled (reason=install) открывает dashboard с `welcome=1` через openDashboard (переиспользует существующую вкладку, дублей нет).
- onMessageExternal: PING и OPEN_DASHBOARD (только saudapulse.kz и *.saudapulse.kz), отвечает `{ok:true}` после открытия/фокуса.
- Добавлен `chrome.action.onClicked` (фокус существующей вкладки). Оговорка: пока в манифесте задан `default_popup`, onClicked не срабатывает; popup оставлен, его кнопка "Открыть кабинет" идёт через сообщение `ui:openDashboard` в SW (focus-existing).
- `externally_connectable` есть в chrome-сборке; host_permissions ровно 3: kaspi.kz, mc.shop.kaspi.kz, idmc.shop.kaspi.kz. Обоснование добавлено в docs/CHROME-WEB-STORE-SUBMISSION.md.

## Сборка
- dist/saudapulse-chrome-release.zip: 1 804 009 байт (копия kaspi-seller-hub-0.1.0.zip). В SW внутри zip есть onMessageExternal, OPEN_DASHBOARD, onClicked.
- Сайт: `node tools/build-site.mjs` -> dist/site, успешно (whatsapp/responseTime не заполнены, блоки опущены).
- Лендинг живёт в kaspi-seller-hub/site (каталога marketflow/ в репозитории нет). Кнопки [data-sp-open] шлют OPEN_DASHBOARD расширению, при отсутствии ответа за 800 мс переходят на href (страница установки). Вторичный CTA: RU "Открыть кабинет", KK "Кабинетті ашу".

## Тесты (9/9 пройдено)
robust (TZ=America/New_York) 38; locales 1116 ключей; bot-run 8; storage-split 16; token-crypto 7; license-signature 11; license-flow 26; feature-flags ok; notices ok.
