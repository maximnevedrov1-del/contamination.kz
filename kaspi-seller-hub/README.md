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

## Release build and anti-tampering

`node tools/build-release.mjs` builds `dist/kaspi-seller-hub-<version>.zip` for the Chrome
Web Store and refuses to build in developer mode, without a licence signing key, with a
service_role key or with test hosts. It strips demo hosts and tightens the CSP
(connect-src: kaspi.kz + your Supabase). Licence dates and limits are read only from the
access token signed by Supabase Auth (ES256, `custom_access_token_hook`), verified with
`BILLING.licenseKeys`; the free trial is bound to hashed Kaspi store ids. Details and
limits: `billing/README.md` → «Защита от взлома».

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
- **Print invoices** opens `dashboard/print.html`, which puts every invoice on its own A4 page and calls `window.print()`.
- HTML invoices are sanitized (no scripts, event handlers or remote resources) and isolated in a Shadow DOM.

**PDF invoices** (Kaspi waybills are PDFs) are rendered page by page with pdf.js, which is bundled in `vendor/pdfjs/` (pdfjs-dist 4.10.38, Apache-2.0), so many waybills print as one job.

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
