# Repair plan after the audit of 22392af

Each stage = its own `claude/repair-N-…` branch from the latest product branch. Each stage goes
through the same order: reproduce → failing regression test → minimal fix → test passes → related
suites → diff review. Every stage stops for review (Manus) and the owner's approval before the next.

## Stage 1 — API-only sync blocker (this branch: `claude/repair-1-apionly-sync`)

Done. See the hand-off message and `tests/e2e/apionly-sync.js`.

## Stage 2 — what a packer can get from the worker

The problem:

- `ui:getState({full:true})` returns every snapshot, ignoring the packer's stores.
- Some pages read `chrome.storage` directly.

Plan:

- Filter **on the data path**, inside the worker:
  - `getState`, `bg:*` broadcasts, print and pick list data, popup — all filtered by `staffGate` /
    the active packer's `shopIds`;
  - no money fields (amounts, profit, payments) and no tokens for a packer.
- Inventory every direct `chrome.storage` read in pages. While a packer is signed in, move them
  behind worker messages.
- Tests:
  - the packer's signed-in page asks for full state, other stores, finances and print data
    through every message → refused or filtered;
  - the owner's view is unchanged.

Limit, stated plainly: a person with access to the shared Chrome profile / DevTools can read
`chrome.storage`. The PIN separates roles in the app, it is not isolation. Real isolation means
separate devices and accounts (stage 7) — an architecture decision for the owner.

## Stage 3 — the token never leaves for another host

The problem:

- `apiRequest()` accepts an absolute URL and adds `X-Auth-Token`.
- `getEntries()` passes `entries.related` from Kaspi's answer without checking it.

Plan:

- One `allowedApiUrl(url)` check: `https:`, the exact origin of `api.base` / `productsBase`, a path
  under the API prefix. Otherwise refuse without sending the token.
- `fetch(…, { redirect: 'manual' })`:
  - a redirect to another origin is an error, not followed with the token;
  - same-origin redirects are followed explicitly, once.
- Waybill downloads checked the same way.
- Tests:
  - the mock answers a `related` link to another host → no request reaches it (a second mock
    server counts hits);
  - a redirect to another host → refused;
  - same-origin → works.

## Stage 4 — Express and deadlines

The problem:

- `toOrderItem()` drops `express`.
- `deadlineOf()` for a new order uses the local acceptance target even when the courier handover
  is earlier.

Plan:

- Keep `express` from the API; show it as a priority mark.
- `deadlineOf()` returns every applicable deadline with its kind and source, then picks the nearest
  one:
  - `accept` (seller's own target);
  - `handover` (Kaspi's `courierTransmissionPlanningDate` for Kaspi Delivery);
  - Express handover when Kaspi gives it.
- The buyer's delivery date is never used as a handover deadline. When there is no known date, there
  is no deadline (no invented one).
- Tests on the mock with Express and non-Express orders, handover before / after the acceptance
  target, and an unknown date.

## Stage 5 — complete and resilient sync

The problem:

- `listOrders()` stops after 50 pages without saying so.
- `fetch` has no timeout.

Plan:

- Paginate until the last page with a hard safety cap. If the cap is hit, the store is marked
  «загружено не всё» with the window to resume from; the next sync continues there.
- Timeout per request (`AbortController`, e.g. 20 s):
  - a timed-out GET is retried by the existing policy;
  - a POST with an unknown result is never repeated automatically — the order is re-read and the
    seller sees «проверьте статус».
- A failed sync always releases the single-flight lock (already `finally`; covered by a test with a
  hanging mock).
- Tests:
  - mock with more than 50 pages;
  - mock that never answers one request;
  - a POST that times out → no second POST in the mock log.

## Stage 6 — analytics consistency

The problem:

- Top products are aggregated over the whole history instead of the selected period.
- Order-content fetch errors can hide behind `status:'ok'`.

Plan:

- Aggregate top products from orders in the selected period (same date rule as the other numbers).
- Keep a per-store «состав заказов загружен для N из M» and show «данные неполные» when N < M.
- Unknown cost or commission stays unknown in profit (shown as «нет данных», not 0). Partly done:
  `orderProfit` has a `complete` flag — verify every total uses it.
- Tests:
  - period switch changes the top products;
  - an entries fetch failure shows «неполные»;
  - unknown cost is not counted as zero.

## Stage 7 — Telegram delivery of every risk

The problem: only the first 10 new risks are sent, although all are marked as seen.

Plan:

- Separate «seen for Chrome» from «delivered to Telegram». An order is marked delivered only after
  the bot function confirms `sent` (or the database says «already sent»).
- Send in batches; leftovers go out on the next sync.
- A failed send is retried (bounded). The Chrome notification does not depend on Telegram.
- Tests:
  - 15 risky orders → 15 messages over two syncs;
  - a Telegram error → retried and delivered later;
  - no duplicates.

## Stage 8 — separate devices for packers (architecture, not a bugfix)

Today:

- The warehouse mode and the packing journal live on one computer.
- The owner's Kaspi tokens never leave the owner's browser.

Options for the owner to choose:

- **Owner's browser as the hub.** It assigns orders and publishes «to pack» lists with no tokens
  and no money to the server; packers' devices read them and post results; the owner's browser
  does the Kaspi calls.
- **Server-side Kaspi access** with encrypted tokens. This changes the privacy promise and needs a
  server.

Not to be done as a small change.

## Stage 9 — release readiness (list, no guessing)

Settings to fill (by the owner, never by guessing):

- Supabase project URL and anon key;
- licence signing public key (JWK);
- the access-token hook enabled;
- run SQL 001–005;
- Kaspi Pay QR;
- legal placeholders `[…]` (address, e-mail, VAT, retention terms);
- site domain and support contacts;
- Telegram bot (BotFather, function secrets, webhook);
- GitHub secrets for the scheduled jobs.

Open questions for a lawyer (Kazakhstan):

- Data localisation (Article 12 of the Law on personal data): where the Supabase database lives.
- Cross-border transfer consent.
- Retention terms.

What goes to the server is listed in the privacy policy:

- accounts;
- invoices;
- price lists, if the automatic upload is on;
- support questions;
- API counts;
- usage counts;
- Telegram digest numbers, if linked.

Never write «no data is sent anywhere».

Before the release:

- a read-only check on a real store;
- the two outdated suites (`billtest`, `hack` — they expect no grace period) updated.
