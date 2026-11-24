# SaudaPulse: White-Box Security Audit, 24.11.2026

**Scope:** `kaspi-seller-hub/` (extension, `billing/supabase/001…029` + `grants.sql` + Edge Functions, admin page, captcha page) and `saas-core-template/`.
**Mode:** read-only. No source, migration, test or build artifact was changed, and no production Supabase project was queried. Only this report was written.
**Method:**
- Manual tracing of every `SECURITY DEFINER` RPC, RLS policy and grant (latest definition of each function across migrations, plus `APPLY-PROD-*` and `grants.sql`).
- Cross-file tracing of extension message routing, staff mode, billing and token storage.
- Parallel automated sweeps for DOM sinks, `postMessage`/manifest, token flows, and secrets in the tree, zips and all 174 commits of git history.

---

## 1. Executive risk rating

| Rating | Count |
|---|---|
| Critical | **0** |
| High | **0** |
| Medium | **7** |
| Low | **12** |
| Informational | 6 |

**Overall: MEDIUM. Score 7.5 / 10.**

The core is well built:
- Every table has RLS and has had its table privileges revoked.
- All writes go through validated `SECURITY DEFINER` RPCs with `set search_path = public`.
- `grants.sql` uses a deny-by-default model.
- The licence is an ES256-signed JWT, and the payment webhook uses HMAC with a replay window.
- The UI has no HTML sinks at all, and the extension CSP is strict.
- Kaspi tokens are AES-GCM encrypted with a non-extractable key.
- No secrets are committed anywhere.

No finding allows one tenant to read or modify another tenant's data through PostgREST or RPC.

The remaining risk is in **business logic** (billing, discounts, auto-confirmation, trials) and in the **warehouse/staff mode**, which is a UI lock and not a security boundary.

### Must fix before public launch
1. **M-1:** payment auto-confirmation can match a payment to an invoice by a phone number the client typed themselves and never verified. Fix this before any provider that sends no `invoice_id` is connected.
2. **M-2:** the "30 % for 2 months" retention offer actually gives 30 % off up to 2 × 12 months.
3. **M-3:** the owner PIN on the warehouse computer has no attempt limit.
4. **M-4:** warehouse lock / packer store restriction is client-side only; `ui:getState` is public on a locked PC.

---

## 2. Findings

### M-1: Auto-confirmation matches payments by an unverified, client-chosen phone (payment misattribution)

**Severity:** Medium. It becomes High once a provider without `invoice_id` is connected; `aipay` is not connected yet (`handler.js:77-81`).

**Where:**
- `kaspi-seller-hub/billing/supabase/028_payment_autoconfirm.sql:127-131`. When the webhook payload has no invoice id, `payment_received` picks *the one pending invoice with this phone and exactly this amount*.
- `001_billing.sql:334` (`create_invoice` → `phone_or_account(p_phone)`) and `001_billing.sql:417-425` (`set_my_phone`) let any user put **any** KZ mobile number on their own pending invoice. There is no ownership check (OTP/SMS) and no uniqueness check across accounts.

**Root cause:** the phone number is treated as a payer identity, but it is just a free-text field controlled by the client.

**Attack scenario (no exploit code):**
1. The attacker learns a victim seller's phone, which is usually public on Kaspi.
2. The attacker creates a pending invoice with the victim's phone and the common amount (12 000 ₸).
3. The victim pays their own invoice by QR. QR payment is allowed without a phone on the invoice, so the victim's invoice has `phone IS NULL`.
4. The webhook reports `phone=victim, amount=12000`, and `n = 1` matches the **attacker's** invoice. The attacker's subscription is extended with the victim's money.
5. The victim's invoice stays unpaid, which leads to a support dispute and possible chargebacks.

The `ambiguous` branch only protects the case where both invoices carry the same phone.

**Business impact:** revenue misattribution, customer disputes, and loss of trust in auto-confirmation.

**Fix:** never auto-confirm on a phone match. Send phone-only matches to review, and auto-confirm only on the invoice reference.
```sql
-- 028_payment_autoconfirm.sql, payment_received(): replace the phone branch
-  elsif ph is not null then
-    select count(*) into n from public.invoices where status = 'pending' and phone = ph and amount = p_amount;
-    if n = 1 then
-      select * into inv from public.invoices where status = 'pending' and phone = ph and amount = p_amount for update;
-    elsif n = 0 then why := 'no_match';
-    else why := 'ambiguous';
-    end if;
+  elsif ph is not null then
+    -- a phone typed by the client proves nothing: suggest the candidate to the admin, never confirm
+    select * into inv from public.invoices where status = 'pending' and phone = ph and amount = p_amount
+      order by created_at limit 1;
+    why := case when found then 'phone_only' else 'no_match' end;
   else
```
Also add `'phone_only'` to the `payment_events.reason` check constraint.

