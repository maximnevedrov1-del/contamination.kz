# Load test of the extension (5 stores × 5 000 orders)

```bash
cd tests/load
ORDERS=5000 STORES=5 node loadmock.js &      # Kaspi API mock with lots of orders on :8099
node load.js ../apicopy                      # copy of the extension with api.base → http://localhost:8099
RATE429=7 ...                                # same, Kaspi answers 429 to every 7th list request
```

`loadmock.js` serves 400 products and 90 days of orders per store. About 2 % of the orders are
active, and each order has 1–3 lines. It keeps Kaspi's limits: a state filter, ≤ 14 days per
request, ≤ 100 per page, and a 40 ms answer time.

## Results (2026-11-17, headless Chromium, 25 000 orders in total)

| | before | after |
|---|---|---|
| first load of 5 stores | 32 s, 1 794 requests (store 1 downloaded 5×) | **20 s**, each store once |
| «Заказы» (30 days, 8 422 orders) | 6.2 s, 8 422 rows drawn | **0.17 s**, 100 rows per page |
| switch to 90 days (25 000 orders) | 26.5 s | **0.2 s** |
| search | 5 s | **0.03 s** |
| page ← worker state | 1.6 s, 17 MB per message and broadcast | **3 ms**, 2 KB (orders read from storage) |
| order contents for profit / pick list | 60 per sync → ~7 h for 5 000 orders | 300 per sync, 3 in parallel → ~1.5 h |
| other sections | 0.1–0.3 s | 0.06–0.35 s |
| dashboard memory | 38 MB | 30 MB |
| 5-minute sync | 25 s | 11 s (mostly order contents; ~2 s once they are cached) |
| Kaspi busy (429 on every 7th request) | — | all orders loaded, 21 retries, no errors |

Storage: 17 MB of order snapshots for 25 000 orders. The extension has the `unlimitedStorage`
permission.

## What changed

- Tables draw 100 rows per page. Filters, sort, search, «select all» and export still use every
  matching row.
- Sort keys are computed once per row. Dates compare as numbers, with one shared `Intl.Collator`.
  Deadline urgency is cached per row.
- Only one sync runs at a time. A call during a sync waits for it and triggers one more run.
- `ui:getState` and the broadcasts after a sync no longer carry the snapshots. Pages read them
  from `chrome.storage` (`withSnapshots`).
- Order contents: `api.entriesPerSync` = 300 per store and sync, `api.concurrency` = 3 in
  parallel.
