# SaudaPulse — Stage 01: карта репозитория

Дата: 2026-11-27. Ветка: `claude/magical-maxwell-6yq76b`. Код приложения на этом этапе не менялся.

Обозначения:
- `kh/` = `kaspi-seller-hub/`;
- номера строк взяты из поиска по состоянию репозитория на момент обнаружения;
- метка **[проверено]** означает, что я перепроверил пункт отдельным запросом, остальное — по отчёту Haiku.

---

## 0. Отклонения от задания

| Что требовалось | Что на самом деле |
|---|---|
| Прочитать `docs/transformation/PROJECT-RULES.md` | **Файла нет**, каталога `docs/transformation/` тоже не было [проверено]. Правил проекта нет, ничего не выдумывал. Каталог создан этим документом. |
| Вызвать агента `saudapulse-discovery` на Haiku | **Такого агента нет** (`.claude/agents/` отсутствует и в репозитории, и в `~/.claude`). Использован встроенный read-only агент `Explore` с `model: haiku`. |
| Не вызывать Opus | Выполнено: в этом этапе Opus не вызывался. |
| Сохранить чужие изменения | Выполнено, см. раздел 1. |

Ограничения отчёта:
- Haiku читал файлы выборочно, поэтому `kh/shared/selectors.js`, `kh/content/content.js` и `kh/content/network-tap.js` не разобраны по символам;
- список `admin_*` RPC получен буквальным поиском и может быть неполным;
- содержимое `APPLY-PROD-2026-11-24-d.sql` проверено только по заголовку.

## 1. Состояние Git

| Параметр | Значение |
|---|---|
| Ветка | `claude/magical-maxwell-6yq76b`, синхронизирована с `origin` (ahead/behind: 0/0) |
| Последний коммит | `38c1741` — отчёт по рынку Kaspi |
| Всего коммитов | 191 (на момент оценки готовности) |
| Незакоммиченных путей | 16 (12 изменены, 4 новых) |
| Stash | пусто |

**Изменены (M):**
- `kh/site-deploy/llms.txt`
- `kh/site-landing/index.html`
- `kh/site-landing/llms.txt`
- `kh/site-landing/source/index.html`
- `kh/site-landing/source/public/llms.txt`
- `kh/site-landing/source/src/i18n.js`
- `kh/site-landing/source/src/locales/kk-part-1.json`
- `kh/site-landing/source/src/locales/kk-part-2.json`
- `kh/site-landing/source/src/main.js`
- `kh/tests/sql/run.sh`
- `kh/tests/sql/test.sql`
- `kh/tests/sql/test10.sql`

**Не отслеживаются (??):**
- `kh/billing/supabase/034_tariffs_v2.sql` (514 строк)
- `kh/site-landing/source/src/landing-extra.css`
- `kh/site-landing/source/src/locales/kk-part-3.json`
- `kh/tools/build-landing.mjs` (66 строк)

**Происхождение.** Все 16 путей — незавершённая работа двух агентов Sonnet, оборвавшихся по недельному лимиту (одно задание — тарифы в биллинге, второе — лендинг). Их работа **не проверена**:
- миграция `034` не прогонялась в тестах;
- `site-landing/index.html` пересобран частично;
- обновлены только `test.sql` и `test10.sql`, а другие тесты со старыми ценами (`test2`, `test3`, `test27`, e2e `billtest*`) не тронуты и, скорее всего, упадут.

**Риск для чистого клона.** `site-landing/source/src/i18n.js` импортирует `kk-part-3.json`, а файл не отслеживается: чистая сборка упадёт.

Решение по этим изменениям (оставить, закоммитить как WIP или откатить) принимает владелец. На этом этапе они не тронуты.

## 2. Архитектура