**Alternative (stronger):**
- Make the provider carry our invoice id (payment comment or `order_id`).
- Or verify phone ownership (OTP) before a phone can be used for matching, and enforce a partial unique index `on invoices(phone, amount) where status='pending'`.

---

### M-2: The retention discount applies to the whole multi-month invoice (30 % off up to 24 months)

**Severity:** Medium (revenue).

**Where:**
- `005_growth.sql:81`: `cancel_flow('…','discount')` sets `discount_pct = 30, discount_left = 2, discount_until = null`.
- `001_billing.sql:340`: `create_invoice` applies `public.discounted(public.billing_price(n_stores, p_months), acc)` to the **full** `p_months` amount (up to `max_months` = 12).
- `028_payment_autoconfirm.sql` (`confirm_invoice_core`): this is the only place that decrements `discount_left`, and it decrements by one per invoice.

**Root cause:** the offer is advertised as "30 % for 2 months" (`005_growth.sql:4`), but it is counted per *invoice*, not per *month*.

**Abuse:**
1. Any paying client opens the cancellation flow and chooses "discount". This is allowed once per 180 days, and the client does not have to actually leave.
2. The client creates two 12-month invoices. That is 24 months at −30 %, or about 7.2 months free.
3. With `discount_until = null` the offer never expires.

**Fix:**
```sql
-- 001_billing.sql, create_invoice(): the discount covers one month per remaining discounted invoice
-    values (acc.user_id, 'manual', n_stores, p_months, public.discounted(public.billing_price(n_stores, p_months), acc), ph, public.discount_now(acc))
+    values (acc.user_id, 'manual', n_stores, p_months,
+            public.discounted(public.billing_price(n_stores, 1), acc) + public.billing_price(n_stores, p_months - 1),
+            ph, public.discount_now(acc))
```
Also, in `005_growth.sql:81`, set `discount_until = now() + interval '60 days'`.

Optionally, offer the discount only to accounts with `cancel_at` set, or with a `cancellations` row whose outcome is `cancelled`, within the last N days.

---

### M-3: The owner PIN on the warehouse computer can be brute-forced (no attempt limit)

**Severity:** Medium.

**Where:** `kaspi-seller-hub/background/staff.js:216-226` (`'ui:ownerUnlock'`). It is listed in `PUBLIC` at `staff.js:103`, so it can be called with nobody signed in.

**Root cause:** the packer PIN login (`staff.js:162-175`) has a 5-attempt / 15-minute lockout. The owner unlock has **none**. The PIN is only 4-8 digits (`validPin`, `staff.js:42`).

At about 50-100 ms per PBKDF2 attempt, all 10 000 four-digit PINs can be tried in about 10-15 minutes. Any extension page can send `ui:ownerUnlock` in a loop.

**Impact:** a packer gains the full owner dashboard for 8 hours (`OWNER_UNLOCK_MS`). That includes:
- every store's orders;
- billing;
- team management (re-enabling themselves);
- connecting or disconnecting Kaspi tokens;
- settings, including turning warehouse mode off.

**Fix:**
```js
// staff.js, 'ui:ownerUnlock'
-      const stored = await get(local, OWNER_PIN_KEY, null);
-      if (!stored) return { ok: false, error: 'staffBadPin' };
-      const { hash } = await pinHash(pin, stored.salt);
-      if (!sameHash(hash, stored.hash)) return { ok: false, error: 'staffBadPin' };
+      const stored = await get(local, OWNER_PIN_KEY, null);
+      if (!stored) return { ok: false, error: 'staffBadPin' };
+      if ((stored.lockedUntil || 0) > Date.now()) return { ok: false, error: 'staffLocked' };
+      const { hash } = await pinHash(pin, stored.salt);
+      if (!sameHash(hash, stored.hash)) {
+        stored.fails = (stored.fails || 0) + 1;
+        if (stored.fails >= MAX_PIN_FAILS) Object.assign(stored, { fails: 0, lockedUntil: Date.now() + LOCK_MS * 2 ** Math.min(stored.locks = (stored.locks || 0) + 1, 6) });
+        await local.set({ [OWNER_PIN_KEY]: stored });
+        return { ok: false, error: 'staffBadPin' };
+      }
+      await local.set({ [OWNER_PIN_KEY]: { hash: stored.hash, salt: stored.salt } });
```
Also require a 6-digit minimum for the owner PIN.

