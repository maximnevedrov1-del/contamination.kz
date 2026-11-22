# SaudaPulse — финальный релизный пакет (2026-11-22)

## 1. Хосты (`manifest.json`)
Широкий `https://*.kaspi.kz/*` удалён. Оставлены только:
- `https://kaspi.kz/*` — Shop API (`/shop/api/v2`, `/shop/api/products`) и кабинет `/mc/`
- `https://mc.shop.kaspi.kz/*` — кабинет продавца (детектор `shared/selectors.js`)
- `https://idmc.shop.kaspi.kz/*` — страница входа кабинета (детектор)

Синхронно изменены: `content_scripts.matches`, `shared/selectors.js` (tabMatchPatterns), `dashboard/dashboard.js` (KASPI_ORIGINS), CSP `connect-src` в `tools/build-release.mjs`. Обоснование добавлено в `docs/CHROME-WEB-STORE-SUBMISSION.md`.
Дополнительно: `background/kaspi-api.js` отклоняет запросы (`ApiError('badUrl')`) к origin, отличному от `https://kaspi.kz`, поэтому `X-Auth-Token` никогда не уходит на чужой хост.

## 2. Telegram-бот @SaudaPulse_bot
- `billing/supabase/functions/telegram-bot/bot.js`: на `/webhook` неверный секрет → `401`; невалидный JSON, битый апдейт, ошибки RPC (`bot_link`/`bot_unlink`) → логируются (`console.error`) и возвращают `200 {"ok":true}`. `/alert` и `/run` без изменений.
- Тесты добавлены в `tests/unit/bot-run.test.mjs` (401 / bad JSON → 200 / RPC throw → 200).
- Живая БД `kaspi-seller-hub` (`zraktrilvwrfpcbmkqwi`): `billing_config.bot_username = 'SaudaPulse_bot'` (id=1, без `@`) — подтверждено `RETURNING`.
- ⚠️ Edge-функция `telegram-bot` **не передеплоена** — новая логика webhook вступит в силу после деплоя.

## 3. Бренд
- «Kaspi Seller Hub» → «SaudaPulse» в заголовочных комментариях 41 файла + `.github/workflows/kaspi-seller-hub.yml`.
- `billing/admin/admin.js` placeholder → `SaudaPulse_bot`.
- `site/assets/og.png` перегенерирован (1200×630, `tools/site-shots/og.js`), старый скриншот убран.
- Остатки: `README.md:223` (описание wildcard), скриншоты `site/assets/*.webp` со старым брендом, исторические отчёты в корне.

## 4. ZIP для Chrome Web Store
- `kaspi-seller-hub/dist/saudapulse-chrome-release.zip` — 1 803 262 байт (~1.8 MB), 91 файл; `manifest.json` в корне, без `.map`, `tests/`, `.git`. `dist/` в `.gitignore` (в коммит не входит).

## 5. Тесты
- SQL (`tests/sql/run.sh`, Postgres 16): **354 passed / 0 failed**, 15 файлов.
- Unit (9/9 зелёные): robust 38, locales 1116 ключей, storage-split 16, token-crypto 7, license-signature 11, license-flow 26, bot-run 8, feature-flags ok, notices ok.
