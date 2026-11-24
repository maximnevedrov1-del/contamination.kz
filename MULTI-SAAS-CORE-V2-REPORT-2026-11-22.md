# MULTI-SAAS CORE V2 — синхронизация 023 (телеметрия ошибок + удержание в Telegram)

Дата: 2026-11-22 · Ветка: `claude/magical-maxwell-6yq76b` · Коммит: `9e639bc`
Supabase: удалённые проекты не затрагивались, тесты шли на локальном PostgreSQL 16.

## 1. Перенесённые файлы (`saas-core-template/`)

| Компонент | Источник (`kaspi-seller-hub/`) | Цель | Действие | Параметризация |
|---|---|---|---|---|
| Миграция 023 | `billing/supabase/023_client_errors_and_retention.sql` | `supabase/migrations/023_client_errors_and_retention.sql` | создан (143 стр.) | `SaudaPulse`→`{{APP_NAME}}` ×3; «данные из Kaspi»→«ваши данные» |
| SQL-тест | `tests/sql/test20.sql` | `tests/sql/test20.sql` | создан (90 стр.) | URL `kaspi.kz`→`shop.example.com` |
| Раннер | `tests/sql/run.sh` | `tests/sql/run.sh` | изменён | шаг 023 добавлен после 022 |
| Telegram-бот | `billing/supabase/functions/telegram-bot/bot.js` | `supabase/functions/telegram-bot/bot.js` | изменён (+3) | тип `nudge` + `enqueue_retention_nudges` после `bot_lock`, сбой не роняет запуск |
| Юнит-тест бота | `tests/unit/bot-run.test.mjs` | `tests/unit/bot-run.test.mjs` | изменён (+9) | проверяет один вызов за запуск и что сбой не ломает запуск |
| Админка | `billing/admin/{admin.js,index.html}` | `admin/{admin.js,index.html}` | изменён | вкладка `errors` + `renderErrors()` |
| Клиентский хелпер | `background/billing.js` (`reportClientError`) | `extension-core/error-telemetry.js` | создан (44 стр.) | `createErrorReporter`/`reportClientError`; лимит 10 мин на ключ, в памяти (не больше 50 ключей), ключей в storage нет (префикс `app.` не понадобился) |
| Тест хелпера | — | `tests/unit/error-telemetry.test.mjs` | создан | лимит, обрезка до 120 символов, нет входа/конфига, ошибка RPC |
| README | — | `README.md` | изменён | 001…023, 20 SQL-файлов |

Итог: 10 файлов, +349 / −5.

## 2. Тесты

| Набор | Файлов | Пройдено | Провалено |
|---|---|---|---|
| SQL `test.sql` + `test2`–`test20` | 20 | 440 | 0 |
| Юнит `tests/unit/*.test.mjs` | 10 | 10 | 0 |

SQL по файлам (пройдено/провалено): test 34/0 · t2 26/0 · t3 17/0 · t4 23/0 · t5 10/0 · t6 17/0 · t7 29/0 · t8 41/0 · t9 28/0 · t10 48/0 · t11 13/0 · t12 11/0 · t13 21/0 · t14 25/0 · t15 14/0 · t16 21/0 · t17 11/0 · t18 6/0 · t19 13/0 · **t20 32/0**.

## 3. Генератор `init-new-saas.mjs`

| Проверка | Результат |
|---|---|
| `--dry-run` | exit 0, 58 замен по 11 ключам (APP_NAME 25, CURRENCY_SYMBOL 12, TRIAL_DAYS 5, APP_SLUG 4, APP_DOMAIN 3, CURRENCY 3, TELEGRAM_HANDLE 2, прочие по 1) |
| Генерация в `/tmp/demo-saas-v2` | exit 0, 72 файла, 58 замен |
| Незаменённые `{{` | **0** |
| Утечки `saudapulse`/`kaspi` | **0** брендовых (1 совпадение: README:43, это описание защиты `--out`, не бренд) |
| 023 и `error-telemetry.js` в результате | есть |

## 4. Безопасность

| Проверка | Результат |
|---|---|
| `git status --porcelain kaspi-seller-hub` | пусто, **0 изменённых** |
| Проект `lfadrqgwkjdxkmolhnwi` | не затрагивался |
| Коммит отправлен | `9e639bc` → `origin/claude/magical-maxwell-6yq76b` |

## 5. Решения

- «+14 дней» в тексте возврата оставлен как есть: в шаблоне нет токена для бонусных дней, а 019 тоже пишет +14 напрямую.
- В `run.sh` в шапке указан PGPORT=5499; на этой машине прогон шёл через сокет на 5432 под пользователем `postgres`.
