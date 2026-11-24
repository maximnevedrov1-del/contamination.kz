-- SaudaPulse: production update 24.11.2026 (c): security-audit fixes (SECURITY-AUDIT-2026-11-24.md) + payer phone confirmed in Telegram.
-- Run ONCE in Supabase → SQL Editor. Production already has 001–029. This applies 030_audit_fixes.sql, 031_phone_verified.sql, then grants.sql. Safe to run again.
-- After it: redeploy the telegram-bot Edge Function (supabase functions deploy telegram-bot --no-verify-jwt).

-- ==================== 030_audit_fixes.sql ====================
-- Seller Hub: fixes from SECURITY-AUDIT-2026-11-24.md. Safe to run again.
-- Apply AFTER 029_client_language.sql, then grants.sql (no new functions: create or replace keeps the grants).
--
-- M-1  payment_received(): a payment that carries no invoice id is NEVER confirmed by a phone match any more.
--      The phone on an invoice is typed by the client and is not verified, so anyone could put another seller's
--      number on their own invoice and receive that seller's payment. A phone + amount match now goes to the
--      admin's review queue with reason 'phone_only' and the candidate invoice; the admin confirms by hand.
-- M-2  The retention discount («30 % на 2 счёта», cancel_flow → discount) covers ONE month of each discounted
--      invoice. Before, a 12-month invoice got 30 % off all 12 months (2 invoices → up to 24 months at −30 %).
--      The offer now also expires 60 days after it was taken.
begin;

-- ---------- M-1: phone-only matches go to review ----------
alter table public.payment_events drop constraint if exists payment_events_reason_check;
alter table public.payment_events add constraint payment_events_reason_check check (reason is null or reason in
  ('no_match', 'ambiguous', 'amount_mismatch', 'invoice_not_pending', 'invoice_not_found', 'phone_only'));