---

### M-4: Warehouse mode and packer store restriction are client-side only

**Severity:** Medium.

**Where:**
- `staff.js:103`: `ui:getState` is in `PUBLIC`, so it is allowed **before any packer signs in**.
  - `service-worker.js:589-600`: `getState({ full: true })` returns every store's order snapshots.
  - `shared/storage.js:240-243`: `withSnapshots()` reads all snapshots straight from `chrome.storage.local` in the page context.
- `dashboard/staff-view.js:163`: the packer's `shop_ids` restriction is only a display `.filter(...)`.
  - `staffGate` (`staff.js:111-121`) checks only `payload.items[].shopId` for actions, so reads are not checked.
- `billing.js:84` and `staff.js:154`: the owner's Supabase session, the packers' sessions and the PIN hashes are stored in plaintext in `chrome.storage.local`. The file header (`staff.js:12-14`) acknowledges this as an "honest limit".
- Revocation (`staff.js:24-25, 89`): the server is checked every 2 minutes, and `OFFLINE_GRACE_MS = 15 min`. A removed packer who unplugs the network keeps local access for up to about 15 minutes.

**Root cause:** the extension's local data is the source of truth for orders, so the server cannot enforce the packer's scope. On top of that, the worker gate covers actions but not reads.

**Impact:** on a warehouse PC, anyone (even with no packer signed in) can read every order of every store. With DevTools (`chrome://extensions` → inspect), they can also read the owner session and use the decrypt key.

Server-side tenant isolation is **not** affected: `team_join` and `team_check` are correctly bound to the invitation e-mail and `auth.uid()` (`002_team.sql:121-147`).

**Fix:**
```js
// staff.js, staffGate(): reads are scoped too
-const PUBLIC = new Set(['ui:getState', 'ui:serviceStatus', ...
+const PUBLIC = new Set(['ui:serviceStatus', ...          // ui:getState handled below
 ...
 export async function staffGate(type, payload) {
   if (!(await warehouseOn()) || (await ownerUnlocked())) return null;
+  if (type === 'ui:getState') return { ok: true, locked: true, staff: (await activeStaff())?.member || null }; // no settings, no snapshots
```
- Serve packer data through a dedicated `ui:staffOrders` handler that filters with `staffMayUseShop` inside the worker.
- In warehouse mode, stop pages reading `ksh.snapshots` directly (`withSnapshots`).
- Move `ksh.session` to `chrome.storage.session` while the warehouse is locked.
- Operationally, run the warehouse PC on a separate Chrome profile with the enterprise policy `DeveloperToolsAvailability = 2`, and document that this is required.
- Reduce `OFFLINE_GRACE_MS` to 3-5 minutes.

---

### M-5: Trial anti-abuse is client-trusted

**Severity:** Medium (business).

**Where:**
- `013_account_sharing.sql:22-34`: `get_license(p_store_count, p_store_keys)`. The "one trial per store" check runs only if the client *sends* keys.
- `shared/store-key.js:36-46`: the key is `SHA-256('ksh:' + store id)`, with no secret salt. For API stores it is derived from the token hash.

**Root cause:** the trial is bound to an e-mail address. The store fingerprint is produced and submitted by the client.

**Abuse:**
- **Unlimited trials:** a modified client (or a direct RPC call) sends `p_store_keys = null`, or a new e-mail plus a freshly issued Kaspi API token, which produces a new key. Each new e-mail gets a full trial (plus 7 days with any referral code).
- **Pre-claim griefing (cabinet mode only):** Kaspi merchant IDs are public, so anyone can compute `sha256('ksh:'+id)` for a competitor and claim it first. The competitor's later sign-up then gets `trial_blocked`. Cabinet mode is disabled in the release build (`FEATURES.cabinet=false`), so this is latent today.

