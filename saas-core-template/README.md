# saas-core-template

Reusable multi-SaaS core extracted from a production browser-extension product: Supabase billing
backend, Telegram bot, owner admin panel and the extension-side licence / storage / migration
modules. Product identity is parameterized; nothing here belongs to one brand.

## Layout

| Path | What |
|---|---|
| `supabase/migrations/001…023_*.sql` | Billing schema: accounts, trial, invoices, team, support, referral, feature flags, retention, funnel events, client error telemetry, Telegram retention nudges, security hardening. Apply in order. |
| `supabase/functions/telegram-bot/` | Edge Function (`bot.js` logic, `index.js` Deno entry): digest, alerts, win-back, retention nudges (`enqueue_retention_nudges`: no first sync, trial ending, trial expired), `/start` linking; reads/writes only via `bot_*` RPCs. |
| `admin/` | Static owner panel (`index.html`, `admin.js`, `admin.css`): invoices, config, tickets, status/banner, bot settings. Payment is generic (`payment_url` + `payment_instructions`). |
| `extension-core/billing.js` | Licence client (OTP login, cached licence, offline grace, invoices, support RPCs). |
| `extension-core/license-signature.js` | ES256/RS256 JWT verification against public JWKs (`createLicenseVerifier`). |
| `extension-core/token-crypto.js` | AES-GCM secrets at rest, non-extractable key in IndexedDB, `scopeId` bound as AAD. |
| `extension-core/storage-split.js` | `createSplitCollection` (one key per record + index, only changed records written), `createSecretStore` (encrypted), `safeSet`. |
| `extension-core/backup-atomic.js` | `runAtomicMigration`: snapshot → migrate → verify → rollback on error; `restoreSnapshot`. |
| `extension-core/error-telemetry.js` | `reportClientError(code, context)`: anonymous, 10-min per-key throttle, fire-and-forget; server (`report_client_error`) sanitizes and aggregates, admin tab «Ошибки» shows it. |
| `extension-core/billing-config.js`, `feature-flags.js`, `notices.js` | Config (URL, anon key, public JWKs, legal/support), remote flags, banners. |
| `tests/sql/` | 20 PostgreSQL test files on a Supabase stub (`run.sh`, `stub.sql`, `test.sql`, `test2…test20.sql`). There is no `test1.sql`: `test.sql` is the first one. |
| `tests/unit/` | Node tests for the extension-core and the bot. |
| `scripts/init-new-saas.mjs` | Bootstrap CLI (not copied into generated projects). |
| `saas.config.example.json` | Values for the placeholders. |

## Placeholders

Text files contain double-brace tokens named `APP_NAME`, `APP_SLUG`, `APP_DOMAIN`,
`SUPABASE_PROJECT_ID`, `SUPABASE_ANON_KEY`, `CURRENCY`, `CURRENCY_SYMBOL`, `SUPPORT_EMAIL`,
`TELEGRAM_HANDLE`, `TRIAL_DAYS`, `LICENSE_PUBLIC_JWK`. `SUPABASE_ANON_KEY` (default empty) and
`LICENSE_PUBLIC_JWK` (JSON array of public JWKs, default `[]`) are optional: empty means the client
runs in developer mode (no login, no signature check). Never put private keys or the `service_role` key in the config.

## Bootstrap a new product

```bash
cp saas.config.example.json my.config.json     # edit values
node scripts/init-new-saas.mjs --config my.config.json --out ../my-product --dry-run   # file list, counts, unreplaced tokens
node scripts/init-new-saas.mjs --config my.config.json --out ../my-product
```

Defaults: `--config` = `saas.config.example.json`, `--out` = `../<APP_SLUG>` relative to the repository root.
The CLI refuses a non-empty `--out` and any `--out` inside `kaspi-seller-hub/`; it exits non-zero on missing keys.
Then: apply `supabase/migrations/*.sql` in a NEW Supabase project, deploy the bot
(`supabase functions deploy telegram-bot --no-verify-jwt`), paste the project's public ES256 JWK
into `LICENSE_PUBLIC_JWK`, host `admin/`.

## Tests

```bash
npm test                                   # = node --test tests/unit/*.test.mjs   (Node 20+; pass a glob, not a directory)
PGHOST=… PGUSER=postgres npm run test:sql  # needs a scratch PostgreSQL; TRIAL_DAYS env (default 14) renders the migration token
```

Not generalized (kept as product-neutral examples): bot message texts and the UTC+5 offset
(`TZ_OFFSET_HOURS` in `bot.js`), the order/store vocabulary in the digest, the `price_feeds` file-feed tables in 001.
