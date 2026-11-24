-- SaaS core: automatic payment confirmation (payment provider webhook → invoice paid). Safe to run again.
-- Apply AFTER 027_ux_events_batch.sql, then grants.sql.
--
-- (a) confirm_invoice_core(id, note, by): the one place that marks an invoice paid (subscription period, store limit,
--     discount, referral reward). admin_confirm_invoice keeps its checks (is_admin, expected amount/stores) and calls it.
-- (b) payment_events: every payment notification, once per (provider, payment_id) — webhook retries are harmless.
-- (c) payment_received(...): service_role only (the payment-webhook Edge Function). Finds the invoice
--     (by our invoice id, else the ONE pending invoice with this phone and exactly this amount) and confirms it only
--     when it is pending and the amount matches to the tenge. Anything else is stored with outcome 'review' and a reason
--     for the admin: nothing is ever confirmed on a guess.
-- (d) admin_payment_events / admin_resolve_payment_event: the review queue in the admin page.
begin;

-- ---------- (a) one confirmation path ----------
create or replace function public.confirm_invoice_core(p_id bigint, p_note text, p_by uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare inv public.invoices; acc public.accounts; start_at timestamptz; end_at timestamptz; ref public.accounts;
begin
  select * into inv from public.invoices where id = p_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if inv.status <> 'pending' then raise exception 'not_pending' using errcode = '22023'; end if;
  select * into acc from public.accounts where user_id = inv.user_id for update;
  if inv.kind = 'addon' then
    -- extra stores for the rest of the current period; the end date does not move
    start_at := now();
    end_at := public.coverage_end(acc);
    update public.accounts set store_limit = greatest(store_limit, inv.stores) where user_id = inv.user_id;
  else
    start_at := greatest(now(), coalesce(acc.paid_until, now()), acc.trial_ends_at);
    end_at := start_at + make_interval(months => inv.months);
    -- paying again = staying: a cancellation or «перейти на Старт» is done; a discount is used up
    update public.accounts set paid_until = end_at, store_limit = inv.stores, cancel_at = null, cancel_reason = null, downgrade_next = false,
           boost_until = null where user_id = inv.user_id;
  end if;
  if inv.discount_pct > 0 then
    update public.accounts set discount_left = greatest(0, discount_left - 1) where user_id = inv.user_id;
  end if;
  update public.invoices set status = 'paid', paid_at = now(), period_from = start_at, period_to = end_at,
         confirmed_by = p_by, admin_note = p_note
    where id = p_id returning * into inv;

  -- referral reward: the first paid invoice of an invited friend gives the inviter +14 days, once
  if inv.kind <> 'addon' and acc.referred_by is not null and not acc.referral_rewarded
     and not exists (select 1 from public.invoices where user_id = inv.user_id and status = 'paid' and kind <> 'addon' and id <> inv.id) then
    select * into ref from public.accounts where user_id = acc.referred_by for update;
    -- inviter gone (deleted → not found), frozen or blocked: no reward (the friend is still marked as rewarded)
    if found and coalesce(ref.frozen_until, '-infinity') < now() and not ref.trial_blocked then
      update public.accounts set
        paid_until = greatest(now(), coalesce(paid_until, now()), trial_ends_at) + interval '14 days',
        referrals_count = referrals_count + 1, referral_bonus_days = referral_bonus_days + 14
      where user_id = ref.user_id;
      if exists (select 1 from public.tg_links where user_id = ref.user_id and blocked_at is null) then
        insert into public.tg_outbox (user_id, kind, payload) values (ref.user_id, 'referral', jsonb_build_object('days', 14));
      end if;
    end if;
    update public.accounts set referral_rewarded = true where user_id = inv.user_id;
  end if;
  return to_jsonb(inv);
end $$;
revoke execute on function public.confirm_invoice_core(bigint, text, uuid) from public, anon, authenticated;

create or replace function public.admin_confirm_invoice(p_id bigint, p_note text default null, p_expected_amount int default null, p_expected_stores int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare inv public.invoices;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  -- the admin page always sends what it displayed; a call without both values is refused before anything changes
  if p_expected_amount is null or p_expected_stores is null then raise exception 'expected_values_required' using errcode = '22023'; end if;
  select * into inv from public.invoices where id = p_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if inv.status <> 'pending' then raise exception 'not_pending' using errcode = '22023'; end if;
  -- the invoice changed after the admin looked at it: refuse, the admin reloads and checks the new amount
  if p_expected_amount is distinct from inv.amount or p_expected_stores is distinct from inv.stores then
    raise exception 'amount_changed' using errcode = '40001';
  end if;
  return public.confirm_invoice_core(p_id, p_note, auth.uid());
end $$;
revoke execute on function public.admin_confirm_invoice(bigint, text, int, int) from public, anon;
grant execute on function public.admin_confirm_invoice(bigint, text, int, int) to authenticated;  -- is_admin() inside

-- ---------- (b) payment notifications ----------
create table if not exists public.payment_events (
  id          bigserial primary key,
  provider    text not null check (provider ~ '^[a-z0-9_-]{2,32}$'),
  payment_id  text not null check (length(payment_id) between 1 and 128),
  invoice_id  bigint references public.invoices (id) on delete set null,
  amount      int not null check (amount > 0),
  phone       text,
  outcome     text not null default 'processing' check (outcome in ('processing', 'confirmed', 'review', 'resolved')),
  reason      text check (reason is null or reason in ('no_match', 'ambiguous', 'amount_mismatch', 'invoice_not_pending', 'invoice_not_found')),
  received_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  admin_note  text,
  unique (provider, payment_id)
);
alter table public.payment_events enable row level security;
revoke all on public.payment_events from public, anon, authenticated;
revoke all on sequence public.payment_events_id_seq from public, anon, authenticated;
create index if not exists payment_events_review_idx on public.payment_events (received_at desc) where outcome = 'review';
create index if not exists invoices_pending_phone_amount on public.invoices (phone, amount) where status = 'pending';

-- ---------- (c) the webhook entry point ----------
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
    select * into inv from public.invoices where id = p_invoice_id for update;
    if not found then why := 'invoice_not_found'; end if;
  elsif ph is not null then
    select count(*) into n from public.invoices where status = 'pending' and phone = ph and amount = p_amount;
    if n = 1 then
      select * into inv from public.invoices where status = 'pending' and phone = ph and amount = p_amount for update;
    elsif n = 0 then why := 'no_match';
    else why := 'ambiguous';
    end if;
  else
    why := 'no_match';
  end if;

  if why is null and inv.status <> 'pending' then why := 'invoice_not_pending'; end if;
  if why is null and inv.amount <> p_amount then why := 'amount_mismatch'; end if;

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

-- ---------- (d) review queue for the admin ----------
create or replace function public.admin_payment_events(p_only_review boolean default true, p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.received_at desc)
      from (select e.id, e.provider, e.payment_id, e.invoice_id, e.amount, e.phone, e.outcome, e.reason, e.received_at,
                   e.resolved_at, e.admin_note, i.status as invoice_status, i.amount as invoice_amount
              from public.payment_events e left join public.invoices i on i.id = e.invoice_id
             where not p_only_review or e.outcome = 'review'
             order by e.received_at desc
             limit least(greatest(coalesce(p_limit, 100), 1), 500)) x), '[]'::jsonb);
end $$;

create or replace function public.admin_resolve_payment_event(p_id bigint, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ev public.payment_events;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.payment_events set outcome = 'resolved', resolved_at = now(), resolved_by = auth.uid(), admin_note = left(p_note, 500)
   where id = p_id and outcome = 'review' returning * into ev;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  return to_jsonb(ev);
end $$;
revoke execute on function public.admin_payment_events(boolean, int), public.admin_resolve_payment_event(bigint, text) from public, anon;
grant execute on function public.admin_payment_events(boolean, int), public.admin_resolve_payment_event(bigint, text) to authenticated;  -- is_admin() inside

commit;
