# Отчёт: телеметрия ошибок и автоудержание через Telegram — 2026-11-22

Проект Supabase: `kaspi-seller-hub` (`zraktrilvwrfpcbmkqwi`, eu-west-1). Удалённая база не изменялась, миграции применяются вручную.

## Результаты тестов

| Набор | Файлов/сьютов | PASS | FAIL |
|---|---|---|---|
| SQL `tests/sql/run.sh` (`test`–`test20`) | все файлы | 440 | 0 |
| — из них `test20.sql` (новый) | 1 | 32 | 0 |
| Unit (10 сьютов) | 10/10 | 10/10 | 0 |
| E2E `tests/e2e/regress.sh` | 21/21 | 21 | 0 |

Детали по unit-сьютам: backup 8, bot-run 10, license-flow 26, license-signature 11, storage-split 16, token-crypto 7, robust 38, locales — 1133 ключа. feature-flags и notices печатают только `ok`, без счётчика.

## Сборка и коммит

| Параметр | Значение |
|---|---|
| `dist/kaspi-seller-hub-0.1.0.zip` | **1 807 970 байт** |
| `build-site.mjs` / `build-release.mjs` | OK / OK |
| Коммит (ветка `claude/magical-maxwell-6yq76b`) | `371c2fe` |

## Порядок миграций на завтра

`019` → `020` → `021` → `022` → `023_client_errors_and_retention.sql`

## Что сделано

| Блок | Суть |
|---|---|
| `client_errors` | RLS включён, прямой доступ у `anon` и `authenticated` отозван. RPC `report_client_error` (только `authenticated`): длина каждой строки до 120 символов, URL, токены, email и числа из 4+ цифр вычищаются. Повторы схлопываются в одну строку по ключу `(user_id, error_code, context)` со счётчиком `occurrences`. На одного пользователя не больше 50 уникальных ключей. |
| `admin_client_errors()` | Доступ только при `is_admin()`. Новая вкладка «Ошибки» в админке. |
| Клиент | `reportClientError` в `background/billing.js`: не блокирует работу и никогда не бросает исключение. Одинаковая ошибка отправляется не чаще раза в 10 минут. Вызывается при ошибке лицензии, ошибке синхронизации и сбое billing reconcile. |
| `retention_nudges_sent` | PK `(user_id, nudge_key)`: каждое сообщение уходит пользователю не больше одного раза. RLS включён, публичного доступа нет. |
| `enqueue_retention_nudges()` | Только `service_role`. Три триггера: `no_first_sync_24h`, `trial_ending_2d`, `trial_expired_winback` (с напоминанием о +14 днях за друга). Отправляется только неоплатившим пользователям с привязанным Telegram. Дедупликация через insert-returning, гонки исключены. |
| Бот | `run()` вызывает `enqueue_retention_nudges` после захвата lease. Ошибка этого вызова не прерывает рассылку. Новый тип сообщения в очереди `nudge` отправляется как текст из `payload.text`. |

## Изменённые файлы (`kaspi-seller-hub/`)

| Файл | Статус |
|---|---|
| `billing/supabase/023_client_errors_and_retention.sql` | новый |
| `tests/sql/test20.sql` | новый |
| `tests/sql/run.sh` | + 023 в цепочку |
| `billing/supabase/functions/telegram-bot/bot.js` | изменён |
| `tests/unit/bot-run.test.mjs` | изменён |
| `background/billing.js`, `background/service-worker.js` | изменены |
| `billing/admin/admin.js`, `billing/admin/index.html` | изменены |

## Риски и оговорки

| Пункт | Комментарий |
|---|---|
| `kaspi-api.js` | Напрямую не подключён, чтобы не создать циклический импорт. Ошибки формата ответа всё равно приходят как `sync_apiFormat`. |
| Пересечение напоминаний | На 12–14 день пробного периода пользователь может получить и `no_first_sync_24h`, и `trial_ending_2d`. |
| Edge-функция бота | После применения 023 нужен передеплой `telegram-bot`. |