**Fix:**
- Server-side: derive the store key from data the server verifies. For example, have the extension call the Kaspi API with the token, return the merchant id the API reports, and HMAC it server-side with a secret pepper: `hmac(pepper, merchant_id)`.
- Until then, add a per-device or per-IP sign-up throttle (Supabase Auth rate limits plus Turnstile, already present).
- Make `trial_store_limit` / `ensure_price_feed` refuse feeds for stores that send no key.
- Never block a trial purely on a client-supplied claim. Send collisions to admin review instead of setting `trial_blocked` automatically.

---

### M-6: Encrypted DB backup is uploaded as a GitHub Actions artifact

**Severity:** Medium. It depends on whether the repo is public.

**Where:** `.github/workflows/seller-hub-db-backup.yml:39-50`. It runs `pg_dump --schema=public --schema=auth`, then `gpg --symmetric` with `BACKUP_PASSPHRASE`, then `actions/upload-artifact` with a 30-day retention.

**Root cause:**
- Artifacts of a public repository can be downloaded by any signed-in GitHub user. The repo is served by Pages (`CNAME = contamination.kz`), which suggests it is public.
- The dump includes `auth.users`, `auth.sessions` and `auth.refresh_tokens`, plus invoices and PII.
- Its confidentiality therefore rests on a single symmetric passphrase.

**Fix:**
- Keep the repository private, or push the dump to a private bucket (R2 or S3) instead of artifacts.
- Switch to public-key encryption (`age -r <pubkey>` or `gpg --encrypt -r`), so CI never holds the decryption key.
- Exclude `auth.refresh_tokens`, `auth.sessions`, `auth.mfa_*` and `auth.flow_state` (`--exclude-table-data=auth.refresh_tokens …`).

---

### M-7: withdrawn

An earlier version of this report said that `saas-core-template` only has migrations 001–018. That was wrong: a directory listing was cut short. The template has all of 001–029, and its own SQL suite passes. Migration 030 was added to it together with the product.

### M-8: Referral reward is not proportional and can be farmed with your own second account

**Severity:** Medium-low (business).

**Where:** `028_payment_autoconfirm.sql:44-55` (`confirm_invoice_core`) and `019_referral_program.sql:67-84` (`apply_referral_code`).

**Root cause:**
- The only self-referral guard is `ref_id = uid` (`019:77`, plus the check constraint).
- A second e-mail owned by the same person counts as a "friend".
- The inviter's reward is a flat **+14 days of their current plan, whatever its size**, triggered by the friend's first paid invoice of any size. The cheapest is a 1-month "Start" plan at 12 000 ₸.

**Abuse:** an owner of a 20-store plan (105 000 ₸/month) creates `B@…`, applies their own code, and pays 12 000 ₸ for B. They receive about 49 000 ₸ of their own plan, and B gets a month as well. This can be repeated without limit.

**Fix (any of):**
- Cap the reward at the value of the friend's payment: `bonus_days = least(14, ceil(30 * inv.amount / billing_price(ref.store_limit, 1)))`.
- Cap the reward count per inviter per period (for example, at most 3 per 90 days).
- Require the friend to have at least one connected store whose key is not already claimed by the inviter. Reject the referral when `store_claims` shows the friend's store keys belong to the inviter: `exists(select 1 from store_claims where user_id = ref.user_id and store_key in (friend keys))`.

---

### Low findings