| Слой | Пути |
|---|---|
| Расширение MV3 | `kh/manifest.json`; `kh/popup/{popup.html,popup.js}`; `kh/dashboard/{dashboard.html,dashboard.js}` и модули (`catalog-view`, `growth-view`, `staff-view`, `support-view`, `feedback-view`, `print`, `charts`, `onboarding`, `ux-wire`); `kh/background/service-worker.js` + `billing.js`, `kaspi-api.js`, `packing.js`, `staff.js`, `growth.js`, `support.js`, `usage.js`, `health.js`, `price-feed.js`, `catalog-service.js`, `spbackup-service.js`; `kh/content/{content.js,network-tap.js}`; `kh/shared/*` |
| Телефонное приложение (PWA) | `kh/app/index.html`, `kh/app/js/{boot,main,data,scan,install,turnstile,config}.js`, `kh/app/sw.js` |
| Лендинг | исходники `kh/site-landing/source/` (Vite 5.4.14; `src/main.js`, `src/i18n.js`); собранная страница `kh/site-landing/index.html` (~1 МБ, всё внутри) |
| Публикуемый пакет | `kh/site-deploy/` (`index.html`, `kk/`, `app/`, `legal/`, `offer/`, `privacy/`, `captcha/`, `_headers`, `robots.txt`, `sitemap.xml`, `llms.txt`) |
| Сборка | `kh/tools/{build-app.mjs,build-release.mjs,build-site-package.mjs,ops-alert.mjs}` |
| Бэкенд | SQL-миграции `kh/billing/supabase/001…034_*.sql`; Edge-функции `kh/billing/supabase/functions/{kaspi-relay,payment-webhook,telegram-bot}`; админка `kh/billing/admin/{index.html,admin.js,admin.css}` |
| Шаблон | `saas-core-template/` — параллельная копия биллинга для других SaaS (по отчёту Haiku, миграции 001–033, без 034) |

**Генерируемые копии (в анализ не входят):**
- `kh/dist/` (в `.gitignore`);
- `kh/site-deploy/app/core`;
- `kh/tests/{apicopy,billcopy,loadcopy,relcopy,run2copy,relmock}`.

**Важное свойство лендинга** [проверено агентом по предыдущему отчёту]: `site-landing/index.html` не собирается из `source/` ни одним скриптом в репозитории; `site-deploy/index.html` — ручная копия. Единственный новый скрипт `tools/build-landing.mjs` не отслеживается и не проверен.

## 3. Аутентификация и авторизация

| Тема | Где | Символы |
|---|---|---|
| Вход по коду из письма (Supabase Auth) | `kh/background/billing.js` | `otpBody:95`, `requestCode:102` (`/auth/v1/otp`), `verifyCode:110`, `saveSession:83`, `logout:191`, `verifyCodeRaw:151`, `refreshRaw:166` |
| Подписанная лицензия | `kh/shared/license-signature.js:33` `createLicenseVerifier`; `kh/background/billing.js:242`, `claimsStale:253`, `trustedLicence:261`; копия в `kh/billing/supabase/functions/kaspi-relay/license-signature.js` | claims из `custom_access_token_hook` (`001_billing.sql:613` [проверено], переопределён в `034:183`) |
| Админ | `001_billing.sql:190` `is_admin()`; таблица `admins` (`001:136`) | |
| Доступ | `has_access()` `034:337`; `has_access_of(p_user)` `002_team.sql:32` [проверено] и `034:347`; `packer_access` `034:358`; `feed_allowed` `034:367` | |
| RLS | `accounts_read_own`, `invoices_read_own` (`001:149,151`, `010:24,28`); RLS включён в `001:141–146`, `002:28`, `003`, `004`, `005`, `008`, `015`, `019`, `022–024`, `028`, `032` | |
| Роли owner/staff | `kh/app/js/main.js:2`, `:133–135` (`state.role`) | |
| PIN упаковщика/владельца | **только на клиенте**: `kh/background/staff.js` — `OWNER_PIN_KEY:22`, `MAX_PIN_FAILS:28` (5), `OWNER_UNLOCK_MS:27` (8 ч), `OFFLINE_GRACE_MS:26` (5 мин), `pinHash:37` (PBKDF2-SHA-256), `validPin:43` (4–8 цифр); сервер переспрашивает каждые 2 мин | |

## 4. Тарифы и платные функции

**Таблица настроек:** `billing_config` — `001_billing.sql:22`; новые колонки в `034:29–31` (`free_store_limit`, `team_packer_limit`, `warehouse_packer_limit`, `year_free_months`, `warehouse_price`, `warehouse_stores`).

**Схема в `034` (черновик, не применён и не проверен):**

