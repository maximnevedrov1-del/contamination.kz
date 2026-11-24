# Multi-SaaS core: отчёт об извлечении шаблона (2026-11-22)

Ветка `claude/magical-maxwell-6yq76b`. Источник: `kaspi-seller-hub/` (только чтение). Цель: `saas-core-template/` (изолированная копия, 69 файлов, 4514 строк).

## 1. Извлечённые модули (источник → цель)

Источник указан относительно `kaspi-seller-hub/`, цель относительно `saas-core-template/`.

| Модуль | Источник | Цель | Файлов | Строк (цель) | Строк (источник) |
|---|---|---|---|---|---|
| SQL-миграции | `billing/supabase/001…022_*.sql` | `supabase/migrations/` | 22 | 2891 | 2892 |
| Telegram-бот | `billing/supabase/functions/telegram-bot/{bot,index}.js` | `supabase/functions/telegram-bot/` | 2 | 249 | 246 |
| Админка | `billing/admin/{index.html,admin.js,admin.css}` | `admin/` | 3 | 991 | 992 |
| Клиент биллинга | `background/billing.js` | `extension-core/billing.js` | 1 | 501 | 580 |
| ES256-верификация | `background/billing.js` (стр. ~203-256) | `extension-core/license-signature.js` (новый ESM-модуль) | 1 | 85 | ~54 |
| Шифрование секретов | `shared/token-crypto.js` | `extension-core/token-crypto.js` | 1 | 66 | 62 |
| Разделение хранилища | `shared/storage.js` | `extension-core/storage-split.js` (переписан, без доменных ключей) | 1 | 178 | 519 |
| Атомарный бэкап | `shared/migrations.js` | `extension-core/backup-atomic.js` (переписан) | 1 | 48 | 68 |
| Конфиг | `shared/billing-config.js` | `extension-core/billing-config.js` | 1 | 76 | 59 |
| Флаги и баннеры | `shared/feature-flags.js`, `shared/notices.js` | `extension-core/feature-flags.js`, `notices.js` | 2 | 49 | 49 |
| SQL-тесты | `tests/sql/*` | `tests/sql/` (`run.sh`, `stub.sql`, `test.sql`, `test2…test19.sql`) | 21 | 1185 | 1181 |
| Unit-тесты | `tests/unit/{license-signature,license-flow,token-crypto,feature-flags,notices,storage-split,bot-run}.test.mjs` | `tests/unit/` | 9 (7 адаптированы + 2 новых) | 866 | 813 |
| Бутстрап | нет | `scripts/init-new-saas.mjs`, `saas.config.example.json`, `package.json`, `README.md` | 4 | 220 | нет |

Примечания:
- `test1.sql` в источнике нет: первый тест называется `test.sql` (указано в README).
- `backup.test.mjs` не перенесён: он зависит от доменного `catalog-service.js` (Kaspi). Вместо него новый `backup-atomic.test.mjs`.
- `billing.js` импортирует `./billing-config.js` и `./license-signature.js`; публичные `verifiedClaims`, `signingRequired` сохранены.
- `storage-split.js`: `createSplitCollection` (ключ на запись + индекс, пишутся только изменённые записи), `createSecretStore` (AES-GCM через `token-crypto`, миграция plain-значений), `safeSet`. `token-crypto`: `shopId` → `scopeId`, добавлены `encryptSecret`/`decryptSecret`.
- `backup-atomic.js`: `runAtomicMigration` (snapshot → migrate → verify → откат), `restoreSnapshot`.
- Служебный префикс `ksh` (ключи хранилища, claim токена, имя IndexedDB) переименован в `app` согласованно во всех SQL, JS и тестах.

## 2. Параметризованные переменные

Количество замен взято из `node scripts/init-new-saas.mjs --dry-run` (токены вида двойных фигурных скобок в текстовых файлах шаблона).

| Переменная | Пример значения (`saas.config.example.json`) | Замен | Где |
|---|---|---|---|
| `APP_NAME` | `Acme Pulse` | 22 | комментарии SQL, бот, админка, конфиг |
| `CURRENCY_SYMBOL` | `$` | 12 | бот (`money`), админка, SQL-комментарии и метки тестов |
| `TRIAL_DAYS` | `14` | 5 | `001` (default колонки, комментарий), `018` (2), `billing-config.js` |
| `APP_SLUG` | `acme-pulse` | 4 | комментарии `011`/`012`/`013`, `billing-config.js` |
| `APP_DOMAIN` | `acmepulse.example` | 3 | ссылки offer/privacy, конфиг |
| `CURRENCY` | `USD` | 3 | `001`, `bot.js`, `billing-config.js` |
| `TELEGRAM_HANDLE` | `AcmePulse` | 2 | `billing-config.js`, плейсхолдер бота в админке |
| `SUPABASE_PROJECT_ID` | `your-project-ref` | 1 | `billing-config.js` (URL проекта) |
| `SUPABASE_ANON_KEY` (добавлена сверх списка) | пусто (режим разработчика) | 1 | `billing-config.js` |
| `LICENSE_PUBLIC_JWK` | `[]` | 1 | `billing-config.js` (`parseJwks`) |
| `SUPPORT_EMAIL` | `support@acmepulse.example` | 1 | `billing-config.js` |
| Итого | | 55 | 68 файлов, нераскрытых токенов: 0 |