| # | Finding | Where | Fix |
|---|---|---|---|
| L-1 | **The captcha fails open.** If the captcha page is not `ready` within 6 s, the call resolves `null` and the OTP request goes out with no token. Admin page: the same pattern. | `kaspi-seller-hub/shared/captcha.js:86`; `billing/admin/admin.js:~57` | `setTimeout(() => finish(reject, new Error('captchaUnavailable')), readyMs)` when `captchaEnabled()`. Keep Supabase Auth "Enable Captcha" ON, since that is the real control. |
| L-2 | **The captcha page posts the token to `'*'`** and has no `frame-ancestors`, so any site can frame it and harvest single-use Turnstile tokens (captcha farming / OTP spam relay). The extension side is safe: it does an exact `e.origin` and `e.source` check (`captcha.js:88`). | `billing/captcha/index.html:34` (and the template copy) | Serve `Content-Security-Policy: frame-ancestors chrome-extension://<EXT_ID> https://saudapulse.kz` from a host that can set headers. As a fallback, pass `?po=<origin>`, regex-check it, and `postMessage(msg, po)`. Add a per-request nonce echoed back by the page. |
| L-3 | **The content-script payload is trusted for `origin`/`url`.** The background uses `msg.payload.origin` instead of `sender.tab.url`, and `upsertStore` persists it; it is later used for `tabs.create`/`update`. | `background/service-worker.js:1448-1449, 113-140` | Derive `origin` and `url` from `sender.tab.url`, check them against an allow-list of Kaspi hosts, and whitelist the payload keys. |
| L-4 | **The page can forge `network-tap` messages** (same window, same origin), which poisons cached orders. Data integrity only; nothing executes. | `content/content.js:266-270` | Use a per-load nonce handed from the isolated world, plus type and size validation of the parsed items. |
| L-5 | **The manifest is broader than needed:** the `tabs` permission and the demo patterns `http://localhost/*` and `file:///*/mc/store-*` are in the source manifest. The release build strips the patterns. | `manifest.json:26, 37, 46, 60` | Drop `tabs` (host permissions already expose `tab.url` for Kaspi). Keep the dev patterns in a dev-only manifest, and do not keep the dev zips (`kaspi-seller-hub.zip`, `kaspi-seller-hub-test.zip`) at the repo root. |
| L-6 | **The hosted admin pages have no CSP.** They are safe today only because there are no HTML sinks. | `billing/admin/index.html:4-5`, `saas-core-template/admin/index.html:4-5` | Add `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src https: data:; connect-src https://<ref>.supabase.co; frame-src https://saudapulse.kz; base-uri 'none'; form-action 'none'">` |
| L-7 | **The order-detail link is rendered with no scheme or origin check.** `absUrl` keeps `javascript:`/`data:`. It is blocked by the extension CSP and the source is Kaspi's DOM, but the code is inconsistent with `safeStoreUrl`. | `dashboard/dashboard.js:787` ← `content/content.js:216-222, 307` | Pass `r.url` through the same https + store-origin check (`safeStoreUrl`) before setting `href`. |
| L-8 | **The recipient in the `mailto:` link is not encoded.** An address containing `?`/`&` could inject `bcc` or `body`. | `billing/admin/admin.js:644`, `dashboard/staff-view.js:381` | Use `mailto:${encodeURIComponent(email)}?…` |
| L-9 | **The print sanitizer is a denylist** of tags and attributes. SVG `<set>`/`<animate attributeName=href>` and CSS UI-redress are not handled. No script runs because of the CSP. | `dashboard/print.js:24-47` | Use an allowlist of tags and attributes (DOMPurify with a strict profile), or render the invoice in a `sandbox` iframe. |
| L-10 | **Backup import does not validate the inner snapshot items.** A crafted backup can set `api.waybill` to any URL, which `downloadWaybill` then fetches (without a token). | `background/catalog-service.js:458` | Rebuild items through a whitelist mapper, and require `api.waybill` to be `https://` on a `kaspi.kz` host. |
| L-11 | **`kaspi_qr_url` has no scheme or host restriction.** It is admin-set and shown to every client as the payment QR, so a hijacked admin session could swap the QR for a phishing one. | `001_billing.sql:597-598` (`admin_update_config`); `dashboard/dashboard.js:2272, 2607`; `admin.js:856-858` | `check (kaspi_qr_url ~ '^https://(saudapulse\.kz\|<ref>\.supabase\.co)/')` on `billing_config`, plus the same check client-side. |
| L-12 | **Deployment hygiene.** If GitHub Pages serves the repo root (`CNAME`), the ~30 internal reports (including the earlier audits and `TODO-OWNER`) and `APPLY-PROD-*.sql` are public. Also, `externally_connectable` matches `https://*.saudapulse.kz/*` (subdomain takeover leads to `OPEN_DASHBOARD` and referral-code injection), and the bot Edge Function sends `Access-Control-Allow-Origin: *` (`bot.js:181, 293`). | repo root, `manifest.json`, `functions/telegram-bot/bot.js` | Publish only `site/` through a Pages workflow, list exact hosts in `externally_connectable`, and restrict CORS to the extension origin. |

### Informational

