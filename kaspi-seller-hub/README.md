# Kaspi Seller Hub

A Chrome extension (Manifest V3) for Kaspi.kz sellers who run 2–5 stores. It puts orders, returns, refusals, payments, analytics and customer chat from every store into one dashboard, so you don't have to switch between store tabs.

Kaspi has no public API for these operations. The extension works **only inside the seller cabinet tabs you already have open and are logged into**. It doesn't store passwords, doesn't log in for you and loads no remote code. It clicks Kaspi's own buttons only after you click a button in the extension.

## Architecture

```
 Kaspi tab (store A) ─┐  content.js parses the DOM, plus JSON the page itself loaded (network-tap.js)
 Kaspi tab (store B) ─┼─► background/service-worker.js ── tab registry · sync · merge/dedupe · cache
 Kaspi tab (store C) ─┘        ▲            │                command routing · chat polling · badge
                               │            ▼
                      popup / dashboard / print  ◄── chrome.storage.local (snapshots, chat, invoices)
```

- Each Kaspi tab runs `content/content.js`. It identifies the store and parses whatever the page shows. On command it clicks Kaspi's UI (Упаковать, chat send…) and reports any selector it couldn't find.
- The **service worker** keeps a registry of tabs per store in `storage.session`. It asks every tab for a snapshot and merges the results per store, deduplicated by order ID. It caches the result with timestamps. A tab that doesn't answer marks only **its own** store as unavailable.
- Sections that aren't visible right now keep their cached data, marked "from cache". Coverage builds up as you browse the cabinet.
- Bulk actions run **one at a time within a store**, with a pause between actions (`timing.actionDelayMs`), and in parallel across stores.
- Chat polling uses `chrome.alarms` and is passive: it reads the conversation list and **never navigates** a tab. A store tab is navigated only after a user click (Pack, Process, opening a conversation).

## File tree

```
kaspi-seller-hub/
  manifest.json
  background/service-worker.js     tab registry, sync, bulk-action routing, chat polling, notifications
  content/content.js               DOM parsing + command handlers (isolated world)
  content/network-tap.js           read-only observer of the page's own JSON responses (main world)
  dashboard/dashboard.html|js|css  Screen 2: Orders, Returns, Refusals, Payments, Analytics, Chat, Settings
  dashboard/charts.js              dependency-free SVG line & bar charts
  dashboard/print.html|js          A4 invoice print page (PDF waybills via vendor/pdfjs)
  background/kaspi-api.js          official Kaspi Shop API client + mapping to the data model
  vendor/pdfjs/                    pdf.js 4.10.38 (Apache-2.0), bundled locally
  popup/popup.html|js|css          Screen 1: quick status
  shared/selectors.js              ALL selectors, URL templates, status maps (edit this when Kaspi changes)
  shared/i18n.js                   t(), plurals, Intl formatting, ICU fallback
  shared/storage.js                typed chrome.storage wrapper + JSDoc data model
  shared/utils.js                  helpers (dates, debounce, mutex, DOM builder, counters)
  shared/tokens.css                design tokens (light/dark) shared by all pages
  locales/ru.json, locales/kk.json
  icons/
```

Compared with the requested tree, four things were added:
- `network-tap.js`: reads the JSON the page itself receives.
- `charts.js`: the hand-rolled charts.
- `tokens.css`: one set of theme variables for every page.
- `icons/`

## Loading the unpacked extension

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the `kaspi-seller-hub/` folder.
3. Open the Kaspi seller cabinet in a separate tab for each store and log in. If tabs were already open before you installed the extension, they're picked up on the first **Refresh**: scripts are injected on demand.
4. Click the toolbar icon to open the popup, then **Open dashboard**.

Minimum Chrome version is 116 (MV3 module service worker, `world: "MAIN"` content scripts).

## API mode (recommended)

Kaspi has an official Shop API with a **token per store** (cabinet → Настройки → Токен API → «Сформировать»; only the company head can create it). Connect a store in **Settings → Подключение по API Kaspi**: pick an existing store or type a name, paste the token, click **Проверить и подключить**. The token is verified against Kaspi before it is saved.

