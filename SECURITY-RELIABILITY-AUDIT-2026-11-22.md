# Аудит безопасности и надёжности — SaudaPulse (kaspi-seller-hub), 2026-11-22

Ветка: `claude/magical-maxwell-6yq76b`. Боевой проект Supabase: `zraktrilvwrfpcbmkqwi` (второй проект не затрагивался). Ни одна миграция на живую БД НЕ применялась.

## 1. База данных / RLS / права
Проверено (read-only): RLS включён на всех таблицах public; политики только `accounts_read_own`, `invoices_read_own` (SELECT своих строк); у `anon` нет грантов на таблицы; у `authenticated` только SELECT на `accounts`, `invoices`. `bot_*`/`ops_digest` доступны только `service_role` (017).
Advisors: WARN `get_service_status` доступна anon (намеренно, 017); WARN 58 SECURITY DEFINER-функций доступны `authenticated`, включая все `admin_*` (защита внутри через `is_admin()`); WARN выключена защита от утёкших паролей; INFO `rls_enabled_no_policy` на 20 серверных таблицах; perf INFO — 11 неиспользуемых индексов.
Находки и исправления (`kaspi-seller-hub/billing/supabase/020_security_hardening_fixes.sql`, идемпотентна, применять строго ПОСЛЕ 019):
- (a) `admin_confirm_invoice`: реферальная награда теперь только для не-addon счетов; не выдаётся, если пригласивший заморожен (`frozen_until`), заблокирован (`trial_blocked`) или удалён. Условие «первый оплаченный счёт» считает только не-addon оплаты (иначе докупка магазинов до подписки навсегда лишала бы награды). Проверка `is_admin()` и `greatest(now(), paid_until, trial_ends_at) + 14 дней` сохранены.
- (b) `invoices`: клиент никогда не читает таблицу напрямую (только RPC `get_license`, который уже вырезает `admin_note`/`confirmed_by`; grep по клиентскому коду подтвердил). Поэтому в 020 отозван табличный SELECT у `authenticated` и выдан column-level SELECT без `admin_note`, `confirmed_by`, `account_ref`.
- (c) Все 23 определения `admin_*` в миграциях 001–019 проверены: каждое содержит `is_admin()`. Исправлений не потребовалось.
- (d) В 020 повторно закреплены revoke: `tg_outbox` (+sequence), `gen_referral_code`, INSERT/UPDATE/DELETE на `accounts` для anon/authenticated.
Живая БД: миграция 019 НЕ применена (нет реферальных колонок, `tg_outbox`, `apply_referral_code`, `my_referral`; `admin_confirm_invoice` в версии до 019), 020 тем более. Рекомендация: после ревью применить 019, затем 020 через Supabase. В Auth включить Leaked Password Protection (Settings → Auth → Password security).

## 2. Расширение (бэкап/восстановление)
- `dashboard/dashboard.js`: `JSON.parse` с reviver, отбрасывающим `__proto__`, `constructor`, `prototype`; битый JSON — уже дружелюбная ошибка `backupInvalid`.
- `shared/catalog.js` `validateProduct`: зарезервированные SKU (`__proto__`, `constructor`, `prototype`) отклоняются.
- `background/catalog-service.js` `ui:backupImport`: результаты всех записей (`setCosts/Photos/Catalog/Snapshots/Feeds/saveSettings`) проверяются; при любой неудаче (квота) возвращается `{ok:false, error:'quota'}` вместо ложного `ok:true`. Добавлен ключ `errors.quota` в `locales/ru.json` и `locales/kk.json`; дашборд показывает его через `errorText`.
- Остаточный риск: записи не атомарны между собой — при квоте часть данных уже записана (пользователь получает ошибку и подсказку очистить место).

## 3. Telegram-бот (`functions/telegram-bot/bot.js`)
- Элементы с пустым текстом (неизвестный `kind`) раньше пропускались без `bot_sent` и возвращались каждый раз, забивая батч. Теперь подтверждаются как `ok:false, error:'skipped_no_text'` — очередь не голодает.
- `parse_mode` не используется нигде (plain text) — экранирование HTML не требуется и не добавлялось; тест с `<b>&</b> > <` и пустыми данными проходит без падений.

## 4. Релизная сборка
`node tools/build-site.mjs` и `node tools/build-release.mjs` — успешно. Свежий артефакт: `dist/kaspi-seller-hub-0.1.0.zip` = 1 806 487 байт. Старый `dist/saudapulse-chrome-release.zip` (от 09:43, сборкой не обновляется) = 1 804 412 байт; `dist/` не отслеживается git. В архиве нет тестов, SQL, admin, demo, `.env`, `.map`; `console.log` — 0 вхождений, `eval`/`new Function` — 0 в собственном и vendor-коде; `service_role` встречается только в комментарии конфига.

## 5. Тесты
- SQL (`tests/sql/run.sh`, локальный PostgreSQL 16, сокет /tmp:5499; run.sh расширен до 020): 389 passed, 0 failed (17 файлов). Новый `tests/sql/test17.sql` (11 проверок): addon не даёт бонус, подписка после addon даёт +14 дней от now() при просроченном paid_until, замороженный пригласивший не получает награду, не-админ не может подтвердить счёт, продавец не читает `admin_note`/`confirmed_by`, нет доступа к `tg_outbox`/`gen_referral_code`.
- Unit (10): robust 38, locales ALL PASSED (1133 ключей), storage-split 16, token-crypto 7, license-signature 11, license-flow 26, bot-run 9 (+1 новый), feature-flags ok, notices ok, backup 7 (+2 новых: `__proto__`, квота). Все 0 failed.
- НЕ запускались: браузерные e2e (Playwright/Chromium, `tests/e2e/regress.sh`) — вне объёма; поэтому e2e-тесты каталога не перепроверены после правки `validateProduct`.

## 6. Не сделано / ограничения
- 019 и 020 не применены к живой БД (по условию). Живое состояние после применения не проверялось.
- «Заблокирован» для пригласившего трактуется как `trial_blocked`; отдельного статуса blocked в `accounts` нет.
- Массовая замена `console.*` и пр. не выполнялась (в релизе их нет).
