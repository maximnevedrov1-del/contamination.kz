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

SQL only (each file on a fresh database):

```bash
createdb -h /tmp -p 5499 -U postgres t && psql -h /tmp -p 5499 -U postgres -d t -f tests/sql/stub.sql \
  && psql -h /tmp -p 5499 -U postgres -d t -f billing/supabase/001_billing.sql \
  && psql -h /tmp -p 5499 -U postgres -d t -f tests/sql/test.sql
```

| Suite | What it checks |
|---|---|
| `sql/test.sql` … `test6.sql` | billing, consent, attacks on the database, admin paging, price-list storage rules |
| `e2e/catunit.js` | catalog: XML price list, Excel/XML import, validation |
| `e2e/cattest.js` | product upload: cards to chosen stores, price lists by URL |
| `e2e/billtest.js`, `billtest2.js` | login, consent, trial, invoices, QR window, admin page |
| `e2e/hack.js` | attempts to get the subscription for free |
| `e2e/apitest.js` | Kaspi API mode: orders, accept, pack, waybills |
| `e2e/run2.js`, `demofile.js` | cabinet-tab (demo) mode, printing |
| `e2e/feat.js` | deadlines, profit, pick list |
| `e2e/uxtest.js` | order card, backup/restore, Excel export |
| `e2e/learn.js` | page guides, tour, help GIFs (desktop + phone) |
| `e2e/devices.js` | layout on 10 screen sizes (320–1920 px) |

The mock Kaspi API (`e2e/mockapi.js`) follows the formats in guide.kaspi.kz; it is not Kaspi.
Passing tests do not replace a check on a real store.
