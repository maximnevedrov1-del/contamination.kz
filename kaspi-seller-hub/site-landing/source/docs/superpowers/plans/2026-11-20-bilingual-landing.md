# SaudaPulse — Russian / Kazakh Implementation Plan

**Goal:** Добавить русский и казахский языки во весь текущий лендинг, сохранив восстановленный Express-дизайн.

**Architecture:** Существующие HTML и demo modules сохраняют русские исходные строки и стабильные DOM/data interfaces. Отдельный locale bridge переводит текстовые узлы и доступные подписи по двум проверяемым JSON-каталогам, отслеживает обновления демо без перемонтирования и хранит только выбор языка. Переключатель в шапке доступен на ПК и телефоне; CSS-подписи получают локализованные значения.

**Tech Stack:** Existing Vite / vanilla JS / CSS, Python unittest and Playwright; no new runtime dependency.

**Spec:** Пользователь: «в лендинг встроить казахский язык тоже. он должен иметь два языка»; сохранённый визуальный baseline `7eebb921a55aba4550bedc848c566c7e77e17afc`.

## Constraints and design

- Сохранить лаймовую палитру, шрифт, структуру, цены 12 000 / 25 000 / от 5 000 ₸, все текущие секции и честные ограничения пилота.
- Не менять продукт Claude, IDs, demo state, checkbox state, calculator values, form input or timers when language changes.
- Русский язык по умолчанию; кнопки Русский / Қазақша в шапке. Явный выбор сохраняется только под `marketflow-language`. Заблокированное storage не ломает сайт. Прямая ссылка `?lang=kk` имеет приоритет; неизвестный язык безопасно возвращается к поддерживаемому.
- Перевести навигацию, все секции, тарифы, форму, уведомления, демо-сцены и aria-label/placeholder/title, метаданные и CSS-generated labels. Собственные имена, бренды и числовые значения сохраняются.
- Корректный html lang `ru` / `kk`, активный язык aria-pressed; touch controls ≥44px. На 1440/768/375px не создавать горизонтальный overflow.

## Structure

- `src/locales/kk-part-1.json`, `kk-part-2.json`: Russian-source → Kazakh message catalog, disjoint keys, consistent terms.
- `src/i18n.js`: locale selection, reversible DOM translation, attribute/metadata translation, dynamic updates and persistence with graceful fallback.
- `src/i18n.css`: compact language control and translated generated content; no redesign.
- `src/main.js`: import locale bridge and mount after existing UI/demo wiring only.
- `tests/test_i18n.py`: real-browser language switching, persistence, dynamic demos, data/state preservation, form feedback and responsive controls.

## Implementation

- [x] Write tests and run them before implementation; missing language control must fail quickly.
- [x] Translate the full extracted static/dynamic catalog in two parallel, isolated file responsibilities; preserve API/security disclaimers and every price/quantity.
- [x] Add the locale bridge and header control without replacing application DOM or restarting demos; handle dynamic numeric units, announcements and named form toast.
- [x] Verify focused tests; fix confirmed issues. Run the complete suite and build, diff and route manifest checks.
- [x] Read-only review translation coverage and behavior; save intended source/tests/docs to origin/main after preserving remote changes.

## Review focus

- New scene text and replaced innerHTML stay in the selected language.
- Switching back restores exact Russian baseline, not stale Kazakh fragments.
- Switching language preserves form entries, range values, Express checks and selected demo phase.
- Choice persists on reload; query and denied storage are handled safely.
- Longer Kazakh labels, navigation and hero remain legible on 375/768/1440px.

## Execution evidence

The initial seven tests failed only because the language controls were missing. The final suite passes 38/38 tests (143.526 seconds), including the unchanged Russian demo regressions and WebKit. Both 369-entry dictionaries retain all 738 source keys; JS syntax, Vite build, diff and route manifest checks pass. Automatic Kazakh playback was separately observed advancing all four demo players. Additional responsive checks cover 320–1920px; a confirmed 320px header overflow was pinned by a failing test and fixed with a two-row header only below 360px. A read-only independent review found no functional integration defect; its terminology consistency issue was corrected. Existing demo modules, main styles, pricing/content markup, route manifest and logo metadata remain unchanged. The intended commit is saved through the existing `origin/main` checkpoint flow; no separate publish request is needed with the existing Auto Publish authorization.
