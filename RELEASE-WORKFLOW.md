# Процесс релиза SaudaPulse (kaspi-seller-hub)

## 1. Каждая новая функция — за флагом
- В коде: `if (await isFeatureEnabled('my_feature')) { … }` (`shared/feature-flags.js`; по умолчанию выключено, без сети тоже выключено).
- Заводим флаг в админке, вкладка «Фича-флаги»: `enabled = false`, `allow_emails = ['тестовый email']`.
- Выкатываем постепенно: тестовый email, затем доля клиентов 10% → 50% → 100%, затем `enabled = true`.
- Когда функция стабильна, удаляем флаг и проверку в коде отдельным релизом.
- Флаги — только про интерфейс (UX). Они не подписаны и не являются границей безопасности: платные функции и лимиты остаются на подписанной лицензии и серверных проверках.
- Флаги приезжают вместе с лицензией (`get_license().features`) и обновляются по её расписанию.

## 2. SQL без простоя (Expand & Contract)
1. Expand: сначала добавляем новую колонку / RPC (старое не трогаем).
2. Выпускаем клиент, который работает и со старой, и с новой схемой.
3. Contract: старое удаляем позже, отдельной миграцией, когда старых клиентов не осталось.

Правила:
- Никогда не удаляем и не переименовываем колонки и аргументы RPC за один шаг.
- `create or replace function` сохраняет права (grants).
- Новые аргументы RPC — только со значениями по умолчанию.
- Индексы — `create index concurrently`: нельзя внутри транзакции, поэтому отдельная миграция без `begin;`/`commit;`.
- Существующие миграции не правим; новая — следующий номер (`016_…`).

## 3. Перед слиянием в main
```
cd kaspi-seller-hub
bash tests/sql/run.sh
TZ=America/New_York node tests/unit/robust.test.mjs
node tests/unit/locales.test.mjs
for t in storage-split token-crypto license-signature license-flow bot-run feature-flags; do node tests/unit/$t.test.mjs || break; done
node tools/build-release.mjs
```
Миграции применяем только к проекту Supabase `kaspi-seller-hub` (`zraktrilvwrfpcbmkqwi`).
