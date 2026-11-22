# Анализ проекта SaudaPulse (Kaspi Seller Hub) — 22.11.2026

Ветка `claude/magical-maxwell-6yq76b`, HEAD `75eed2e`. Supabase: `kaspi-seller-hub` (`zraktrilvwrfpcbmkqwi`).

## Итог

Технически продукт почти готов: код, БД, тесты и сборка в порядке. До запуска мешают в основном **внешние вещи**: домен, публикация в Chrome Web Store, ID расширения и ссылка на магазин в конфиге сайта.

Оценка готовности: **код ~90 %, запуск ~75 %**. Пока не закрыты пункты из раздела «Блокеры», запуск невозможен.

## Что сделано хорошо

- **Архитектура:** MV3-расширение без сервера. Синхронизация с Kaspi и печать PDF идут на компьютере продавца, поэтому сервер почти не нагружается.
- **Безопасность лицензии:** лицензия подписана ES256 и проверяется по публичным JWK (`shared/billing-config.js`, `background/billing.js:200-260`). Если без входа после истечения срока прошло больше `offlineGraceDays` (3 дня), доступ закрывается.
- **Токены Kaspi:** шифруются AES-GCM 256 с неизвлекаемым ключом в IndexedDB и привязкой к shopId (`shared/token-crypto.js`).
- **Supabase:** 16 миграций применены (001–016). RLS включён на всех таблицах. Все `admin_*` проверяют `is_admin()`. Все `bot_*` проверяют SHA-256 ключа бота и делают `pg_sleep` при ошибке.
- **Telegram-бот:** вебхук и cron защищены сравнением секрета `sameSecret` и возвращают 401 (`bot.js:199,219`). В проде развёрнута версия v5.
- **Релизная сборка:** `tools/build-release.mjs` убирает localhost/file-хосты, `scripting` и source map. Она также проверяет, что в сборку не попали секреты, `console.log` и `eval`. В ZIP остаются ровно 3 хоста Kaspi и `externally_connectable` (только Chrome).
- **Тесты:** все 9 наборов unit-тестов проходят: robust 38, locales 1116 ключей, bot-run 8, storage-split 16, token-crypto 7, license-signature 11, license-flow 26, feature-flags, notices. Кроме них есть SQL-, e2e- (Playwright), perf- и load-тесты, они настроены в CI.

## Блокеры запуска (P0)

1. **Домен.** `CNAME` указывает на `contamination.kz`, и в корневом `index.html` до сих пор старый лендинг «Contamination». При этом всё остальное ссылается на `saudapulse.kz`: `externally_connectable`, оферта `saudapulse.kz/offer`, политика `saudapulse.kz/privacy`, `support@saudapulse.kz`.
   - Что сделать: поднять DNS и хостинг для `saudapulse.kz` и выложить туда `kaspi-seller-hub/dist/site`.
   - Без живых страниц оферты и политики Chrome Web Store отклонит публикацию, а мост `OPEN_DASHBOARD` работать не будет.
2. **`site/site.config.json`: поля `extensionId` и `storeUrl` пустые.** Пока они пустые, кнопка «Подключить магазин Kaspi за 1 минуту» ведёт на `#support`, а бесшовный запуск с сайта не работает. Их нужно заполнить после публикации в CWS и пересобрать сайт.
3. **Ответ 401 от прода `telegram-bot` не подтверждён:** прокси контейнера не пускает запросы к Supabase. Проверить вручную:
   ```bash
   curl -s -o /dev/null -w '%{http_code}' -X POST https://zraktrilvwrfpcbmkqwi.supabase.co/functions/v1/telegram-bot -d '{}'
   ```

## Важно (P1)

4. **Оплата вручную.** Счёт Kaspi Pay подтверждает админ (`admin_confirm_invoice`). Для первых десятков клиентов это нормально, но дальше админ станет узким местом и источником задержек в продлении. Нужен вебхук или выгрузка платежей.
5. **Заказы хранятся только в `chrome.storage.local`.** Если продавец переустановит Chrome или очистит профиль, история пропадёт. Стоит добавить экспорт или импорт резервной копии в настройки либо явно предупредить об этом в онбординге.
6. **Supabase advisors (security):**
   - 8 функций `SECURITY DEFINER` доступны `anon`: `bot_*`, `ops_digest`, `get_service_status`. Они защищены ключом, но надёжнее сделать `REVOKE EXECUTE ... FROM anon, authenticated` и вызывать их из Edge Function с `service_role`.
   - Leaked password protection выключена. Вход идёт по OTP, так что риск низкий, но включение занимает один клик.
   - 20 таблиц с RLS без политик — это намеренный deny-all, доступ к ним идёт только через RPC. 65 RPC для `authenticated` тоже предусмотрены дизайном.
7. **Бэкапы и алерты.** Workflow `seller-hub-db-backup.yml` и `seller-hub-ops-alert.yml` не работают без секретов в GitHub и запускаются только из основной ветки. Также нужно проверить, включён ли PITR в Supabase.
8. **Иконка расширения.** Из-за `default_popup` обработчик `chrome.action.onClicked` не срабатывает. Дубли вкладок не появляются, потому что popup открывает уже существующую вкладку. Если нужно, чтобы клик по иконке сразу открывал кабинет, убрать `default_popup`.

## Можно улучшить (P2)

9. **Расхождение в истории миграций.** Миграция 009 записана в БД под именем `001_billing_revoke_fix`, а файл в репозитории называется `009_billing_revoke_fix.sql`. Это косметика, но может запутать при `supabase db diff`.
10. **`dashboard/dashboard.js` занимает 3415 строк.** Стоит вынести представления в модули так же, как уже вынесены `catalog-view`, `growth-view` и `staff-view`.
11. **В корне репозитория 15 отчётов `*.md` и 2 неотслеживаемых ZIP-архива.** Отчёты лучше перенести в `docs/reports/`, архивы удалить.
12. **`PROJECT_STATUS.md` устарел.** Например, там указано «Шифрование токенов — НЕТ», хотя оно уже реализовано.
13. **В `SUPPORT.whatsapp` и `site.config.responseTime` пусто.** Для селлеров в Казахстане WhatsApp — основной канал связи, его стоит заполнить.
14. **Регулярное выражение в `money()` (`bot.js:18`).** Intl `ru-RU` разделяет разряды узким неразрывным пробелом U+202F, а регулярка ищет U+00A0, поэтому замена, скорее всего, ничего не делает. На вывод это не влияет.

## План на ближайшие шаги

1. Настроить домен `saudapulse.kz`, выложить сайт и проверить страницы `/offer` и `/privacy`.
2. Отправить ZIP в Chrome Web Store: `kaspi-seller-hub/dist/saudapulse-chrome-release.zip`, 1,8 МБ, обоснования в `docs/CHROME-WEB-STORE-SUBMISSION.md`.
3. После одобрения заполнить `extensionId` и `storeUrl`, пересобрать сайт и проверить запуск по кнопке с сайта.
4. Добавить секреты для бэкапов и алертов, включить PITR и leaked password protection.
5. Сделать `REVOKE` на `bot_*` и `ops_digest` для ролей `anon` и `authenticated`, а функцию перевести на `service_role`.
6. Добавить экспорт и импорт резервной копии данных в расширении.
