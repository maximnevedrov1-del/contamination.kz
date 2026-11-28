-- Seller Hub: «Поддержать проект» (Supporter) — Stage 04. Safe to run again. Apply AFTER 035_free_access.sql, then grants.sql.
--
-- Commercial model:  FREE = 0 ₸, every business function, with advertisements.
--                    SUPPORTER = 5 000 ₸ / month, the SAME functions, no advertisements, no donation prompts.
-- The subscription state changes ONE thing: whether advertisements are shown. Nothing here touches has_access(),
-- store_cap(), ensure_price_feed() or any other function that guards business data.
--
-- (a) supporter_config: price, payments switch. `payments_enabled` is FALSE until the owner turns it on, and the owner
--     cannot turn it on while the payment instructions / QR are missing (admin_set_supporter_payments).
-- (b) accounts.supporter_until / supporter_cancel_at — the paid ad-free period and a cancellation request.
-- (c) invoices.kind = 'supporter' — rides the existing, reviewed payment path (payment_received → confirm_invoice_core):
--     HMAC webhook, payment_events idempotency, exact-amount match, admin review queue.
-- (d) get_entitlements(): the ONLY source of «show ads or not». Derived from the database for auth.uid(); the client
--     never sends a plan, a date or a payment claim.
-- (e) create_supporter_invoice / cancel_supporter / resume_supporter / payment_failed.
--
-- NOTE: do not re-run 028/030 after this file (they would restore the legacy confirm_invoice_core over the wrapper); re-apply 036 if you did.
--
-- Legacy customers: nothing is charged, converted or reset. A period already paid through an invoice
-- (kind manual|renewal, status paid) keeps the account ad-free until its period_to (legacy_paid_until()).
begin;

-- ---------- (a) configuration ----------
create table if not exists public.supporter_config (
  id               int primary key default 1 check (id = 1),
  price_month      int  not null default 5000 check (price_month > 0),
  currency         text not null default 'KZT' check (currency = 'KZT'),
  max_months       int  not null default 12 check (max_months between 1 and 24),
  payments_enabled boolean not null default false,
  updated_at       timestamptz not null default now()
);
insert into public.supporter_config (id) values (1) on conflict (id) do nothing;
alter table public.supporter_config enable row level security;
revoke all on public.supporter_config from public, anon, authenticated;

-- ---------- (b) accounts ----------
alter table public.accounts add column if not exists supporter_until     timestamptz;
alter table public.accounts add column if not exists supporter_cancel_at timestamptz;

-- ---------- (c) invoices ----------
alter table public.invoices drop constraint if exists invoices_kind_check;
alter table public.invoices add constraint invoices_kind_check check (kind in ('manual', 'renewal', 'addon', 'supporter'));
-- one open invoice per user per family: a pending supporter invoice and a (legacy) pending invoice may coexist
drop index if exists public.invoices_one_pending;
create unique index if not exists invoices_one_pending on public.invoices (user_id) where status = 'pending' and kind <> 'supporter';
create unique index if not exists invoices_one_pending_supporter on public.invoices (user_id) where status = 'pending' and kind = 'supporter';

-- Legacy create_invoice cancels «the» pending invoice: it must not cancel a supporter one.
do $$
declare d text := pg_get_functiondef('public.create_invoice(integer,integer,text)'::regprocedure);
        old_s text := 'where user_id = acc.user_id and status = ''pending'';';
        new_s text := 'where user_id = acc.user_id and status = ''pending'' and kind <> ''supporter'';';
begin
  if position('kind <> ''supporter''' in d) = 0 then
    if (length(d) - length(replace(d, old_s, ''))) / length(old_s) <> 1 then
      raise exception 'create_invoice: expected exactly one "%"', old_s;
    end if;
    execute replace(d, old_s, new_s);
  end if;
end $$;