With a token the store needs **no open cabinet tab**:

| Feature | Via API |
|---|---|
| Orders, returns, refusals | all states, last 90 days on the first sync, then the last 28 days on every sync (older orders stay cached); Kaspi allows ≤ 14 days per request and needs a state filter, so one sync is several requests |
| Payment status | credit awaiting the buyer's signature → pending; bank-approved → paid; cancelled/returned → payment voided |
| Cancellation reasons | Kaspi codes translated (RU/KK) |
| **Принять выбранные** | `ACCEPTED_BY_MERCHANT`, only orders waiting for acceptance; confirmation dialog (irreversible on Kaspi's side) |
| **Упаковать выбранные** | Kaspi Delivery orders that are accepted: `ASSEMBLE` with 1 place, then the waybill PDF is downloaded. Own-delivery orders are refused with a message |
| **Собрать накладные / Печать** | official waybill PDFs, printed via the bundled pdf.js |
| Top products | from order contents (cached; ≤ 60 new orders per sync) |
| Chat, Kaspi's own analytics page | not in the API → still read from an open cabinet tab |

Endpoints follow guide.kaspi.kz (`/shop/api/v2/orders`, list q3201, by code q3202, accept q3211, assemble q3210). They live in `selectors.js › api`.

Security:
- the token is stored only in this browser (`chrome.storage.local`, key `ksh.apiTokens`), is never sent to the dashboard/popup, and is sent only to the API host (a waybill on another host is downloaded without it);
- buyer name, phone and address from the API are not stored;
- **Отключить API** deletes the token; removing a store deletes it too. If a token leaks, re-create it in the cabinet — the old one stops working.

What was verified: against a mock of the API (pagination, 14-day windows, wrong token, accept, assemble → waybill → print, refusals for unsigned credit and own delivery, incremental sync) and read-only against a real store. Accept and assemble were **not** run on a real order.

## Deadlines, profit, pick list

**Deadlines** (column «Срок», filter «Только горящие», 🔥 counter in the sidebar and popup, notification once per order):
- *ship* — Kaspi's planned courier hand-over date (`courierTransmissionPlanningDate`, Kaspi Delivery orders, API);
- *accept* — the seller's own target in Settings › Сроки (default 2 h). Kaspi publishes no fixed acceptance limit, so this is not presented as a Kaspi rule;
- "soon" = within Settings › «Предупреждать за» hours (default 2).

**Profit** (column «Прибыль», section «Товары», Analytics KPIs and a per-store chart):
`profit = revenue − cost price × quantity − Kaspi commission % × revenue − delivery cost for the seller`.
Cost price is entered per SKU (shared by all stores selling that SKU); commission % per category or one default. Orders with a missing cost or commission show «?» and are counted separately — nothing is guessed. Needs order contents, i.e. API stores.

**Pick list** («Сборочный лист» on the Orders toolbar): for the selected orders, or with no selection for every order still to assemble (new / accepted), one A4 table — product, SKU, total quantity, which orders (store colour) need it, a tick box. Orders without known contents (tab-mode stores) are listed separately.

## Subscription, offer and consent

Billing (Supabase, Kaspi QR, invoices) is described in [`billing/README.md`](billing/README.md).
The login screen has a clickwrap consent checkbox linking to the public offer and
privacy policy (`legal/terms.html`, or your own URLs in `shared/billing-config.js` → `LEGAL`).
Acceptance is logged server-side (`accept_terms()`, table `consents`: version, time, IP,
user agent). Raising «Версия условий» in the admin page makes every client accept again.

## Product upload («Выгрузка товаров»)

The seller keeps the whole assortment in the extension and puts products on sale in **all
stores or only the ones ticked**. Two official Kaspi mechanisms are used
(guide.kaspi.kz/partner/ru/shop/api/goods, …/shop/goods/price_list):

- **Product cards** — `POST /shop/api/products/import` (categories, attributes and values come
  from `/shop/api/products/classification/*`), sent with the API token of each chosen store;
  status and result are polled (`/import?i=`, `/import/result?i=`).
- **Price & stock** — a per-store XML price list (`kaspi_catalog`, `offer sku`, `availability
  storeId/stockCount/preOrder`, `price`). It is uploaded to Supabase Storage
  (`pricelists/<secret feed id>/<shop>.xml`, write access only for the owner while subscribed,
  at most as many stores as paid); the seller pastes the URL once in the cabinet
  (Товары → Загрузить прайс-лист → Автоматическая загрузка) and Kaspi re-reads it hourly.

Kaspi takes products **missing** from a price list off sale, so a store's list is only switched on
after the seller imported the current assortment (Kaspi Excel/XML price list) and confirmed it.
Code: `shared/catalog.js` (XML builder, .xlsx/.xml reader), `background/catalog-service.js`,
`dashboard/catalog-view.js`.

## Browsers and devices

| Where | Status | How |
|---|---|---|
| Google Chrome — Windows, macOS, Linux | ✅ main target | Chrome Web Store, `node tools/build-release.mjs` |
| Yandex Browser, Microsoft Edge, Opera, Brave, Vivaldi (desktop) | ✅ same build (Chromium) | install from Chrome Web Store (Opera: "Install Chrome Extensions"; Edge: allow other stores or publish to Edge Add-ons) |
| Firefox desktop / Firefox for Android | 🟡 separate build | `node tools/build-release.mjs --target=firefox` → addons.mozilla.org; passes Mozilla `addons-linter` with 0 errors; not run in a real Firefox yet |
| Yandex Browser for Android | 🟡 possible | installs Chrome Web Store extensions; not tested |
| Safari — macOS, iPhone, iPad | 🔴 needs an app wrapper | `xcrun safari-web-extension-converter` + Apple Developer account + App Store; Safari extensions have no reliable notifications |
| Chrome / Edge on Android, Chrome on iPhone | 🔴 no extensions at all | only a web version (would need a server for orders) |

Cross-browser safeguards in the code: notifications fall back to a plain one where images are not
supported (Firefox) and are skipped where the API is missing (Safari); clipboard fallback; Excel
import tells the user to use XML if `DecompressionStream` is missing; a banner asks for kaspi.kz
access if the browser did not grant it at install time. The dashboard layout is checked on
iPhone SE … Full HD (`320`–`1920` px): no horizontal scroll, menu becomes a slide-in drawer.

## Release build and anti-tampering

`node tools/build-release.mjs` builds `dist/kaspi-seller-hub-<version>.zip` for the Chrome
Web Store and refuses to build in developer mode, without a licence signing key, with a
service_role key or with test hosts. It strips demo hosts and tightens the CSP
(connect-src: kaspi.kz + your Supabase). Licence dates and limits are read only from the
access token signed by Supabase Auth (ES256, `custom_access_token_hook`), verified with
`BILLING.licenseKeys`; the free trial is bound to hashed Kaspi store ids. Details and
limits: `billing/README.md` → «Защита от взлома».

**Cabinet-tab mode and chat are off in the release build** (`shared/features.js`). They rely on
the markup of the seller cabinet (TODO selectors), which has not been checked on a live store.
Without `--with-cabinet` the release:
- ships no content scripts and no `scripting` permission (nothing runs on kaspi.kz pages);
- hides «Чат»;
- never creates a store from an open cabinet tab (such a store would count toward the plan).

Stores connect by API token only. Once the selectors are verified on a real cabinet, build with
`node tools/build-release.mjs --with-cabinet`. Development builds and the tests keep the mode on.

## Demo mode (try it without Kaspi)

`demo/` contains three fake seller-cabinet pages built on the placeholder selectors. They are **not** Kaspi pages; they exist so you can click through every feature before the real selectors are filled in.

1. Load the extension unpacked (see above).
2. **Easiest:** open `demo/mc/store-a.html`, `store-b.html`, `store-c.html` by double-click (in Chrome).
   If the dashboard finds no stores, open `chrome://extensions` → Kaspi Seller Hub → **Details** and turn on **Allow access to file URLs**. Then continue with step 4.
   **Alternative** — serve the demo folder:

```bash
cd kaspi-seller-hub/demo && python3 -m http.server 8080
```

   (no Python? `npx serve -l 8080` in the same folder works too)
3. Open three tabs:
   - http://localhost:8080/mc/store-a.html#/orders
   - http://localhost:8080/mc/store-b.html#/orders
   - http://localhost:8080/mc/store-c.html#/orders
4. Click the extension icon → **Open dashboard** → **Refresh**.

Every action is visible on the demo pages: packed orders change status and get an invoice in the "Накладные" block, chat replies appear in the store's chat.

`http://localhost/*` and `file:///*/mc/store-*` are in `manifest.json` and `selectors.js › tabMatchPatterns` only for this mode. **Remove it before publishing.**

## Adding a store

You don't need to configure anything. When a Kaspi cabinet tab is logged in, the content script reads the store's name and ID (`session.shopName` / `session.shopId` in `selectors.js`). The store appears in **Settings › Stores** with its own colour.

In Settings you can:
- set a short alias;
- change the colour;
- turn a store off (it disappears from every view and from notifications);
- remove it.

To have one cabinet tab per store, log into each store in its own Chrome profile or session, as you do today. The extension works with tabs you already use and doesn't keep its own sessions.

For the chat inbox, it's best to keep each store's chat page open. **Chat › Open chat tabs** opens one pinned background tab per store.

## Editing selectors

Everything that depends on Kaspi's layout lives in **`shared/selectors.js`**. Business logic never contains a selector.

- Each selector is an **array of candidates**, tried in order. Put the new selector first and keep the old ones as fallbacks.
- A candidate starting with `xpath:` is evaluated as XPath; anything else is CSS.
- Field specs look like `{ sel: [...], attr?: 'href', regex?: '(\\d+)' }`.
- `statusMap` / `paymentMap` map Kaspi's status text (RU and KK substrings) to the extension's statuses.
- `urls` holds the routes the extension may open after a click, such as `orderDetails: '/mc/#/orders/{orderId}'`.
- `network` is optional. It maps JSON endpoints the page already calls (regex + dot-paths) onto fields. This is often more stable than the DOM.
- **Every value marked `TODO` is a placeholder.**

Suggested workflow:
1. Open the page in the cabinet and inspect the element.
2. Put the selector into `selectors.js` and bump `version`.
3. Reload the extension at `chrome://extensions`.
4. **Settings › Selector diagnostics** lists every selector that matched nothing, per store.

A missing selector never crashes anything: it's logged to the console with a `[KSH]` prefix and shown in Diagnostics, and the affected section is shown as "not open" for that store.

**Host permissions:** `manifest.json` currently matches `https://kaspi.kz/mc/*` and `https://*.kaspi.kz/*`. Narrow this to the exact cabinet hosts. Change it in three places: `host_permissions`, both `content_scripts[].matches`, and `tabMatchPatterns` in `selectors.js`.

## Safety guarantees in the action code

- **Packing is verified.** After clicking Упаковать the content script waits for proof: the button disappears or is disabled, a success marker or a new invoice appears, or the row status becomes "packed". Without proof the order is reported as failed (`packNotConfirmed`) and stays selected for a retry; successfully packed orders leave the selection.
- **Chat replies go only to a provably correct thread.** A reply is typed only when the open thread's id (`chat.threadId`) equals the conversation id from the list (`chat.conversationFields.id`). If Kaspi exposes no id, conversations get a temporary `~hash` id, they can be read but replies are refused (`conversationIdUnstable`). Configure both selectors before using replies.
- **Status text is matched by the longest substring**, so «Не оплачен» is `failed`, not `paid`.
- **Links scraped from Kaspi pages** are opened only if they stay on the store's own `https` origin.
- **Settings are written only by the service worker** (under one lock), so edits in the dashboard and stores discovered in the background never overwrite each other.

## Invoices and printing

- **Pack selected** clicks Упаковать for each order in its store tab, confirms Kaspi's dialog if one appears, then captures the invoice Kaspi shows.
- Only an invoice that belongs to *this* order is accepted: the link mentions the order ID, it sits inside the order row, or it appeared after the click.
- A link is fetched with the page's own session, and only from the tab's origin or `invoice.allowedOrigins`.
- Invoices are saved to `chrome.storage.local` as `{ orderId, shopId, kind: 'pdf'|'html', data, ts }`. PDFs are stored as data URLs, which is why the extension asks for `unlimitedStorage`.
- **Generate invoices** collects invoices for orders that are already packed.
- **Print invoices** opens `dashboard/print.html` and calls `window.print()`.
- HTML invoices are sanitized (no scripts, event handlers or remote resources) and isolated in a Shadow DOM.

**PDF invoices** (Kaspi waybills are PDFs) are rendered page by page with pdf.js, which is bundled in `vendor/pdfjs/` (pdfjs-dist 4.10.38, Apache-2.0), so many waybills print as one job.

**Every seller has a different printer.** «Настройки → Печать накладных» is chosen once per computer
(`dashboard/print-layout.js`):

| Mode | Printer | Layout |
|---|---|---|
| Как в накладной Kaspi | any | each waybill on its own page size (A4 or label), via named `@page` rules |
| Термопринтер | Xprinter, Godex, TSC… | fitted on a label of the chosen size (100×150, 100×100, 75×120, 58×100 or custom), turned 90° if needed |
| A4 — 1 на лист | office | one waybill per A4 sheet, 8 mm margins |
| A4 — 4 на лист | office | 2×2 per A4, dashed cut lines, for label-size waybills |

**Kaspi's real waybill** (Kaspi Logistics, checked on a real one on 2026-11-18) is a ~100×150 mm
label in the top-left corner of an A4 page. Its barcodes (2× Code 128 and a QR code) are small
1-bit images. In «Термопринтер» and «A4 — 4 на лист» the empty paper is cut off first
(`cropToContent`), so the label prints at its real size. After our processing all three codes
decode at 203 and 300 dpi, identical to Kaspi's original.

The waybill is never redrawn. Kaspi's PDF page is rasterized at 300 dpi and scaled as a whole, so
the number and the barcode stay Kaspi's own.

**Пробная печать** prints a frame of the chosen paper. It has corner marks (nothing cut off), a
50 mm ruler (scale 100 %) and 0.33 mm stripes (barcode sharpness). A link to each original PDF stays
on screen.

**Product photos** (`shared/photos.js`) appear in the order card, «Себестоимость» and the pick list.
The photo for a SKU is the one the seller set (a Kaspi image link or a file resized to ≤ 400 px
JPEG), else the first image from «Выгрузка товаров». Only Kaspi image hosts and local files are
accepted (checked in the worker), and the release CSP allows exactly those hosts.

## Charts (and bundling Chart.js instead)

The charts are hand-rolled SVG in `dashboard/charts.js`, roughly 200 lines with no dependencies. They follow a few rules:
- one y-axis per chart: revenue and orders are separate charts;
- a hover tooltip on every chart;
- each store keeps its colour everywhere;
- a "Table" toggle on every chart as an accessible alternative;
- all labels go through the i18n formatters.

The store palette in `shared/utils.js › STORE_COLORS` is in a fixed order that keeps neighbouring colours distinguishable for colour-blind users. Keep that order if you change it.

If you'd rather use Chart.js, it must be **bundled locally**, never from a CDN:

```bash
npm pack chart.js@4.4.7
```

```bash
mkdir -p vendor && tar -xzf chart.js-4.4.7.tgz -C /tmp && cp /tmp/package/dist/chart.umd.js vendor/chart.umd.js
```

Then load it in `dashboard.html` with `<script src="../vendor/chart.umd.js"></script>` before `dashboard.js`, and replace the `lineChart`/`barChart` calls in `viewAnalytics()`. Pass `formatMoney`/`formatDate` from `i18n.js` as tick and tooltip callbacks so labels follow the language.

## Adding a language

1. Copy `locales/ru.json` to `locales/<code>.json` and translate it. Keep every key.
   - Plural values are objects keyed by `Intl.PluralRules` categories: `one`, `few`, `many`, `other`. Use the categories your language needs (Kazakh only needs `one` and `other`).
   - The `format` block holds month and weekday names, relative-time phrases and the compact-number units. These are used when the browser has no ICU data for the locale.
2. Register the language in `shared/i18n.js › LANGS`, for example `en: { intl: 'en-US', numberFallback: 'en-US', label: 'EN' }`.
3. Add a button to the language switchers in `popup/popup.html` and `dashboard/dashboard.html`, plus an option in `viewSettings()`.

Rules: no hardcoded user-facing strings. Use `t('group.key', vars)` in JS, `data-i18n` / `data-i18n-attr` in HTML, and `formatMoney` / `formatDate` / `formatPercent` / `formatRelative` for values. Message content in the chat is shown as is.

Some Chromium builds advertise `kk-KZ` but ship no data for it, which produces "M10 18" or "KZT 65,000". `i18n.js` detects this by probing the real output. It then falls back to `ru-RU` number grouping (the same convention: `12 345,5 ₸`) and to the month names and phrases in `kk.json`.

## Permissions

| Permission | Why |
|---|---|
| `tabs`, `scripting`, `activeTab` | find Kaspi tabs, inject the content script into tabs opened before install, focus or navigate a store tab after a click |
| `storage`, `unlimitedStorage` | cached snapshots, chat, settings, captured PDF invoices |
| `notifications` | new orders / returns / messages |
| `alarms` | chat polling and background refresh. The worker sleeps, so `setInterval` isn't reliable. Chrome's minimum period is **30 s**, so the setting is clamped to ≥ 30 s. |

## Data model (short)

`storage.js` documents the types in JSDoc. In short:

- `Snapshot` (per store):
  - `{ shopId, shopName, ts, status: ok|noTab|notAuth|error, sections, missingSelectors }`
  - `sections.orders|returns|refusals = { status, source: dom|network|cache, items: OrderItem[] }`
  - `sections.analytics = { data: { kpi, series, topProducts } }`
  - `sections.chat = { items: Conversation[] }`
- `OrderItem`: `{ id, kind, date, status, statusRaw, amount, paymentStatus, paymentRaw, customer?, reason?, url? }`.

Analytics never invents numbers:
- The daily series comes from the store's Kaspi analytics page when it's visible. Otherwise it's calculated from the loaded order list, and the dashboard says which source it used.
- Conversion is shown only when Kaspi shows views.

## Landing page (`site/`)

A static site that presents the extension with real screenshots taken on demo data. The design
follows `DESIGN.md`, the same look as the extension. The page has:
- a scroll story;
- the «5 cabinets → 1 window» animation;
- a tilting product frame;
- a sticky call-to-action on phones;
- FAQ, pricing, a 404 page, `robots.txt`, `sitemap.xml`, an OG image and JSON-LD.

```bash
node tools/build-site.mjs        # → dist/site/ (upload to any static host)
node tests/site/sitecheck.js     # phone / tablet / desktop, dark mode, keyboard, 404
```

At launch, fill in `site/site.config.json` (domain, WhatsApp/Telegram/e-mail, response time,
hours). Blocks whose value is empty are left out of the build, so nothing is shown half-done.

Reviews are hidden in `index.html` (`#reviews`) until there are real ones.

To refresh the screenshots, run `tools/site-shots/shots.js` (with `tests/e2e/mockapi.js`), then
`convert.py` and `og.js`.

## Interactive dashboard

Every number leads to the orders behind it:
- Home tiles (today, yesterday, 7 and 30 days), store cards, and the KPI cards in «Аналитика»
  open the matching list;
- a click on a day in a chart opens that day's orders;
- a click on a store's bar filters the whole dashboard to that store (`drillTo` in
  `dashboard/dashboard.js`).