| Тариф | Цена | Лимиты |
|---|---|---|
| Бесплатно | 0 ₸ | 1 магазин, только владелец, 0 упаковщиков |
| Команда | 6 990 ₸/мес | до 3 магазинов, 3 упаковщика |
| Склад | 12 990 ₸/мес | до 10 магазинов, 20 упаковщиков; сверх 10 — +1 000 ₸ за магазин |
| Пробный период | 14 дней | лимиты «Склад» |
| Год | 12 месяцев по цене 10 | |

**Функции SQL в `034`:** `billing_price:48`, `plan_stores:58`, `account_status:67` (`frozen|active|trial|grace|free|expired`), `account_plan:79`, `account_store_limit:90`, `account_packer_limit:101`, `owner_packer_limit:108`, `get_license:114`, `create_invoice:210`, `ensure_renewal_invoice:235`, `team_join:451`, `team_check:467`.

**Действующая (применённая) схема в продакшене** — из `001…032`: Старт 12 000 ₸ (1 магазин), Мульти 20 000 ₸ (до 3), +5 000 ₸ за магазин, пробный период 14 дней на 3 магазина, после него полная блокировка. Лимита упаковщиков по тарифу нет, общий потолок — 20.

**В расширении:**

| Что | Где |
|---|---|
| Вид лицензии | `kh/background/billing.js` — `licenseView:336`, `getLicense:286`, `LICENSE_KEY:16` |
| Блокировка действий | `kh/background/service-worker.js` — `NEEDS_LICENSE:1329` [проверено], `WRITES:1324`, `refreshReadOnly:1326`, `licenseGate:1355` [проверено] (ошибки `readOnly`, `subscriptionRequired`) |
| Экран оплаты | `kh/dashboard/dashboard.js` — `payMode:2193` [проверено], `paywall():2462`, отрисовка шлюза `:3205`; `kh/popup/popup.js:44`; `kh/app/js/main.js:216`, `licenseBanner:283` |
| Режим «только чтение» | настройка пользователя (`shared/storage.js:72`), а не состояние лицензии |
| Флаги функций | `kh/shared/features.js` (`FEATURES = {cabinet: true}`, в релизе выключается `tools/build-release.mjs`); `kh/shared/feature-flags.js` — `featureFrom:7`, `getFeatures:12`, `isFeatureEnabled:22`; сервер `015_feature_flags.sql` — `feature_flags_for:26`, `admin_set_feature_flag:48` |

**Устаревшее:** `kh/dashboard/growth-view.js:4,44` (и запасные суммы 12000/20000/5000 в `dashboard.js:2382, 2558`, `growth-view.js:49`) ссылаются на тариф «Старт», который `034` убирает.

## 5. Лимиты магазинов

| Что | Где |
|---|---|
| SQL | `034:90` `account_store_limit`; `get_license` отдаёт `store_limit` и `paid_store_limit` (`034:155–156`); `013_account_sharing.sql:16` — подсчёт магазинов по браузерам |
| Расширение | `service-worker.js` — `enabledStoreList:152–157` (обрезка по `lic.storeLimit`), пропуск сверх лимита `:467`, проверка без счёта `:539`, офлайн-запас `storeLimit:0` `:598` |
| Упаковщики | на сервере — `team_join` (`034:451`), `team_check` (`034:467`); **в интерфейсе лимит не показан** |
| Прайс-листы | `ensure_price_feed` (`034:374`, `001:662`), `can_write_feed` (`034:393`, `001:681`); клиент `kh/background/price-feed.js` — `ensureFeed:9`, `uploadFeed:19` |

## 6. Платёжные провайдеры

| Что | Где |
|---|---|
| Приёмник уведомлений | `kh/billing/supabase/functions/payment-webhook/handler.js` — `MAX_BODY:23`, `MAX_SKEW_S:24` (5 минут), `hmacHex:29`, `safeEqual:35`, `PROVIDERS:61`, `handle:92`; `index.js:2` (деплой с `--no-verify-jwt`) |
| Провайдер `generic` | работает: заголовки `X-Timestamp`, `X-Signature` = HMAC-SHA256(`PAYMENT_WEBHOOK_SECRET`, `"ts.body"`) |
| Провайдер `aipay` | **не подключён**, отвечает 501 (`handler.js:77`, `billing/README.md:307`) |
| База | `028_payment_autoconfirm.sql` — `confirm_invoice_core:15`, `admin_confirm_invoice:62`, таблица `payment_events:82`, `payment_received:104` (переопределена в 030 и 031), `admin_payment_events:153`, `admin_resolve_payment_event:167`; строгое подтверждение `026:12` |
| Ручные счета | `create_invoice` (`001:325`, `034:210`), `ensure_renewal_invoice` (`034:235`), `request_store_addon` (`001:384`, `025:85`), `cancel_my_invoice` (`001:429`) |
| Kaspi QR | `payment.qr_url` из конфигурации сервера, `dashboard.js:599–600` (`safeQrUrl`), `checkPayment:2241` |

