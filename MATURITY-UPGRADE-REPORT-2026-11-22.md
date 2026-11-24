# Maturity upgrade report — 2026-11-22

Branch: `claude/magical-maxwell-6yq76b` · code commit: `a94f58bcbe7dfae1773a8455a1bf15778a96161b`

## 1. Browser E2E (`tests/e2e/regress.sh`, Playwright/Chromium)
- Baseline run (code before the changes) was stopped partway because the code changed during the run. Suites that reported:
  - cattest, hack, billtest2, team — CRASH `page.waitForSelector: Timeout 30000ms exceeded`;
  - billtest — FAIL/CRASH `net::ERR_TUNNEL_CONNECTION_FAILED https://saudapulse.kz/privacy` (the sandbox proxy blocks the external site).
- The timeouts already happened on the old code, so the new changes did not cause them. The likely cause is the sandbox, but this is not confirmed yet.
- **Status:** the full post-change E2E run with crash diagnosis is still in progress. Its results will be added to this file.

## 2. Atomic backup rollback (`background/catalog-service.js`, `ui:backupImport`)
- Before writing, the current Costs, Photos, Catalog, Snapshots, Feeds and raw `ksh.settings` are read into `rollbackSnapshot`. Only sections whose content actually changes are written.
- On the first failed write (`safeSet` → `{ok:false, kind:'quota'}`), the remaining writes are skipped and every section is restored from `rollbackSnapshot` (best effort). The handler returns `{ ok:false, error:'quota', rolledBack:true }`. `scheduleFeedSync` is not called.
- Test: `tests/unit/backup.test.mjs` seeds costs, catalog and settings, makes the second `storage.local.set` fail with QuotaExceededError, and checks `rolledBack:true` and that the data equals the pre-import state.

## 3. Funnel events (`billing/supabase/022_product_funnel_events.sql`)
- Table `funnel_events(user_id, event, created_at)` with PK `(user_id, event)`: one event per account, no seller business data. RLS is on with no policies, and all privileges are revoked from `anon`, `authenticated` and `public`.
- RPC `track_funnel_event(p_event text)` (security definer, `authenticated` only). Allowed events: `onboarding_completed`, `first_sync_done`, `trial_expired_view`, `invoice_created`, `referral_shared`. It raises `not_authenticated` when there is no user and `bad_event` for an event outside the list. It returns `true` only on the first insert.
- Admin-only `admin_funnel_events()` (guarded by `is_admin()`) returns counts per event. `admin_insights` is untouched.
- Extension: `trackFunnel` in `background/billing.js` is fire-and-forget, with its own allowed-events list. It skips silently when offline or signed out and sends each event at most once (`ksh.funnelSent`). Call sites: onboarding complete (`dashboard/onboarding.js`), first sync (`service-worker.js` apiSnapshot), the trial-expired pay screen and referral link copy (`dashboard.js`), and a successful `create_invoice` (`billing.js`). `ui:trackFunnel` is added to the PUBLIC set in `staff.js`.
- **Reminder:** tomorrow, apply in `kaspi-seller-hub` (`zraktrilvwrfpcbmkqwi`) in this order: `019` → `020` → `021` → `022`. The project `lfadrqgwkjdxkmolhnwi` is not touched. Nothing was applied to Supabase today.

## 4. Build and tests
- `dist/kaspi-seller-hub-0.1.0.zip`: **1 807 555 bytes** (`node tools/build-release.mjs`). `dist/` is in `.gitignore`, so the ZIP is not committed. `node tools/build-site.mjs` succeeded, and the rebuild left the committed `site/` files unchanged.
- SQL: test1–test18 (baseline, before the changes): **395 PASS / 0 FAIL**. test19: **11/11 PASS** (run on a temporary database with migrations 001–022). The full `tests/sql/run.sh` with 022 is still in progress.
- Unit (all exit 0): robust 38 passed · locales 1133 keys · storage-split 16 ok · token-crypto 7 ok · license-signature 11 ok · license-flow 26 passed · bot-run 9 ok · feature-flags ok · notices ok · backup passed (including the new rollback test).
