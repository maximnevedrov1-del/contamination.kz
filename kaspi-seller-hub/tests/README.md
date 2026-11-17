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
| `sql/test.sql` … `test6.sql` | billing, consent, attacks on the database, admin paging, price-list storage rules |
| `e2e/catunit.js` | catalog: XML price list, Excel/XML import, validation |
| `e2e/cattest.js` | product upload: cards to chosen stores, price lists by URL, «empty price list» guard, support report |
| `e2e/billtest.js`, `billtest2.js` | login, consent, trial, invoices, QR window, admin page |
| `e2e/hack.js` | attempts to get the subscription for free |
| `e2e/apitest.js` | Kaspi API mode: orders, accept, pack, waybills |
| `e2e/run2.js`, `demofile.js` | cabinet-tab (demo) mode, printing |
| `e2e/feat.js` | deadlines, profit, pick list |
| `e2e/uxtest.js` | order card, backup/restore, Excel export |
| `e2e/photoprint.js` | product photos (order card, cost prices, pick list), waybills at their own paper size (A4 / 100×150 label) at 300 dpi |
| `e2e/learn.js` | page guides, tour, help GIFs (desktop + phone) |
| `e2e/apionly.js` | release build without cabinet mode: no chat, no content scripts, a Kaspi page never creates a store |
| `e2e/devices.js` | layout on 10 screen sizes (320–1920 px) |

The mock Kaspi API (`e2e/mockapi.js`) follows the formats in guide.kaspi.kz; it is not Kaspi.
Passing tests do not replace a check on a real store.