Правило автоподтверждения: точная сумма по ожидающему счёту, иначе — в очередь проверки; совпадение только по телефону подтверждается, если номер подтверждён в Telegram-боте (`031`).

## 7. База данных

**Миграции** `kh/billing/supabase/`:

| № | Содержание |
|---|---|
| 001 | биллинг: `billing_config`, `accounts`, `invoices`, `consents`, `store_claims`, `admins`, `price_feeds` |
| 002 | команда: `team_members`, `team_*` RPC |
| 003 | поддержка: `service_status`, `support_tickets`, `api_health`, `ops_settings`, `ops_digest` |
| 004 | аналитика: `user_progress`, `usage_daily`, `feedback` |
| 005 | рост: `cancellations`, `tg_links`, `tg_link_tokens`, `tg_sent`, `digest_stats`, пробный буст, `cancel_flow`, `bot_jobs` |
| 006–012 | индексы, батчи бота, `bot_run_lock`, исправления безопасности, защита пробного периода |
| 013–014 | общий доступ аккаунта, срок хранения и удаление |
| 015–018 | `feature_flags`, системная плашка, права `service_role`, пробный период 14 дней |
| 019–021 | рефералка (`tg_outbox`), исправления |
| 022–024 | `funnel_events`, `client_errors`, `retention_nudges_sent`, `ux_events` |
| 025–027 | аудит F1/F2, строгое подтверждение счетов, `pending_storage_cleanups`, пакет `track_ux_events` |
| 028 | `payment_events` |
| 029–033 | язык клиента, исправления аудита, `phone_verified`, бот поддержки (`support_faq`, `bot_questions`), `bot_faq` |
| **034** | тарифы v2 — **черновик, не отслеживается** |

**Пакеты для продакшена** (`APPLY-PROD-2026-11-24*.sql`):
- основной — 019–023, 025–028 (в продакшене уже 001–018 и 024);
- `-b` — 029;
- `-c` — 030 и 031 (заменён `-d`);
- `-d` — 030, 031 и 032, затем `grants.sql`.

**Миграции 033 и 034 не входят ни в один пакет** [проверено].

**Прочее:** `grants.sql` — права `EXECUTE` и политики хранилища.

**Таблицы и файлы определения:** `billing_config`, `accounts`, `invoices`, `consents`, `store_claims`, `admins`, `price_feeds` (001; `price_feeds` — `:641`); `team_members` (002); `service_status`, `support_tickets`, `api_health`, `ops_settings` (003); `user_progress`, `usage_daily`, `feedback` (004); `cancellations`, `tg_links`, `tg_link_tokens`, `tg_sent`, `digest_stats` (005); `bot_run_lock` (008); `feature_flags` (015); `tg_outbox` (019); `funnel_events` (022); `client_errors`, `retention_nudges_sent` (023); `ux_events` (024); `pending_storage_cleanups` (026); `payment_events` (028); `support_faq`, `bot_questions` (032).

**Таблицы заказов в миграциях нет** [проверено]: заказы живут только в браузере (`chrome.storage`).

## 8. Интеграция с Kaspi

| Файл | Символы |
|---|---|
| `kh/background/kaspi-api.js` | `RETRY_DELAYS:43`, `API_TIMEOUT_MS:49`, `MAX_IN_FLIGHT:60`, `apiRequest:96`, `verifyToken:173`, `listOrders:186`, `getOrderByCode:219`, `getEntries:225`, `acceptOrder:252`, `assembleOrder:260`, `downloadWaybill:268`, `mapStatus:295`, `mapPayment:313`, `toOrderItem:324`, `getCategories:367`, `getAttributes:372`, `importProducts:385`, `getImportStatus:392`, `getImportResult:397` |
| `kh/shared/api-sync.js` | `apiSnapshot:19`, `apiTopProducts:55` |
| `kh/shared/api-breaker.js` | `OUTAGE_CODES:9`, `BREAKER_FAILS:10` (3), `BREAKER_PAUSE:11` (10 мин), `breakerOpen:14` |
| `kh/shared/selectors.js`, `kh/content/content.js`, `kh/content/network-tap.js` | существуют, символы не разобраны |
| Клиент транзитного сервера для телефона | `kh/shared/kaspi-relay-client.js` — `KASPI_API:12`, `installRelayFetch:27`, `relayUrlFor:69`; используется в `kh/app/js/boot.js`, `config.js` |

