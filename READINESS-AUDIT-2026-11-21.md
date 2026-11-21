# Аудит готовности Kaspi Seller Hub — 2026-11-21

Только чтение: код, git и БД не менялись.

# Аудит готовности Kaspi Seller Hub к запуску на 1 000–2 000 клиентов (21.11.2026)
Метод: facts-repo.md, facts-supabase.md, grep/sed, read-only SQL (pg_policies, pg_indexes, pg_extension). Ничего не менялось. Прошлый аудит: готовность ~65%, защищённость ~75%, без багов ~60%.

## Оценки по направлениям
| # | Направление | % | Вес |
|---|---|---|---|
| 1 | Ядро расширения и стабильность | 70 | 20% |
| 2 | Биллинг и БД | 65 | 20% |
| 3 | Безопасность | 72 | 20% |
| 4 | Telegram-бот | 40 | 10% |
| 5 | Платежи | 35 | 15% |
| 6 | Тесты и CI | 55 | 5% |
| 7 | Юр./эксплуатация/релиз | 40 | 10% |
**Итого (взвешенно): ≈ 57%** (0.2*70+0.2*65+0.2*72+0.1*40+0.15*35+0.05*55+0.1*40 = 14+13+14.4+4+5.25+2.75+4).

## 1. Ядро (70%)
+ Лимиты Kaspi: MAX_IN_FLIGHT=4 глобально (kaspi-api.js:60), concurrency=3 на магазин (selectors.js:266), таймаут 30 с (kaspi-api.js:49,113), retry [1500,4000] + Retry-After на 429 (:43,:104-127), circuit breaker 3 отказа/пауза 10 мин (service-worker.js:1150-1152, исп. :479,:675).
+ Хранилище: снапшоты по магазинам (storage.js:120-121), накладные по waybill (:305-306), чат ≤50 тредов (:287), накладные ≤30 дн/500/50 МБ (:375), фото ≤400 КБ/≤40 МБ (photos.js:18-20), unlimitedStorage (manifest.json:30).
− ksh.catalog и ksh.costs — единые большие ключи (storage.js:19,22), без квот/ограничений размера и шардирования; на сотнях тысяч SKU каждая запись переписывает весь объект. Лимит квоты нигде не проверяется (grep "quota" пуст).
− Памяти MV3 service worker: нет данных/замеров -> НЕТ ДАННЫХ / ТРЕБУЕТ ПРОВЕРКИ (heap-профиль на большом магазине).
− Лимитов "overall" (по всем магазинам аккаунта) кроме глобального 4 in-flight нет; дубли фото/каталога не проверены (НЕТ ДАННЫХ).
## 2. Биллинг и БД (65%)
+ Миграции 001-008 применены в Supabase (kaspi-seller-hub, PG17); 22 таблицы, RLS на всех; 41 индекс; 77 функций.
− Дрейф: в БД есть лишняя миграция `001_billing_revoke_fix` (20261121055930), в репозитории её файла нет (только 001-008) -> повторное развёртывание из репо воспроизведёт БД с ошибкой (возможно, вернёт grants). P1.
− RLS: только 2 политики (accounts_read_own, invoices_read_own); 19 таблиц RLS без политик (доступ только через SECURITY DEFINER RPC) — осознанно, но вся авторизация в 58+ функциях.
− Advisors: 12 функций с mutable search_path (WARN), 2 политики с auth.<fn>() без (select ...) (accounts, invoices), 12 неиспользуемых индексов (на пустой БД — норма), 1 FK без индекса, Leaked Password Protection выключена.
− БД почти пустая (1 аккаунт, 1 счёт): нагрузка 1-2k НЕ проверена на проде; есть billing/loadtest и tests/perf/seed.sql (результаты не изучались).
− pg_cron отсутствует; план Supabase/PITR не проверялся (НЕТ ДАННЫХ).
## 3. Безопасность (72%)
+ Токены: AES-GCM 256, non-extractable CryptoKey в IndexedDB, AAD=shopId (token-crypto.js:2,22,46-57).
+ Секреты в репозитории: service_role/sb_secret не найдены; сборка отказывается при service_role (billing/README.md:152); в CI секреты через secrets.*.
+ Лицензия ES256, 2 публичных ключа в billing-config.js:23-38; admin-функции проверяют is_admin() (001_billing.sql:190,468+).
− Ключ шифрования в IndexedDB того же профиля: защищает от чтения storage, но не от вредоносного кода в расширении/XSS; плана ротации ключей нет.
− anon может исполнять 8 SECURITY DEFINER функций (bot_*, get_service_status) — защита только ключом bot_key_ok (см. "Требуется Opus").
− admins: 0 строк — админ-панель не активирована/не проверена в бою.
## 4. Telegram-бот (40%)
+ Блокировка: bot_lock/bot_unlock c TTL 120 с (008_bot_lock.sql:15-30; bot.js:142-148); батч 300 (007:9), чанк 50, бюджет 45 с (bot.js:139); 429 ретрай один раз, 403 = blocked (bot.js:64-79); webhook с секрет-токеном (bot.js:199).
− Edge Function в Supabase НЕ развернута (list пуст), хотя код есть (functions/telegram-bot) -> бот не работает в проде. P0 для канала уведомлений.
− Расписание только через GitHub Actions cron 04:00 UTC (seller-hub-bot.yml:8); GH cron не гарантирует время, может пропускаться; pg_cron нет. Бюджет 45 с при 2k клиентов (батч 300) = несколько прогонов, нужен цикл/повтор — не проверено.
− tg_links/tg_sent: 0 строк — реальных прогонов не было. Дубли при параллельных запусках: lock есть, но TTL 120 с < возможной длительности прогона (риск двойной отправки) -> ТРЕБУЕТ ПРОВЕРКИ. Unit-тестов bot-run нет по счётчику (0), есть e2e telegram.js (10).
## 5. Платежи (35%)
− Автоплатежей/вебхуков нет: только ручной Kaspi Pay (README.md:14,26,28,228; автоподтверждение «later» README.md:417; 001_billing.sql:488 — комментарий). reconcile/autopay кода нет.
− Оператор вручную подтверждает счёт (admin_confirm_invoice). При 1-2k клиентов с ежемесячным продлением: 1000-2000 подтверждений/мес (~35-70/день + поддержка) — главный операционный риск; нет сверки по выписке/импорта платежей.
+ Есть rate-limit check_invoice_rate, ensure_renewal_invoice, grace/offlineGrace 3 дня, trial.
## 6. Тесты и CI (55%)
+ CI (kaspi-seller-hub.yml): jobs run/unit/sql/catalog/browser; SQL-тесты (tests/sql, 12 файлов); e2e по биллингу, поддержке, telegram, growth.
− Unit: robust.test.mjs 39; bot-run, license-signature, token-crypto, storage-split, locales показали 0 по прокси-счётчику (формат тестов может быть другим — проверить, что они реально запускаются). Нет теста на circuit breaker/ретраи/429 (по грепу не подтверждено).
− Нет тестов Edge Function на развёрнутом окружении, нагрузочных результатов в CI, e2e против реального Kaspi (только mockapi). Дубли дерева tests/{apicopy,billcopy,loadcopy,relcopy} — шум.
## 7. Юр./операции/релиз (40%)
− billing-config.js:39-40 offerUrl='' и privacyUrl='' — оферты и политики нет (P0 юридически, также требование Chrome Web Store). :55-58 SUPPORT (whatsapp/telegram/email/hours) пусты — клиенту некуда писать.
+ Бэкапы: seller-hub-db-backup.yml (ежедневно 21:17 UTC, gpg, хранение 30 дней, алерт в Telegram при сбое); ops-alert каждые 10 мин (seller-hub-ops-alert.yml). − Восстановление ни разу не проверено (НЕТ ДАННЫХ); бэкап в GH artifacts (30 дн.); ops-alert зависит от секретов и неразвёрнутой инфраструктуры.
− Релизная сборка: есть сборка с проверкой ключей (README.md:149), но package.json в корне расширения нет, воспроизводимого release-процесса/версионирования/публикации в CWS не подтверждено (НЕТ ДАННЫХ). Подтверждён terms accept (accept_terms), но текст условий не задан.