create or replace function public.payment_received(p_provider text, p_payment_id text, p_amount int,
                                                   p_invoice_id bigint default null, p_phone text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ev public.payment_events; inv public.invoices; ph text; n int; why text;
begin
  if p_provider is null or p_provider !~ '^[a-z0-9_-]{2,32}$' or p_payment_id is null or length(p_payment_id) not between 1 and 128
     or p_amount is null or p_amount <= 0 then
    raise exception 'invalid_payment' using errcode = '22023';
  end if;
  ph := public.normalize_phone(p_phone);
  insert into public.payment_events (provider, payment_id, amount, phone)
  values (p_provider, p_payment_id, p_amount, ph)
  on conflict (provider, payment_id) do nothing
  returning * into ev;
  if not found then
    -- the provider sent the same payment again (retry): answer what was decided the first time, change nothing
    select * into ev from public.payment_events where provider = p_provider and payment_id = p_payment_id;
    return jsonb_build_object('outcome', ev.outcome, 'reason', ev.reason, 'invoice_id', ev.invoice_id, 'duplicate', true);
  end if;

  if p_invoice_id is not null then
    -- our own invoice number came back from the provider: the only reference good enough to confirm automatically
    select * into inv from public.invoices where id = p_invoice_id for update;
    if not found then why := 'invoice_not_found'; end if;
    if why is null and inv.status <> 'pending' then why := 'invoice_not_pending'; end if;
    if why is null and inv.amount <> p_amount then why := 'amount_mismatch'; end if;
  elsif ph is not null then
    -- the phone on an invoice is whatever the client typed (not verified): suggest the candidate, never confirm
    select count(*) into n from public.invoices where status = 'pending' and phone = ph and amount = p_amount;
    if n = 0 then why := 'no_match';
    elsif n > 1 then why := 'ambiguous';
    else
      select * into inv from public.invoices where status = 'pending' and phone = ph and amount = p_amount;
      why := 'phone_only';
    end if;
  else
    why := 'no_match';
  end if;

  if why is null then
    perform public.confirm_invoice_core(inv.id, left('auto: ' || p_provider || ' ' || p_payment_id, 200), null);
    update public.payment_events set outcome = 'confirmed', invoice_id = inv.id where id = ev.id returning * into ev;
  else
    update public.payment_events set outcome = 'review', reason = why, invoice_id = inv.id where id = ev.id returning * into ev;
  end if;
  return jsonb_build_object('outcome', ev.outcome, 'reason', ev.reason, 'invoice_id', ev.invoice_id, 'duplicate', false);
end $$;
revoke execute on function public.payment_received(text, text, int, bigint, text) from public, anon, authenticated;
grant execute on function public.payment_received(text, text, int, bigint, text) to service_role;

-- ---------- M-2: the discount covers one month per discounted invoice; the offer expires ----------
-- Both functions are patched in place (exactly one occurrence each), so the rest of their bodies and their grants
-- stay as the earlier migrations left them. Re-running is a no-op once patched.
do $$
declare d text; old_s text; new_s text;
begin
  d := pg_get_functiondef('public.create_invoice(integer,integer,text)'::regprocedure);
  old_s := 'public.discounted(public.billing_price(n_stores, p_months), acc)';
  new_s := 'public.discounted(public.billing_price(n_stores, 1), acc) + public.billing_price(n_stores, p_months - 1)';
  if position(new_s in d) = 0 then
    if (length(d) - length(replace(d, old_s, ''))) / length(old_s) <> 1 then
      raise exception 'create_invoice: expected exactly one "%"', old_s;
    end if;
    execute replace(d, old_s, new_s);
  end if;

  d := pg_get_functiondef('public.cancel_flow(text,text,text)'::regprocedure);
  old_s := 'discount_pct = 30, discount_left = 2, discount_until = null';
  new_s := 'discount_pct = 30, discount_left = 2, discount_until = now() + interval ''60 days''';
  if position(new_s in d) = 0 then
    if (length(d) - length(replace(d, old_s, ''))) / length(old_s) <> 1 then
      raise exception 'cancel_flow: expected exactly one "%"', old_s;
    end if;
    execute replace(d, old_s, new_s);
  end if;
end $$;

commit;

-- ==================== 031_phone_verified.sql ====================
-- Seller Hub: phone confirmed through the Telegram bot. Safe to run again.
-- Apply AFTER 030_audit_fixes.sql, then grants.sql.
--
-- A phone typed by the client proves nothing (030 sends every phone-only match to review). Telegram, however,
-- can hand the bot the user's OWN number: the «Поделиться номером» button (request_contact) sends a contact whose
-- user_id is the sender's, and Telegram has verified that number by SMS. The bot stores it here (bot_verify_phone).
-- payment_received() confirms a payment that carries no invoice id only when exactly one pending invoice has this
-- phone and amount AND that phone is the account's Telegram-confirmed number. Anything else still goes to review.
begin;

alter table public.accounts add column if not exists phone_verified text check (phone_verified ~ '^77\d{9}$');
alter table public.accounts add column if not exists phone_verified_at timestamptz;

-- The bot (service_role) received a contact the user shared from their own Telegram account.
create or replace function public.bot_verify_phone(p_key text, p_chat_id bigint, p_phone text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid; ph text;
begin
  if not public.bot_key_ok(p_key) then perform pg_sleep(0.5); raise exception 'bad_key'; end if;
  select user_id into uid from public.tg_links where chat_id = p_chat_id and blocked_at is null;
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not_linked'); end if;
  ph := public.normalize_phone(p_phone);
  if ph is null then return jsonb_build_object('ok', false, 'error', 'invalid_phone'); end if;
  update public.accounts set phone = ph, phone_verified = ph, phone_verified_at = now() where user_id = uid;
  update public.invoices set phone = ph where user_id = uid and status = 'pending';
  return jsonb_build_object('ok', true, 'phone', ph);
end $$;
revoke execute on function public.bot_verify_phone(text, bigint, text) from public, anon, authenticated;
grant execute on function public.bot_verify_phone(text, bigint, text) to service_role;

-- payment_received: as in 030, plus the confirmed-phone path
create or replace function public.payment_received(p_provider text, p_payment_id text, p_amount int,
                                                   p_invoice_id bigint default null, p_phone text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ev public.payment_events; inv public.invoices; ph text; n int; why text;
begin
  if p_provider is null or p_provider !~ '^[a-z0-9_-]{2,32}$' or p_payment_id is null or length(p_payment_id) not between 1 and 128
     or p_amount is null or p_amount <= 0 then
    raise exception 'invalid_payment' using errcode = '22023';
  end if;
  ph := public.normalize_phone(p_phone);
  insert into public.payment_events (provider, payment_id, amount, phone)
  values (p_provider, p_payment_id, p_amount, ph)
  on conflict (provider, payment_id) do nothing
  returning * into ev;
  if not found then
    -- the provider sent the same payment again (retry): answer what was decided the first time, change nothing
    select * into ev from public.payment_events where provider = p_provider and payment_id = p_payment_id;
    return jsonb_build_object('outcome', ev.outcome, 'reason', ev.reason, 'invoice_id', ev.invoice_id, 'duplicate', true);
  end if;

  if p_invoice_id is not null then
    -- our own invoice number came back from the provider
    select * into inv from public.invoices where id = p_invoice_id for update;
    if not found then why := 'invoice_not_found'; end if;
    if why is null and inv.status <> 'pending' then why := 'invoice_not_pending'; end if;
    if why is null and inv.amount <> p_amount then why := 'amount_mismatch'; end if;
  elsif ph is not null then
    select count(*) into n from public.invoices where status = 'pending' and phone = ph and amount = p_amount;
    if n = 0 then why := 'no_match';
    elsif n > 1 then why := 'ambiguous';
    else
      select * into inv from public.invoices where status = 'pending' and phone = ph and amount = p_amount for update;
      -- confirmed only when the phone is the account's own, confirmed in Telegram; a typed phone goes to review
      if not exists (select 1 from public.accounts a where a.user_id = inv.user_id and a.phone_verified = ph) then
        why := 'phone_only';
      end if;
    end if;
  else
    why := 'no_match';
  end if;

  if why is null then
    perform public.confirm_invoice_core(inv.id, left('auto: ' || p_provider || ' ' || p_payment_id, 200), null);
    update public.payment_events set outcome = 'confirmed', invoice_id = inv.id where id = ev.id returning * into ev;
  else
    update public.payment_events set outcome = 'review', reason = why, invoice_id = inv.id where id = ev.id returning * into ev;
  end if;
  return jsonb_build_object('outcome', ev.outcome, 'reason', ev.reason, 'invoice_id', ev.invoice_id, 'duplicate', false);
end $$;
revoke execute on function public.payment_received(text, text, int, bigint, text) from public, anon, authenticated;
grant execute on function public.payment_received(text, text, int, bigint, text) to service_role;

-- The licence tells the extension whether the account's phone is the confirmed one (for the hint on the payment page).
do $$
declare d text := pg_get_functiondef('public.get_license(integer,text[])'::regprocedure);
        old_s text := '''phone'', acc.phone,';
        new_s text := '''phone'', acc.phone, ''phone_verified'', acc.phone_verified is not null and acc.phone_verified is not distinct from acc.phone,';
begin
  if position('phone_verified' in d) = 0 then
    if (length(d) - length(replace(d, old_s, ''))) / length(old_s) <> 1 then
      raise exception 'get_license: expected exactly one "%"', old_s;
    end if;
    execute replace(d, old_s, new_s);
  end if;
end $$;

commit;

-- ==================== grants.sql ====================
-- Seller Hub: function, table and Storage privileges, deterministic and idempotent.
-- Apply AFTER restoring a dump (pg_restore --no-owner ...):
--   psql "$TARGET_DB_URL" -f kaspi-seller-hub/billing/supabase/grants.sql
-- Mirrors the grants of migrations 001..026 (verified against a database built from them).
-- Keep in sync: when a migration adds a function or changes who may call it, update this file too.

-- 1. everything closed first (also for future functions)
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon;

-- 2. anonymous: the service-status banner (extension, admin page) and the health probe
grant execute on function public.get_service_status(), public.health() to anon, authenticated;

-- 3. signed-in sellers and admins (admin_* functions check is_admin() inside)
grant execute on function
  public.accept_terms(),
  public.admin_accounts(text,text,int,int),
  public.admin_cancel_invoice(bigint,text),
  public.admin_client_errors(int),
  public.admin_confirm_invoice(bigint,text,int,int),
  public.admin_payment_events(boolean,int),
  public.admin_resolve_payment_event(bigint,text),
  public.set_my_lang(text),
  public.admin_delete_account(uuid,text),
  public.admin_delete_feature_flag(text),
  public.admin_fail_storage_cleanup(bigint,text),
  public.admin_funnel_events(),
  public.admin_get_config(),
  public.admin_get_system_banner(),
  public.admin_grant_days(uuid,int,int),
  public.admin_growth_settings(jsonb),
  public.admin_health(int),
  public.admin_insights(int),
  public.admin_invoices(text,text,int,int),
  public.admin_list_feature_flags(),
  public.admin_list_storage_cleanups(),
  public.admin_ops_settings(text,int,numeric),
  public.admin_purge_expired(),
  public.admin_resolve_storage_cleanup(bigint),
  public.admin_set_feature_flag(text,boolean,int,text[],text),
  public.admin_set_status(text,text,int),
  public.admin_set_system_banner(boolean,text,text),
  public.admin_ticket_reply(bigint,text,boolean),
  public.admin_tickets(text,text,int,int),
  public.admin_update_config(jsonb),
  public.admin_ux_summary(),
  public.alert_create(text,text,int,text),
  public.apply_referral_code(text),
  public.billing_price(int,int),
  public.can_write_feed(text),
  public.cancel_flow(text,text,text),
  public.cancel_my_invoice(bigint),
  public.create_invoice(int,int,text),
  public.digest_report(date,jsonb),
  public.ensure_price_feed(text),
  public.ensure_renewal_invoice(int),
  public.feedback_due(),
  public.feedback_submit(text,int,text,text,bigint),
  public.get_license(int,text[]),
  public.health_report(jsonb),
  public.is_admin(),
  public.my_referral(),
  public.my_tickets(),
  public.report_client_error(text,text,text),
  public.request_store_addon(int),
  public.resume_subscription(),
  public.set_my_phone(text),
  public.start_trial_boost(),
  public.team_check(uuid),
  public.team_invite(text,text,text[],boolean),
  public.team_join(uuid),
  public.team_list(),
  public.team_remove(uuid),
  public.team_set_enabled(uuid,boolean),
  public.team_update(uuid,text,text[],boolean),
  public.tg_link_create(),
  public.tg_settings(boolean,boolean),
  public.tg_status(),
  public.tg_unlink(),
  public.ticket_close(bigint),
  public.ticket_create(text,text,text,text),
  public.ticket_seen(bigint),
  public.track_funnel_event(text),
  public.track_ux_event(text,text,text),
  public.track_ux_events(jsonb),
  public.upgrade_quote(int),
  public.usage_report(jsonb,jsonb,text)
to authenticated;

-- 4. server side only (Telegram bot Edge Function, ops-alert job, retention job): service_role
grant execute on function
  public.bot_link(text, text, bigint, text), public.bot_unlink(text, bigint, boolean), public.bot_jobs(text), public.bot_sent(text, jsonb),
  public.bot_lock(text, text, int), public.bot_unlock(text, text), public.bot_key_ok(text), public.ops_digest(text),
  public.enqueue_retention_nudges(), public.payment_received(text,text,int,bigint,text), public.bot_langs(text,uuid[],bigint[]), public.bot_verify_phone(text,bigint,text)
to service_role;

-- 5. only Supabase Auth may run the access-token hook
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant usage on schema public to supabase_auth_admin;
    grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
  end if;
end $$;

-- ---------- 6. tables and sequences (restore drill 2026-11-23) ----------
-- A restore into a Supabase project runs CREATE TABLE under Supabase's default privileges
-- (ALL to anon/authenticated); the dump's GRANTs only add on top. Close everything, then
-- re-grant exactly what the migrations grant: clients read their own account row (RLS) and
-- the public invoice columns of their own invoices (RLS); everything else goes through RPCs.
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
alter default privileges in schema public revoke all on tables from public, anon, authenticated;
alter default privileges in schema public revoke all on sequences from public, anon, authenticated;
grant select on public.accounts to authenticated;
grant select (id, user_id, kind, stores, months, amount, phone, status, created_at, paid_at, period_from, period_to, discount_pct)
  on public.invoices to authenticated;

-- ---------- 7. Storage: price-list bucket and its rules (schema storage is NOT in the dump) ----------
-- The files themselves live in Supabase Storage, outside the database dump: after a restore the
-- extension re-uploads a feed only when its prices/stock change or on a forced re-publish (same feed_id → same URL
-- on the same project; a new project has a new URL that the seller must paste into Kaspi again).
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('pricelists', 'pricelists', true, 5242880, array['application/xml', 'text/xml'])
      on conflict (id) do update set public = true, file_size_limit = 5242880, allowed_mime_types = array['application/xml', 'text/xml'];
    drop policy if exists "pricelists insert own" on storage.objects;
    drop policy if exists "pricelists update own" on storage.objects;
    drop policy if exists "pricelists select own" on storage.objects;
    drop policy if exists "pricelists delete own" on storage.objects;
    drop policy if exists "pricelists admin select" on storage.objects;
    drop policy if exists "pricelists admin delete" on storage.objects;
    create policy "pricelists insert own" on storage.objects for insert to authenticated
      with check (bucket_id = 'pricelists' and public.can_write_feed(name));
    create policy "pricelists update own" on storage.objects for update to authenticated
      using (bucket_id = 'pricelists' and public.can_write_feed(name))
      with check (bucket_id = 'pricelists' and public.can_write_feed(name));
    create policy "pricelists select own" on storage.objects for select to authenticated
      using (bucket_id = 'pricelists' and public.can_write_feed(name));
    create policy "pricelists delete own" on storage.objects for delete to authenticated
      using (bucket_id = 'pricelists' and public.can_write_feed(name));
    create policy "pricelists admin select" on storage.objects for select to authenticated
      using (bucket_id = 'pricelists' and public.is_admin());
    create policy "pricelists admin delete" on storage.objects for delete to authenticated
      using (bucket_id = 'pricelists' and public.is_admin());
  end if;
end $$;