## 9. Хранилище браузера и IndexedDB

- **`kh/shared/storage.js`**: `KEYS:9–27` — `ksh.settings`, `ksh.snapshots`, `ksh.chat`, `ksh.invoices`, `ksh.lastSync`, `ksh.apiTokens`, costs, catalog, feeds, imports, photos и др.; сессионные — `registry`, `printQueue`, `pickList`; по магазинам `ksh.snap.*` (`:142–144`); кэш счетов `ksh.inv.*` (`:333–334`), `INVOICE_LIMITS:405` (30 дней, 500 записей, 50 МБ).
- **`kh/background/billing.js`**: `ksh.session:12`, `ksh.lastUser:13`, `ksh.tickets/csat/usage/tg:15`, `ksh.license:16`.
- **`kh/background/staff.js`**: `ksh.staffRoster:20`, `ksh.ownerPin:22`, `ksh.ownerUnlocked:23` (сессия), `ksh.ownerPinFails:24`.
- **Журнал сборки:** `kh/background/packing.js` — `ksh.packLog:11`, `ksh.barcodes:12`. **Использование:** `usage.js` — `ksh.usage:15`, `ksh.feedbackDue:16`. **Telegram:** `growth.js` — `ksh.tg:14`.
- **Шифрование токенов:** `kh/shared/token-crypto.js` — AES-GCM, неизвлекаемый ключ в IndexedDB `ksh-secrets` / `keys` / `apiTokens` (`:11–13`), префикс `enc1:` (`:10`), `newKey:22`, `encryptToken:46`, `decryptToken:53`.
- **Телефонное приложение:** `kh/shared/storage-adapter.js` — `createIdbBackend:51` (база `saudapulse-app`), `createSecureArea:122`, `createMemoryArea:226`, `installChromeFacade:270`; подключено в `kh/app/js/boot.js:8,17–18`; `kh/app/js/data.js:336` хранит `ksh.session`, `:347` удаляет БД `ksh-secrets`.
- IndexedDB в `kh/dashboard/` и `kh/popup/` — **не найдено**.

## 10. API-прокси и заголовки

**`kaspi-relay`** (`kh/billing/supabase/functions/kaspi-relay/handler.js`; точки входа `index.js:4,11` — Deno, `worker.js:2,9` — Cloudflare Worker):
- `ALLOWED_HOST:31` = `kaspi.kz`; `ALLOWED_PATHS:32` = `/shop/api/v2/`, `/shop/api/products/`; `allowedTarget:44`;
- `DEFAULT_ORIGINS:76` = `saudapulse.kz`, `www.saudapulse.kz`, `saudapulse.pages.dev`, переопределяется `RELAY_ALLOWED_ORIGINS` (`:82,89`); проверка origin `:122`; CORS `:109–112`;
- аутентификация JWT ES256 по JWKS (`:97, 136–138`), анонимные отклоняются;
- лимит `createLimiter:59` (300 в минуту на пользователя), `MAX_ENVELOPE:144`, таймаут и запрет редиректов (`:175, 181`).