- **I-1:** the Supabase **anon** key is in `shared/billing-config.js:13`, the zips and git history (role=anon). This is expected for a public client and is not a secret.
- **I-2:** `invoices.phone` is readable by the owner through the column grant (`grants.sql:112-113`). Only the user's own rows are visible (RLS `invoices_read_own`). This is fine.
- **I-3:** `discount` from `cancel_flow` is available to any paying client without them actually leaving. This is a product decision; see M-2 for the abuse amplifier.
- **I-4:** `ops_digest` and the `bot_*` RPCs are `service_role` only (017 + `grants.sql:4`). The `bot_key` check is constant-shape and the key is stored as a SHA-256 hash.
- **I-5:** the content script injects nothing into kaspi.kz pages; it is read-only.
- **I-6:** the license JWT verification rejects `alg: none` and `HS256`, private JWKs, and the wrong issuer or audience. There is a rollback check.

---

## 3. Areas verified as secure

**Multi-tenant isolation (PostgREST and RPC)**
- RLS is enabled on all 29 public tables.
- `grants.sql` revokes ALL table and sequence rights from `public`, `anon` and `authenticated`. The only re-grants are `SELECT` on `accounts` (`user_id = auth.uid()`) and a column subset of `invoices` (own rows).
- All other data is reachable only through RPCs.

**RPC ownership checks:** every user RPC derives the tenant from `auth.uid()` and never from a parameter. This covers:
- `get_license`, `create_invoice`, `cancel_my_invoice` (`user_id = auth.uid()`), `set_my_phone`, `request_store_addon`, `ensure_renewal_invoice`;
- `ensure_price_feed`, `can_write_feed` (feed must belong to the caller and access must be active);
- `my_tickets`, `ticket_*`, `tg_*`, `team_list`, `team_update`, `team_set_enabled`, `team_remove` (all `owner_id = auth.uid()`);
- `team_join` (bound to the invited e-mail; a joined row cannot be taken over by another uid);
- `team_check` (`user_id = auth.uid()`);
- `alert_create`, `report_client_error`, `track_ux_event(s)`, `track_funnel_event`, `my_referral`, `apply_referral_code`.

No IDOR was found on subscriptions, invoices, store keys, feeds or tickets.

**Admin functions:** all `admin_*` functions check `is_admin()` (the `admins` table, which has no client access) before doing anything.
- `admin_delete_account` refuses to delete admins or yourself, and needs an e-mail confirmation.
- `admin_confirm_invoice` requires the expected amount and stores and locks the invoice row `FOR UPDATE`.
- `confirm_invoice_core` and `payment_received` are not executable by `authenticated`.

**Least privilege:**
- `grants.sql` starts by revoking EXECUTE on all functions from `public`, `anon` and `authenticated`, and sets default privileges.
- `anon` gets only `get_service_status()` and `health()`.
- `service_role` gets only the bot, ops, retention and payment functions. `custom_access_token_hook` is executable only by `supabase_auth_admin`.
- Internal `SECURITY DEFINER` helpers are not callable by clients after `grants.sql`, which `APPLY-PROD-2026-11-24-b.sql` applies. These are `health_window`, `usage_summary`, `has_access_of`, `account_ref`, `purge_expired`, `sanitize_client_text` and `gen_referral_code`.
- All `SECURITY DEFINER` functions pin `search_path`.

**Billing state machine:**
- Amounts are computed server-side.
- There is one pending invoice per user (a partial unique index).
- Each user can create at most 30 invoices per 24 h.
- Confirmation is idempotent (`status <> 'pending'` raises an error) and locked by row.
- Freeze and resume give back exactly the unused days, with no net gain.
- The boost is once per account, and `discount_left` is decremented on confirmation.

**Referral program:**
- Self-referral by the same uid is blocked.
- A code can be applied only once, within 7 days of sign-up.
- The reward is given once per friend, not for add-on invoices, and not to frozen, blocked or deleted inviters.

**`pending_storage_cleanups`:** RLS is admin-only and there are no table rights. Rows are filled in the same transaction as account deletion.

**Payment webhook:**
- HMAC-SHA256 over `timestamp.body`, compared in constant time.
- 5-minute replay window, 64 KB cap, at least a 32-character secret.
- Idempotent on `(provider, payment_id)`, never echoes errors, and an unknown provider returns 404 or 501.

**Telegram bot:** the webhook secret header and `x-bot-key` are checked in constant time.

**Extension message routing:**
- `onMessage` requires `sender.id === runtime.id`.
- `ui:*` messages only come from extension pages, and `content:*` only from tabs and only when the cabinet feature is on.
- `onMessageExternal` accepts only `PING` and `OPEN_DASHBOARD`, from `https` `saudapulse.kz` with an exact or dot-suffix match, and validates `ref` with a regex.