## Общий вывод: ≈ 57% (с весами выше). Не готов к запуску на 1-2k без P0.

## БЛОКЕРЫ
### P0
1. Заполнить offerUrl, privacyUrl, SUPPORT.* — shared/billing-config.js:39-40, :55-58; опубликовать страницы.
2. Развернуть Edge Function telegram-bot (billing/supabase/functions/telegram-bot), задать секреты WEBHOOK_SECRET/BOT_KEY, прогнать `/run` на тестовом чате; проверить lock TTL против длительности прогона.
3. Платежи: определить процесс/мощность оператора для 1-2k ручных подтверждений либо подключить автоподтверждение (Kaspi Pay API/импорт выписки); минимум — очередь и SLA в admin.
4. Добавить файл миграции `001_billing_revoke_fix` в billing/supabase (устранить дрейф) и проверить чистое развёртывание с нуля.
5. Создать записи в admins и проверить админ-контур в бою (admins=0).
### P1
6. Добавить SET search_path в 12 функций; обернуть auth.uid() в (select ...) в политиках accounts/invoices; включить Leaked Password Protection; индекс на FK.
7. Нагрузочный прогон 2k аккаунтов (billing/loadtest) на реальном проекте, снять результаты; проверить тариф/лимиты Supabase (connections, Auth, PITR).
8. Квоты и размеры ksh.catalog/ksh.costs; замер памяти service worker; обработка QuotaExceeded.
9. Проверить восстановление из бэкапа; перенос бэкапа за пределы GH artifacts.
10. Тесты: убедиться, что unit-файлы с 0 тестов реально выполняются; добавить тесты breaker/429/retry и bot-run.
### P2
11. Заменить GH cron на pg_cron/Supabase scheduled; мониторинг неудачных прогонов.
12. Ротация лицензионных ключей/токен-ключа, документированный release-процесс и версионирование для CWS.
13. Убрать копии tests/*copy из репозитория/CI.

## Узкие места при 1-2k клиентов
- Supabase: refreshMinutes=10 -> 2000 клиентов = ~200 запросов get_license/мин (~12k/ч) без учёта команд и поддержки; нужен jitter/увеличение интервала и проверка лимитов плана. Все права через SECURITY DEFINER RPC — CPU функций, не RLS.
- Бот: батч 300, бюджет 45 с, одна ежедневная выгрузка; при 2k нужны ~7+ чанков и повторные вызовы; один cron-триггер GH; лимиты Telegram ~30 сообщений/с.
- Ручные платежи: см. п.5; любой пропуск = клиент теряет доступ после grace 3 дня, поток тикетов.
- Хранилище расширения: каталог/себестоимости как один ключ у крупных продавцов.

## Требуется Opus
- anon-исполняемые SECURITY DEFINER функции (8 шт., bot_*, get_service_status) + 58 для authenticated: аудит авторизации каждой (bot_key_ok, is_admin) на предмет утечек данных/повышения прав.
- 001_billing_revoke_fix: непонятно, какие REVOKE/GRANT он правит; конфликт прав между репозиторием и БД.
- Гонка bot_lock (TTL 120 с) vs прогон до 45 с+ при крупных батчах — возможна двойная отправка/потеря tg_sent.
- Хранение ключа AES в IndexedDB рядом с зашифрованными токенами — модель угроз.

---

# Приложение A. Факты по репозиторию

# Facts: kaspi-seller-hub (read-only collection)

Repo: /home/user/contamination.kz/kaspi-seller-hub (branch `claude/magical-maxwell-6yq76b`). `git status --short` printed nothing.

## 1. Kaspi limits (background/kaspi-api.js, background/service-worker.js)
- kaspi-api.js:43 `RETRY_DELAYS = [1500, 4000]`
- kaspi-api.js:49 `API_TIMEOUT_MS = 30000`; :113 `AbortSignal.timeout(timeoutMs)`; :261 fetch timeout
- kaspi-api.js:60 `MAX_IN_FLIGHT = 4` (global in-flight cap, :56-75)
- kaspi-api.js:104-127 retry loop: 429 handled via `retryAfter` (:79, :127), other retries via `RETRY_DELAYS` (:118)
- kaspi-api.js:154-159 `pool(jobs, limit)`; :211 `pool(jobs, A().concurrency)`
- shared/selectors.js:266 `concurrency: 3` (per store); service-worker.js:744 `S.api.concurrency || 3`
- service-worker.js:1150 `BREAKER_FAILS = 3`; :1151 `BREAKER_PAUSE = 10 * 60000` (10 min); :1152 `breakerOpen`; used at :479, :675
- service-worker.js:98 `sendToTab` timeout 15000; :361 `runInStore` timeout 30000 (45000 at :901, 30000 at :912)
- service-worker.js:327 `waitForTabReady` uses `S.timing.navigationTimeoutMs`

## 2. Storage
shared/storage.js
- Keys (`KEYS`, :10-26): settings `ksh.settings`, chat `ksh.chat`, lastSync `ksh.lastSync`, apiTokens `ksh.apiTokens` (:17), costs `ksh.costs` (:19), catalog `ksh.catalog` (:22), feeds `ksh.feeds` (:23), imports `ksh.imports` (:24), contentCache `ksh.contentCache` (:25), photos `ksh.photos` (:26); session keys registry/printQueue/deadlineNotified/pickList (:15-21); legacy `ksh.snapshots` (:11), `ksh.invoices` (:13), `ksh.apiEntries` (:18)
- Snapshots split per store: `SNAP_INDEX = 'ksh.snapIndex'` (:120), `SNAP_PREFIX = 'ksh.snap.'` (:121); comment :114-116; legacy read :196-198; write :223-243
- Invoices split per waybill: `INV_INDEX = 'ksh.invIndex'` (:305), `INV_PREFIX = 'ksh.inv.'` (:306); comment :300-302
- Chat: `CHAT_THREADS_MAX = 50` (:287); `pruneChat` (:288); `setChat` (:297)
- Invoice limits: `INVOICE_LIMITS` (:375) = maxAgeDays 30, maxCount 500, maxBytes 50*1024*1024; `pruneInvoiceList` (:376-383)
- Clear-all removes `KEYS.snapshots, SNAP_INDEX, snap keys, KEYS.chat, KEYS.lastSync, KEYS.apiEntries` (:474)
- Other quota constants in storage.js: none found (grep "quota" empty)
- manifest.json:29 `"storage"`, :30 `"unlimitedStorage"`
shared/photos.js
- `MAX_PHOTO_DATA = 400 * 1024` (:18, characters of data: URL); `MAX_PHOTOS_DATA = 40 * 1024 * 1024` (:20); used :28, :68
ksh.catalog / ksh.costs
- ksh.catalog: storage.js:22 only (shared/catalog.js referenced in comment)
- ksh.costs: storage.js:19 (written by worker); background/usage.js:53,60; shared/migrations.js:29 (migration 2); tests/unit/robust.test.mjs:214-246; tests/e2e/uxtest.js:84

## 3. Token encryption (shared/token-crypto.js, shared/storage.js)
- token-crypto.js:2 AES-GCM 256, value format `enc1:<iv b64url>:<ciphertext b64url>` (PREFIX)
- :4-8 key is a non-extractable CryptoKey stored in IndexedDB (store `keys`, :12), not in chrome.storage
- :22 `generateKey({name:'AES-GCM', length:256}, false, ...)`; :25 plain-Node fallback = per-process key
- :34 key stored via IndexedDB `add` (race-safe); :41 `tokenKey` memoized
- :46-48 `encryptToken`: random IV, AAD = shopId
- :53-57 `decryptToken`: AAD = shopId, returns null on failure
- No PBKDF2 / salt / iterations found in token-crypto.js (grep empty)
- storage.js:437 calls `tokenSerial(migrateApiTokens)`; :440 `async function migrateApiTokens()`

## 4. billing-config (shared/billing-config.js)
- :12 `supabaseUrl` filled
- :13 `supabaseAnonKey` filled (~208 chars)
- :16 `refreshMinutes: 10`; :17 `offlineGraceDays: 3`
- :23-38 `licenseKeys`: filled, 2 public EC P-256 JWK objects (lengths not recorded)
- :39 `offerUrl: ''` empty; :40 `privacyUrl: ''` empty
- :55-58 `SUPPORT` whatsapp, telegram, email, hours: all `''` empty

## 5. Migrations (billing/supabase/)
001_billing.sql, 002_team.sql, 003_support.sql, 004_insights.sql, 005_growth.sql, 006_indexes.sql, 007_bot_batch.sql, 008_bot_lock.sql
Also .sql under billing/loadtest/ (9 files), tests/sql/ (12 files), tests/perf/seed.sql, and copied trees tests/{apicopy,billcopy,loadcopy,relcopy}/billing/...

## 6. Edge Functions (billing/supabase/functions/)
- Only `telegram-bot/` (bot.js 222 lines, index.js 7 lines; index.js:7 `Deno.serve`)
- bot.js:5 header lists routes; :198 `/webhook` route, :199 checks `x-telegram-bot-api-secret-token` vs WEBHOOK_SECRET; :9 `/run` scheduled 09:00 Almaty with X-Bot-Key
- Lock: bot.js:142 `rpc bot_lock` (returns busy at :143), :148 `bot_unlock`; comment :136
- Schedule itself lives in .github/workflows/seller-hub-bot.yml:8 (cron `0 4 * * *`)
- No other cron in the function code

## 7. Bot batch / lock
- 007_bot_batch.sql:4 comment (50 messages per record); :9 `batch constant int := 300`; :49 `limit batch`; :51 returns batch
- 008_bot_lock.sql:4 lease note; :7 table `public.bot_run_lock`; :15 `bot_lock(p_key, p_holder, p_ttl int default 120)`; :22 `on conflict` row lock; :30 `bot_unlock`
- bot.js:139 `run(env, f, pause=40, {chunk=50, budgetMs=45000})`; :158 batch; :187 loop break on `items.length < jobs.batch`
- bot.js:64-79 `tg()` call: 429 waited once; 403/400 "chat not found" = blocked

## 8. Auto-payment / webhooks (billing/)
- Only Telegram webhook code (bot.js:101 `webhook`, :198-200)
- Kaspi Pay: manual flow in README.md:14, :26, :28, :228 (remote invoice by hand); README.md:417 says automatic confirmation via Kaspi Pay API is "later" (future text)
- supabase/001_billing.sql:488 comment "Payment received in Kaspi Pay → extend the subscription"; :32 `kaspi_qr_url`
- admin/admin.js:183 manual payment instructions
- grep for reconcile / autopay: no code hits

## 9. CI (/home/user/contamination.kz/.github/workflows/)
- kaspi-seller-hub.yml: triggers `push` (:5), `pull_request` (:7), `workflow_dispatch` (:9); jobs `run` (:15), `unit` (:19), `sql` (:59), `catalog` (:83), `browser` (:101)
- seller-hub-bot.yml: `schedule` cron `'0 4 * * *'` (:8), `workflow_dispatch` (:9); job `morning` (:15)
- seller-hub-db-backup.yml: `schedule` cron `'17 21 * * *'` (:9), `workflow_dispatch` (:10); job `backup` (:16)
- seller-hub-ops-alert.yml: `schedule` cron `'*/10 * * * *'` (:7), `workflow_dispatch` (:8); job `digest` (:14)
- No .github directory inside kaspi-seller-hub/

