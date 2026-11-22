# SaudaPulse: системный баннер, напоминание об окончании, номер счёта, заметки для Chrome Web Store, чистка релизной сборки (22.11.2026)

Добавлено системное объявление для всех клиентов (миграция 016, применена в живую базу), мягкое напоминание за 1–3 дня до окончания подписки или пробного периода, номер счёта с кнопкой «Копировать» в оплате. Подготовлены тексты для Chrome Web Store, релизная сборка стала строже, дописаны разделы про почту и безопасный релиз. Фича-флаги сделаны раньше (коммит `50bf0ed`, миграция 015); баннер — отдельная миграция 016.

## Изменённые файлы

| Файл | Что изменено |
|---|---|
| `kaspi-seller-hub/billing/supabase/016_system_banner.sql` | новая миграция: колонки баннера, `system_banner()`, патч `get_license`, admin-RPC |
| `kaspi-seller-hub/tests/sql/test15.sql`, `run.sh` | новый SQL-тест (14 проверок), миграция 016 в цепочке |
| `kaspi-seller-hub/shared/notices.js` | новый: `bannerFrom`, `expiryNotice` |
| `kaspi-seller-hub/tests/unit/notices.test.mjs` | новый unit-тест |
| `kaspi-seller-hub/background/billing.js` | `licenseView.systemBanner` |
| `kaspi-seller-hub/dashboard/dashboard.js` | баннеры в `renderBanners()`, `invoiceNumber()` в карточке счёта и окне оплаты |
| `kaspi-seller-hub/locales/ru.json`, `kk.json` | раздел `notices` (9 ключей) |
| `kaspi-seller-hub/billing/admin/admin.js` | блок «Объявление в расширении» во вкладке «Фича-флаги» |
| `kaspi-seller-hub/manifest.json`, `legal/privacy.html`, `legal/terms.html`, `README.md` | убрано `activeTab` |
| `kaspi-seller-hub/docs/CHROME-WEB-STORE-SUBMISSION.md` | новый |
| `kaspi-seller-hub/tools/build-release.mjs` | фильтр `*.map`/tests, расширенная финальная проверка |
| `.github/workflows/kaspi-seller-hub.yml` | `notices` в цикле unit-тестов |
| `RELEASE-WORKFLOW.md` | разделы 4 и 5, `notices` в списке тестов |

## Пункт 1. Системный баннер (миграция 016)
- В `ops_settings`: `banner_active`, `banner_text` (до 300), `banner_type` (info/warn/danger), `banner_updated_at`.
- `system_banner()` (внутренняя, закрыта для клиентов) отдаёт `{active, text, type}`; активен только при включении и непустом тексте.
- `get_license` дополнен ключом `system_banner` (замена подстроки, ровно одно вхождение, как в 015); старые ключи на месте.
- `admin_set_system_banner` и `admin_get_system_banner`: только админ, проверка типа и длины, текст обязателен для активного баннера.

## Пункт 2. Клиент
- `licenseView.systemBanner` приводится к `{active:false}`, если данных нет или они некорректны.
- Системный баннер выводится первым (`textContent`, не `innerHTML`), затем напоминание «Пробный период/Подписка истекает через N дн.» (`banner--warn`) с кнопкой «Продлить» (`#pay` при неоплаченном счёте, иначе `#account`).
- Дубля нет: готового баннера за ≤3 дня не было. Существовали только пункт «to-do» на Главной для триала (≤5 дней), автоокно оплаты и `planNotice` (grace/frozen/cancelled). Они сохранены, новый баннер их дополняет.
- Казахские тексты добавлены; тест локалей: 1116 ключей совпадают.

## Пункт 3. Админка
Блок над таблицей флагов: чекбокс, тип, текст (до 300), «Сохранить»; загрузка через `admin_get_system_banner`.

## Пункт 4. Номер счёта
В карточке счёта и окне оплаты: «Номер счёта: № N» крупно, кнопка «Копировать» (clipboard, тост «Скопировано»), инструкция по оплате. Автоматическое сопоставление не обещается: оплату подтверждает админ вручную.

## Пункт 5. Chrome Web Store
- `activeTab` удалён: ни `activeTab`, ни `scripting` в релизе в коде не используются. Юридические тексты и README обновлены.
- `tabs` оставлен: `tabs.query({})` с поиском своей вкладки по URL, `tabs.onUpdated` по `change.url` (без `tabs` URL ухода со Kaspi не виден).
- Документ `docs/CHROME-WEB-STORE-SUBMISSION.md`: single purpose, обоснования, Remote code: No, таблица Data usage, три сертификации, шаблон для ревьюеров, советы по карточке.
- Демо-режим в релиз не входит (вырезается сборкой), поэтому для ревьюеров нужны видео и тестовый аккаунт.
- Обращаю внимание: широкий `https://*.kaspi.kz/*` ревьюер может попросить сузить.

## Пункт 6. Релизная сборка
- `cpSync` с фильтром: `*.map` и каталоги `tests`/`__tests__` не копируются.
- Финальная проверка падает при `.map` и при `console.log(`/`console.debug(` вне `vendor/`.
- Проверки `hostname === 'localhost'` (`service-worker.js:879`, `dashboard.js:602`) оставлены: они требуют совпадения origin с origin зарегистрированного магазина, а в релизе у магазинов только kaspi.kz (localhost и `file:` вырезаны из host_permissions и content scripts). Вреда нет.

## Миграция в живой базе (zraktrilvwrfpcbmkqwi)
016 применена успешно.

| Проверка | Результат |
|---|---|
| колонки `banner_active/text/type/updated_at` в `ops_settings` | есть |
| `get_license` содержит `system_banner`, `features`, `is distinct from` | да |
| `admin_set/get_system_banner`: authenticated / anon | да / нет |
| `system_banner()`: authenticated / anon | нет / нет |
| `system_banner()` сейчас | `{active:false,type:info,text:null}` |

## Тесты

| Набор | Результат |
|---|---|
| SQL, всего (15 файлов) | 354 passed, 0 failed |
| из них `test15.sql` | 14 passed |
| robust (TZ=America/New_York) | 38 passed |
| locales | 1116 ключей, ok |
| storage-split / token-crypto / license-signature / license-flow / bot-run | 16 / 7 / 11 / 26 / 5 |
| feature-flags, notices | ok |
| `node --check` по всему JS | ok |

## Аудит dist
`node tools/build-release.mjs` прошла. `.map`: 0. `console.log/debug` вне `vendor/`: 0. Релизные permissions: `tabs, storage, unlimitedStorage, notifications, alarms`. Хосты: kaspi.kz/mc/*, *.kaspi.kz/*.

## Что осталось
- Видео для ревьюеров и тестовый аккаунт (поля в шаблоне помечены `<вставьте ссылку на видео>`).
- Решить по подстановочному хосту `*.kaspi.kz` и по категориям в Data usage (спорные помечены в документе).
- DNS (SPF, DKIM, DMARC) и прогрев почты выставляет владелец, см. `RELEASE-WORKFLOW.md`, раздел 4.
- Расширение не пересобиралось в ZIP для магазина после изменений: собрать перед загрузкой.