Effects:
- the 7- and 30-day tiles show sparklines;
- the numbers count up when the dashboard opens;
- cards lift on hover;
- charts draw in once;
- sections cross-fade (View Transitions API).

Plain CSS and SVG, no libraries. Everything is off under «reduce motion».

## Склад: сотрудники-сборщики (stage 1)

Settings → «Сотрудники» and «Режим склада».

- **Invite.** The owner invites a packer by e-mail and picks:
  - the stores the packer may see;
  - whether the packer may press «Принять».

  Server side: `billing/supabase/002_team.sql`, at most 20 people.
- **First sign-in on the warehouse computer.** «Первый вход» → e-mail → code from the letter → the packer sets a 4–8-digit PIN.
  - The PIN is stored only on this computer (PBKDF2, 150 000 iterations).
  - After 5 wrong PINs the sign-in is locked for 15 minutes.
- **Режим склада.** Once the owner turns it on with their own PIN, the extension opens the lock screen.
  - A packer sees only the «Панель сборщика»: the queue of orders to pack for their stores, a scan field, and the «Проблема» button.
  - The worker (`background/staff.js`, `staffGate`) refuses every other action. Hiding buttons is not the protection.
  - The owner unlocks with their PIN for 8 hours.
- **Scan-to-verify.**
  - Scanning the waybill opens the order.
  - Scanning item barcodes ticks the lines; the wrong item gives a red flash and a sound. An unknown code is bound to a product once.
  - When everything is ticked: «Упаковать» → print.
  - Every step goes to the journal (`ksh.packLog`, Settings → «Журнал упаковки»).