## 10. Tests (counts = lines matching `\b(test|it)\(`, a rough proxy)
tests/unit: bot-run.test.mjs 0; license-signature.test.mjs 0; locales.test.mjs 0; robust.test.mjs 39; storage-split.test.mjs 0; token-crypto.test.mjs 0
tests/e2e (*.js, excluding *prof* and non-test helpers; counts): apionly 1, apitest 0, billtest 2, billtest2 1, cattest 5, catunit 2, demofile 1, feat 4, growth 7, insights 1, interactive 2, mockapi 1, mocksupa 1, orchestra 1, photoprint 2, reltest 2, run2 2, support 7, team 1, telegram 10, uxtest 4; 0 in devices, fixture, hack, learn, onboard, rate, readonly, uishots, widecheck
Copies of the test tree exist under tests/{apicopy,billcopy,loadcopy,relcopy}/ (not counted).

## 11. Git
- Branch: `claude/magical-maxwell-6yq76b`
- Last 5 commits:
  - 8ea097f Billing: add the project's public ES256 signing keys (signed licence on)
  - 360dc9c Tests: run extension copies in developer mode now that the real Supabase is configured
  - 7a81932 Ignore the local test build zip
  - f06b744 Billing: connect the extension to the kaspi-seller-hub Supabase project
  - 153015e Ignore graphify-out/ (generated code map)

