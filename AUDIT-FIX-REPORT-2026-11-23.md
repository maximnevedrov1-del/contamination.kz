# Отчёт: исправления аудита F1–F4, 2026-11-23

## F1–F4

| # | Проблема | Исправление | Файлы | Статус |
|---|---|---|---|---|
| F1 | Подтверждение счёта админом без сверки суммы/магазинов с тем, что видит админ | `admin_confirm_invoice(p_id, p_note, p_expected_amount, p_expected_stores)`: серверная проверка; admin.js передаёт ожидаемые значения | billing/supabase/025_audit_hardening_f1_f2.sql, billing/admin/admin.js | Готово |
| F2 | Повторное применение миграций/восстановление из бэкапа сбрасывает GRANT/REVOKE | `grants.sql` — идемпотентное восстановление прав; в 025 revoke для public/anon и default privileges | billing/supabase/grants.sql, 025 | Готово |
| F3 | Нет удаления аккаунта из админки; Storage-объекты остаются | Кнопка удаления + подтверждение в admin.js; admin-политики на Storage в 025 | admin.js, 025 | Готово (проверить на реальном проекте) |
| F4 | Политика конфиденциальности не раскрывает телеметрию (Clarity) | Раздел о телеметрии в privacy.html | legal/privacy.html | Готово |
| — | Бот `SaudaPluseBot` (опечатка) | Везде `SaudaPulseBot` | locales ru/kk, site, bot | Готово |
| — | Бэкап-воркфлоу, зеркало в шаблоне | Синхронизация workflow, saas-core-template (025, grants.sql, test22, admin.js, run.sh) | .github/workflows/seller-hub-db-backup.yml, saas-core-template/* | Готово |

## Тесты

| Набор | Результат |
|---|---|
| SQL test–test22 (22 файла) | 484 PASS / 0 FAIL |
| Unit | 11/11 |
| E2E regress.sh | 21/21 (billtest 6 прогонов подряд ALL PASS) + apionly OK |
| Шаблон: npm test | 11/11 |
| Шаблон: test:sql | 484/0 |
| Шаблон: init-new-saas --dry-run | OK, unreplaced tokens: none, exit 0 |

## billtest: причина и исправление

| Что | Описание |
|---|---|
| Причина | Не связана с F1–F4: на чистом HEAD без правок падает так же (2 из 5 прогонов). Гонка: запоздавший `reconcileInvoice` с устаревшим `lic` вызывает `request_store_addon`, который отменял неоплаченный manual-счёт клиента (4 магазина × 2 мес., 50 000) и создавал add-on 2 400 ₸ |
| Исправление | В `request_store_addon` (в составе 025, обе копии): если открыт manual-счёт с `stores >= n`, он возвращается без замены. Ассерты теста не менялись. После фикса 6/6 ALL PASS |

## Релиз

| Параметр | Значение |
|---|---|
| Путь | kaspi-seller-hub/dist/kaspi-seller-hub-0.1.1.zip |
| Размер | 1813269 байт |
| Собран из коммита | 3a381fd |
| git чистый до/после сборки | да / да (dist в .gitignore) |
| Содержимое | locales/ru.json, kk.json: SaudaPulseBot (SaudaPluseBot: 0); legal/privacy.html: раздел Clarity присутствует |

## Коммиты

| Хэш | Сообщение |
|---|---|
| cb46876 | docs(faq): Telegram connect FAQ, bot handle @SaudaPulseBot |
| 3a381fd | fix(security): audit F1–F4 — invoice amount guard, grants preservation, admin account deletion, privacy telemetry disclosure |

## Порядок миграций Supabase (kaspi-seller-hub, zraktrilvwrfpcbmkqwi)

| Шаг | Файл |
|---|---|
| 1–7 | 019 → 020 → 021 → 022 → 023 → 024 → 025 |
| После любого восстановления из бэкапа | `grants.sql` |

Миграции этим прогоном НЕ применялись на удалённом проекте.

## Риски и действия владельца

| Риск | Действие |
|---|---|
| Username бота: код использует @SaudaPulseBot, в истории написание менялось туда-обратно | Сверить в @BotFather |
| Admin-политики Storage (025) и удаление аккаунта не проверены на реальном Supabase | После 025 прогнать удаление тестового аккаунта в админке |
| Раскрытие Clarity в privacy.html | Проверить формулировку на соответствие реальной конфигурации Clarity |
| 025 включает правку `request_store_addon` (гонка add-on) | Учесть при применении: порядок не меняется |
