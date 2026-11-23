-- SaaS core: security/reliability fixes. Safe to run again.
-- MUST be applied AFTER 019_referral_program.sql (redefines its admin_confirm_invoice, reasserts its revokes).
-- 1. Referral reward only for subscription invoices (manual/renewal), never for add-on (extra stores) invoices,
--    and not to an inviter whose account is frozen or blocked (trial_blocked) or deleted.
-- 2. Sellers can no longer read invoices.admin_note / confirmed_by / account_ref (the client reads invoices only
--    through get_license, which already strips them; no client code selects the table directly).
-- 3. Reassert: no client access to tg_outbox, gen_referral_code, writes on accounts.

-- ---------- 1. admin_confirm_invoice ----------
create or replace function public.admin_confirm_invoice(p_id bigint, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare inv public.invoices; acc public.accounts; start_at timestamptz; end_at timestamptz; ref public.accounts;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
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

-- ---------- 2. column-level read on invoices ----------
revoke select on public.invoices from authenticated;
grant select (id, user_id, kind, stores, months, amount, phone, status, created_at, paid_at, period_from, period_to, discount_pct)
  on public.invoices to authenticated;

-- ---------- 3. reassert revokes ----------
revoke all on public.tg_outbox from public, anon, authenticated;
revoke all on sequence public.tg_outbox_id_seq from public, anon, authenticated;
revoke execute on function public.gen_referral_code() from public, anon, authenticated;
revoke insert, update, delete on public.accounts from anon, authenticated;
revoke execute on function public.admin_confirm_invoice(bigint, text) from public, anon;
grant execute on function public.admin_confirm_invoice(bigint, text) to authenticated;  -- is_admin() inside
