# Tests

Everything runs locally: real Chromium with the extension loaded, a mock Kaspi API, a mock
Supabase that runs the **real** `billing/supabase/001_billing.sql` on a local PostgreSQL 16.

## Setup (once)

```bash
cd tests/e2e && npm install          # pg driver; Playwright + Chromium must be installed
# PostgreSQL 16 listening on the unix socket /tmp, port 5499, user postgres
```

## Run

```bash
tests/e2e/regress.sh                 # all browser suites, each on a fresh DB and fresh mocks
```

Without a browser (also run by CI, `.github/workflows/kaspi-seller-hub.yml`):

```bash
TZ=America/New_York node tests/unit/robust.test.mjs   # KZ time, retries, price-list guard, migrations, error journal
node tests/unit/locales.test.mjs                      # ru/kk keys and {placeholders} match, no missing keys
PGHOST=/tmp PGPORT=5499 PGUSER=postgres tests/sql/run.sh   # every SQL file on its own fresh database
```

| Suite | What it checks |
|---|---|
| `unit/robust.test.mjs` | Kazakhstan time, Kaspi API retries, price-list drop guard, data migrations, error journal |
| `unit/locales.test.mjs` | Russian and Kazakh texts have the same keys and placeholders |
| `sql/test.sql` … `test10.sql` | billing, consent, attacks on the database, admin paging, price-list storage rules, staff (invite / join / switch off), support (notice, tickets, API health, Telegram key), control panel (usage counts, NPS / exit / «ответ помог?», funnel, cohorts, risk list), plans and retention («Старт»/«Мульти», boost, proration, grace, cancellation offers, freeze, Telegram link/digest/alerts/care/win-back) |
| `e2e/catunit.js` | catalog: XML price list, Excel/XML import, validation |
| `e2e/cattest.js` | product upload: cards to chosen stores, price lists by URL, «empty price list» guard, support report |
| `e2e/billtest.js`, `billtest2.js` | login, consent, trial, invoices, QR window, admin page |
| `e2e/hack.js` | attempts to get the subscription for free |
| `e2e/team.js` | staff: owner invites a packer, first sign-in by code + PIN, scan-to-verify packing, wrong item, switch off, PIN lock, owner unlock |
| `e2e/support.js` | notice for every client, question with the report → answer with a template → notification and badge, API health counts (Kaspi 502), Telegram digest via `tools/ops-alert.mjs` |
| `e2e/insights.js` | «Пульт»: section and action counts + first steps reach the server once, NPS card → answer, «Ответ помог?», «Почему не продлеваете?» inside the blocking payment window, admin panel (tiles, funnel bottleneck, unused sections, quotes, risk list, phone width) |
| `e2e/orchestra.js` | everything together: an expired session + every background job and page request at once (one token refresh, nobody logged out), worker stopped and woken, lost alarms recreated, Kaspi outage and recovery, warehouse lock, another account on the same computer |
| `e2e/telegram.js` | the sellers' bot function against the real SQL and a mock Telegram: one-time link, morning digest template and buttons, alert with the seller's token, care message, blocked bot (403), secrets |
| `e2e/growth.js` | store meter, soft paywall on «Старт» (24 h boost, upgrade with proration), cancellation flow (discount, freeze/unfreeze, cancel/resume), grace days, Telegram card, digest numbers and a real alert after a sync, Kaspi circuit breaker, smart polling |
| `perf/sqlperf.sh` | server timing at scale (10 000 sellers, ~900 000 usage days, 300 000 health rows, 20 000 tickets, 50 000 invoices): every function the extension and the admin page call |
| `perf/open.js` | opening speed with a 250 ms network delay: dashboard first paint, sections, popup, worker wake-up, admin page |
| `perf/site.js` | landing page on a phone over 4G and slow 3G: FCP, LCP, CLS, bytes |
| `perf/print.js` | printing a batch of N waybills at 300 dpi (`N=200 node tests/perf/print.js`) |
| `e2e/apitest.js` | Kaspi API mode: orders, accept, pack, waybills |
| `e2e/run2.js`, `demofile.js` | cabinet-tab (demo) mode, printing |
| `e2e/feat.js` | deadlines, profit, pick list |
| `e2e/uxtest.js` | order card, backup/restore, Excel export |
| `e2e/photoprint.js` | product photos (order card, cost prices, pick list), waybills at their own paper size (A4 / 100×150 label) at 300 dpi |
| `e2e/interactive.js` | Home tiles / store cards / KPIs / chart points and bars open the matching orders; count-up; «reduce motion» |
| `e2e/onboard.js` | «Первые шаги»: 0 of 5 → each button leads to the right place, test print in its tab updates Home, «why the token is safe», ready message for the store owner, closed for good, phone width |
| `load/load.js` | 5 stores × 5 000 orders: load time, requests, storage, every section under budget (see `load/README.md`) |
| `e2e/readonly.js` | «Только чтение»: banner; reads work; accept / pack / publish refused in the UI, by the worker and by the API client; no POST reaches Kaspi |
| `e2e/learn.js` | page guides, tour, help GIFs (desktop + phone) |
| `e2e/apionly.js` | release build without cabinet mode: no chat, no content scripts, a Kaspi page never creates a store |
| `e2e/apionly-sync.js` | synchronisation in the **release build** (API-only, prepared by `e2e/mkrelcopy.sh`): no stores → empty state; one and two token stores load orders without any Kaspi tab; one store 503/401 → its error shown, the other works, its cache kept; six syncs at once → at most one extra cycle, no deadlock; worker restart → stores and alarms back; «Только чтение» → no write reaches the API. Any request to the real kaspi.kz fails the test |
| `e2e/devices.js` | layout on 10 screen sizes (320–1920 px) |

The mock Kaspi API (`e2e/mockapi.js`) follows the formats in guide.kaspi.kz; it is not Kaspi.
Passing tests do not replace a check on a real store.

## Exit codes

Every suite run by `e2e/regress.sh` counts as passed only with **exit code 0 and** `ALL PASS` in its
output; `regress.sh` prints a PASS/FAIL line per suite with its exit code and exits with 1 if any
failed. (Some older suites print `FAIL` without setting the exit code; requiring both covers them.)

## Release build in tests (`e2e/mkrelcopy.sh`)

The real `tools/build-release.mjs` runs on an isolated copy (`tests/relcopy/`) with a made-up but
valid config: an https Supabase address, an anon-role key and the mock Supabase signing key. The
source `shared/billing-config.js` is never changed. `tests/relcopy/dist/kaspi-seller-hub` is the
build as shipped (`apionly.js`). `tests/relmock/` is the same build where only the Kaspi and
Supabase addresses (code, host permissions, CSP connect-src) point at the local mocks; the script
asserts the build's own decisions still hold (cabinet off, no content scripts, no `scripting`).