Обязательные ключи (отсутствие даёт exit 2): все, кроме `SUPABASE_ANON_KEY` и `LICENSE_PUBLIC_JWK`.

Секреты: приватных ключей, `service_role`-ключей и токенов бота в источнике не найдено. Заменены публичные значения: ES256 JWK (2 шт.) и anon JWT из `billing-config.js` (anon JWT содержал ref проекта в base64, поэтому добавлен `SUPABASE_ANON_KEY`).

## 3. Удалено или обобщено как Kaspi-специфичное

| Что | Действие |
|---|---|
| Прайс-фиды Kaspi в `billing.js` (`ensureFeed`, `feedUrl`, `uploadFeed`, блок ~507-550) | удалены |
| `kaspi_qr_url` (колонка, `admin_update_config`, `get_license`, админка, тесты) | переименовано в `payment_url`; ключ ответа `qr_url` → `payment_url` |
| Текст оплаты Kaspi Pay QR в админке (стр. ~184, 604, 606, 629-630) | заменён на общие payment instructions / `payment_url` |
| Рынки `('kaspi','ozon','wb')` в `api_health` и тестах | `('primary','secondary','tertiary')`, подписи в админке обобщены |
| Тексты «Kaspi не отвечает», «Сбой Kaspi», шаблон «Токен» (кабинет Kaspi), шаблон «Принтер» | обобщены или удалены |
| Текст бота про синхронизацию Kaspi | «синхронизацией данных» |
| Комментарии 001/003/016 про Kaspi-кабинет и прайс-листы | обобщены |
| `shopIds` в `teamInvite`/`teamUpdate` | `workspaceIds` (RPC-параметр `p_shop_ids` и БД не менялись) |
| Доменные ключи storage (`snapshots`, `invoices`, `costs`, `catalog`, `feeds` и т.д.), `packSnapshot`, чат, счета | не перенесены |
| Идентификаторы `saudapulse`, `zraktrilvwrfpcbmkqwi`, `kaspi-seller-hub`, `₸` | параметризованы |

Остаточное (не обобщалось, указано в README): тексты сообщений бота и терминология «заказ/магазин», смещение UTC+5 (`TZ_OFFSET_HOURS`), таблицы `price_feeds` и bucket `pricelists` в `001` (оставлены ради целостности миграций и тестов).

## 4. Результаты тестов

| Набор | Результат |
|---|---|
| Unit, 9 файлов (`node --test saas-core-template/tests/unit/*.test.mjs`) | 9 из 9 файлов pass, 0 fail |
| Unit, подтесты по файлам | backup-atomic 6, bot-run 9, license-flow 26, license-signature 11, license-verifier 5, storage-split 11, token-crypto 8, feature-flags ok, notices ok |
| Unit на сгенерированном проекте (`demo-saas`, `npm test`) | 9 из 9 pass |
| SQL, 19 тестовых файлов (`tests/sql/run.sh`, локальный PostgreSQL 16, все 22 миграции) | 408 passed, 0 failed |

Замечание: команда `node --test saas-core-template/tests/unit/` (каталог без glob) на Node 22.23 завершается ошибкой `MODULE_NOT_FOUND` (каталог трактуется как модуль). Рабочий вариант: glob `tests/unit/*.test.mjs` (в шаблоне: `npm test`). Исправление шаблона для этого не требуется.

Исправлено при переносе: `storage-split.update` (мутированная копия терялась), `test.sql` (ключ `qr_url` → `payment_url`). Новые тесты: `backup-atomic.test.mjs` (откат при ошибке migrate, при `verify=false`, восстановление, сбой записи снапшота), `license-verifier.test.mjs` (чужая подпись, подмена payload, sub/iss/aud, alg none/HS256, приватный JWK).

## 5. Dry-run

Команда: `node saas-core-template/scripts/init-new-saas.mjs --dry-run` (config и out по умолчанию), exit 0.

```
total replacements: 55
unreplaced tokens: none

dry run: nothing written.
```

Реальная генерация: `--out <scratchpad>/demo-saas`, записано 68 файлов, exit 0. `grep -r '{{'` по результату пуст. `grep -ri 'saudapulse\|zraktrilvwrfpcbmkqwi'` по шаблону пуст. Проверены отказы: непустой out (exit 1), out внутри `kaspi-seller-hub` (exit 1), нехватка обязательных ключей (exit 2).

## 6. Защита исходников

```
$ git status --porcelain kaspi-seller-hub .github
(пусто)
$ git diff --stat HEAD -- kaspi-seller-hub
(пусто)
```

kaspi-seller-hub/: 0 modified

`.github/`: 0 modified. Supabase MCP не вызывался, ни один проект Supabase не затронут. Временный PostgreSQL для SQL-тестов запущен локально (вне репозитория) и удалён.

## 7. Коммит

| Поле | Значение |
|---|---|
| Коммит | `0306965` |
| Состав | `saas-core-template/`, `MULTI-SAAS-CORE-REPORT-2026-11-22.md` |
| Сообщение | `feat(architecture): extract reusable Multi-SaaS core template and bootstrap CLI` |
| Ветка | `claude/magical-maxwell-6yq76b` (в `main` не пушилось) |
