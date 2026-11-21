# Speed on every front (2026-11-18)

How each number was measured is in the script next to it. Headless Chromium on the test container.
The phone numbers use a 4× slower CPU and network throttling.

## Server (`sqlperf.sh`)

Data size: 10 000 sellers, about 2 years of use.

| call | who / how often | time |
|---|---|---|
| get_license, usage_report, health_report, my_tickets, feedback_due, get_service_status | every extension, every few minutes | **1–6 ms** |
| ops_digest | Telegram job, every 10 min | 76 ms |
| admin_invoices / accounts / tickets / health | admin page | 4–58 ms |
| admin_insights («Пульт»), 30 days | admin page | **0.5 s** (was 3.0 s) |
| admin_insights («Пульт»), 365 days | admin page | **1.0 s** (was 9.7 s, over Supabase's ~8 s statement limit) |

Load from 10 000 sellers is about 20–25 small calls per second.

## Extension (`../load/load.js`, `open.js` with a 250 ms network delay)

| | time |
|---|---|
| dashboard: new tab → Home drawn | 0.37–0.39 s (the network extras are drawn when they arrive and do not delay it) |
| switching sections | 0.06–0.15 s |
| popup | 0.23 s |
| worker asleep → first answer | 0.07 s (awake: 7–9 ms) |
| 25 000 orders: «Заказы» / 90 days / search | 0.14 s / 0.23 s / 0.03 s |
| first load of 5 stores × 5 000 orders | 20 s, then 11.6 s per 5-minute sync |
| dashboard memory | 32 MB |

## Admin page (`open.js`)

| | before | after |
|---|---|---|
| «Пульт» tab | 1.9 s | **0.86 s** (tab counters load in parallel) |
| open | 0.87 s | 0.87 s |

## Landing page (`site.js`)

Phone (Pixel 7, 4× slower CPU).

| | 4G | slow 3G |
|---|---|---|
| first content / largest content (LCP) | **0.38 s** | 1.6 s |
| layout shift (CLS) | 0 | 0 |
| first load | 89 KB, 5 requests | 220 KB |
| repeat visit | 22 KB, 0.24 s | 0.85 s |

## Printing waybills at 300 dpi (`print.js`)

| | before | after |
|---|---|---|
| 50 waybills (A4 / labels) | 7.9 s / 9.3 s | **5.0 s / 6.0 s** |
| 200 waybills (A4 / labels) | 31 s / 39 s | **19 s / 24 s** |
| page memory, 200 labels | 46 MB | **5 MB** |

What changed:

- Each page is encoded with `toBlob` off the main thread, into a blob URL. `toDataURL` blocked
  the page and kept multi-megabyte strings in memory.
- Two PDFs are rendered at a time.
- The empty margins are found on a copy 4× smaller.
- Barcodes stay lossless PNG at 300 dpi.
