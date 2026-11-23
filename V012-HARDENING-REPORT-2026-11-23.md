# V0.1.2 — отчёт об усилении (2026-11-23)

Ветка `claude/magical-maxwell-6yq76b`. Релизный коммит **`d116ac2`** (`d116ac2cf7bdb6d58eeeb7fc820a5ee3729c7fca`); перед ним `5de437e` (исправления) и `73e9b56` (тесты). Удалённый Supabase `zraktrilvwrfpcbmkqwi` **не изменялся**: 026 применяет владелец. Проект `lfadrqgwkjdxkmolhnwi` не затрагивался.

## Исправления

| # | Проблема (TEST-REPORT) | Решение | Файлы | Тест |
|---|---|---|---|---|
| 1 | Тот же API-токен как «Новый магазин» → дубль, слот, доплата | id = `api-` + 16 hex SHA-256(`ksh-api:`+токен.trim()); при совпадении `api.tokenHash`/id — переподключение существующего | `shared/store-key.js`, `background/service-worker.js` (`ui:connectApi`) | `store-key.test.mjs` 6 ok |
| 2 | Тот же токен на 2-м ПК / после переустановки → чужой магазин | Серверный ключ API-магазина от `tokenHash` (не от локального id); tab-магазины — прежний `ksh:<id>` | `service-worker.js` (`storeKeys`) | `store-key.test.mjs`, e2e `uxtest` (тот же id, 1 магазин) |
| 3 | `admin_confirm_invoice` без ожидаемых значений | `null` → `expected_values_required` (22023) до блокировки строки; 2-арг. вызов старой админки отклоняется | `026_strict_invoice_and_cleanup.sql` | `test22` 18/0, `test23` 21/0 |
| 4 | Сбой очистки Storage виден 6 с | Таблица `pending_storage_cleanups` (RLS, только admin), заполняется в `admin_delete_account` в той же транзакции; RPC `admin_list/resolve/fail_storage_cleanup`; постоянный баннер «Ожидают очистки Storage: N» + «Повторить очистку» | 026, `billing/admin/admin.js`, `admin.css`, `grants.sql` | `test23` |
| 5 | Зависший магазин задерживает всех ~100 с | API-магазины параллельно; снимок каждого сохраняется под `lock()` сразу по готовности (read-merge-write) | `service-worker.js` (`syncNow`) | e2e `apitest`, `run2`, `apionly` |
| 6 | Пауза 10 мин за ~18 с у нового магазина | Ошибка считается, только если с прошлой учтённой ≥ 60 с (`BREAKER_MIN_GAP`); после истёкшей паузы счётчик сбрасывается | `shared/api-breaker.js` (`nextApiHealth`) | `sync-breaker.test.mjs` 5 ok, e2e `growth` |
| 7 | Баннер API-магазина: «Открыть вкладку магазина» | «Переподключить токен»: Настройки → карточка API с выбранным магазином → фокус на поле токена | `dashboard/dashboard.js`, `locales/ru.json`, `kk.json` | `locales` ALL PASSED (1136) |
| 8 | Telegram `curl` без `--fail` | `--fail-with-body` | `seller-hub-db-backup.yml:55`, `seller-hub-ops-alert.yml:38` | — |

Доп.: `regress.sh` теперь печатает `N/M suites passed` и выходит с кодом 1 при сбое (раньше всегда 0).

## Тесты (коммит `d116ac2`)

| Набор | PASS | FAIL | Итог |
|---|---|---|---|
| SQL `test`–`test23` (23 файла) | 505 | 0 | ✅ |
| Unit (13 файлов, вкл. `store-key`, `sync-breaker`) | 13/13 файлов | 0 | ✅ |
| E2E `regress.sh` | 22/22 набора | 0 | ✅ (наборов 22, а не 21: 11 billing + 10 API + `apionly`) |
| `saas-core-template` SQL | 505 | 0 | ✅ |
| `saas-core-template` unit (`npm test`) | 11 | 0 | ✅ |
| `init-new-saas.mjs --dry-run` | 60 замен, 0 незаменённых | — | ✅ |

Старые тесты (`test`, `test2`, `test10`, `test16`, `test17`, e2e `billtest2`, `uxtest`, `growth`) обновлены под новое поведение; проверки не ослаблены.

## saas-core-template

| Что | Статус |
|---|---|
| `supabase/migrations/026_strict_invoice_and_cleanup.sql` | ✅ скопирован |
| `tests/sql/test22.sql`, `test23.sql`, `run.sh` | ✅ |
| `admin/admin.js`, `admin.css` (плейсхолдеры `{{APP_NAME}}` и др. сохранены) | ✅ |
| `supabase/grants.sql` | ✅ |
| Unit-тесты store-key/breaker | — (в шаблоне нет этого кода) |

## Релиз

| Параметр | Значение |
|---|---|
| Файл | `kaspi-seller-hub/dist/kaspi-seller-hub-0.1.2.zip` |
| Размер | **1 815 747 байт** |
| SHA-256 | `650ec96e3ad62a9c563c216f5bc06fc7732171540a6aea5615d298cb7bc0caca` |
| Собран из | `d116ac2`, чистое дерево |
| Содержимое | 95 записей; нет `tests/`, `dist/`, `.map`, секретов; `version` 0.1.2 |

## Порядок миграций

`019` → `020` → `021` → `022` → `023` → `024` → `025` → `026`

## Риски и действия владельца

| # | Что |
|---|---|
| 1 | Применить `026` к `zraktrilvwrfpcbmkqwi`, затем перезагрузить админку (старая страница без ожидаемых значений получит отказ) |
| 2 | Существующие API-магазины со случайным id: серверный ключ меняется один раз при следующем переподключении (окно ~2 ч может показать −1 слот) |
| 3 | `api.tokenHash` хранится в настройках: это хэш, а не токен, но он задаёт серверный ключ, поэтому экспорт настроек — чувствительные данные |
| 4 | Секреты GitHub `SUPABASE_DB_URL`, `SUPABASE_SERVICE_ROLE_KEY` (из прошлого отчёта) — по-прежнему за владельцем; теперь сбой Telegram будет виден в Actions |