- **Switching off.** «Отключить» works at once on the server.
  - The warehouse computer checks every 2 minutes and signs the packer out.
  - With no internet, the packer keeps working for at most 15 minutes.
  - When the owner's subscription ends, packers stop too.

Tests: `tests/sql/test7.sql`, `tests/e2e/team.js`.

## «Первые шаги» (activation)

Most sellers who stop using a tool never reached the useful part. Home shows five steps with
progress until they are done or the seller hides the card (`dashboard/onboarding.js`):

1. connect a store;
2. orders loaded;
3. test print;
4. at least one cost price;
5. backup saved.

Each step has a button to the right place; Settings cards are highlighted when opened this way.

- Steps that leave no trace in the data are marked in `ksh.onboarding`: the test print (or the
  first real waybill print) and the backup. The print tab marks its step and Home updates by itself.
- **Connect dialog:**
  - «Почему давать токен безопасно» — the token stays in the browser and goes only to Kaspi; it
    cannot withdraw money and can be revoked;
  - a ready message for the store owner (WhatsApp / Telegram / copy), because only the owner can
    create the token.

Test: `tests/e2e/onboard.js`.

## Control panel («Пульт»): usage counts and surveys

- **Counts** (`background/usage.js`). Only numbers, per day, KZ time:
  - sections opened (the dashboard sends `ui:usage`);
  - actions used: worker messages in `ACTION_OF`, counted when they succeed, plus Excel export and
    the pick list from the page;
  - the five first steps.

  Every 15 minutes the counts go to `usage_report`, and sent counts are subtracted locally, so
  nothing is counted twice.
