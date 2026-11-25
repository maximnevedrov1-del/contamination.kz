# SaudaPulse Mobile PWA: implementation and verification report

Date: 2026-11-25 · Branch: `claude/magical-maxwell-6yq76b` · Scope: `kaspi-seller-hub/`

## 1. Summary

The phone version of SaudaPulse is built and verified locally. It is **not deployed**: no production
Supabase project and no live site were touched. It runs at `saudapulse.kz/app` with two roles:

- **Owner (Владелец).** Multi-store dashboard: today's revenue, margin, 7-day revenue, new orders and orders to pack. Also the order list and order card, store connection (by token or by an encrypted `.spbackup` file from the computer), and a file for a packer.
- **Packer (Упаковщик).** Packing queue, search by order number, scan-to-verify of product lines, «Собран» / «Принять». No revenue, prices, cost prices, profit, billing or buyer data is stored on the phone or shown in this mode.

All data lives only on the phone, encrypted with AES-GCM 256 under a non-extractable Web Crypto key in IndexedDB. Kaspi does not allow browser calls from other sites (CORS), so the phone reaches Kaspi through a **stateless relay**. The relay forwards one request, logs nothing and stores nothing.

| Check | Result |
|---|---|
| Existing unit tests (17 suites, incl. robust 38, license-flow 35, locales 1171 keys) | **all pass** |
| SQL tests (`tests/sql/run.sh`, 001…033 on PostgreSQL 16) | **663 passed, 0 failed** |
| Extension browser suites rerun: apitest, feat, uxtest, readonly, interactive, onboard, run2 | **all pass** |
| Extension `devices` suite | 320 px overflow on Home/Orders/Products, **identical on untouched `HEAD`** (pre-existing, not caused by this work) |
| New: `secure-storage` (IndexedDB AES-GCM roundtrip, facade, `.spbackup`) | **18/18** |
| New: `kaspi-relay` (allowlist, JWT, rate limit, zero-log, transport) | **14/14** |
| New: `spbackup-ext` (extension worker export/import) | **5/5** |
| New: `e2e/pwa-mobile.js` (390×844, Owner + Packer, real relay handler) | **14/14** |
| New: `e2e/phonecard.js` (extension «Перенести на телефон») | **all pass** |
| Release build (`build-release.mjs`, in a scratch copy) | builds; new files included |
| `dist/kaspi-seller-hub-0.1.2.zip` | **unchanged**: sha256 `e99d3afe…c7e07f` before and after |

## 2. Architecture

```
 Chrome extension (desktop)                         Phone (Safari / Chrome) — saudapulse.kz/app
 ┌──────────────────────────────┐                   ┌─────────────────────────────────────────────┐
 │ background/service-worker.js │                   │ app/js/boot.js → installChromeFacade()      │
 │ background/billing.js ───────┼── same code ──────┤ background/billing.js (OTP, licence, JWT)   │
 │ background/kaspi-api.js ─────┼── same code ──────┤ background/kaspi-api.js                     │
 │ shared/api-sync.js ──────────┼── same code ──────┤ shared/api-sync.js (orders, top products)    │
 │ shared/storage.js ───────────┼── same code ──────┤ shared/storage.js                           │
 │ shared/license-signature.js ─┼── same code ──────┤ shared/license-signature.js                 │
 │ shared/store-key.js ─────────┼── same code ──────┤ shared/store-key.js (double SHA-256)        │
 │ chrome.storage.local         │                   │ shared/storage-adapter.js:                  │
 │                              │                   │   IndexedDB + AES-GCM 256 (non-extractable) │
 └──────────┬───────────────────┘                   └───────┬─────────────────────────┬───────────┘
            │ direct (host permission)                      │ Supabase JWT +          │ OTP / licence /
            ▼                                               │ envelope in POST body   │ team_check
        kaspi.kz/shop/api ◄── X-Auth-Token ── kaspi-relay ◄─┘                         ▼
                                              (stateless: no DB, no logs)     Supabase (unchanged SQL)
   .spbackup file (PBKDF2 600k + AES-GCM) ── moved by the owner (AirDrop / cable / messenger) ──►
```

### 2.1 Shared core and storage adapter (`shared/`)

