-- Seller Hub: strict invoice confirmation + durable Storage cleanup queue. Safe to run again.
-- MUST be applied AFTER 025_audit_hardening_f1_f2.sql.
-- (a) admin_confirm_invoice now REQUIRES p_expected_amount and p_expected_stores ('expected_values_required',
--     errcode 22023, raised before anything is updated). The admin page always sends them; old 2-argument
--     and all-NULL calls no longer mark an invoice paid.
-- (b) public.pending_storage_cleanups: price-list files of a deleted account that still have to be removed from
--     Storage. admin_delete_account fills it in the same transaction; the admin page removes the files and then
--     calls admin_resolve_storage_cleanup (or admin_fail_storage_cleanup); leftovers are shown there and retried.
begin;

-- ---------- (a) strict admin_confirm_invoice ----------
create or replace function public.admin_confirm_invoice(p_id bigint, p_note text default null, p_expected_amount int default null, p_expected_stores int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare inv public.invoices; acc public.accounts; start_at timestamptz; end_at timestamptz; ref public.accounts;
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

-- ---------- (b) cleanup queue ----------
create table if not exists public.pending_storage_cleanups (
  id          bigserial primary key,
  bucket      text not null default 'pricelists',
  object_path text not null,
  created_at  timestamptz not null default now(),
  attempts    int not null default 0,
  last_error  text,
  unique (bucket, object_path)
);
alter table public.pending_storage_cleanups enable row level security;
drop policy if exists "pending_storage_cleanups admin" on public.pending_storage_cleanups;
create policy "pending_storage_cleanups admin" on public.pending_storage_cleanups for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
revoke all on public.pending_storage_cleanups from public, anon, authenticated;   -- reached only through the RPCs below
revoke all on sequence public.pending_storage_cleanups_id_seq from public, anon, authenticated;

-- ---------- (c) admin_delete_account also queues the Storage cleanup ----------
create or replace function public.admin_delete_account(p_user uuid, p_email text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare em text; ref text; feeds jsonb; n_inv int; n_cons int;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_user is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p_user = auth.uid() or exists (select 1 from public.admins where user_id = p_user) then
    raise exception 'cannot_delete_admin' using errcode = '42501';
  end if;
  select email into em from auth.users where id = p_user for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if lower(btrim(coalesce(p_email, ''))) is distinct from lower(btrim(coalesce(em, ''))) or em is null then
    raise exception 'email_mismatch' using errcode = '22023';
  end if;
  ref := public.account_ref(em);
  update public.invoices set status = 'cancelled', admin_note = 'account deleted', confirmed_by = auth.uid()
    where user_id = p_user and status = 'pending';
  update public.invoices set account_ref = ref where user_id = p_user;
  get diagnostics n_inv = row_count;
  update public.consents set account_ref = ref where user_id = p_user;
  get diagnostics n_cons = row_count;
  select coalesce(jsonb_agg(feed_id), '[]'::jsonb) into feeds from public.price_feeds where user_id = p_user;
  -- Storage files of the removed feeds are deleted by the admin page through the Storage API; remember them
  -- in the same transaction so a failed or interrupted cleanup can be retried (admin_list_storage_cleanups)
  insert into public.pending_storage_cleanups (bucket, object_path)
    select 'pricelists', f.feed_id::text from public.price_feeds f where f.user_id = p_user
    on conflict (bucket, object_path) do nothing;
  delete from auth.users where id = p_user;   -- cascades to accounts, tickets, usage, Telegram links…
  return jsonb_build_object('deleted', true, 'account_ref', ref, 'invoices_kept', n_inv,
                            'consents_kept', n_cons, 'price_feeds_to_remove', feeds);
end $$;
revoke all on function public.admin_delete_account(uuid, text) from public, anon;
grant execute on function public.admin_delete_account(uuid, text) to authenticated;

-- ---------- (d) cleanup RPCs ----------
create or replace function public.admin_list_storage_cleanups()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from public.pending_storage_cleanups c), '[]'::jsonb);
end $$;

create or replace function public.admin_resolve_storage_cleanup(p_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.pending_storage_cleanups where id = p_id;
  get diagnostics n = row_count;
  return jsonb_build_object('resolved', n > 0);
end $$;

create or replace function public.admin_fail_storage_cleanup(p_id bigint, p_error text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.pending_storage_cleanups set attempts = attempts + 1, last_error = left(p_error, 500) where id = p_id;
  get diagnostics n = row_count;
  return jsonb_build_object('updated', n > 0);
end $$;

revoke execute on function public.admin_list_storage_cleanups(), public.admin_resolve_storage_cleanup(bigint), public.admin_fail_storage_cleanup(bigint, text) from public, anon;
grant execute on function public.admin_list_storage_cleanups(), public.admin_resolve_storage_cleanup(bigint), public.admin_fail_storage_cleanup(bigint, text) to authenticated;  -- is_admin() inside

commit;