- **Surveys** (`dashboard/feedback-view.js`):
  - NPS card on Home (the server decides when: `feedback_due`);
  - «Почему не продлеваете?» on the subscription page and inside the blocking payment window;
  - «Ответ помог?» under support answers.
- **Server side:** `billing/supabase/004_insights.sql`. Admin tab «Пульт»: tiles, risk list,
  funnel with the bottleneck, section and action use, weekly retention cohorts, NPS with
  comments, exit reasons.

Tests: `tests/sql/test9.sql`, `tests/e2e/insights.js`.

## Support without the owner at the computer

- **Notice for every client** (admin page → «Состояние»). The banner is on every dashboard page,
  even before login: the anon RPC `get_service_status`, cached for 5 minutes.
- **«Помощь» → «Написать в поддержку».**
  - The question goes to the server with the technical report attached (`shared/errorlog.js`
    `formatReport`: no tokens, no buyers' data).
  - The owner answers in the admin page («Вопросы», with reply templates).
  - Every 15 minutes the worker checks questions that still wait (`background/support.js`
    `pollTickets`). A new answer gives a Chrome notification, a badge on «Помощь» and a home item.
- **API health counts** (`background/health.js`).
  - Every Kaspi API request ends as «ok» or «failed: auth / rate / server / network / format /
    other» (`setApiObserver` in `kaspi-api.js`).
  - Every 15 minutes only these numbers go to `health_report`.
- **Telegram for the owner.** `tools/ops-alert.mjs` runs from GitHub Actions every 10 minutes and
  reports:
  - outage alerts, when many clients fail at once;
  - recovery;
  - new questions;
  - new invoices.

  Setup: `billing/README.md` → «Уведомления в Telegram». Server side: `billing/supabase/003_support.sql`.

Tests: `tests/sql/test8.sql`, `tests/e2e/support.js`.

## «Только чтение» (testing on live stores)

«Настройки → Только чтение» lets a seller connect working stores without any risk. Orders,
statuses, payments and waybills load as usual, but nothing is changed in Kaspi. The block works
at three levels:
- the worker refuses accept, pack, returns, chat replies, publishing and price-list changes;
- `apiRequest` refuses any non-GET request;
- scheduled price-list uploads stop.

A banner on every page shows that the mode is on.

## Reliability

- **Kazakhstan time.** «Сегодня», day filters, charts and every date shown use UTC+5 (all of
  Kazakhstan since March 2024), not the computer's time zone (`shared/utils.js` → `dayKey`,
  `startOfDay`; `formatDate` in `shared/i18n.js`).