-- get_license reports ONE pending invoice (scalar subquery): with a legacy and a supporter invoice open at the same time it
-- would return two rows and fail. Keep it to the legacy family; the supporter invoice is reported by get_entitlements().
do $$
declare d text := pg_get_functiondef('public.get_license(integer,text[])'::regprocedure);
        old_s text := 'where i.user_id = acc.user_id and i.status = ''pending''),';
        new_s text := 'where i.user_id = acc.user_id and i.status = ''pending'' and i.kind <> ''supporter''),';
begin
  if position('i.kind <> ''supporter''' in d) = 0 then
    if (length(d) - length(replace(d, old_s, ''))) / length(old_s) <> 1 then
      raise exception 'get_license: expected exactly one "%"', old_s;
    end if;
    execute replace(d, old_s, new_s);
  end if;
end $$;

create or replace function public.ensure_renewal_invoice(p_stores int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare acc public.accounts; pend public.invoices;
begin
  acc := public.ensure_account();
  select * into pend from public.invoices where user_id = acc.user_id and status = 'pending' and kind <> 'supporter';
  return case when found then to_jsonb(pend) - 'confirmed_by' - 'admin_note' end;
end $$;

-- ---------- confirmation: supporter invoices extend supporter_until, everything else is the old path ----------
do $$ begin
  if to_regprocedure('public.confirm_legacy_invoice_core(bigint,text,uuid)') is null then
    alter function public.confirm_invoice_core(bigint, text, uuid) rename to confirm_legacy_invoice_core;
  end if;
end $$;
revoke execute on function public.confirm_legacy_invoice_core(bigint, text, uuid) from public, anon, authenticated;

create or replace function public.confirm_invoice_core(p_id bigint, p_note text, p_by uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare inv public.invoices; acc public.accounts; start_at timestamptz; end_at timestamptz;
begin
  select * into inv from public.invoices where id = p_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if inv.kind <> 'supporter' then return public.confirm_legacy_invoice_core(p_id, p_note, p_by); end if;
  if inv.status <> 'pending' then raise exception 'not_pending' using errcode = '22023'; end if;
  select * into acc from public.accounts where user_id = inv.user_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  -- renewal stacks: paying before the end adds a month to the end, paying after the end starts now
  start_at := greatest(now(), coalesce(acc.supporter_until, now()));
  end_at := start_at + make_interval(months => inv.months);
  -- paying again = staying: a cancellation request is withdrawn. Business columns (paid_until, store_limit, ...) are untouched.
  update public.accounts set supporter_until = end_at, supporter_cancel_at = null where user_id = inv.user_id;
  update public.invoices set status = 'paid', paid_at = now(), period_from = start_at, period_to = end_at,
         confirmed_by = p_by, admin_note = p_note
    where id = p_id returning * into inv;
  return to_jsonb(inv);
end $$;
revoke execute on function public.confirm_invoice_core(bigint, text, uuid) from public, anon, authenticated;

-- ---------- failed payments ----------
alter table public.payment_events drop constraint if exists payment_events_outcome_check;
alter table public.payment_events add constraint payment_events_outcome_check
  check (outcome in ('processing', 'confirmed', 'review', 'resolved', 'failed'));
alter table public.payment_events drop constraint if exists payment_events_reason_check;
alter table public.payment_events add constraint payment_events_reason_check check (reason is null or reason in
  ('no_match', 'ambiguous', 'amount_mismatch', 'invoice_not_pending', 'invoice_not_found', 'phone_only', 'provider_failed', 'reversed'));
-- the 'failed:' prefix belongs to failure records only: a provider payment id can never collide with one
alter table public.payment_events drop constraint if exists payment_events_failed_prefix;
alter table public.payment_events add constraint payment_events_failed_prefix check (outcome = 'failed' or reason = 'reversed' or payment_id not like 'failed:%') not valid;

-- The provider reports that a payment did not go through. Recorded once per (provider, payment); it changes NO entitlement and
-- leaves the invoice pending, so the client can pay again. A later successful payment has its own payment_id.
create or replace function public.payment_failed(p_provider text, p_payment_id text, p_amount int, p_invoice_id bigint default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ev public.payment_events; inv_id bigint; rev_inv bigint;
begin
  if p_provider is null or p_provider !~ '^[a-z0-9_-]{2,32}$' or p_payment_id is null or length(p_payment_id) not between 1 and 120
     or p_amount is null or p_amount <= 0 then
    raise exception 'invalid_payment' using errcode = '22023';
  end if;
  select id into inv_id from public.invoices where id = p_invoice_id;  -- null when unknown: the FK must not fail
  -- «failed» for a payment we already CONFIRMED is a reversal (refund / chargeback): the entitlement is not changed
  -- automatically, but it lands in the admin review queue instead of being filed away as a plain failure.
  select invoice_id into rev_inv from public.payment_events where provider = p_provider and payment_id = p_payment_id and outcome = 'confirmed';
  insert into public.payment_events (provider, payment_id, amount, invoice_id, outcome, reason, resolved_at)
  values (p_provider, 'failed:' || p_payment_id, p_amount, coalesce(rev_inv, inv_id),
          case when rev_inv is not null then 'review' else 'failed' end,
          case when rev_inv is not null then 'reversed' else 'provider_failed' end,
          case when rev_inv is not null then null else now() end)
  on conflict (provider, payment_id) do nothing returning * into ev;
  if not found then
    return jsonb_build_object('outcome', 'failed', 'reason', 'provider_failed', 'duplicate', true);
  end if;
  return jsonb_build_object('outcome', ev.outcome, 'reason', ev.reason, 'invoice_id', ev.invoice_id, 'duplicate', false);
end $$;
revoke execute on function public.payment_failed(text, text, int, bigint) from public, anon, authenticated;
grant execute on function public.payment_failed(text, text, int, bigint) to service_role;

-- ---------- (d) entitlements ----------
-- The paid period a legacy customer already bought. Only real paid invoices count: not the trial, not referral or
-- admin-granted days in accounts.paid_until.
create or replace function public.legacy_paid_until(p_user uuid)
returns timestamptz language sql stable security definer set search_path = public as $$
  select max(period_to) from public.invoices where user_id = p_user and status = 'paid' and kind in ('manual', 'renewal');
$$;
revoke execute on function public.legacy_paid_until(uuid) from public, anon, authenticated;

create or replace function public.supporter_payments_ready()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select s.payments_enabled
                     and (nullif(btrim(coalesce(b.kaspi_qr_url, '')), '') is not null or nullif(btrim(coalesce(b.payment_instructions, '')), '') is not null)
                     from public.supporter_config s, public.billing_config b where s.id = 1 and b.id = 1), false);
$$;
revoke execute on function public.supporter_payments_ready() from public, anon, authenticated;

create or replace function public.get_entitlements()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid(); acc public.accounts; c public.supporter_config; leg timestamptz; until_at timestamptz;
        sup boolean; st text; pend public.invoices;
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select * into acc from public.accounts where user_id = uid;
  select * into c from public.supporter_config where id = 1;
  leg := public.legacy_paid_until(uid);
  until_at := greatest(acc.supporter_until, leg);
  sup := coalesce(until_at > now(), false);
  st := case when sup and acc.supporter_cancel_at is not null and acc.supporter_until > now() then 'supporter_ending'
             when sup then 'supporter'
             when until_at is not null then 'expired'
             else 'free' end;
  select * into pend from public.invoices where user_id = uid and status = 'pending' and kind = 'supporter';
  return jsonb_build_object(
    'status', st,
    'ad_free', sup,
    'show_ads', not sup,
    'supporter_until', acc.supporter_until,
    'legacy_paid_until', leg,
    'ends_at', case when sup then until_at end,
    'cancel_at', acc.supporter_cancel_at,
    'price_month', c.price_month,
    'currency', c.currency,
    'max_months', c.max_months,
    'payments_enabled', public.supporter_payments_ready(),
    'pending_invoice', case when pend.id is not null then to_jsonb(pend) - 'confirmed_by' - 'admin_note' end,
    'restricts_functionality', false,
    'server_time', now());
end $$;
revoke execute on function public.get_entitlements() from public, anon;
grant execute on function public.get_entitlements() to authenticated;

-- ---------- (e) client actions ----------
create or replace function public.create_supporter_invoice(p_months int, p_phone text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare acc public.accounts; c public.supporter_config; b public.billing_config; ph text; inv public.invoices;
begin
  acc := public.ensure_account();
  select * into b from public.billing_config where id = 1;
  select * into c from public.supporter_config where id = 1;
  if acc.terms_version is distinct from b.terms_version then raise exception 'terms_required' using errcode = '42501'; end if;
  if not public.supporter_payments_ready() then raise exception 'payments_disabled' using errcode = '55000'; end if;
  if p_months is null or p_months < 1 or p_months > c.max_months then raise exception 'invalid_months' using errcode = '22023'; end if;
  perform public.check_invoice_rate(acc.user_id);
  select * into inv from public.invoices where user_id = acc.user_id and status = 'pending' and kind = 'supporter' for update;
  if found and inv.months = p_months and inv.amount = c.price_month * p_months then
    return to_jsonb(inv) - 'confirmed_by' - 'admin_note';   -- same request again: the same open invoice, one amount
  end if;
  update public.invoices set status = 'cancelled', admin_note = 'replaced by client'
    where user_id = acc.user_id and status = 'pending' and kind = 'supporter';
  ph := public.phone_or_account(p_phone, acc);
  insert into public.invoices (user_id, kind, stores, months, amount, phone)
    values (acc.user_id, 'supporter', 1, p_months, c.price_month * p_months, ph) returning * into inv;
  if ph is not null then update public.accounts set phone = ph where user_id = acc.user_id; end if;
  return to_jsonb(inv) - 'confirmed_by' - 'admin_note';
end $$;
revoke execute on function public.create_supporter_invoice(int, text) from public, anon;
grant execute on function public.create_supporter_invoice(int, text) to authenticated;

-- Cancel: no renewal is ever automatic, so cancelling = withdraw the open invoice and mark the end. The paid period runs out.
create or replace function public.cancel_supporter()
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  update public.invoices set status = 'cancelled', admin_note = 'cancelled by client'
    where user_id = uid and status = 'pending' and kind = 'supporter';
  update public.accounts set supporter_cancel_at = coalesce(supporter_cancel_at, now())
    where user_id = uid and supporter_until > now();
  return public.get_entitlements();
end $$;
revoke execute on function public.cancel_supporter() from public, anon;
grant execute on function public.cancel_supporter() to authenticated;

create or replace function public.resume_supporter()
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  update public.accounts set supporter_cancel_at = null where user_id = uid;
  return public.get_entitlements();
end $$;
revoke execute on function public.resume_supporter() from public, anon;
grant execute on function public.resume_supporter() to authenticated;

-- Owner switch. Refuses while there is nothing to pay to (no Kaspi QR / payment instructions in the admin settings).
create or replace function public.admin_set_supporter_payments(p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b public.billing_config;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into b from public.billing_config where id = 1;
  if p_enabled and nullif(btrim(coalesce(b.kaspi_qr_url, '')), '') is null and nullif(btrim(coalesce(b.payment_instructions, '')), '') is null then
    raise exception 'payment_config_missing' using errcode = '55000';
  end if;
  update public.supporter_config set payments_enabled = coalesce(p_enabled, false), updated_at = now() where id = 1;
  return jsonb_build_object('payments_enabled', public.supporter_payments_ready());
end $$;
revoke execute on function public.admin_set_supporter_payments(boolean) from public, anon;
grant execute on function public.admin_set_supporter_payments(boolean) to authenticated;  -- is_admin() inside

commit;