**Заголовки сайта:** `kh/site-deploy/_headers` — глобально `nosniff`, `Referrer-Policy`, `Permissions-Policy`; для `/app/*` — `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `camera=(self)`. CSP с `connect-src` **нет**.

Других прокси и обработчиков CORS не найдено.

## 11. Шапка и боковая панель

| Где | Что |
|---|---|
| Панель управления | `kh/dashboard/dashboard.html` — `aside.sidebar:13`, `nav:21`, пункты `data-route:22–72`, `header.topbar:86`, `topbar__meta:132`; `kh/dashboard/dashboard.js` — `ROUTES:72` [проверено] (12 маршрутов; `chat` только при `FEATURES.cabinet`), `TABLE_ROUTES:75`, `renderTopbar:1891` [проверено], `renderSidebar:1926` [проверено], `renderBanners:1982`, `GUIDE_ROUTES:2994` |
| Всплывающее окно | `kh/popup/popup.html:11` (`header.pp-header`), `popup.js:44` |
| Телефонное приложение | `kh/app/js/main.js` — `shell():115` (шапка), `OWNER_TABS:203`, `STAFF_TABS:515`, `startOwner:205`, `startStaff:517`, `go:241`, `render:246` |
| Лендинг | `kh/site-landing/source/src/main.js:227–228` (`.menu-btn`, `.main-nav`) |

## 12. Админка

`kh/billing/admin/admin.js`: вкладки `renderInvoices:282`, `renderAccounts:466`, `renderUx:539`, `renderErrors:559`, `renderInsights:571`, `renderFaq:669`, `renderTickets:764`, `renderStatus:821`, `renderConfig:936` (форма цен), `renderFlags:1005`; подключение вкладок `:205`, `:1133`.

Вызываемые RPC (поиск по шаблону, список может быть неполным): `admin_accounts`, `admin_bot_questions`, `admin_cancel_invoice`, `admin_client_errors`, `admin_confirm_invoice`, `admin_delete_account`, `admin_delete_feature_flag`, `admin_fail_storage_cleanup`, `admin_faq`, `admin_faq_delete`, `admin_faq_save`, `admin_get_config`, `admin_get_system_banner`, `admin_grant_days`, `admin_growth_settings`, `admin_health`, `admin_insights`, `admin_invoices`, `admin_list_feature_flags`, `admin_list_storage_cleanups`, `admin_ops_settings`, `admin_payment_events`, `admin_resolve_payment_event`, `admin_resolve_storage_cleanup`, `admin_set_feature_flag`, `admin_set_status`, `admin_set_system_banner`, `admin_ticket_reply`, `admin_tickets`, `admin_update_config`, `admin_ux_summary`, а также `is_admin`, `get_service_status`.

Через админку нельзя менять `max_stores` и `boost_hours`; поля `034` в форму ещё не добавлены.

## 13. Лендинг и локализация

- **Лендинг:** `kh/site-landing/source/src/i18n.js` — `messages:7`, `translate:24` (язык по умолчанию `kk`), ключ `saudapulse-language:50`, `initialLanguage:63`, `mountI18n:73`; словари `locales/kk-part-1.json`, `kk-part-2.json`, `kk-part-3.json` (последний не отслеживается). Страницы `kh/site-landing/index.html` (`lang="ru"`), `kh/site-deploy/index.html`, `kh/site-deploy/kk/index.html`. Тесты лендинга — 13 Python-файлов в `kh/site-landing/source/tests/` (включая `test_i18n.py`).
- **Расширение:** `kh/locales/ru.json` (1673 строки), `kh/locales/kk.json` (1583); `kh/shared/i18n.js` — `LANGS:19`, `loadDict:50`, `load:57–67` (язык из настроек, запасной `ru`); серверный язык клиента `029_client_language.sql` — `set_my_lang:18`.
- **Телефонное приложение:** только русский.

## 14. Аналитика

- **UX-телеметрия:** `kh/shared/ux-telemetry.js` — `track:51`, rage-click (4 клика за 2 с, `:74–81`); сервер `024` (`track_ux_event:22`, `admin_ux_summary:49`), `027` (`track_ux_events:12`).
- **Воронка и ошибки:** `kh/background/billing.js` — `reportClientError:447` → `report_client_error` (`023:39`), `FUNNEL_EVENTS:440`, `trackFunnel:503` → `track_funnel_event` (`022:15`), `trackUxEvents:479`, `uxBatch:490`.
- **Использование и оценка (NPS):** `004` (`usage_report:49`, `feedback_submit:112`), `kh/background/usage.js`.
- **Сводки:** `003 ops_digest:262` (переопределён в 011, 014, 032), `032 ops_daily_report:254`, `005 digest_report:195`; `kh/tools/ops-alert.mjs` по расписанию каждые 10 минут.
- **Сторонняя аналитика** (GA, GTM, Mixpanel, PostHog, Amplitude, Метрика, Sentry, Hotjar) — **не найдена**; телеметрия только собственная.

## 15. Тесты и развёртывание

| Что | Значение |
|---|---|
| SQL-тесты | `kh/tests/sql/run.sh` — применяет 001→034 и запускает 29 файлов `test*.sql` [проверено] |
| Юнит-тесты | `kh/tests/unit/*.mjs` — 25 файлов [проверено] |
| E2E | `kh/tests/e2e/` — 37 файлов `.js` и 4 `.sh` (по Haiku; в каталоге 660 записей вместе с артефактами) |
| Нагрузка и производительность | `kh/tests/load/`, `kh/tests/perf/` |
| GitHub Actions | `.github/workflows/`: `kaspi-seller-hub.yml` (push + ручной запуск: синтаксис, юнит-тесты, локали, сборка приложения, SQL-тесты на Postgres, Chromium-тесты), `seller-hub-bot.yml` (cron: 04:07, 04:37, 05:07, 06:07 UTC), `seller-hub-db-backup.yml` (21:17 UTC), `seller-hub-ops-alert.yml` (каждые 10 мин) |
| Сборка | `kh/tools/build-release.mjs` (выключает `FEATURES.cabinet`, если нет `--with-cabinet`), `build-app.mjs` (`dist/app-site`), `build-site-package.mjs` (`dist/site-package`) |
| Документация | `RELEASE-WORKFLOW.md`, `kh/site-deploy/README.md` (проект Cloudflare Pages `saudapulse`), `kh/docs/CHROME-WEB-STORE-SUBMISSION.md`, `kh/docs/ozon-api-notes.md`, отчёты в корне и `docs/reports/` |
| Домены | корневой `CNAME` = `contamination.kz` |
| Конфигурация Supabase | `supabase/config.toml` **нет**; функции разворачиваются командами (`payment-webhook/index.js:2`, `wrangler deploy … --name saudapulse-kaspi-relay`) |

## 16. Отсутствующие компоненты

| Компонент | Статус |
|---|---|
| `docs/transformation/PROJECT-RULES.md` | **нет**, правил проекта в репозитории нет |
| Агент `saudapulse-discovery`, `.claude/agents/`, `CLAUDE.md` проекта | **нет** |
| Ссылка на Chrome Web Store | **не подключена**: метатеги `sp-extension-id` и `sp-store-url` в `kh/site-deploy/index.html` пусты, `install-button.js` использует заглушку `/detail/<id>` |
| Реальный платёжный провайдер | **не подключён**: работает только `generic`, `aipay` отвечает 501 |
| Таблица заказов на сервере | **нет**: заказы только в хранилище браузера (`shared/storage.js:142`) |
| Бесплатный тариф | в `034` есть, но не применён в продакшене |
| Лимит упаковщиков по тарифу | на сервере есть только в `034` (не применён); в интерфейсе нет |
| Казахский язык в телефонном приложении | **нет** |
| Сторонняя аналитика и трекинг ошибок | **нет** |
| `supabase/config.toml` | **нет** |
| Каталог `graphify-out/` | **нет** (хотя глобальные инструкции упоминают graphify) |
| Режим кабинета Kaspi в релизе | **выключен** (`FEATURES.cabinet = false` в релизной сборке) |
| Применение миграций 033 и 034 в продакшене | **не оформлено**, нет `APPLY-PROD`-пакета |

**Устаревшее и дублирование:**
- `growth-view.js` и `dashboard.js` — упоминания тарифа «Старт» и запасные суммы;
- `kaspi-relay/license-signature.js` — дубль `shared/license-signature.js`;
- `saas-core-template/` дублирует ядро биллинга и отстаёт от основного проекта.

## 17. Фактическое использование моделей в этом этапе

| Роль | Модель | Что сделано |
|---|---|---|
| Обнаружение | Haiku (`Explore`, `model: haiku`) | 31 вызов инструментов, ~179 тыс. токенов, ~196 с; карта по 15 темам |
| Валидация и Git | Sonnet 5.5 (`claude-sonnet-5-5`, основная сессия) | проверка правил и агентов, статус Git, точечная перепроверка 12 пунктов, запись документа |
| Opus | не вызывался на этом этапе | — |

До этого этапа в сессии использовались и другие модели (Haiku, Sonnet, Opus 5.5 — для анализа рынка и планирования). Два агента Sonnet прервались по лимиту, результат их работы — 16 незакоммиченных путей из раздела 1.