- **Kaspi busy / briefly down.** `apiRequest` retries twice (1.5 s, 4 s; honours `Retry-After`,
  max 10 s). 429 is retried for any call; 502/503/504 and network failures only for reads.
  Writes (accept, assemble, card import) are never repeated automatically: Kaspi may already
  have applied them.
- **Price list cannot empty a store by accident.** If a store's price list would lose all its
  products, or more than half of 10+, the upload is held (`isSuspiciousDrop` in
  `background/catalog-service.js`). The seller gets a notification and a warning in
  «Выгрузка товаров» with the counts, and uploads only after an explicit confirmation. Restoring
  the products lifts the hold by itself.
- **Updates keep the seller's data.** `shared/migrations.js`: stored data carries
  `ksh.dataVersion`. A release that changes the stored format bumps `DATA_VERSION` and adds a
  step. Steps run once, before the worker answers any page. A copy of all data is kept in
  `ksh.preMigration`, and a failed step is resumed on the next start. Data from a newer build is
  never touched.
- **Error journal for support.** `shared/errorlog.js` keeps the last 50 errors of the worker and
  pages on the computer (scrubbed of tokens, e-mails, phones and buyer data). In «Помощь →
  Сообщить о проблеме» the seller copies a plain-text report for the support chat. Nothing is
  sent automatically.