---

# Приложение B. Факты по Supabase

# Supabase facts (read-only collection)

## 1. Projects
- `kaspi-seller-hub`: id `zraktrilvwrfpcbmkqwi`, region eu-west-1, status ACTIVE_HEALTHY, Postgres 17. Selected as the seller hub / billing project.
- Other project in the org: `maximnevedrov1-del's Project`: id `lfadrqgwkjdxkmolhnwi`, ap-south-1, ACTIVE_HEALTHY (not analyzed).

## 2. Migrations (kaspi-seller-hub)
Applied, in order:
- 20261121054828 001_billing
- 20261121055035 002_team
- 20261121055130 003_support
- 20261121055408 004_insights
- 20261121055608 005_growth
- 20261121055641 006_indexes
- 20261121055754 007_bot_batch (present)
- 20261121055850 008_bot_lock (present)
- 20261121055930 001_billing_revoke_fix (name reuses 001; listed after 008)

## 3. Tables (public), RLS and row counts
All 22 tables have RLS enabled.
- billing_config 1 row
- accounts 1
- invoices 1
- consents 1
- store_claims 0
- admins 0
- price_feeds 0
- team_members 0
- service_status 1
- support_tickets 0
- api_health 0
- ops_settings 1
- user_progress 1
- usage_daily 1
- feedback 0
- cancellations 0
- tg_links 0
- tg_link_tokens 0
- tg_sent 0
- digest_stats 0
- bot_run_lock 0

