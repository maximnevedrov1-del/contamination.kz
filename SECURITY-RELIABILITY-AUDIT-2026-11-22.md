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
- 019 и 020 пока не применены к живой БД. Пользователь дал команду применить; попытка применить 019 через Supabase MCP прервалась по таймауту (230 с): сервер запросил подтверждение, ответа не было. Частично ли применилась 019, не проверено. 020 не запускалась. Живое состояние после применения не проверялось.
- «Заблокирован» для пригласившего трактуется как `trial_blocked`; отдельного статуса blocked в `accounts` нет.
- Массовая замена `console.*` и пр. не выполнялась (в релизе их нет).

## 7. Сводка по 6 векторам

| # | Вектор | Итог | Где исправлено |
|---|--------|------|----------------|
| 1 | XSS через `?ref=` на сайте | Уязвимости нет: `/^SP-[A-Z0-9]{6}$/`, try/catch вокруг `localStorage`, только `textContent` | — |
| 2 | Накрутки и гонки в рефералке | `apply_referral_code`: `FOR UPDATE`, `upper(btrim())`, проверки формата, самоприглашения, повтора и окна 7 дней, без PII. Бонус +14 дней считается от `greatest(now(), paid_until, trial_ends_at)`. Исправлено: бонус за оплату дополнительных магазинов; бонус замороженному или заблокированному пригласившему; доступ продавца к `admin_note` и `confirmed_by` в счетах | `020_security_hardening_fixes.sql`, `tests/sql/test17.sql` |
| 3 | `tg_outbox` и Telegram-бот | `tg_outbox` закрыт RLS и REVOKE. HTML-режима в боте нет. Исправлено: уведомление с пустым текстом отмечается пропущенным и не забивает очередь | `functions/telegram-bot/bot.js`, тест bot-run |
| 4 | Импорт JSON-бэкапа | Исправлено: ключи `__proto__`, `constructor`, `prototype` отбрасываются, такие артикулы отклоняются; при переполнении хранилища показывается ошибка quota, а не «восстановлено» | `dashboard/dashboard.js`, `background/catalog-service.js`, `shared/catalog.js`, `locales/*.json` |
| 5 | Релиз и манифест | В архиве нет тестов, секретов, `console.log` и `eval`. `externally_connectable` только `https://saudapulse.kz/*` и `https://*.saudapulse.kz/*` | — |
| 6 | Сборка и пуш | Сайт и релиз собраны. Коммит `4d80f47` запушен в `claude/magical-maxwell-6yq76b` | — |

## 8. Статус живой БД `zraktrilvwrfpcbmkqwi`

- Применены 017 (`bot_*` и `ops_digest` доступны только `service_role`) и 018 (триал 14 дней).
- 019 и 020 не применены: попытка применить 019 прервалась по таймауту подтверждения. Порядок применения: 019, затем 020, затем повторная проверка прав и Advisors.
- Перед применением сверено: живая `admin_confirm_invoice` совпадает с базой 019; зависимости `coverage_end`, `grace_until`, `has_access_of`, `tg_links` на месте.
- Клиентам вне `service_role`: `anon` не имеет прав на таблицы; `authenticated` может только читать `accounts` и `invoices`, без записи.
- Ручное действие: включить Leaked Password Protection в настройках Auth.

## 9. Итоговые цифры

- SQL-тесты: 389 пройдено, 0 упало (17 файлов, локальный PostgreSQL 16).
- Unit-тесты, 0 упало: robust 38, locales (1133 ключа), storage-split 16, token-crypto 7, license-signature 11, license-flow 26, bot-run 9, feature-flags ok, notices ok, backup 7.
- Браузерные e2e-тесты (Playwright) не запускались.
- Архив: `dist/kaspi-seller-hub-0.1.0.zip`, 1 806 487 байт. `dist/saudapulse-chrome-release.zip`, 1 804 412 байт: старая сборка, скрипт его не пересоздаёт.