- **CI.** `.github/workflows/kaspi-seller-hub.yml` runs on every push:
  - syntax checks, unit tests and the ru/kk translation check;
  - the eval check, and a check that the release build refuses an empty config;
  - the SQL suite on PostgreSQL 16;
  - the catalog tests in Chromium.

  The full browser regression (`tests/e2e/regress.sh`) still runs locally (see `tests/README.md`).

## Development notes

- No build step: plain ES2022 modules. The content script is a classic script because MV3 content scripts can't be modules.
- Message protocol:
  - UI → worker: `ui:*`
  - worker → content: `ksh:*`
  - content → worker: `content:hello`, `content:update`
  - worker → UI broadcasts: `bg:stateChanged`, `bg:progress`, `bg:chatUpdated`
- Tested in Chromium (headless) against mock store pages built on the placeholder selectors:
  - parsers: 31 unit cases (money, dates incl. ISO/epoch/words in RU and KK, status and payment mapping);
  - end-to-end: popup → dashboard, discovery of 3 stores, logged-out and non-cabinet Kaspi tabs, sorting, 7/30-day and custom ranges, search, keyboard selection, pack success and verified failure, invoice capture and A4 print (HTML and, with pdf.js, PDF), returns processing, payment refresh with navigation, alias/colour/disable/remove store, chat replies (duplicate text, refusal on unstable ids), closed store tab, toolbar badge, re-injection over an orphaned content script, JSON capture via fetch and XHR;
  - ESLint (no-undef, unused vars, unreachable code): clean.
- Real Kaspi markup will need the `TODO` selectors filled in.