## 4. Edge functions
None (empty list).

## 5. Advisors
Security (5 items):
- [INFO] RLS Enabled No Policy: 19 tables have RLS on with no policies
- [WARN] Function Search Path Mutable: 12 functions
- [WARN] Public Can Execute SECURITY DEFINER Function (anon): 8 functions, including bot_* RPCs and get_service_status
- [WARN] Signed-In Users Can Execute SECURITY DEFINER Function: 58 functions
- [WARN] Leaked Password Protection Disabled: 1

No ERROR-level items.

Performance (3 items):
- [INFO] Unindexed foreign keys: 1
- [WARN] Auth RLS Initialization Plan: 2 policies (accounts, invoices)
- [INFO] Unused Index: 12

No ERROR-level items.

## 6. Functions (public, pg_proc)
Count: 77. Names include: accept_terms, admin_* (accounts, cancel/confirm invoice, config, grant_days, growth_settings, health, insights, invoices, ops_settings, set_status, ticket_reply, tickets, update_config), alert_create, billing_price, bot_jobs, bot_key_ok, bot_link, bot_lock, bot_sent, bot_unlink, bot_unlock, can_write_feed, cancel_flow, cancel_my_invoice, check_invoice_rate, clean_shop_ids, coverage_end, create_invoice, custom_access_token_hook, digest_report, discount_now, discounted, ensure_account, ensure_price_feed, ensure_renewal_invoice, feedback_due, feedback_submit, get_license, get_service_status, grace_until, handle_new_user, has_access, has_access_of, health, health_report, health_window, insight_keys, is_admin, my_tickets, normalize_phone, ops_digest, outage_fails, phone_or_account, plan_stores, request_store_addon, resume_subscription, set_my_phone, start_trial_boost, team_check, team_invite, team_join, team_list, team_remove, team_row, team_set_enabled, team_update, tg_link_create, tg_settings, tg_status, tg_unlink, ticket_close, ticket_create, ticket_json, ticket_seen, upgrade_quote, usage_report, usage_summary.

## 7. pg_cron
`cron.job` does not exist: NO pg_cron jobs. The query failed with 42P01 (relation "cron.job" does not exist). Recorded as absent.