- **`shared/storage-adapter.js`**: one interface, the `chrome.storage.StorageArea` shape (`get/set/remove/clear` + `onChanged`).
  - The extension keeps the browser's own `chrome.storage` (unchanged).
  - The PWA uses `createSecureArea()` on an IndexedDB backend. Every value is encrypted with AES-GCM 256 and a fresh 12-byte IV. The additional data is `sp-kv:v1:<key name>`, so a record copied under another name does not decrypt. The key is a **non-extractable** `CryptoKey` stored in IndexedDB.
  - `installChromeFacade()` publishes this as `globalThis.chrome.storage`, so `storage.js`, `billing.js`, `kaspi-api.js`, `api-sync.js`, `store-key.js` and `license-signature.js` run **unchanged** on the phone.
  - Kaspi tokens are encrypted twice: `token-crypto.js` (`enc1:`) inside the encrypted record.
- **`shared/api-sync.js`**: `apiSnapshot` / `apiTopProducts` moved **verbatim** out of `background/service-worker.js`. The worker now imports them (diff: 2 lines changed, 82 moved). Both platforms compute orders, returns, refusals and top products the same way.
- **`shared/spbackup.js`**: the `.spbackup` transfer file.
  - Encryption: PBKDF2-SHA-256 with 600 000 iterations and a random 16-byte salt derives an AES-GCM 256 key. The authenticated header (format, version, scope, date, KDF, IV) is the additional data. Changing `staff`→`owner` or lowering the iterations makes the file fail to open. Passphrase is at least 12 characters.
  - Scope `owner` contains stores, tokens, cost prices, profit and deadline settings.
  - Scope `staff` contains stores, tokens and the owner id only. `sanitizePayload` runs on write **and** on read, so a hand-edited staff file cannot bring money data onto a packer's phone.
- **Licence**: `licenseView()` from `billing.js`. The subscription is read only from the ES256-signed access token (`license-signature.js`). Store keys come from `store-key.js`: `SHA-256('ksh:api:' + SHA-256('ksh-api:' + token))`. The same token gives the same store id and the same trial key on the computer and on the phone (tested: importing a file for an already connected token creates no duplicate).
- **Extension side** (`background/spbackup-service.js`, `dashboard/phone-transfer.js`): new Settings card «Перенести на телефон» with three buttons: file for my phone, file for a packer, open a file from the phone.
  - The worker decrypts the tokens and encrypts the file. The page only ever sees ciphertext (tested).
  - Import goes through the extension's own `ui:connectApi`, which checks the token with Kaspi and derives the store id from the token hash.
  - Packers on a «Компьютер склада» cannot call these handlers (not in `STAFF_ALLOWED`). Import requires a licence (`NEEDS_LICENSE`).

### 2.2 Stateless zero-knowledge relay (`billing/supabase/functions/kaspi-relay/`)

- `handler.js` holds the logic. `index.js` is the Supabase Edge Function entry; `worker.js` is a Cloudflare Worker entry with the same handler.
- **Allowlist**: only `https://kaspi.kz/shop/api/v2/…` and `https://kaspi.kz/shop/api/products/…`, methods GET and POST.
  - The URL is checked after WHATWG parsing, so `..`, `%2e%2e`, backslashes, userinfo, ports, subdomains, `http:` and fragments are all refused. Encoded slashes are refused.
  - Anything else returns **403** and nothing is fetched (24 hostile URLs tested).
- **Zero persistence**: no database client, no storage, no cache.
  - The source contains no `console.*`. This is checked statically, and again at run time with every console method trapped to throw.
  - The Kaspi URL, token and body travel **inside the POST body**, never in the URL or headers. The platform request log therefore shows only `POST /functions/v1/kaspi-relay <status>`.
  - Upstream error text is never echoed back.
- **Auth**: a Supabase access token is required.
  - It is verified ES256 against the project's **public** JWKS by the same `license-signature.js` (byte-identical copy, enforced by a test).
  - The audience must be `authenticated`, the role `authenticated`, and `exp` in the future. The anon key, service role, a foreign issuer, an expired token and a wrong signature all return 401.
- **Rate limit**: 300 requests/min per user (`RELAY_RATE_PER_MINUTE`), returning 429 with `Retry-After`. The counter lives only in this instance's memory, nothing is stored.
- **Forwarding**:
  - Only `X-Auth-Token`, `Accept`, `Content-Type` and a fixed `User-Agent` reach Kaspi. No client IP, cookies or Supabase token.
  - Redirects are never followed (`redirect: 'manual'`): a 3xx returns **502**, so the token cannot be carried elsewhere.
  - The answer is streamed back with status, `Content-Type` and `Retry-After`. `Set-Cookie` and all other upstream headers are dropped, and `Cache-Control: no-store` is set.
