# UX-телеметрия — отчёт 2026-11-23

| Параметр | Значение |
|---|---|
| Проект Supabase | `kaspi-seller-hub` (`zraktrilvwrfpcbmkqwi`, eu-west-1); `lfadrqgwkjdxkmolhnwi` не затронут |
| Миграция | `024_ux_behavior_telemetry` применена; RLS=on, anon/authenticated SELECT=нет, anon EXECUTE=нет, authenticated EXECUTE=да |
| Коммит (push) | `616b19970b1ab0ffb14b312c16ce865f9e6b6c36` → `claude/magical-maxwell-6yq76b` |
| Версия | `manifest.json` 0.1.0 → **0.1.1** |
| ZIP | `kaspi-seller-hub/dist/kaspi-seller-hub-0.1.1.zip` — **1 811 811 байт** (в .gitignore) |

## SQL (`kaspi-seller-hub/tests/sql/run.sh`)

| Файл | PASS | FAIL |
|---|---|---|
| test | 34 | 0 |
| test2 | 26 | 0 |
| test3 | 17 | 0 |
| test4 | 23 | 0 |
| test5 | 10 | 0 |
| test6 | 17 | 0 |
| test7 | 29 | 0 |
| test8 | 41 | 0 |
| test9 | 28 | 0 |
| test10 | 48 | 0 |
| test11 | 13 | 0 |
| test12 | 11 | 0 |
| test13 | 21 | 0 |
| test14 | 25 | 0 |
| test15 | 14 | 0 |
| test16 | 21 | 0 |
| test17 | 11 | 0 |
| test18 | 6 | 0 |
| test19 | 13 | 0 |
| test20 | 32 | 0 |
| **test21 (новый)** | **26** | **0** |
| **Итого** | **466** | **0** |

## Unit (`kaspi-seller-hub/tests/unit`)

| Набор | Результат |
|---|---|
| backup | 8 ok |
| bot-run | 10 ok |
| feature-flags | ok |
| license-flow | 26 ok |
| license-signature | 11 ok |
| locales | ALL PASSED (1133 ключа) |
| notices | ok |
| robust | 38/38 |
| storage-split | 16 ok |
| token-crypto | 7 ok |
| **ux-telemetry (новый)** | **10 ok** |
| **Итого** | **11/11 файлов, 0 FAIL** |

## E2E (`tests/e2e/regress.sh`)

| Группа | Наборы | Итог |
|---|---|---|
| Billing/mock-Supabase | cattest, billtest, hack, billtest2, team, support, insights, orchestra, growth, telegram, **uxtelemetry (новый)** | 11/11 ALL PASS |
| API/demo | apitest, run2, demofile, feat, uxtest, learn, photoprint, interactive, readonly, onboard | 10/10 ALL PASS |
| **Итого** | | **21/21** (+ apionly: ALL PASS) |

## `saas-core-template/`

| Проверка | Результат |
|---|---|
| Синхронизировано | `supabase/migrations/024_ux_behavior_telemetry.sql`, `tests/sql/test21.sql`, `tests/sql/run.sh`, `extension-core/ux-telemetry.js` (`{{APP_NAME}}`), `tests/unit/ux-telemetry.test.mjs`, `admin/` (вкладка UX), `README.md` (001…024) |
| SQL `run.sh` | 466 PASS / 0 FAIL |
| Unit | 11/11 файлов ok (ux-telemetry: 11 ok) |
| `init-new-saas.mjs --dry-run` | rc=0, 76 файлов, 60 замен, 0 незамещённых токенов |

## Приватность (Chrome Web Store)

| Требование | Статус |
|---|---|
| Запись экрана / сессий в расширении | нет |
| `innerText` / `textContent` / `value` / URL / DOM Kaspi | не читаются; только `dataset.uxKey`, id маршрута, id диалога |
| Типы событий | whitelist: `screen_view`, `action_click`, `rage_click`, `form_abandoned`, `help_opened` |
| Ключи | `^[a-z0-9_:-]{1,64}$`, не только цифры; проверка в клиенте, background, RPC и CHECK таблицы |
| Объём | ≤100 уникальных строк/пользователь; отправка пачкой ≤1 раз/60 с (+1 при закрытии вкладки); тихий отказ |
| E2E-проверка утечек | введённый токен, имя магазина, URL, кириллица в БД не попали |
| **PII / DOM-текст** | **0 — не собирается** |

## Компоненты

| Слой | Файл |
|---|---|
| БД | `billing/supabase/024_ux_behavior_telemetry.sql` — `ux_events`, `track_ux_event()`, `admin_ux_summary()` (`is_admin()`, 42501) |
| Клиент | `shared/ux-telemetry.js`, `dashboard/ux-wire.js`, `background/billing.js` (`trackUxEvents`), `service-worker.js` (`ui:trackUx`) |
| Админка | `billing/admin/` вкладка «UX / Затыки» (data-tab=`ux`) |
| Сайт | `site/clarity.js` + `clarityProjectId` в `site/site.config.json`; пусто → ни тега, ни файла в сборке; id `^[a-z0-9]{6,20}$` |
