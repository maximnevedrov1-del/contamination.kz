# Публикация в Chrome Web Store: что вставлять в форму

Тексты на английском готовы к вставке (форма CWS на английском). Всё взято из `legal/privacy.html` и релизного манифеста (`node tools/build-release.mjs` → `dist/kaspi-seller-hub/manifest.json`). Политика конфиденциальности: **https://saudapulse.kz/privacy**

Релизный манифест: permissions `tabs`, `storage`, `unlimitedStorage`, `notifications`, `alarms`; hosts `https://kaspi.kz/mc/*`, `https://*.kaspi.kz/*`. `activeTab` убран (в коде не используется); `scripting`, content scripts, localhost и `file:` релизная сборка вырезает.

## 1. Single purpose

```
SaudaPulse helps a Kaspi.kz seller manage their own store in one dashboard: view orders, returns, catalog, prices, stock, costs, chat messages and print waybills, across several stores. All features serve this single purpose.
```

## 2. Permission justifications

**tabs**
```
Used to find and focus the seller's already open Kaspi.kz Merchant Cabinet tabs, to open the extension's own dashboard/print pages in a tab, and to detect when a tab leaves kaspi.kz (tabs.onUpdated URL change) so we stop treating it as a store tab. We do not read tab content or browsing history of other sites.
```

**storage**
```
Stores settings, cached store data (orders, catalog) and the Kaspi API token (encrypted with AES-GCM, non-extractable key) locally in the browser.
```

**unlimitedStorage**
```
Cached order/catalog data and product photos for sellers with large catalogs can exceed the default 10 MB quota. All data stays on the user's device.
```

**notifications**
```
Shows desktop notifications about new orders and urgent events (opt-in settings).
```

**alarms**
```
Schedules periodic background sync of orders and reminders in the Manifest V3 service worker.
```

**Host permission `https://kaspi.kz/mc/*`**
```
The extension calls the Kaspi Merchant Cabinet API on behalf of the seller (with the seller's own token) to read orders, catalog and update prices/stock, and opens the seller's cabinet pages. No other site is accessed.
```

**Host permission `https://*.kaspi.kz/*`**
```
Kaspi serves the merchant API and product images from several kaspi.kz subdomains (the seller cabinet and API hosts). The wildcard covers only subdomains of kaspi.kz that the seller's own cabinet uses. No other domains are accessed.
```
Заметка: подстановочный `*.kaspi.kz` ревьюер может спросить. Если известен точный список поддоменов API, сузить до них (проверить в `shared/selectors.js` → `tabMatchPatterns` и в CSP `connect-src`) и поправить `manifest.json` + `tools/build-release.mjs`.

**Remote code: No.** Весь код в пакете, `script-src 'self'`, нет `eval`/`new Function` (CI это проверяет). Отметить «No, I am not using remote code».

## 3. Privacy practices (Data usage)

Правило: «collected» = передаётся с устройства на наш сервер. Всё, что хранится только в браузере (токен Kaspi API, заказы, каталог, себестоимость), собранным не считается.

| Категория в форме | Отметить? | Почему (по privacy.html) |
|---|---|---|
| Personally identifiable information | **Да** | email (аккаунт, коды входа), телефон (счета Kaspi Pay), имя участников команды |
| Health information | Нет | не собираем |
| Financial and payment information | **Нет** (спорно) | данные карт не получаем; платёж идёт в Kaspi Pay. Сумма и номер счёта подписки — не платёжные данные пользователя. Если ревьюер возразит, отметить и пояснить |
| Authentication information | **Нет** | токен Kaspi API зашифрован и хранится только локально, на сервер не передаётся. Код входа по email — обычная авторизация в наш аккаунт; если сомнительно, отметить |
| Personal communications | **Да, если считаете обращения** | тексты обращений в поддержку (email, текст, по желанию диагностический отчёт). Чат покупателей Kaspi остаётся в браузере |
| Location | Нет | IP фиксируется только в журнале согласий (юридическое доказательство), геолокацию не используем |
| Web history | Нет | историю не читаем |
| User activity | **Да** | счётчики использования по дням без идентификаторов магазинов, счётчики состояния API |
| Website content | **Нет** | содержимое страниц Kaspi читается и обрабатывается локально; на сервер уходят только SHA-256 хэши идентификаторов магазинов и (при включённом Telegram) цифры сводки |

Пояснение к «Personally identifiable information»: email, phone number, team member names. Используются для аккаунта и счетов, не продаются.

Три сертификации (поставить все три галочки):
- I do not sell or transfer user data to third parties, outside of the approved use cases (хостинг Supabase, Telegram по желанию пользователя, сервис отправки писем: это обработчики).
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

## 4. Instructions for reviewers (шаблон)

Демо-режим (`demo/` + `localhost`/`file:`) в релизную сборку **не входит**: его вырезает `build-release.mjs`. Ревьюер без кабинета Kaspi в расширении ничего не увидит, поэтому нужны видео и тестовые доступы.

```
SaudaPulse is a tool for Kaspi.kz sellers; most features need a Kaspi Merchant Cabinet account and API token, which reviewers normally do not have.

1. Video walkthrough of all features with a real (anonymised) store: <вставьте ссылку на видео>
2. Test account: <вставьте email тестового аккаунта SaudaPulse; вход по коду на email, поэтому приложите способ получить код, например общий ящик>. Test Kaspi store access: <вставьте, если есть тестовый кабинет Kaspi, иначе удалите строку>.
3. How to use: install, click the extension icon, open the dashboard, sign in with email (a one-time code is sent), connect a store (Kaspi API token) and press Refresh.
4. The extension reads data only from kaspi.kz and our backend (Supabase, EU). Privacy policy: https://saudapulse.kz/privacy
5. Support: Telegram @SaudaPulse
```

К заполнению владельцем: ссылка на видео (поле выше), тестовый аккаунт (создать заранее и держать подписку активной), способ получения кода входа для ревьюера.

## 5. Советы по карточке

- Не использовать логотип и товарный знак Kaspi в иконке, скриншотах и названии. Название «SaudaPulse», не «Kaspi …».
- В описании и на сайте: «Не аффилирован с Kaspi.kz и не одобрен им. Kaspi — товарный знак его владельца» (EN: «Not affiliated with, endorsed by or sponsored by Kaspi.kz. Kaspi is a trademark of its owner.»).
- Скриншоты 1280x800 на демо-данных, без реальных клиентов, телефонов и адресов.
- Описание: что делает, какие данные хранятся локально, что уходит на сервер (кратко, как в политике); ссылка на политику и контакты поддержки.
- Версия в `manifest.json` выше предыдущей; перед отправкой прогнать `node tools/build-release.mjs` и загружать `dist/kaspi-seller-hub-<версия>.zip`.