- **CORS**: `Access-Control-Allow-Origin` is sent only for `RELAY_ALLOWED_ORIGINS` (default `https://saudapulse.kz`). A foreign page origin gets 403.
- **Client**: `shared/kaspi-relay-client.js` wraps `fetch` in the PWA only. `background/kaspi-api.js` runs unchanged (same retries, timeouts and `badUrl` guard). If the user is logged out, no request is sent at all.

### 2.3 Phone app and PWA (`app/`)

- **Files**:
  - `index.html` has a strict CSP: `connect-src 'self' https://<project>.supabase.co`, so the page cannot talk to Kaspi or anywhere else directly. Also `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `referrer no-referrer`.
  - Also: `manifest.webmanifest`, home-screen icons (192, 512, maskable 512, Apple 180), `app.css`, and `js/{boot,config,data,main,turnstile}.js`.
- **`sw.js` caches the app shell only.**
  - It caches exactly the built file list and never intercepts cross-origin, non-GET or `Authorization` requests, or anything outside the shell.
  - Tested: after use, Cache Storage holds 27 shell files and nothing from Supabase, the relay or Kaspi.
- **Mobile UI** (360–430 px):
  - Bottom navigation pinned to the bottom, touch targets of at least 44×44 px (tested for every visible control), no sideways scroll, bottom-sheet dialogs, light and dark theme.
  - All DOM is built with `h()`, with no `innerHTML` for data, so text from Kaspi cannot inject markup.
- **Login**: Supabase e-mail OTP with **native Cloudflare Turnstile** on the page (no iframe).
  - It works like the extension: no site key means no captcha. If the widget fails to load, the code is requested without a token, so nobody is silently locked out.
- **Packer lifecycle**:
  1. The owner invites the packer in the extension (Команда).
  2. The owner makes a «файл для упаковщика».
  3. The packer signs in with their own e-mail and opens the file with the passphrase. `team_join` binds them.
  4. `team_check` runs on start and every 2 minutes.
  5. If the owner switches the packer off, the phone is **wiped**: all records and the encryption key itself (tested). With no server answer for more than 5 minutes, the screen locks.
  - Server-side `shop_ids` restrictions are applied. «Принять» appears only with `can_accept`.
- **Build**: `node tools/build-app.mjs [--turnstile-key=0x…]` writes `dist/app-site/app/` (28 files). It copies the shared modules unchanged into `app/core/` and fills the service-worker shell list and build hash.
  - It refuses to build with an empty config, a secret or service-role key, missing licence keys, or a CSP that does not match the Supabase project or that allows `kaspi.kz` or `*`.

### 2.4 Files

New: `app/**`, `shared/{storage-adapter,spbackup,kaspi-relay-client,api-sync}.js`,
`billing/supabase/functions/kaspi-relay/{handler,index,worker,license-signature}.js`,
`background/spbackup-service.js`, `dashboard/phone-transfer.js`, `tools/build-app.mjs`,
`tests/unit/{secure-storage,kaspi-relay,spbackup-ext}.test.mjs`, `tests/e2e/{pwa-mobile,phonecard}.js`,
`docs/media/pwa/*.png`, this report.

Changed:
- `background/service-worker.js`: import of `api-sync.js`, registration of the `.spbackup` handlers, `ui:spbackupImport` added to `NEEDS_LICENSE`.
- `dashboard/dashboard.js`: one import and one card.
- `locales/{ru,kk}.json`: `phone.*` and 6 `errors.backup*` keys, same in both languages.
- `tests/e2e/regress.sh`: `+phonecard`.
- `.github/workflows/kaspi-seller-hub.yml`: new unit tests, PWA build, syntax check and eval scan for `app/` and the functions.

**No SQL migration was needed.** The PWA uses the existing `get_license`, `team_join` and `team_check`.

## 3. Verification

How to rerun:

```
cd kaspi-seller-hub
for t in secure-storage kaspi-relay spbackup-ext; do node tests/unit/$t.test.mjs; done
node tools/build-app.mjs && node tests/e2e/pwa-mobile.js       # Playwright, 390×844
PGHOST=<socket dir> PGPORT=5499 PGUSER=postgres bash tests/sql/run.sh
```

The `pwa-mobile.js` checks, all passing:

1. **Owner login**: e-mail and code (captcha off, so no token, like the extension).
2. **Store connection**: by token, checked against Kaspi through the **real relay handler**.
3. **Owner home at 390×844**:
   - revenue 88 490 ₸ (the cancelled 99 999 ₸ order is excluded);
   - margin «—» while cost prices are unknown, never a made-up 100 %;
   - layout rules pass.
4. **Owner `.spbackup` from the computer**: the same store is recognised (no duplicate), and the margin becomes **28 % / 24 641 ₸**. That is 88 490 − 55 000 cost − 10 % commission.
5. **Order list and order card.**
6. **Raw IndexedDB holds only ciphertext**: the token, amounts, product names, store name, order number, e-mail and refresh token are all unreadable. The key is a `CryptoKey` with `extractable=false`. localStorage, sessionStorage and cookies are empty. The Kaspi token appears only inside relay POST bodies.
7. **Service worker** caches the shell only.
8. **Packer file**: saved by the owner and encrypted. The token, store name and owner id are not readable in it.
9. **Packer queue at 390×844**: no `₸`, amounts, «Выручка», «Маржа», «Прибыль», «Подписка», «себестоимость» or buyer name.
10. **Packer phone storage, decrypted**: no `ksh.costs`, licence or snapshots, and no `amount`, `price`, `total`, `totalPrice`, `paymentMode`, `deliveryCost`, buyer name or phone.
11. **Scan-to-verify a line, then «Собран»**: Kaspi `ASSEMBLE` is sent through the relay and the order leaves the queue.
12. **Search by order number**: the card shows no amounts.
13. **Owner switches the packer off**: on the next check the phone is wiped (records and key).
14. **No request** went to `kaspi.kz` directly or to a production Supabase project. The test blocks both and fails if either is attempted.

Screenshots (390×844 @2x): `kaspi-seller-hub/docs/media/pwa/owner-home-390x844.png`,
`owner-orders-390x844.png`, `staff-queue-390x844.png`, `staff-order-390x844.png`,
`extension-phone-card.png`.

## 4. Security self-audit

| Data | On the phone | On our servers (Supabase / relay) |
|---|---|---|
| Kaspi API token | AES-GCM in IndexedDB, plus the `enc1:` inner layer; key non-extractable | **never stored or logged**. Passes through relay memory for one request (TLS to the relay, TLS to Kaspi) |
| Orders, amounts, buyer data | Owner: encrypted on the phone. Packer: amounts and buyer data dropped **before** storage | **never** (the relay streams the answer through without reading or keeping it) |
| Cost prices, profit settings | Owner phone only, encrypted. Never on a packer phone | **never** |
| `.spbackup` file | ciphertext (PBKDF2 600k + AES-GCM) | **never uploaded**: moved by the owner |
| E-mail, licence, team membership | session encrypted on the phone | same as the extension today (Supabase Auth, `get_license`, `team_*`) |
| App shell (HTML/JS/CSS/icons) | Cache Storage | public static files |

Honest residual risks and limits:

1. **The relay sees the token in memory while it forwards a request.** This is unavoidable with Kaspi's CORS policy. Mitigations:
   - open code with no logging (tested);
   - token only in the POST body;
   - deployed with **no** extra logging. On Cloudflare, keep Workers Logs and Logpush **off** for this worker.
2. **A packer holds a real Kaspi token.** Kaspi tokens have full API rights. The app strips money data, but a technically skilled packer could pull the token out of their own phone's browser. The extension's «Компьютер склада» has the same limit. Two things help:
   - when you dismiss a packer, switch them off (the phone wipes itself) **and generate a new Kaspi token**;
   - the passphrase should go by a different channel than the file.
3. **iPhone storage eviction**: Safari may delete a website's data after about 7 days without use. Apps added to the Home Screen are exempt. Tell owners to add it to the Home Screen. If data is lost, re-open the `.spbackup` file.
4. **Rate limit is per relay instance** (stateless by design). For a global limit, use Cloudflare's own rate-limiting rules in front of the worker, which store no request content.
5. **Camera scanning** uses `BarcodeDetector` (Android Chrome). On iPhone, type the number or use a Bluetooth scanner as a keyboard.
6. The extension zip now also carries `shared/storage-adapter.js` and `shared/kaspi-relay-client.js`. The extension never loads them (dead code, about 15 KB).
7. **Waybill PDF download** from Kaspi subdomains is not available on the phone. The relay allowlist is `kaspi.kz/shop/api` only. Printing stays on the computer.

_Independent review and fixes: see section 6._

## 5. Deployment (do on a staging project first)

**A. Relay** (Supabase Edge Function), from `kaspi-seller-hub/billing`:

```
supabase link --project-ref <STAGING project ref>
supabase functions deploy kaspi-relay --no-verify-jwt
supabase secrets set RELAY_ALLOWED_ORIGINS=https://saudapulse.kz
```

`--no-verify-jwt` lets the function answer the browser's CORS preflight (`OPTIONS`, which carries no token) itself. Every real request is still checked inside the function: the user's token must be ES256-signed by the project (JWKS read from the project) and unexpired, with the role `authenticated`.

Check: `curl -X POST https://<project>.supabase.co/functions/v1/kaspi-relay` must answer `401 {"relayError":"auth"}`.

Then repeat `link` and `deploy` on production (`zraktrilvwrfpcbmkqwi`). The relay URL is derived from `BILLING.supabaseUrl`, so no app change is needed.

Alternative (Cloudflare Worker): `wrangler deploy billing/supabase/functions/kaspi-relay/worker.js --name saudapulse-kaspi-relay` with vars `SUPABASE_URL` and `RELAY_ALLOWED_ORIGINS`. Keep Logs and Logpush off. Then change `relayUrlFor()` / `RELAY_URL` in `app/js/config.js` and add the worker's host to the CSP `connect-src`.

**B. App `/app`:**

```
cd kaspi-seller-hub
TURNSTILE_SITE_KEY=0x… node tools/build-app.mjs     # same site key as saudapulse.kz/captcha
```

1. Copy `dist/app-site/app/` into the site so it is served at `https://saudapulse.kz/app/`, next to `/captcha`, `/offer` and `/privacy`.
2. If the host reads `_headers` (Cloudflare Pages, Netlify), copy `dist/app-site/_headers` too. GitHub Pages ignores it; the CSP is in the page itself.
3. In Cloudflare Turnstile, make sure the widget's hostnames include `saudapulse.kz` (already true for `/captcha`).
4. Smoke test on a real iPhone and Android: log in, open an owner `.spbackup`, «Обновить», check revenue against the Kaspi cabinet.

**C. Extension:** the next release (0.1.4) brings the «Перенести на телефон» card. Build with `node tools/build-release.mjs` as usual. Without it, owners can still connect a store on the phone by pasting the token.

## 6. Independent security review

A separate read-only review of the relay, the client, storage, `.spbackup`, the app, the service worker, the build and the extension handlers found **no critical issues**. These checks held up: the allowlist, redirects, JWT checks, CORS, the service worker, XSS, field whitelisting for packers, AES-GCM IVs and the authenticated header.

Fixed after the review (all tests rerun and passing):

| # | Finding | Fix |
|---|---|---|
| 1 | The packer file held tokens for every store; the per-packer store restriction was applied only on screen | after `team_join` / `team_check`, tokens and stores the owner did not give this packer (`shop_ids`) are **deleted from the phone** (`pruneStaffStores`) |
| 2 | Cloudflare's captcha script stayed loaded next to decrypted data | the page **reloads after login**, so the script is gone before any data is decrypted |
| 3 | Another account on the same phone saw the previous account's data | the phone remembers whose data it holds (`pwa.user`); a different account **wipes everything first** |
| 4 | Gaps in wipe on revocation | a revoked or deleted session on a packer phone now wipes; the wipe awaits the deletion of the token-key database; logout happens before wipe |
| 5 | Relay accepted anonymous Supabase users; flooding the limiter could reset counters | `is_anonymous` is refused; a full limiter refuses newcomers instead of evicting active users (tests added) |
| 6 | Passphrase floor was 10 characters | raised to **12** (PBKDF2 600k), ru/kk texts updated |
| 8 | `__proto__` / `constructor` as a store id in a hand-made file | refused (test added) |

Open (by design or for later):
- **Clickjacking.** `frame-ancestors` and `X-Frame-Options` only work as HTTP headers. GitHub Pages cannot send them; Cloudflare Pages or Netlify can (`_headers` is generated). With only a meta CSP, the page can be framed. The impact is limited: there are no one-click destructive actions without a confirmation sheet.
- **Relay accepts any signed-in SaudaPulse user**, without a licence or team check. The impact is free use of the relay, not data access. The rate limit applies.
- **"Encrypted at rest" protects the stored data against reading the browser's files and DevTools dumps.** It does not protect against code running inside the app's own origin, or a fully copied browser profile. There is no PIN lock on the phone yet. A PIN lock is a good next step, especially for owners.
- **Wording.** Platform logs (Supabase gateway / Cloudflare) still record request **metadata**: IP, time, status, size, user id in the gateway. The right claim is "no tokens, orders or prices are logged or stored", not "no logs at all".
- **Packer token.** A packer still holds a full-power Kaspi token for their stores. Switching them off wipes the phone if it is online, but cannot revoke the token. **Rotate the Kaspi token when dismissing a packer.**
- **Captcha.** Turnstile fails open on the client, as in the extension. It is real only once captcha is turned on in Supabase Auth.

## 7. Update: one-tap transfer and «Установить» (founder feedback)

**Transfer in one tap (QR).**
- **Computer:** extension → Настройки → «Показать QR-код для телефона». The worker builds the code; the page gets only the picture (a matrix), never the token as text.
- **Phone:** in the app, «Сканировать QR с компьютера» → point the camera → stores, tokens, cost prices and commission appear. No password, no file. This is the first screen of an owner with no stores, and the main button on «Магазины».
- **What the code contains:** `SP1.` + deflate + base64url (`shared/qr-transfer.js`).
  - It is short-lived: refused 2 minutes after it was shown. The dialog hides it and shows a countdown.
  - It is not a link, so a camera app opens nothing; only the SaudaPulse app reads it. Android uses its own `BarcodeDetector`; iPhone uses vendored jsQR (Apache-2.0, `app/vendor/`).
  - It goes from screen to camera and never through the internet or a server.
  - Cost prices ride along only while the code stays easy to scan. Otherwise they are left out, and the phone keeps its own.
- **The trade-off:** the code is not encrypted, because the key would have to be in the same picture. It must not be photographed or shown to others, and the dialog says so.
- **Other ways are now folded under «Другие способы»:** the password file, the token, and the packer file.

**«Установить».**
- **Phone app** (`app/js/install.js`):
  - A bar at the bottom.
  - Android, Chrome, Edge and Samsung: one tap opens the browser's own install prompt.
  - iPhone and iPad: Apple has no install button, so the bar opens a 3-step hint: «Поделиться → На экран Домой → Добавить».
  - Not shown when the app is already installed. «✕» hides it for 7 days.
  - `/app/?install=1` opens the install step at once.
- **Website** (`site-widgets/install-button.js`; the build copies it to `dist/app-site/install-button.js`):
  - Computer or laptop: floating «Установить расширение» bottom-right, to the Chrome Web Store. Until the store link is known it scrolls to `#how`.
  - Tablet: the same floating button, to the phone app, because tablets cannot run Chrome extensions.
  - Phone: a bar at the bottom, to `/app/?install=1`.
  - Add it to every page before `</body>`:
    `<script src="/install-button.js" defer data-store-url="https://chromewebstore.google.com/detail/<id>"></script>`

**Tests.**

| Suite | Result | What it checks |
|---|---|---|
| `tests/unit/qr-transfer.test.mjs` | 5/5 | encode → QR picture → **jsQR reads it** → decode; expiry; a far-future code refused; foreign texts refused; many cost prices left out while staying ≤ 1600 chars |
| `spbackup-ext` | 6/6 | the worker's QR matrix is read by the phone reader; no token text reaches the page |
| `e2e/pwa-mobile.js` | 19/19 | QR import → margin 28 %; Android install prompt in one tap; iPhone steps, «Не сейчас», `?install=1`; website button on 1440, 1280, iPad and iPhone |
| `e2e/phonecard.js` | all pass | the QR drawn in the real extension decodes to the store token and cost price |

The unit suites, robust (38) and locales (1184 keys) all pass. The release build ships `vendor/qrcode/` and `shared/qr-transfer.js`, and the 0.1.2 zip is unchanged.

## 8. Published (2026-11-25)

- Edge Function `kaspi-relay` deployed to `kaspi-seller-hub` (`zraktrilvwrfpcbmkqwi`): version 1, `verify_jwt = false`, status ACTIVE.
  - Nothing else on the project changed: no SQL and no secrets. The existing `telegram-bot` was not touched.
  - Allowed page origins are built into `handler.js` (`DEFAULT_ORIGINS`): `https://saudapulse.kz`, `https://www.saudapulse.kz` and `https://saudapulse.pages.dev`.
  - Rollback: delete the function in Supabase → Edge Functions → kaspi-relay.
- Site: Cloudflare Pages project `saudapulse`, connected to this repository (branch `claude/magical-maxwell-6yq76b`, output `kaspi-seller-hub/site-deploy`). It is live at `saudapulse.pages.dev`; the `saudapulse.kz` nameservers were moved to Cloudflare and activation is pending.