**Manifest:**
- CSP is `script-src 'self'; object-src 'self'`, with no `unsafe-*` and no remote scripts.
- There are no `web_accessible_resources` and no sandbox pages, so no extension page can be framed or clickjacked.
- There is no `<all_urls>`, `webRequest` or `cookies` permission.

**Captcha bridge (extension side):** exact `e.origin !==` check and `e.source === frame.contentWindow`, a token length check, a single-resolve guard, the listener is removed on finish, and cancel aborts the request.

**DOM XSS:**
- There is no `innerHTML`, `outerHTML` write, `insertAdjacentHTML`, `document.write`, `eval` or `new Function` in the live source.
- All UI, including the admin page that renders tickets, client errors, UX events and e-mails, is built with the text-node helpers `h()`, `el()` and `s()`. Event handlers are attached only as functions.
- Photos go through `isAllowedPhoto`, and CSV export neutralises formulas.

**Token handling:**
- Kaspi tokens are AES-GCM-256 encrypted, with a non-extractable IndexedDB key and the shopId as additional authenticated data.
- Tokens are never returned to pages (`getState` returns ids only), are sent only to the Kaspi API origin with `credentials: 'omit'`, and never appear in logs, errors or telemetry.

**Telemetry and error reporting:**
- The client sends whitelisted codes and keys only.
- `sanitize_client_text` in SQL strips URLs, e-mails, bearer tokens, JWTs, long strings and numbers.
- Per-user row caps apply.

**Backup:**
- The export contains no token, session or licence.
- The import is versioned and size-capped, guards against prototype pollution, whitelists fields, cannot overwrite token, session or staff flags, and rolls back all-or-nothing.

**Secrets:**
- There is no `service_role` key, `sb_secret_` value, private key, bot token or `.env` file in the tree, the zips or any of the 174 commits.
- The release build refuses empty config and secret-looking keys (`tools/build-release.mjs:52-69`).
- There are no debug or bypass flags.

---

## 4. Remediation order

1. **M-1** (phone auto-match → review), **M-2** (discount per month), **M-3** (owner PIN lockout). Each is a small, local change.
2. **M-4** (scope `getState`, warehouse profile with DevTools disabled), **M-6** (backup to private storage / public-key encryption).
3. **M-5** and **M-8** (server-verified store identity, proportional referral reward).
4. The Low items, as hardening alongside regular releases.

---

## 5. Fix status (24.11.2026, after the audit)

| Finding | Status |
|---|---|
| M-1 phone-only auto-confirm | **Fixed.** `030_audit_fixes.sql`: a phone match goes to review (`phone_only`) and names the candidate invoice. Only our invoice number confirms automatically. |
| M-2 discount on multi-month invoices | **Fixed.** `030`: −30 % applies to one month of each discounted invoice, and the offer expires after 60 days. |
| M-3 owner PIN brute force | **Fixed.** `background/staff.js`: 5 wrong tries lock the unlock for 15 minutes. |
| M-4 warehouse mode is client-side | **Mitigated.** Offline grace cut from 15 to 5 minutes. README documents the separate profile plus `DeveloperToolsAvailability=2` / `URLBlocklist` policy. A full fix needs server-side order access (architecture). |
| M-5 trial anti-abuse | Open. Needs a server-verified store identity. |
| M-6 backup artifact | Open. Owner action: private repo or private bucket, public-key encryption. |
| M-7 | Withdrawn (not a finding). |
| M-8 referral farming | Open. Product decision on a proportional reward. |
| L-3 content-script origin | **Fixed.** The worker uses `sender.tab.url`. |
| L-7 order link, L-11 QR URL | **Fixed.** Rendered only for safe URLs. |
| L-8 mailto | **Fixed.** In both admin pages and the staff view. |
| L-9 print sanitizer | **Hardened.** SVG animation tags and `foreignObject` are removed. |
| L-10 waybill from a backup | **Fixed.** The download is allowed only from the API host or https `*.kaspi.kz`. |
| L-1, L-2, L-5, L-6, L-12 | Open. These are hosting or config changes; see the table above. |

Verification:
- SQL: 605 checks pass in both the product and the template, including the new `test27.sql`.
- Unit: all 15 suites pass.
- Browser: billtest2, team, orchestra, growth, hack, apitest, run2, demofile, photoprint and uxtest all pass.
- `APPLY-PROD-2026-11-24-c.sql` runs twice on the same database without errors.
