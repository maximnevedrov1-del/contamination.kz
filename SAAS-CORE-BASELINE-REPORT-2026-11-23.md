# saas-core-template v1.0.0: отчёт о базовой версии (2026-11-23)

Тег: `saas-core-v1.0.0`. Ветка: `claude/magical-maxwell-6yq76b`.

## Синхронизация с SaudaPulse 0.1.2 (d116ac2)

| Пункт | Статус |
|---|---|
| Миграции 001-026 | полный набор; `run.sh` применяет до 026 |
| 026, test22, test23 | идентичны kaspi-версии |
| admin.js / admin.css | баннер очистки и строгие ожидаемые значения |
| grants.sql | отличается только комментариями в заголовке |

## Исправленные утечки продукт-специфики

| Файл | Что сделано |
|---|---|
| admin/admin.js:444 | «данных Kaspi» -> «данных маркетплейса» |
| admin/admin.js:701 | placeholder `https://example.com` |
| supabase/grants.sql:117, migrations/024 | нейтральные комментарии |
| migrations 002,006,007,008,019,020,021,022,024,026 | заголовок «Seller Hub» -> «SaaS core» (только комментарии) |
| migrations/017 | ссылка на `github-workflows/ops-alert.yml` |
| tests/sql/test21.sql, tests/unit/ux-telemetry.test.mjs | фикстуры kaspi.kz -> example.com (та же семантика валидации) |

grep `kaspi|seller hub|saudapulse`: остались только защитные проверки пути `kaspi-seller-hub` (README.md:44, scripts/init-new-saas.mjs:9,65).

## Новое

| Файл | Назначение |
|---|---|
| github-workflows/ops-alert.yml | Telegram-дайджест (нужен собственный tools/ops-alert.mjs) |
| github-workflows/db-backup.yml | ежедневный зашифрованный дамп БД |
| NEW-SAAS-QUICKSTART.md | чек-лист запуска нового SaaS |

Init обходит все каталоги (кроме `scripts`), `.yml` в списке текстовых: workflows обрабатываются, новых токенов нет.

## Плейсхолдеры (11)

`APP_NAME`, `APP_SLUG`, `APP_DOMAIN`, `SUPABASE_PROJECT_ID`, `SUPABASE_ANON_KEY`, `CURRENCY`, `CURRENCY_SYMBOL`, `SUPPORT_EMAIL`, `TELEGRAM_HANDLE`, `TRIAL_DAYS`, `LICENSE_PUBLIC_JWK`.

## Тесты

| Проверка | Результат |
|---|---|
| SQL (`npm run test:sql`, PG16) | 505 passed, 0 failed |
| `npm test` | 11/11, 0 fail |
| `init --dry-run` | 68 замен, unreplaced: none (было 60, +8 из workflows) |

## Запуск нового SaaS

```bash
git archive saas-core-v1.0.0 saas-core-template | tar -x && cd saas-core-template
cp saas.config.example.json saas.config.json   # заполнить
node scripts/init-new-saas.mjs --dry-run --config saas.config.json
node scripts/init-new-saas.mjs --config saas.config.json --out ../<APP_SLUG>
# затем по NEW-SAAS-QUICKSTART.md: Supabase, миграции 001->026 + grants.sql, секреты, workflows, bot
```
