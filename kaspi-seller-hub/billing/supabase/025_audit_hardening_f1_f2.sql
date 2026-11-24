-- Seller Hub: audit hardening F1 + F2 (+ admin Storage cleanup policy). Safe to run again.
-- MUST be applied AFTER 024_ux_behavior_telemetry.sql.
-- F1. admin_confirm_invoice gets optional p_expected_amount / p_expected_stores: the admin page passes what it
--     displayed; if the open invoice was rewritten meanwhile (extension licence checks can change amount/stores
--     of an open invoice) the confirmation is refused with 'amount_changed' (errcode 40001) and nothing is paid.
--     NULL = old behaviour (no check).
-- F2. Privilege hardening: EXECUTE on public functions is taken away from PUBLIC and anon; only the explicit
--     anonymous RPCs below are granted back. Same list lives in grants.sql (apply it after a restore).
-- F3 (support). Admins may list and delete price-list objects in Storage (the client deletes feeds of a removed
--     account through the Storage API; direct deletes from storage.objects are not possible in Supabase).
begin;

-- ---------- F1. admin_confirm_invoice with expected amount / stores ----------
drop function if exists public.admin_confirm_invoice(bigint, text);
create or replace function public.admin_confirm_invoice(p_id bigint, p_note text default null, p_expected_amount int default null, p_expected_stores int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare inv public.invoices; acc public.accounts; start_at timestamptz; end_at timestamptz; ref public.accounts;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into inv from public.invoices where id = p_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if inv.status <> 'pending' then raise exception 'not_pending' using errcode = '22023'; end if;
  -- the invoice changed after the admin looked at it: refuse, the admin reloads and checks the new amount
  if (p_expected_amount is not null and p_expected_amount is distinct from inv.amount)
     or (p_expected_stores is not null and p_expected_stores is distinct from inv.stores) then
    raise exception 'amount_changed' using errcode = '40001';
  end if;
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
         confirmed_by = auth.uid(), admin_note = p_note
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
revoke execute on function public.admin_confirm_invoice(bigint, text, int, int) from public, anon;
grant execute on function public.admin_confirm_invoice(bigint, text, int, int) to authenticated;  -- is_admin() inside

-- ---------- F3 support: admins may list / delete price-list objects (account deletion cleanup) ----------
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    drop policy if exists "pricelists admin select" on storage.objects;
    drop policy if exists "pricelists admin delete" on storage.objects;
    create policy "pricelists admin select" on storage.objects for select to authenticated
      using (bucket_id = 'pricelists' and public.is_admin());
    create policy "pricelists admin delete" on storage.objects for delete to authenticated
      using (bucket_id = 'pricelists' and public.is_admin());
  end if;
end $$;

-- ---------- F2. privilege hardening ----------
-- Functions created after 001 got Supabase's default EXECUTE for anon / PUBLIC: take it away everywhere,
-- then grant back only what the extension / site / admin page call without a login. Keep in sync with grants.sql.
-- Audit follow-up: a stale add-on reconcile (client race) must not cancel an unpaid manual plan that already covers all connected stores.
create or replace function public.request_store_addon(p_total_stores int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare acc public.accounts; c public.billing_config; pend public.invoices; covered int; extra int; days int; amt int; n int;
begin
  acc := public.ensure_account();
  select * into c from public.billing_config where id = 1;
  n := least(c.max_stores, coalesce(p_total_stores, 0));
  if public.coverage_end(acc) <= now() + make_interval(days => c.remind_days) then
    return public.ensure_renewal_invoice(n);
  end if;
  covered := case when acc.paid_until > now() then acc.store_limit else greatest(c.trial_store_limit, acc.store_limit) end;
  extra := n - covered;
  n := public.plan_stores(n);
  select * into pend from public.invoices where user_id = acc.user_id and status = 'pending' for update;
  if extra <= 0 then
    return case when found then to_jsonb(pend) - 'confirmed_by' - 'admin_note' end;
  end if;
  days := greatest(1, ceil(extract(epoch from (public.coverage_end(acc) - now())) / 86400.0)::int);
  amt := greatest(100, (ceil((public.billing_price(n, 1) - public.billing_price(covered, 1)) * days / 30.0 / 100.0) * 100)::int);
  if found and pend.kind = 'manual' and pend.stores >= n then       -- the client's own unpaid plan already covers every store:
    return to_jsonb(pend) - 'confirmed_by' - 'admin_note';             -- a late/stale reconcile must not replace it with an add-on
  end if;
  if found and pend.kind = 'addon' then
    update public.invoices set stores = n, amount = amt where id = pend.id returning * into pend;
    return to_jsonb(pend) - 'confirmed_by' - 'admin_note';
  end if;
  perform public.check_invoice_rate(acc.user_id);
  if found then                                                        -- replace an unpaid manual plan
    update public.invoices set status = 'cancelled', admin_note = 'replaced by add-on' where id = pend.id;
  end if;
  insert into public.invoices (user_id, kind, stores, months, amount, phone)
    values (acc.user_id, 'addon', n, 0, amt, acc.phone) returning * into pend;
  return to_jsonb(pend) - 'confirmed_by' - 'admin_note';
end $$;

revoke execute on all functions in schema public from public, anon;
alter default privileges in schema public revoke execute on functions from public, anon;
grant execute on function public.get_service_status(), public.health() to anon;

commit;
